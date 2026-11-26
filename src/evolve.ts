import { approve } from "./approval.js";
import { bus, type Fighter } from "./bus.js";
import { config } from "./config.js";
import { breedChallengers, type GenerationFeedback } from "./designer.js";
import * as fs from "./flagsmith/admin.js";
import { createSdk, SIGNUP_EVENT, waitUntilLive } from "./flagsmith/sdk.js";
import { spawnVisitors } from "./personas.js";
import { GENESIS, PRODUCT } from "./seed.js";
import { fallbackInference } from "./stats.js";
import { runSwarm } from "./swarm.js";
import type { VariantSpec } from "./variant.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "fighter";

/** The production flag the real landing page reads. The champion ships here. */
export const PRODUCTION_FLAG = "landing_page";

/**
 * Wait for Flagsmith to ingest the swarm's events and compute Bayesian results.
 * Refreshes are rate-limited to one per 5 minutes, so we refresh, poll, and
 * only refresh again once the window has passed and the counts are still short.
 */
async function awaitResults(expId: number, metricId: number, expected: number) {
  const REFRESH_EVERY = 5 * 60_000 + 5_000;
  const deadline = Date.now() + 20 * 60_000;
  bus.phase("analysing", "Waiting for Flagsmith to ingest events (about a minute)…");
  await sleep(75_000);
  let lastRefresh = 0;
  let best: fs.Results | null = null;
  while (Date.now() < deadline) {
    if (Date.now() - lastRefresh > REFRESH_EVERY) {
      try {
        await fs.refreshResults(expId);
        lastRefresh = Date.now();
        bus.phase("analysing", "Flagsmith is computing Bayesian results…");
      } catch (e) {
        bus.log(`Refresh not allowed yet: ${(e as Error).message.slice(0, 100)}`);
        lastRefresh = Date.now() - REFRESH_EVERY + 60_000; // retry in a minute
      }
    }
    await sleep(15_000);
    const r = await fs.getResults(expId, metricId).catch(() => null);
    if (r) {
      best = r;
      const seen = r.variants.reduce((n, v) => n + v.visitors, 0);
      bus.phase("analysing", `Flagsmith has analysed ${seen}/${expected} visitors…`);
      if (seen >= expected * 0.95) return r;
    }
  }
  // Never crown a winner on missing data: an incomplete analysis stops the run.
  const seen = best?.variants.reduce((n, v) => n + v.visitors, 0) ?? 0;
  if (best && seen >= expected * 0.8) return best;
  throw new Error(`Flagsmith analysed only ${seen}/${expected} visitors in time; not deciding a winner on incomplete data`);
}

function feedbackFrom(fighters: Fighter[]): GenerationFeedback {
  const thoughts = bus.state.thoughts;
  const champKey = fighters.find((f) => f.isChampion)?.key;
  return {
    scoreboard: fighters.map((f) => ({
      name: f.spec.name,
      conversionRate: f.flagsmith?.rate ?? (f.visitors ? f.signups / f.visitors : 0),
      visitors: f.flagsmith?.visitors ?? f.visitors,
    })),
    objections: thoughts.filter((t) => t.fighterKey === champKey && !t.signup).slice(-12).map((t) => `${t.persona}: ${t.text}`),
    praise: thoughts.filter((t) => t.signup).slice(-8).map((t) => `${t.persona}: ${t.text}`),
  };
}

