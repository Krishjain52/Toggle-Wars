import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { config } from "../config.js";

/**
 * Admin operations go through the official Flagsmith CLI (`flagsmith ...`), so
 * every change the agent makes is a command a human could run and audit.
 * Credentials come from FLAGSMITH_API_KEY; project/environment from flagsmith.json.
 */
const BIN = resolve("node_modules/.bin/flagsmith");

export function cli(args: string[], input?: string): Promise<string> {
  return new Promise((res, rej) => {
    const child = execFile(
      BIN,
      // --yes: the human already confirmed through the agent's approval gate.
      [...args, "--no-input", "--yes"],
      { env: process.env, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // Some CLI refusals exit 0, so an "Error:" line counts as failure too.
        const refused = /^Error:/m.test(stderr) || /^Error:/m.test(stdout);
        if (err || refused) rej(new Error(`flagsmith ${args.slice(0, 3).join(" ")} failed: ${(stderr || stdout || err?.message || "").trim().split("\n")[0]}`));
        else res(stdout);
      },
    );
    if (input !== undefined) child.stdin!.end(input);
  });
}

/** Call the Admin API through `flagsmith api` and parse the JSON response. */
async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const args = ["api", path, "-X", method];
  if (body !== undefined) args.push("--input", "-");
  const out = await cli(args, body === undefined ? undefined : JSON.stringify(body));
  return (out.trim() ? JSON.parse(out) : null) as T;
}

const envPath = (suffix: string) => `api/v1/environments/${config.flagsmith.environmentKey()}/${suffix}`;

// ── Flags ───────────────────────────────────────────────────────────────────

export interface FeatureInfo {
  id: number;
  name: string;
  default_value: string;
  variants: { id: number; key: string; value: string; weight: number }[];
}

export const getFeature = async (name: string): Promise<FeatureInfo> =>
  JSON.parse(await cli(["feature", "get", name, "--json"]));

/**
 * Create the generation's multivariate flag: the champion is the control
 * (default value) and each challenger is a keyed variant.
 */
export async function createArenaFlag(
  name: string,
  description: string,
  control: string,
  variants: { key: string; value: string }[],
): Promise<FeatureInfo> {
  await cli(["feature", "create", name, "--value", control, "--enabled", "--description", description]);
  for (const v of variants) {
    await cli(["feature", "variant", "add", name, "--value", v.value, "--key", v.key, "--weight", "0"]);
  }
  return getFeature(name);
}

export const deleteFeature = (name: string) => cli(["feature", "delete", name]);

/** Archive instead of delete: the generation's experiment history stays browsable in Flagsmith. */
export const archiveFeature = (name: string) => cli(["feature", "update", name, "--archive"]);

export async function featureExists(name: string): Promise<boolean> {
  try {
    await getFeature(name);
    return true;
  } catch {
    return false;
  }
}

/** Ship a value: create the production flag, or update its environment value. */
export async function shipFlagValue(name: string, value: string, description: string) {
  if (await featureExists(name)) {
    await cli(["flag", "update", name, "--value", value, "--type", "string", "--enable"]);
  } else {
    await cli(["feature", "create", name, "--value", value, "--enabled", "--description", description]);
  }
}

/** Create (or update) a segment and point the flag's segment override at `value`. */
export async function shipSegmentOverride(flag: string, segment: string, description: string, rules: unknown, value: string) {
  const rulesJson = JSON.stringify(rules);
  try {
    await cli(["segment", "get", segment, "--json"]);
    await cli(["segment", "update", segment, "--rules", rulesJson]);
  } catch {
    await cli(["segment", "create", segment, "--rules", rulesJson, "--description", description]);
  }
  await cli(["flag", "update", flag, "--segment", segment, "--value", value, "--type", "string", "--enable"]);
}

export async function projectId(): Promise<number> {
  const env = await api<{ project: number }>(`api/v1/environments/${config.flagsmith.environmentKey()}/`);
  return env.project;
}

// ── Metrics ─────────────────────────────────────────────────────────────────

interface Metric { id: number; name: string; definition: { event: string } }

