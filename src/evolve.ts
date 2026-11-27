import { approve } from "./approval.js";
import { bus, newFighter, type Fighter, type Round } from "./bus.js";
import { config } from "./config.js";
import { breedChallengers, type GenerationFeedback } from "./designer.js";
import * as fs from "./flagsmith/admin.js";
import { createSdk, SIGNUP_EVENT, waitUntilLive } from "./flagsmith/sdk.js";
import { buildInsights } from "./insights.js";
import { ARCHETYPES, spawnVisitors } from "./personas.js";
import { GENESIS, PRODUCT } from "./seed.js";
import { fallbackInference } from "./stats.js";
import { runSwarm } from "./swarm.js";
import type { VariantSpec } from "./variant.js";
import { closeVision } from "./vision.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "fighter";

/** The production flag the real landing page reads. The champion ships here. */
export const PRODUCTION_FLAG = "landing_page";

/** Retry a whole step when every model is overloaded, rather than failing the run. */
async function patiently<T>(what: string, fn: () => Promise<T>, tries = 6): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries) throw e;
      bus.log(`Gemini is overloaded while ${what}; retrying in 30s (attempt ${i + 1}/${tries})`);
      await sleep(30_000);
    }
  }
}

/**
 * Wait for Flagsmith to ingest the swarm's events and compute Bayesian results.
 * Refreshes are rate-limited to one per 5 minutes, so we refresh, poll, and
 * only refresh again once the window has passed and the counts are still short.
 */
