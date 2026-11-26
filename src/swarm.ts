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
  // 1. Exposures: let Flagsmith bucket everyone.
  const exposures = await pool(visitors, 10, async (v) => ({ visitor: v, exposure: await expose(sdk, flagName, v.id) }));
  const enrolled = exposures.filter((e) => e.exposure.inExperiment);
  bus.log(`Flagsmith bucketed ${enrolled.length}/${visitors.length} visitors into the experiment`);

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

  let failed = 0;
  await pool(batches, config.arena.concurrency, async (batch) => {
    let verdicts;
    try {
      verdicts = await judgeBatch(batch.page, batch.visitors);
    } catch (e) {
      failed += batch.visitors.length;
      bus.log(`A visitor batch failed (${(e as Error).message.slice(0, 120)}); counted as bounces`);
      return;
    }
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
  });
  await sdk.flushEvents();
  if (failed) bus.log(`${failed} visitors could not be simulated`);
  return { enrolled: enrolled.length, failed };
}
