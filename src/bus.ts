import { EventEmitter } from "node:events";
import type { VariantSpec } from "./variant.js";

/** Everything the arena screen renders. Mutated by the agent, streamed over SSE. */
export interface Fighter {
  key: string; // Flagsmith variant key ("control" = champion)
  spec: VariantSpec;
  isChampion: boolean;
  /** Live tallies from the swarm, before Flagsmith's analysis lands. */
  visitors: number;
  signups: number;
  /** Flagsmith's verdict once results are computed. */
  flagsmith?: {
    visitors: number; conversions: number; rate: number; chanceToWin: number | null; lift: number | null;
    /** "flagsmith" = Flagsmith's own inference; "fallback" = Beta posterior on Flagsmith's counts. */
    source: "flagsmith" | "fallback";
  };
  status: "fighting" | "winner" | "defeated" | "defended";
}

export interface Thought {
  fighterKey: string;
  persona: string;
  signup: boolean;
  text: string;
}

export interface Round {
  generation: number;
  champion: string;
  winner: string;
  winnerRate: number;
  dethroned: boolean;
  experimentUrl: string;
  spec: VariantSpec;
}

export type Phase =
  | "idle" | "breeding" | "awaiting-approval" | "deploying" | "battling"
  | "analysing" | "verdict" | "shipping" | "done" | "error";

export interface ArenaState {
  product: string;
  goal: string;
  generation: number;
  totalGenerations: number;
  phase: Phase;
  phaseDetail: string;
  flagName: string | null;
  experimentUrl: string | null;
  fighters: Fighter[];
  thoughts: Thought[];
  rounds: Round[];
  approval: { id: string; title: string; details: string[] } | null;
  log: { at: string; text: string }[];
}

class Bus extends EventEmitter {
  state: ArenaState = {
    product: "", goal: "", generation: 0, totalGenerations: 0, phase: "idle", phaseDetail: "",
    flagName: null, experimentUrl: null, fighters: [], thoughts: [], rounds: [], approval: null, log: [],
  };

  update(patch: Partial<ArenaState>) {
    Object.assign(this.state, patch);
    this.emit("state", this.state);
  }

  phase(phase: Phase, detail = "") {
    this.update({ phase, phaseDetail: detail });
    this.log(detail || phase);
  }

  log(text: string) {
    this.state.log = [...this.state.log.slice(-199), { at: new Date().toISOString(), text }];
    console.log(`\x1b[36m[arena]\x1b[0m ${text}`);
    this.emit("state", this.state);
  }

  thought(t: Thought) {
    this.state.thoughts = [...this.state.thoughts.slice(-59), t];
    this.emit("state", this.state);
  }
}

export const bus = new Bus();
