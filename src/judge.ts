import { z } from "zod";
import { config } from "./config.js";
import { generateJson } from "./llm.js";
import type { Visitor } from "./personas.js";
import { PRODUCT } from "./seed.js";

export interface Verdict {
  visitorId: string;
  signup: boolean;
  /** One short first-person sentence, shown in the arena. */
  thought: string;
}

const SYSTEM = `You simulate real website visitors deciding whether to start a free trial.
Stay in character for each visitor. Be realistic and demanding: most visitors to most landing pages do NOT sign up
(typical conversion is 2-15%). Only sign up when the page clearly speaks to that visitor's needs.
Judge only what is on the page. Each "thought" is one short first-person sentence (max 15 words).`;

const Verdicts = z.object({
  verdicts: z.array(z.object({ id: z.string(), signup: z.boolean(), thought: z.string().max(140) })),
});

/** Ask the model how a batch of visitors reacts to ONE page. */
export async function judgeBatch(pageText: string, visitors: Visitor[]): Promise<Verdict[]> {
  const prompt = [
    `PRODUCT: ${PRODUCT.name}`,
    `THE PAGE EACH VISITOR SEES:\n"""\n${pageText}\n"""`,
    `VISITORS:\n${visitors.map((v) => `- id=${v.id} | ${v.archetype.label}: ${v.archetype.description} | right now: ${v.mood}`).join("\n")}`,
    `Return one verdict per visitor id, in the same order.`,
  ].join("\n\n");

  const { verdicts } = await generateJson({
    model: config.gemini.visitorModel,
    system: SYSTEM,
    prompt,
    schema: Verdicts,
    temperature: 0.8,
  });
  const byId = new Map(verdicts.map((v) => [v.id, v]));
  // A visitor the model skipped counts as a bounce, never as a conversion.
  return visitors.map((v) => {
    const r = byId.get(v.id);
    return { visitorId: v.id, signup: r?.signup ?? false, thought: r?.thought ?? "…" };
  });
}
