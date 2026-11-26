import { z } from "zod";
import { config } from "./config.js";
import { generateJson } from "./llm.js";
import { rng, type Visitor } from "./personas.js";
import { PRODUCT } from "./seed.js";

export interface Verdict {
  visitorId: string;
  signup: boolean;
  /** 0-100: the model's estimate of how likely this visitor is to start a trial. */
  likelihood: number;
  /** One short first-person sentence, shown in the arena. */
  thought: string;
}

const SYSTEM = `You simulate real website visitors deciding whether to start a free trial.
Stay in character for each visitor and judge only what is on the page.
For each visitor, estimate "likelihood": the percentage chance (0-100) that THIS person starts a trial from THIS page.
Be calibrated like real web traffic: most visitors to most landing pages do not convert.
- 0-3: page is irrelevant, confusing or off-putting to this person
- 4-12: typical; mildly interested
- 13-30: strong fit; the page answers their key question
- above 30: rare; the page is exactly what they were searching for
"thought" is one short first-person sentence (max 15 words) explaining their reaction.`;

const Verdicts = z.object({
  verdicts: z.array(z.object({
    id: z.string(),
    likelihood: z.number().min(0).max(100),
    thought: z.string().max(140),
  })),
});

/** Stable per-visitor random draw, so a run with the same seed replays identically. */
function draw(visitorId: string): number {
  let h = config.arena.seed;
  for (const c of visitorId) h = Math.imul(h ^ c.charCodeAt(0), 2654435761);
  return rng(h)();
}

/**
 * Ask the model how a batch of visitors reacts to ONE page. The model gives a
 * calibrated likelihood; a seeded draw turns it into the actual decision, which
 * keeps conversion rates realistic and outcomes naturally noisy.
 */
export async function judgeBatch(
  pageText: string,
  visitors: Visitor[],
  models: string[] = config.gemini.visitorModels,
): Promise<Verdict[]> {
  const prompt = [
    `PRODUCT: ${PRODUCT.name}`,
    `THE PAGE EACH VISITOR SEES:\n"""\n${pageText}\n"""`,
    `VISITORS:\n${visitors.map((v) => `- id=${v.id} | ${v.archetype.label}: ${v.archetype.description} | right now: ${v.mood}`).join("\n")}`,
    `Return one verdict per visitor id, in the same order.`,
  ].join("\n\n");

  const { verdicts } = await generateJson({
    models,
    system: SYSTEM,
    prompt,
    schema: Verdicts,
    temperature: 0.8,
  });
  const byId = new Map(verdicts.map((v) => [v.id, v]));
  return visitors.map((v) => {
    const r = byId.get(v.id);
    // A visitor the model skipped counts as a bounce, never as a conversion.
    const likelihood = r?.likelihood ?? 0;
    return { visitorId: v.id, likelihood, signup: draw(v.id) * 100 < likelihood, thought: r?.thought ?? "…" };
  });
}
