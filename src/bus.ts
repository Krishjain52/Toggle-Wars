import { EventEmitter } from "node:events";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import type { VariantSpec } from "./variant.js";

/**
 * Event-sourced arena state. Every change is an ArenaEvent applied by one
 * reducer, so the same stream drives the live arena, the run recording
 * (runs/*.jsonl) and replays.
 */

export interface Tally {
  visitors: number;
  signups: number;
}

export interface FlagsmithStats {
  visitors: number;
  conversions: number;
  rate: number;
  chanceToWin: number | null;
  lift: number | null;
  /** "flagsmith" = Flagsmith's own inference; "fallback" = two-proportion test on Flagsmith's counts. */
  source: "flagsmith" | "fallback";
}

export interface Fighter {
  key: string; // Flagsmith variant key ("control" = champion)
  spec: VariantSpec;
  isChampion: boolean;
  /** Synthetic visitor tallies, live from the swarm. */
  visitors: number;
  signups: number;
  /** Tallies per visitor archetype id. */
  byPersona: Record<string, Tally>;
  /** Real people who joined through the /play page. */
  humans: Tally;
  flagsmith?: FlagsmithStats;
  status: "fighting" | "winner" | "defeated" | "defended";
}

export interface Thought {
  fighterKey: string;
  persona: string; // archetype id, or "human"
  personaLabel: string;
  signup: boolean;
  text: string;
  likelihood?: number;
  /** Monotonic visit number, so the arena can animate exactly the new arrivals. */
  seq?: number;
}

export interface Round {
  generation: number;
  champion: string;
  winner: string;
  winnerRate: number;
  dethroned: boolean;
  experimentId: number;
  experimentUrl: string;
  spec: VariantSpec;
  parent: VariantSpec;
  /** Every fighter's final numbers, for the insights matrix. */
  fighters: { key: string; name: string; isChampion: boolean; flagsmith?: FlagsmithStats; byPersona: Record<string, Tally> }[];
}

export interface Insights {
  headline: string;
  findings: string[];
  perPersona: { persona: string; label: string; bestFighter: string; rate: number }[];
}

export type Phase =
  | "idle" | "breeding" | "awaiting-approval" | "deploying" | "battling"
  | "analysing" | "verdict" | "shipping" | "done" | "error";

export interface ArenaState {
  runId: string | null;
  replay: boolean;
  product: string;
  goal: string;
  generation: number;
  totalGenerations: number;
  phase: Phase;
  phaseDetail: string;
  /** Epoch ms the current wait is expected to end, for countdowns. */
  phaseEndsAt: number | null;
  flagName: string | null;
  experimentId: number | null;
  experimentUrl: string | null;
  judgeModel: string | null;
  vision: boolean;
  fighters: Fighter[];
  thoughts: Thought[];
  rounds: Round[];
  approval: { id: string; title: string; details: string[]; commands: string[]; previews?: VariantSpec[] } | null;
  insights: Insights | null;
  log: { at: string; text: string }[];
  /** Count of every visit event so far (synthetic and human). */
  visitSeq: number;
}

export type ArenaEvent =
  | { type: "patch"; patch: Partial<ArenaState> }
  | { type: "phase"; phase: Phase; detail: string; endsAt?: number | null }
  | { type: "log"; text: string }
  | { type: "visit"; thought: Thought }
  | { type: "fighter"; key: string; patch: Partial<Fighter> }
  /** A real person on the /play page saw a fighter, or signed up on it. */
  | { type: "human"; fighterKey: string; action: "view" | "signup" };

export const initialState = (): ArenaState => ({
  runId: null, replay: false, product: "", goal: "", generation: 0, totalGenerations: 0,
  phase: "idle", phaseDetail: "", phaseEndsAt: null, flagName: null, experimentId: null,
  experimentUrl: null, judgeModel: null, vision: false, fighters: [], thoughts: [], rounds: [],
  approval: null, insights: null, log: [], visitSeq: 0,
});

