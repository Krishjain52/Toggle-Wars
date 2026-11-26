import { z } from "zod";
import { config } from "./config.js";
import { generateJson } from "./llm.js";
import { PRODUCT } from "./seed.js";
import { VariantSpec } from "./variant.js";

export interface GenerationFeedback {
  /** Conversion rate per fighter name from the last generation. */
  scoreboard: { name: string; conversionRate: number; visitors: number }[];
  /** Short quotes from visitors who did NOT sign up on the champion. */
  objections: string[];
  /** Short quotes from visitors who DID sign up anywhere. */
  praise: string[];
}

const SYSTEM = `You are a conversion-rate designer in a landing-page evolution arena.
You create challenger variants that will compete against the reigning champion in a live A/B test.
Rules:
- Only use the product facts you are given. Never invent numbers, customers, awards or features.
- Each challenger must test ONE clear, different idea (its "strategy"), so results are explainable.
- Mutate from the champion: keep what works, fix what visitors objected to.
- Colours must be valid 6-digit hex with readable contrast between background, text and accent.
- Fighter names are short and punchy, like wrestling personas ("The Straight Shooter").`;

/** Breed `count` challengers from the current champion and the last round's feedback. */
export async function breedChallengers(
  champion: VariantSpec,
  generation: number,
  feedback: GenerationFeedback | null,
  count = config.arena.challengers,
): Promise<VariantSpec[]> {
  const prompt = [
    `PRODUCT: ${PRODUCT.name}: ${PRODUCT.pitch}`,
    `GOAL: ${PRODUCT.goal}`,
    `TRUE FACTS YOU MAY USE:\n${PRODUCT.facts.map((f) => `- ${f}`).join("\n")}`,
    `REIGNING CHAMPION (generation ${generation - 1}):\n${JSON.stringify(champion, null, 2)}`,
    feedback
      ? [
          `LAST ROUND SCOREBOARD:\n${feedback.scoreboard.map((s) => `- ${s.name}: ${(s.conversionRate * 100).toFixed(1)}% of ${s.visitors}`).join("\n")}`,
          `WHY VISITORS LEFT THE CHAMPION:\n${feedback.objections.map((q) => `- "${q}"`).join("\n") || "- (none recorded)"}`,
          `WHAT MADE VISITORS SIGN UP:\n${feedback.praise.map((q) => `- "${q}"`).join("\n") || "- (none recorded)"}`,
        ].join("\n\n")
      : "This is the first generation: no visitor feedback yet.",
    `Create exactly ${count} challengers for generation ${generation}. Make them meaningfully different from each other.`,
  ].join("\n\n");

  const { challengers } = await generateJson({
    model: config.gemini.designerModel,
    system: SYSTEM,
    prompt,
    schema: z.object({ challengers: z.array(VariantSpec).length(count) }),
    temperature: 1,
  });
  // Names must be unique: they become Flagsmith variant keys.
  const seen = new Set([champion.name]);
  return challengers.map((c) => {
    let name = c.name;
    for (let n = 2; seen.has(name); n++) name = `${c.name} ${n}`;
    seen.add(name);
    return { ...c, name };
  });
}