export async function runArena() {
  const runId = `r${Date.now().toString(36).slice(-5)}`;
  const { generations, visitorsPerGeneration, winThreshold, seed } = config.arena;
  const sdk = createSdk();
  const project = await fs.projectId();
  bus.update({ product: PRODUCT.name, goal: PRODUCT.goal, totalGenerations: generations });
  bus.log(`Run ${runId}: evolving the ${PRODUCT.name} landing page over ${generations} generations`);

  const metric = await fs.ensureMetric("Arena sign-ups", SIGNUP_EVENT);
  let champion: VariantSpec = GENESIS;
  let feedback: GenerationFeedback | null = null;
  const flags: string[] = [];

  for (let gen = 1; gen <= generations; gen++) {
    bus.update({ generation: gen, fighters: [], thoughts: [], flagName: null, experimentUrl: null });

    // 1. Breed challengers from the champion and last round's visitor feedback.
    bus.phase("breeding", `Generation ${gen}: designing challengers for "${champion.name}"…`);
    const challengers = await breedChallengers(champion, gen, feedback);
    const used = new Set(["control"]);
    const keyed = challengers.map((spec) => {
      let key = slug(spec.name);
      while (used.has(key)) key += "_x";
      used.add(key);
      return { key, spec };
    });
    bus.update({
      fighters: [
        { key: "control", spec: champion, isChampion: true, visitors: 0, signups: 0, status: "fighting" },
        ...keyed.map(({ key, spec }) => ({ key, spec, isChampion: false, visitors: 0, signups: 0, status: "fighting" as const })),
      ],
    });

    // 2. Human approval before anything touches Flagsmith.
    const flagName = `arena_${runId}_g${gen}`;
    const ok = await approve(`Launch generation ${gen} in Flagsmith`, [
      `Create multivariate flag "${flagName}" (champion = control, ${keyed.length} challenger variants)`,
      `Create and start an experiment measuring "${SIGNUP_EVENT}", split evenly across ${keyed.length + 1} fighters`,
      `Send ${visitorsPerGeneration} synthetic visitors through it`,
      ...keyed.map(({ spec }) => `🥊 ${spec.name}: ${spec.strategy}`),
    ]);
    if (!ok) {
      bus.phase("done", "Run stopped by the operator. Nothing was changed in Flagsmith for this generation.");
      return;
    }

    // 3. Deploy: flag + experiment, all through the Flagsmith CLI.
    bus.phase("deploying", `Creating flag ${flagName} and its experiment…`);
    const feature = await fs.createArenaFlag(
      flagName,
      `Toggle Wars ${runId} generation ${gen}: ${champion.name} defends against ${keyed.map((k) => k.spec.name).join(", ")}`,
      JSON.stringify(champion),
      keyed.map(({ key, spec }) => ({ key, value: JSON.stringify(spec) })),
    );
    flags.push(flagName);
    const exp = await fs.createExperiment({
      feature,
      name: `Toggle Wars ${runId} · Gen ${gen}`,
      hypothesis: `At least one challenger (${keyed.map((k) => k.spec.name).join(", ")}) converts better than the champion "${champion.name}".`,
      metricId: metric.id,
    });
    await fs.startExperiment(exp.id);
    bus.phase("deploying", "Waiting for the experiment to reach Flagsmith's edge…");
    await waitUntilLive(sdk, flagName, exp.id);
    const url = fs.experimentUrl(project, exp.id);
    bus.update({ flagName, experimentUrl: url });
    bus.log(`Experiment ${exp.id} is running: ${url}`);

    // 4. Battle: synthetic visitors flow through the live experiment.
    bus.phase("battling", `${visitorsPerGeneration} visitors are entering the arena…`);
    const visitors = spawnVisitors(visitorsPerGeneration, runId, gen, seed);
    const { enrolled } = await runSwarm(sdk, flagName, visitors);

    // 5. Flagsmith decides.
    const results = await awaitResults(exp.id, metric.id, enrolled);
    for (const f of bus.state.fighters) {
      const r = results.variants.find((v) => v.key === f.key);
      if (r) f.flagsmith = { visitors: r.visitors, conversions: r.conversions, rate: r.rate, chanceToWin: r.chanceToWin, lift: r.lift, source: "flagsmith" };
    }
    // Flagsmith withholds inference when an arm has < 5 conversions. If only the
    // champion is short, apply Flagsmith's own formula to Flagsmith's counts.
    const champStats = bus.state.fighters.find((f) => f.isChampion)?.flagsmith;
    for (const f of bus.state.fighters) {
      if (f.isChampion || !f.flagsmith || f.flagsmith.chanceToWin !== null || !champStats) continue;
      const inf = fallbackInference(champStats, f.flagsmith);
      if (!inf) continue;
      f.flagsmith.chanceToWin = inf.chanceToWin;
      f.flagsmith.source = "fallback";
      bus.log(`Champion had too few conversions for Flagsmith inference; ${f.spec.name}: ${pct(inf.chanceToWin)} chance to win (two-proportion test on Flagsmith's counts)`);
    }
    const contenders = bus.state.fighters
      .filter((f) => !f.isChampion && (f.flagsmith?.chanceToWin ?? 0) >= winThreshold)
      .sort((a, b) => (b.flagsmith!.rate - a.flagsmith!.rate));
    const winner = contenders[0] ?? null;
    const champFighter = bus.state.fighters.find((f) => f.isChampion)!;
    for (const f of bus.state.fighters) {
      f.status = winner ? (f === winner ? "winner" : "defeated") : f.isChampion ? "defended" : "defeated";
    }
    const verdict = winner
      ? `🏆 ${winner.spec.name} dethrones ${champion.name}: ${pct(winner.flagsmith!.rate)} vs ${pct(champFighter.flagsmith?.rate ?? 0)} (${pct(winner.flagsmith!.chanceToWin!)} chance to win)`
      : `🛡️ ${champion.name} defends the title: no challenger reached ${pct(winThreshold)} chance to win`;
    bus.phase("verdict", verdict);
    if (results.srmPValue !== null && results.srmPValue < 0.01) bus.log("⚠️ Flagsmith flagged a sample ratio mismatch for this round");

    // 6. End the experiment with Flagsmith's rollout decision.
    const winnerVariant = winner ? feature.variants.find((v) => v.key === winner.key) : undefined;
    await fs.completeExperiment(exp.id, winnerVariant?.id ?? null);
    bus.state.rounds.push({
      generation: gen,
      champion: champion.name,
      winner: (winner ?? champFighter).spec.name,
      winnerRate: (winner ?? champFighter).flagsmith?.rate ?? 0,
      dethroned: !!winner,
      experimentUrl: url,
      spec: (winner ?? champFighter).spec,
    });
    feedback = feedbackFrom(bus.state.fighters);
    if (winner) champion = winner.spec;
    bus.update({});
    await sleep(4000);
  }

  // 7. Ship the champion to the production flag and archive the battle flags.
  const shipOk = await approve(`Ship "${champion.name}" to production`, [
    `Set flag "${PRODUCTION_FLAG}" to the champion page (the live landing page updates instantly, no deploy)`,
    `Archive ${flags.length} generation flags: ${flags.join(", ")} (experiment history stays in Flagsmith)`,
  ]);
  if (shipOk) {
    bus.phase("shipping", `Shipping ${champion.name}…`);
    await fs.shipFlagValue(PRODUCTION_FLAG, JSON.stringify(champion), "Live landing page, owned by Toggle Wars");
    for (const f of flags) await fs.archiveFeature(f).catch((e) => bus.log(`Could not archive ${f}: ${e.message}`));
    bus.phase("done", `👑 ${champion.name} is live on "${PRODUCTION_FLAG}". ${flags.length} battle flags archived.`);
  } else {
    bus.phase("done", `Champion "${champion.name}" not shipped (rejected by the operator).`);
  }
  await sdk.close();
}