/** The one reducer. Mutates in place for speed (the swarm emits hundreds of events). */
export function apply(s: ArenaState, e: ArenaEvent, at = new Date().toISOString()): void {
  switch (e.type) {
    case "patch":
      Object.assign(s, e.patch);
      break;
    case "phase":
      s.phase = e.phase;
      s.phaseDetail = e.detail;
      s.phaseEndsAt = e.endsAt ?? null;
      if (e.detail) s.log = [...s.log.slice(-199), { at, text: e.detail }];
      break;
    case "log":
      s.log = [...s.log.slice(-199), { at, text: e.text }];
      break;
    case "visit": {
      const t = { ...e.thought, seq: ++s.visitSeq };
      s.thoughts = [...s.thoughts.slice(-79), t];
      const f = s.fighters.find((x) => x.key === t.fighterKey);
      if (!f) break;
      if (t.persona === "human") {
        f.humans.visitors++;
        if (t.signup) f.humans.signups++;
      } else {
        f.visitors++;
        if (t.signup) f.signups++;
        const p = (f.byPersona[t.persona] ??= { visitors: 0, signups: 0 });
        p.visitors++;
        if (t.signup) p.signups++;
      }
      break;
    }
    case "human": {
      const f = s.fighters.find((x) => x.key === e.fighterKey);
      if (!f) break;
      if (e.action === "view") f.humans.visitors++;
      else f.humans.signups++;
      s.thoughts = [...s.thoughts.slice(-79), {
        seq: ++s.visitSeq, fighterKey: e.fighterKey, persona: "human", personaLabel: "Real human", signup: e.action === "signup",
        text: e.action === "view" ? "A real person just landed on this page." : "A real person clicked sign up!",
      }];
      break;
    }
    case "fighter": {
      const f = s.fighters.find((x) => x.key === e.key);
      if (f) Object.assign(f, e.patch);
      break;
    }
  }
}

class Bus extends EventEmitter {
  state: ArenaState = initialState();
  private recorder: WriteStream | null = null;
  private startedAt = 0;

  /** Start recording every event of a run to runs/<runId>.jsonl. */
  record(runId: string) {
    mkdirSync("runs", { recursive: true });
    this.recorder?.end();
    this.recorder = createWriteStream(`runs/${runId}.jsonl`);
    this.startedAt = Date.now();
    // A snapshot first, so a replay starts from the same state.
    this.recorder.write(JSON.stringify({ t: 0, type: "patch", patch: { ...this.state, approval: null } }) + "\n");
  }

  stopRecording() {
    this.recorder?.end();
    this.recorder = null;
  }

  emitEvent(e: ArenaEvent) {
    apply(this.state, e);
    if (this.recorder) {
      // Countdowns are stored relative to the event so replays can rescale them.
      const rec = e.type === "phase" && e.endsAt ? { ...e, endsAt: undefined, endsInMs: e.endsAt - Date.now() } : e;
      this.recorder.write(JSON.stringify({ t: Date.now() - this.startedAt, ...rec }) + "\n");
    }
    if (e.type === "log" || e.type === "phase") console.log(`\x1b[36m[arena]\x1b[0m ${e.type === "log" ? e.text : e.detail}`);
    this.emit("state", this.state);
  }

  reset(patch: Partial<ArenaState> = {}) {
    this.state = { ...initialState(), ...patch };
    this.emit("state", this.state);
  }

  // Convenience wrappers
  update(patch: Partial<ArenaState>) { this.emitEvent({ type: "patch", patch }); }
  phase(phase: Phase, detail = "", endsAt: number | null = null) { this.emitEvent({ type: "phase", phase, detail, endsAt }); }
  log(text: string) { this.emitEvent({ type: "log", text }); }
  visit(thought: Thought) { this.emitEvent({ type: "visit", thought }); }
  fighter(key: string, patch: Partial<Fighter>) { this.emitEvent({ type: "fighter", key, patch }); }
  human(fighterKey: string, action: "view" | "signup") { this.emitEvent({ type: "human", fighterKey, action }); }
}

export const bus = new Bus();

export const newFighter = (key: string, spec: VariantSpec, isChampion: boolean): Fighter => ({
  key, spec, isChampion, visitors: 0, signups: 0, byPersona: {}, humans: { visitors: 0, signups: 0 }, status: "fighting",
});
