import type { Flagsmith } from "@flagsmith/nodejs";
import { bus } from "./bus.js";
import { config } from "./config.js";
import { convert, expose } from "./flagsmith/sdk.js";
import { judgeBatch } from "./judge.js";
import { healthiest, pool } from "./llm.js";
import type { Visitor } from "./personas.js";
import { PRODUCT } from "./seed.js";
import { parseVariant, renderText } from "./variant.js";
import { screenshot } from "./vision.js";

/**
 * Send a swarm of synthetic visitors through a live Flagsmith experiment.
 * 1. Flagsmith decides which fighter each visitor sees (exposure recorded).
 * 2. Gemini role-plays the visitor looking at that exact page (a screenshot
 *    rendered in a real browser, plus its text).
 * 3. Sign-ups are sent to Flagsmith as conversion events.
 * The page comes from the flag value Flagsmith served, not from local state.
 */
export async function runSwarm(sdk: Flagsmith, flagName: string, visitors: Visitor[]) {
  // 1. Exposures: let Flagsmith bucket everyone. Visitors who hit an edge node
  //    that has not seen the experiment yet are retried a few times.
  const enrolled: { visitor: Visitor; exposure: Awaited<ReturnType<typeof expose>> }[] = [];
  let waiting = visitors;
  for (let round = 0; waiting.length && round < 5; round++) {
    if (round) await new Promise((r) => setTimeout(r, 5000));
    const results = await pool(waiting, 10, async (v) => ({ visitor: v, exposure: await expose(sdk, flagName, v.id, { visitor_type: v.archetype.id }) }));
    enrolled.push(...results.filter((e) => e.exposure.inExperiment));
    waiting = results.filter((e) => !e.exposure.inExperiment).map((e) => e.visitor);
  }
  bus.log(`Flagsmith enrolled ${enrolled.length}/${visitors.length} visitors in the experiment`);
  if (enrolled.length < visitors.length * 0.5) throw new Error("Most visitors were not enrolled; is the experiment running?");

  // 2. Group by the page Flagsmith served, render each page once.
  const byKey = new Map<string, { text: string; screenshot: string | null; visitors: Visitor[] }>();
  for (const { visitor, exposure } of enrolled) {
    let g = byKey.get(exposure.variantKey);
    if (!g) {
      const spec = parseVariant(exposure.value);
      if (!spec) continue;
      const shot = await screenshot(spec).catch((e) => {
        bus.log(`Screenshot failed (${(e as Error).message.slice(0, 80)}); judging text only`);
        return null;
      });
      g = { text: renderText(spec, PRODUCT.name), screenshot: shot, visitors: [] };
      byKey.set(exposure.variantKey, g);
    }
    g.visitors.push(visitor);
  }
  const vision = [...byKey.values()].every((g) => g.screenshot);
  bus.update({ vision });
  if (vision) bus.log("👁️ Visitors are judging real screenshots of each page");

  // One LLM call judges a batch of visitors on one page. Batches are
  // interleaved so every fighter fills up at the same pace in the arena.
  type Batch = { key: string; page: { text: string; screenshot: string | null }; visitors: Visitor[] };
  const perKey: Batch[][] = [...byKey].map(([key, g]) => {
    const out: Batch[] = [];
    for (let i = 0; i < g.visitors.length; i += config.arena.visitorsPerLlmCall) {
      out.push({ key, page: g, visitors: g.visitors.slice(i, i + config.arena.visitorsPerLlmCall) });
    }
    return out;
  });
  const batches: Batch[] = [];
  for (let i = 0; perKey.some((l) => i < l.length); i++) for (const l of perKey) if (l[i]) batches.push(l[i]!);

  // Fairness: one model judges every fighter in a generation, so no fighter is
  // scored by a more generous model. Only after three failed rounds on that
  // model do the remaining batches fall back to the full chain (and say so).
  // Every exposed visitor must be judged: a skipped batch would count as
  // bounces and unfairly penalise that fighter, so failed batches are retried.
  const judgeModel = healthiest(config.gemini.visitorModels);
  bus.update({ judgeModel });
  bus.log(`All visitors this generation are judged by ${judgeModel}`);
  let pending = batches;
  for (let round = 1; pending.length && round <= 4; round++) {
    const models = round < 4 ? [judgeModel] : config.gemini.visitorModels;
    if (round > 1) {
      bus.log(`Retrying ${pending.length} visitor batches in 20s (Gemini overloaded)…`);
      await new Promise((r) => setTimeout(r, 20_000));
    }
    if (round === 4) bus.log(`⚠️ ${judgeModel} stayed overloaded; ${pending.length} batches fall back to other models`);
    const failed: Batch[] = [];
    await pool(pending, config.arena.concurrency, async (batch) => {
      try {
        const verdicts = await judgeBatch(batch.page, batch.visitors, models);
        for (const v of verdicts) {
          // 3. Conversions go to Flagsmith; the arena mirrors them live.
          if (v.signup) convert(sdk, v.visitorId);
          const who = batch.visitors.find((x) => x.id === v.visitorId)!;
          bus.visit({
            fighterKey: batch.key,
            persona: who.archetype.id,
            personaLabel: who.archetype.label,
            signup: v.signup,
            text: v.thought,
            likelihood: v.likelihood,
          });
        }
      } catch {
        failed.push(batch);
      }
    });
    pending = failed;
  }
  await sdk.flushEvents();
  const lost = pending.reduce((n, b) => n + b.visitors.length, 0);
  if (lost) bus.log(`⚠️ ${lost} visitors could not be simulated after retries; they count as bounces`);
  return { enrolled: enrolled.length, failed: lost };
}
