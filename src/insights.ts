import { z } from "zod";
import type { Insights, Round, Tally } from "./bus.js";
import { config } from "./config.js";
import { generateJson } from "./llm.js";
import { ARCHETYPES } from "./personas.js";
import { PRODUCT } from "./seed.js";

/** Smallest persona × page sample we are willing to quote. */
const MIN_SEGMENT = 15;

/**
 * Turn a finished run into what a team actually wants to know: which message
 * works for which kind of visitor. The per-persona matrix is computed from the
 * recorded tallies; Gemini only phrases the findings (and the run still ends
 * with plain computed findings if Gemini is unavailable).
 */
export function personaMatrix(rounds: Round[]) {
  // Aggregate every page that fought, across generations, by persona.
  const pages = new Map<string, Record<string, Tally>>();
  for (const r of rounds) {
    for (const f of r.fighters) {
      let acc = pages.get(f.name);
      if (!acc) pages.set(f.name, (acc = {}));
      for (const [p, t] of Object.entries(f.byPersona)) {
        const a = (acc[p] ??= { visitors: 0, signups: 0 });
        a.visitors += t.visitors;
        a.signups += t.signups;
      }
    }
  }
  return ARCHETYPES.map((a) => {
    let best = { fighter: "-", rate: 0, visitors: 0, signups: 0 };
    for (const [name, byP] of pages) {
      const t = byP[a.id];
      if (!t || t.visitors < MIN_SEGMENT) continue; // too few to call
      const rate = t.signups / t.visitors;
      if (rate > best.rate) best = { fighter: name, rate, visitors: t.visitors, signups: t.signups };
    }
    return { persona: a.id, label: a.label, bestFighter: best.fighter, rate: best.rate, signups: best.signups, visitors: best.visitors };
  });
}

export async function buildInsights(rounds: Round[]): Promise<Insights> {
  const perPersona = personaMatrix(rounds);
  const first = rounds[0];
  const last = rounds[rounds.length - 1];
  const genesis = first?.fighters.find((f) => f.isChampion)?.flagsmith;
  // The final champion's rate pooled over every round it fought (Flagsmith counts).
  const pooled = { conversions: 0, visitors: 0 };
  for (const r of rounds) {
    const f = r.fighters.find((x) => x.name === last?.winner)?.flagsmith;
    if (f) { pooled.conversions += f.conversions; pooled.visitors += f.visitors; }
  }
  const fmt = (c: number, v: number) => `${((c / Math.max(1, v)) * 100).toFixed(1)}%`;
  const headline = genesis && last
    ? `${PRODUCT.name}: ${fmt(genesis.conversions, genesis.visitors)} → ${fmt(pooled.conversions, pooled.visitors)} sign-ups. "${last.winner}" is the champion after ${rounds.length} generations (${pooled.conversions}/${pooled.visitors} across its rounds).`
    : `${PRODUCT.name}: ${rounds.length} generations of evolution`;

  const table = rounds
    .map((r) => `Gen ${r.generation}: ${r.fighters.map((f) => `${f.name}${f.isChampion ? " (champion)" : ""} ${f.flagsmith ? `${f.flagsmith.conversions}/${f.flagsmith.visitors}` : "n/a"}`).join("; ")} → ${r.dethroned ? `${r.winner} won` : `${r.champion} defended`}`)
    .join("\n");
  const personas = perPersona
    .map((p) => (p.bestFighter === "-" ? `${p.label}: not enough visitors to call` : `${p.label}: best = ${p.bestFighter}, ${p.signups}/${p.visitors} (${(p.rate * 100).toFixed(0)}%)`))
    .join("\n");
  const strategies = rounds.flatMap((r) => [`${r.spec.name}: ${r.spec.strategy}`]).join("\n");

  try {
    const { findings } = await generateJson({
      models: config.gemini.designerModels,
      system: "You are a growth analyst writing the conclusions of an A/B testing tournament for a product team. Be specific and cite numbers WITH their sample sizes (e.g. 12/40). Never invent data, never overstate small samples, and treat synthetic-visitor results as a pre-test to confirm with real users. Each finding is one sentence, max 32 words.",
      prompt: `PRODUCT: ${PRODUCT.name}: ${PRODUCT.pitch}\n\nRESULTS BY GENERATION (conversions/visitors):\n${table}\n\nBEST PAGE PER VISITOR TYPE:\n${personas}\n\nWINNING STRATEGIES:\n${strategies}\n\nWrite 4 findings: what message won overall, which visitor segments responded to what, what consistently failed, and one concrete next experiment to run on real users.`,
      schema: z.object({ findings: z.array(z.string().max(260)).min(3).max(5) }),
      temperature: 0.4,
      timeoutMs: 90_000,
    });
    return { headline, findings, perPersona };
  } catch {
    const findings = perPersona
      .filter((p) => p.bestFighter !== "-")
      .slice(0, 4)
      .map((p) => `${p.label}s converted best on "${p.bestFighter}" (${p.signups}/${p.visitors}).`);
    return { headline, findings, perPersona };
  }
}