async function awaitResults(expId: number, metricId: number, expected: number) {
  const REFRESH_EVERY = 5 * 60_000 + 5_000;
  const INGEST_MS = 75_000;
  const deadline = Date.now() + 20 * 60_000;
  bus.phase("analysing", "Flagsmith is ingesting the battle's events…", Date.now() + INGEST_MS);
  await sleep(INGEST_MS);
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

/** What the designer learns from a finished round. */
function feedbackFrom(fighters: Fighter[]): GenerationFeedback {
  const thoughts = bus.state.thoughts;
  const champ = fighters.find((f) => f.isChampion);
  const segments = champ
    ? ARCHETYPES.map((a) => {
        const t = champ.byPersona[a.id];
        return t?.visitors ? `${a.label}: ${t.signups}/${t.visitors} signed up` : null;
      }).filter((x): x is string => !!x)
    : [];
  return {
    scoreboard: fighters.map((f) => ({
      name: f.spec.name,
      conversionRate: f.flagsmith?.rate ?? (f.visitors ? f.signups / f.visitors : 0),
      visitors: f.flagsmith?.visitors ?? f.visitors,
    })),
    objections: thoughts.filter((t) => t.fighterKey === champ?.key && !t.signup).slice(-14).map((t) => `${t.personaLabel}: ${t.text}`),
    praise: thoughts.filter((t) => t.signup).slice(-8).map((t) => `${t.personaLabel}: ${t.text}`),
    segments,
  };
}

export async function runArena() {
  const runId = `r${Date.now().toString(36).slice(-5)}`;
  const { generations, visitorsPerGeneration, winThreshold, seed } = config.arena;
  const sdk = createSdk();
  bus.reset({ runId, product: PRODUCT.name, goal: PRODUCT.goal, totalGenerations: generations });
  bus.record(runId);
  try {
    const project = await fs.projectId();
    bus.log(`Run ${runId}: evolving the ${PRODUCT.name} landing page over ${generations} generations`);

    const metric = await fs.ensureMetric("Arena sign-ups", SIGNUP_EVENT);
    let champion: VariantSpec = GENESIS;
    let feedback: GenerationFeedback | null = null;
    const flags: string[] = [];

    for (let gen = 1; gen <= generations; gen++) {
      bus.update({ generation: gen, fighters: [], thoughts: [], flagName: null, experimentId: null, experimentUrl: null });

      // 1. Breed challengers from the champion and last round's visitor feedback.
      bus.phase("breeding", `Generation ${gen}: Gemini is designing challengers for "${champion.name}"…`);
      const challengers = await patiently("designing challengers", () => breedChallengers(champion, gen, feedback));
      const used = new Set(["control"]);
      const keyed = challengers.map((spec) => {
        let key = slug(spec.name);
        while (used.has(key)) key += "_x";
        used.add(key);
        return { key, spec };
      });
      bus.update({ fighters: [newFighter("control", champion, true), ...keyed.map(({ key, spec }) => newFighter(key, spec, false))] });

      // 2. Human approval before anything touches Flagsmith, showing the exact commands.
      const flagName = `arena_${runId}_g${gen}`;
      const ok = await approve(
        `Launch generation ${gen} in Flagsmith`,
        [
          `Multivariate flag "${flagName}": the champion "${champion.name}" is control, ${keyed.length} challengers are variants`,
          `Experiment on "${SIGNUP_EVENT}", traffic split evenly across ${keyed.length + 1} fighters`,
          `${visitorsPerGeneration} synthetic visitors, plus any real people who join from the QR code`,
        ],
        {
          commands: [
            `flagsmith feature create ${flagName} --value <champion page JSON> --enabled`,
            ...keyed.map(({ key }) => `flagsmith feature variant add ${flagName} --key ${key} --value <page JSON> --weight 0`),
            `flagsmith api api/v1/environments/<env>/experiments/ -X POST --input <experiment>`,
            `flagsmith api api/v1/environments/<env>/experiments/<id>/start/ -X POST`,
          ],
          previews: keyed.map((k) => k.spec),
        },
      );
      if (!ok) {
        bus.phase("done", "Run stopped by the operator. Nothing was changed in Flagsmith for this generation.");
        return;
      }

      // 3. Deploy: flag + experiment, all through the Flagsmith CLI.
      bus.phase("deploying", `Creating flag ${flagName} and its experiment through the Flagsmith CLI…`);
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
      bus.update({ flagName, experimentId: exp.id, experimentUrl: url });
      bus.log(`Experiment ${exp.id} is running: ${url}`);

      // 4. Battle: synthetic visitors (and any real people) flow through the live experiment.
      bus.phase("battling", `${visitorsPerGeneration} visitors are entering the arena…`);
      const visitors = spawnVisitors(visitorsPerGeneration, runId, gen, seed);
      const { enrolled } = await runSwarm(sdk, flagName, visitors);
      const humans = bus.state.fighters.reduce((n, f) => n + f.humans.visitors, 0);

      // 5. Flagsmith decides.
      const results = await awaitResults(exp.id, metric.id, enrolled + humans);
      for (const f of bus.state.fighters) {
        const r = results.variants.find((v) => v.key === f.key);
        if (r) bus.fighter(f.key, { flagsmith: { visitors: r.visitors, conversions: r.conversions, rate: r.rate, chanceToWin: r.chanceToWin, lift: r.lift, source: "flagsmith" } });
      }
      // Flagsmith withholds inference when an arm has < 5 conversions. If only the
      // champion is short, fall back to a two-proportion test on Flagsmith's counts.
      const champStats = bus.state.fighters.find((f) => f.isChampion)?.flagsmith;
      for (const f of bus.state.fighters) {
        if (f.isChampion || !f.flagsmith || f.flagsmith.chanceToWin !== null || !champStats) continue;
        const inf = fallbackInference(champStats, f.flagsmith);
        if (!inf) continue;
        bus.fighter(f.key, { flagsmith: { ...f.flagsmith, chanceToWin: inf.chanceToWin, source: "fallback" } });
        bus.log(`Champion had too few conversions for Flagsmith inference; ${f.spec.name}: ${pct(inf.chanceToWin)} chance to win (two-proportion test on Flagsmith's counts)`);
      }
      const contenders = bus.state.fighters
        .filter((f) => !f.isChampion && (f.flagsmith?.chanceToWin ?? 0) >= winThreshold)
        .sort((a, b) => b.flagsmith!.rate - a.flagsmith!.rate);
      const winner = contenders[0] ?? null;
      const champFighter = bus.state.fighters.find((f) => f.isChampion)!;
      for (const f of bus.state.fighters) {
        bus.fighter(f.key, { status: winner ? (f === winner ? "winner" : "defeated") : f.isChampion ? "defended" : "defeated" });
      }
      const verdict = winner
        ? `🏆 ${winner.spec.name} dethrones ${champion.name}: ${pct(winner.flagsmith!.rate)} vs ${pct(champFighter.flagsmith?.rate ?? 0)} (${pct(winner.flagsmith!.chanceToWin!)} chance to win)`
        : `🛡️ ${champion.name} defends the title: no challenger reached ${pct(winThreshold)} chance to win`;
      bus.phase("verdict", verdict);
      if (results.srmPValue !== null && results.srmPValue < 0.01) bus.log("⚠️ Flagsmith flagged a sample ratio mismatch for this round");

      // 6. End the experiment with Flagsmith's rollout decision.
      const winnerVariant = winner ? feature.variants.find((v) => v.key === winner.key) : undefined;
      await fs.completeExperiment(exp.id, winnerVariant?.id ?? null);
      const crowned = winner ?? champFighter;
      const round: Round = {
        generation: gen,
        champion: champion.name,
        winner: crowned.spec.name,
        winnerRate: crowned.flagsmith?.rate ?? 0,
        dethroned: !!winner,
        experimentId: exp.id,
        experimentUrl: url,
        spec: crowned.spec,
        parent: champion,
        fighters: bus.state.fighters.map((f) => ({ key: f.key, name: f.spec.name, isChampion: f.isChampion, flagsmith: f.flagsmith, byPersona: f.byPersona })),
      };
      bus.update({ rounds: [...bus.state.rounds, round] });
      feedback = feedbackFrom(bus.state.fighters);
      if (winner) champion = winner.spec;
      await sleep(5000);
    }

    // 7. What did we learn?
    bus.phase("shipping", "Writing the insights report…");
    bus.update({ insights: await buildInsights(bus.state.rounds) });

    // 8. Ship the champion to the production flag and archive the battle flags.
    const shipOk = await approve(
      `Ship "${champion.name}" to production`,
      [
        `Set flag "${PRODUCTION_FLAG}" to the champion page: the live landing page changes instantly, no deploy`,
        `Archive ${flags.length} battle flags (their experiments stay browsable in Flagsmith)`,
      ],
      {
        commands: [
          `flagsmith flag update ${PRODUCTION_FLAG} --value <champion page JSON> --type string --enable`,
          ...flags.map((f) => `flagsmith feature update ${f} --archive`),
        ],
        previews: [champion],
      },
    );
    if (shipOk) {
      bus.phase("shipping", `Shipping ${champion.name}…`);
      await fs.shipFlagValue(PRODUCTION_FLAG, JSON.stringify(champion), "Live landing page, owned by Toggle Wars");
      for (const f of flags) await fs.archiveFeature(f).catch((e) => bus.log(`Could not archive ${f}: ${e.message}`));
      bus.phase("done", `👑 ${champion.name} is live on "${PRODUCTION_FLAG}". ${flags.length} battle flags archived.`);
    } else {
      bus.phase("done", `Champion "${champion.name}" not shipped (rejected by the operator).`);
    }
  } catch (e) {
    bus.phase("error", `Run failed: ${(e as Error).message}`);
    throw e;
  } finally {
    bus.stopRecording();
    await sdk.close().catch(() => {});
    await closeVision();
  }
}
