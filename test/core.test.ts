import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, initialState, newFighter, type Round } from "../src/bus.js";
import { proposeSegments } from "../src/segments.js";
import { GENESIS } from "../src/seed.js";
import { compareAbsolute, fallbackInference, normalCdf } from "../src/stats.js";
import { parseVariant } from "../src/variant.js";

test("normal CDF matches known values", () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(normalCdf(1.959963984540054) - 0.975) < 1e-4);
  assert.ok(Math.abs(normalCdf(-1) - 0.158655) < 1e-4);
});

test("fallback only fills Flagsmith's low-converting-champion gap", () => {
  // Flagsmith would answer itself: champion has ≥ 5 conversions.
  assert.equal(fallbackInference({ visitors: 100, conversions: 6 }, { visitors: 100, conversions: 12 }), null);
  // Too few visitors on either side.
  assert.equal(fallbackInference({ visitors: 40, conversions: 0 }, { visitors: 100, conversions: 12 }), null);
  // Challenger has too few conversions to claim anything.
  assert.equal(fallbackInference({ visitors: 100, conversions: 0 }, { visitors: 100, conversions: 4 }), null);
  // The real case from a run: 2/114 vs 15/95 is decisive.
  const inf = fallbackInference({ visitors: 114, conversions: 2 }, { visitors: 95, conversions: 15 });
  assert.ok(inf && inf.chanceToWin > 0.99);
});

test("two-proportion test is symmetric and calibrated", () => {
  const same = compareAbsolute({ visitors: 200, conversions: 20 }, { visitors: 200, conversions: 20 });
  assert.ok(same.chanceToWin > 0.4 && same.chanceToWin < 0.6);
  const worse = compareAbsolute({ visitors: 200, conversions: 30 }, { visitors: 200, conversions: 10 });
  assert.ok(worse.chanceToWin < 0.01);
});

test("reducer tallies synthetic and human visits separately", () => {
  const s = initialState();
  apply(s, { type: "patch", patch: { fighters: [newFighter("control", GENESIS, true)] } });
  apply(s, { type: "visit", thought: { fighterKey: "control", persona: "cto", personaLabel: "Busy CTO", signup: true, text: "ok" } });
  apply(s, { type: "visit", thought: { fighterKey: "control", persona: "cto", personaLabel: "Busy CTO", signup: false, text: "no" } });
  apply(s, { type: "human", fighterKey: "control", action: "view" });
  apply(s, { type: "human", fighterKey: "control", action: "signup" });
  const f = s.fighters[0]!;
  assert.deepEqual([f.visitors, f.signups], [2, 1]);
  assert.deepEqual(f.byPersona.cto, { visitors: 2, signups: 1 });
  assert.deepEqual(f.humans, { visitors: 1, signups: 1 });
  assert.equal(s.visitSeq, 4);
  assert.deepEqual(s.thoughts.map((t) => t.seq), [1, 2, 3, 4]);
});

test("segments are proposed only with enough evidence", () => {
  const challenger = { ...GENESIS, name: "Free Forever" };
  const round = (champSignups: number, champVisitors: number, chSignups: number, chVisitors: number): Round => ({
    generation: 1, champion: GENESIS.name, winner: GENESIS.name, winnerRate: 0.1, dethroned: false,
    experimentId: 1, experimentUrl: "", spec: GENESIS, parent: GENESIS,
    fighters: [
      { key: "control", name: GENESIS.name, spec: GENESIS, isChampion: true, byPersona: { student: { visitors: champVisitors, signups: champSignups } } },
      { key: "free", name: challenger.name, spec: challenger, isChampion: false, byPersona: { student: { visitors: chVisitors, signups: chSignups } } },
    ],
  });
  // Clear, well-sampled preference → one segment for students.
  const yes = proposeSegments([round(3, 40, 14, 30)], GENESIS);
  assert.equal(yes.length, 1);
  assert.equal(yes[0]!.persona, "student");
  assert.equal(yes[0]!.page.name, "Free Forever");
  // Same rates but too few visitors → nothing.
  assert.equal(proposeSegments([round(1, 12, 5, 10)], GENESIS).length, 0);
  // Well sampled but no real difference → nothing.
  assert.equal(proposeSegments([round(6, 40, 5, 30)], GENESIS).length, 0);
});

test("page specs from the wire are validated", () => {
  assert.equal(parseVariant("not json"), null);
  assert.equal(parseVariant(JSON.stringify({ ...GENESIS, theme: { ...GENESIS.theme, accent: "red" } })), null);
  assert.equal(parseVariant(JSON.stringify(GENESIS))?.name, GENESIS.name);
});
