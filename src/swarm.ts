import type { Flagsmith } from "@flagsmith/nodejs";
import { bus } from "./bus.js";
import { config } from "./config.js";
import { convert, expose } from "./flagsmith/sdk.js";
import { judgeBatch } from "./judge.js";
import { pool } from "./llm.js";
import type { Visitor } from "./personas.js";
import { PRODUCT } from "./seed.js";
import { parseVariant, renderText } from "./variant.js";

/**
 * Send a swarm of synthetic visitors through a live Flagsmith experiment.
 * 1. Flagsmith decides which fighter each visitor sees (exposure recorded).
 * 2. Gemini role-plays the visitor reading that exact page.
 * 3. Sign-ups are sent to Flagsmith as conversion events.
 * The page text comes from the flag value Flagsmith served, not from local state.
 */
export async function runSwarm(sdk: Flagsmith, flagName: string, visitors: Visitor[]) {
  // 1. Exposures: let Flagsmith bucket everyone. Visitors who hit an edge node
  //    that has not seen the experiment yet are retried a few times.
  const enrolled: { visitor: Visitor; exposure: Awaited<ReturnType<typeof expose>> }[] = [];
  let waiting = visitors;
  for (let round = 0; waiting.length && round < 5; round++) {
    if (round) await new Promise((r) => setTimeout(r, 5000));
    const results = await pool(waiting, 10, async (v) => ({ visitor: v, exposure: await expose(sdk, flagName, v.id) }));
    enrolled.push(...results.filter((e) => e.exposure.inExperiment));
    waiting = results.filter((e) => !e.exposure.inExperiment).map((e) => e.visitor);
  }
  bus.log(`Flagsmith enrolled ${enrolled.length}/${visitors.length} visitors in the experiment`);
  if (enrolled.length < visitors.length * 0.5) throw new Error("Most visitors were not enrolled; is the experiment running?");

  // 2. Group by served page, then judge in batches (one LLM call per batch).
  const byKey = new Map<string, { page: string; visitors: Visitor[] }>();
  for (const { visitor, exposure } of enrolled) {
    const spec = parseVariant(exposure.value);
    if (!spec) continue;
    const g = byKey.get(exposure.variantKey) ?? { page: renderText(spec, PRODUCT.name), visitors: [] };
    g.visitors.push(visitor);
    byKey.set(exposure.variantKey, g);
  }
  const batches: { key: string; page: string; visitors: Visitor[] }[] = [];
  for (const [key, g] of byKey) {
    for (let i = 0; i < g.visitors.length; i += config.arena.visitorsPerLlmCall) {
      batches.push({ key, page: g.page, visitors: g.visitors.slice(i, i + config.arena.visitorsPerLlmCall) });
    }
  }
  // Interleave fighters so the arena fills evenly instead of one fighter at a time.
  batches.sort((a, b) => a.visitors[0]!.id.localeCompare(b.visitors[0]!.id));

  // Exposed visitors must all be judged: a skipped batch would count as
  // bounces and unfairly penalise that fighter. Failed batches are retried.
  let pending = batches;
  for (let round = 1; pending.length && round <= 4; round++) {
    if (round > 1) {
      bus.log(`Retrying ${pending.length} visitor batches in 20s (Gemini overloaded)…`);
      await new Promise((r) => setTimeout(r, 20_000));
    }
    const failedBatches: typeof batches = [];
    await pool(pending, config.arena.concurrency, async (batch) => {
      try {
        record(batch, await judgeBatch(batch.page, batch.visitors));
      } catch {
        failedBatches.push(batch);
      }
    });
    pending = failedBatches;
  }
  const failed = pending.reduce((n, b) => n + b.visitors.length, 0);

  function record(batch: (typeof batches)[number], verdicts: Awaited<ReturnType<typeof judgeBatch>>) {
    const fighter = bus.state.fighters.find((f) => f.key === batch.key);
    for (const verdict of verdicts) {
      // 3. Conversions go to Flagsmith; the arena mirrors them live.
      if (verdict.signup) convert(sdk, verdict.visitorId);
      if (fighter) {
        fighter.visitors++;
        if (verdict.signup) fighter.signups++;
      }
      const persona = batch.visitors.find((v) => v.id === verdict.visitorId)?.archetype.label ?? "Visitor";
      bus.thought({ fighterKey: batch.key, persona, signup: verdict.signup, text: verdict.thought });
    }
  }
  await sdk.flushEvents();
  if (failed) bus.log(`⚠️ ${failed} visitors could not be simulated after retries; they count as bounces`);
  return { enrolled: enrolled.length, failed };
}