/** Find or create the occurrence metric that counts `event` (a sign-up). */
export async function ensureMetric(name: string, event: string): Promise<Metric> {
  const list = await api<{ results: Metric[] }>(envPath("experiment-metrics/"));
  const existing = list.results.find((m) => m.definition?.event === event);
  if (existing) return existing;
  return api<Metric>(envPath("experiment-metrics/"), "POST", {
    name,
    aggregation: "occurrence",
    direction: "up",
    definition: { version: 1, event },
  });
}

// ── Experiments ─────────────────────────────────────────────────────────────

export interface Experiment {
  id: number;
  name: string;
  status: "created" | "running" | "paused" | "completed";
}

/** Create an experiment that splits traffic evenly between control and every variant. */
export async function createExperiment(opts: {
  feature: FeatureInfo;
  name: string;
  hypothesis: string;
  metricId: number;
}): Promise<Experiment> {
  const arms = opts.feature.variants.length + 1;
  const share = Math.floor((100 / arms) * 100) / 100; // control gets the remainder
  return api<Experiment>(envPath("experiments/"), "POST", {
    feature: opts.feature.id,
    name: opts.name,
    hypothesis: opts.hypothesis,
    metrics: [{ metric: opts.metricId, expected_direction: "increase" }],
    experiment_rollout: {
      enabled: true,
      rollout_percentage: 100,
      feature_state_value: { type: "string", value: opts.feature.default_value },
      multivariate_feature_state_values: opts.feature.variants.map((v) => ({
        multivariate_feature_option: v.id,
        percentage_allocation: share,
      })),
    },
  });
}

export const startExperiment = (id: number) => api<Experiment>(envPath(`experiments/${id}/start/`), "POST");

/** Ask Flagsmith to recompute results. Allowed once per 5 minutes per experiment. */
export const refreshResults = (id: number) => api<null>(envPath(`experiments/${id}/results/refresh/`), "POST");

export interface VariantResult {
  key: string; // "control" or a variant key
  visitors: number;
  conversions: number;
  rate: number;
  /** Probability this variant beats control (null for control). */
  chanceToWin: number | null;
  lift: number | null;
}

export interface Results {
  asOf: string | null;
  isFinal: boolean;
  srmPValue: number | null;
  variants: VariantResult[];
}

interface RawResults {
  results: null | {
    as_of: string | null;
    is_final: boolean;
    payload: null | {
      srm_p_value: number | null;
      metrics: {
        metric_id: number;
        variants: Record<string, { n: number; sum: number }>;
        inference: Record<string, { lift: number; chance_to_win: number } | null>;
      }[];
    };
  };
}

/** Read the Bayesian results Flagsmith computed for the experiment's metric. */
export async function getResults(id: number, metricId: number): Promise<Results | null> {
  const raw = await api<RawResults>(envPath(`experiments/${id}/results/`));
  const payload = raw.results?.payload;
  const metric = payload?.metrics.find((m) => m.metric_id === metricId) ?? payload?.metrics[0];
  if (!raw.results || !payload || !metric) return null;
  return {
    asOf: raw.results.as_of,
    isFinal: raw.results.is_final,
    srmPValue: payload.srm_p_value,
    variants: Object.entries(metric.variants).map(([key, s]) => ({
      key,
      visitors: s.n,
      conversions: s.sum,
      rate: s.n ? s.sum / s.n : 0,
      chanceToWin: metric.inference[key]?.chance_to_win ?? null,
      lift: metric.inference[key]?.lift ?? null,
    })),
  };
}

/** End the experiment and roll out the winner (or keep the champion). */
export const completeExperiment = (id: number, winnerVariantId: number | null) =>
  api<Experiment>(
    envPath(`experiments/${id}/complete/`),
    "POST",
    winnerVariantId === null
      ? { rollout_decision: "control" }
      : { rollout_decision: "variant", rollout_variant: winnerVariantId },
  );

export const experimentUrl = (projectId: number, experimentId: number) =>
  `${config.flagsmith.dashboardUrl}/project/${projectId}/environment/${config.flagsmith.environmentKey()}/experiments/${experimentId}`;
