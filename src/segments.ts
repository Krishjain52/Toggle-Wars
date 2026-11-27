import type { Round, SegmentProposal, Tally } from "./bus.js";
import { ARCHETYPES } from "./personas.js";
import { compareAbsolute } from "./stats.js";
import type { VariantSpec } from "./variant.js";

/**
 * Personalisation discovered by evolution: for each visitor type, is there a
 * page that clearly beats the overall champion *for that type*? If so, propose
 * a Flagsmith segment (trait visitor_type == <type>) with a segment override on
 * the production flag. Conservative on purpose: ≥ 30 champion and ≥ 20
 * challenger visitors of that type, ≥ 5 sign-ups, and ≥ 90% chance to win.
 */
const MIN_CHAMPION_VISITORS = 30;
const MIN_CHALLENGER_VISITORS = 20;
const MIN_CHANCE = 0.9;
const MAX_SEGMENTS = 3;

export const segmentName = (persona: string) => `toggle-wars-${persona}`;

export function proposeSegments(rounds: Round[], champion: VariantSpec): SegmentProposal[] {
  // Pool each page's per-persona tallies across every round it fought.
  const pages = new Map<string, { spec: VariantSpec; byPersona: Record<string, Tally> }>();
  for (const r of rounds) {
    for (const f of r.fighters) {
      if (!f.spec) continue;
      let p = pages.get(f.name);
      if (!p) pages.set(f.name, (p = { spec: f.spec, byPersona: {} }));
      for (const [persona, t] of Object.entries(f.byPersona)) {
        const acc = (p.byPersona[persona] ??= { visitors: 0, signups: 0 });
        acc.visitors += t.visitors;
        acc.signups += t.signups;
      }
    }
  }
  const champ = pages.get(champion.name);
  if (!champ) return [];

  const proposals: SegmentProposal[] = [];
  for (const a of ARCHETYPES) {
    const c = champ.byPersona[a.id];
    if (!c || c.visitors < MIN_CHAMPION_VISITORS) continue;
    let best: SegmentProposal | null = null;
    for (const [name, p] of pages) {
      if (name === champion.name) continue;
      const t = p.byPersona[a.id];
      if (!t || t.visitors < MIN_CHALLENGER_VISITORS || t.signups < 5) continue;
      const inf = compareAbsolute({ visitors: c.visitors, conversions: c.signups }, { visitors: t.visitors, conversions: t.signups });
      if (inf.chanceToWin < MIN_CHANCE) continue;
      const rate = t.signups / t.visitors;
      if (!best || rate > best.pageRate) {
        best = {
          persona: a.id,
          label: a.label,
          page: p.spec,
          pageRate: rate,
          pageN: `${t.signups}/${t.visitors}`,
          championRate: c.signups / c.visitors,
          championN: `${c.signups}/${c.visitors}`,
          chanceToWin: inf.chanceToWin,
          segment: segmentName(a.id),
        };
      }
    }
    if (best) proposals.push(best);
  }
  return proposals.sort((x, y) => y.pageRate - y.championRate - (x.pageRate - x.championRate)).slice(0, MAX_SEGMENTS);
}

/** The segment rule: identities whose visitor_type trait equals the persona id. */
export const segmentRules = (persona: string) => ({
  type: "ALL",
  rules: [{ type: "ANY", conditions: [{ property: "visitor_type", operator: "EQUAL", value: persona }] }],
});
