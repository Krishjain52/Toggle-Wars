/**
 * Offline analysis of a recorded run: rebuilds its final state through the
 * same reducer, then prints the persona matrix and segment proposals.
 * Usage: tsx src/tools/analyse-run.ts runs/<id>.jsonl
 */
import { apply, initialState, type ArenaEvent } from "../bus.js";
import { loadRun } from "../replay.js";
import { proposeSegments } from "../segments.js";
import type { VariantSpec } from "../variant.js";

const file = process.argv[2];
if (!file) throw new Error("usage: analyse-run.ts <run.jsonl>");
const state = initialState();
const specs = new Map<string, VariantSpec>();
for (const { t: _t, endsInMs: _e, ...e } of loadRun(file)) {
  apply(state, e as ArenaEvent);
  for (const f of state.fighters) specs.set(f.spec.name, f.spec);
}
// Older recordings lack per-fighter specs in rounds: fill them from the fighters seen.
for (const r of state.rounds) for (const f of r.fighters) f.spec ??= specs.get(f.name);

console.log("Rounds:");
for (const r of state.rounds) {
  console.log(`  Gen ${r.generation}: ${r.fighters.map((f) => `${f.name}${f.isChampion ? "*" : ""} ${f.flagsmith?.conversions}/${f.flagsmith?.visitors}`).join(" | ")}`);
}
const champion = state.rounds[state.rounds.length - 1]!.spec;
console.log(`\nChampion: ${champion.name}\nSegment proposals:`);
const proposals = proposeSegments(state.rounds, champion);
for (const p of proposals) console.log(`  ${p.label}: "${p.page.name}" ${p.pageN} vs champion ${p.championN} → ${(p.chanceToWin * 100).toFixed(1)}%`);
if (!proposals.length) console.log("  (none qualify)");
