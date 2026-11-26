/**
 * Synthetic visitor archetypes. Each simulated visitor is one archetype plus a
 * random mood/context so the swarm is varied but reproducible from a seed.
 */
export interface Archetype {
  id: string;
  label: string;
  description: string;
  /** Rough share of the visitor population. */
  weight: number;
}

export const ARCHETYPES: Archetype[] = [
  { id: "cto", label: "Busy CTO", weight: 12,
    description: "Skims for 5 seconds. Wants to know what it does and why it beats alternatives. Hates fluff and buzzwords." },
  { id: "indie", label: "Indie hacker", weight: 16,
    description: "Solo founder, price-sensitive, loves tools that save time today. Responds to concrete outcomes and low commitment." },
  { id: "skeptic", label: "Sceptical senior engineer", weight: 14,
    description: "Distrusts marketing. Signs up only if claims are specific and believable. Social proof from engineers helps." },
  { id: "student", label: "CS student", weight: 12,
    description: "Curious, budget of zero, drawn to 'free' and learning. Easily confused by enterprise jargon." },
  { id: "pm", label: "Product manager", weight: 14,
    description: "Thinks in outcomes and team workflows. Likes clarity about who it is for and how fast to get value." },
  { id: "designer", label: "Design-minded founder", weight: 10,
    description: "Judges quality by polish and tone. A cluttered or shouty page signals a low-quality product." },
  { id: "enterprise", label: "Enterprise buyer", weight: 10,
    description: "Cares about security, reliability and trust signals. Ignores playful copy." },
  { id: "drive-by", label: "Drive-by visitor", weight: 12,
    description: "Clicked a link by accident, low intent. Converts only if the headline instantly hooks them." },
];

const MOODS = ["in a hurry", "relaxed and browsing", "comparing several tools", "on mobile, distracted", "actively looking for a solution"];

export interface Visitor {
  id: string; // also the Flagsmith identity
  archetype: Archetype;
  mood: string;
}

/** Small deterministic PRNG so a run can be replayed exactly. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function spawnVisitors(count: number, runId: string, generation: number, seed = 1): Visitor[] {
  const rand = rng(seed * 1000 + generation);
  const total = ARCHETYPES.reduce((n, a) => n + a.weight, 0);
  return Array.from({ length: count }, (_, i) => {
    let roll = rand() * total;
    const archetype = ARCHETYPES.find((a) => (roll -= a.weight) < 0) ?? ARCHETYPES[0]!;
    return {
      id: `${runId}-g${generation}-v${String(i).padStart(4, "0")}`,
      archetype,
      mood: MOODS[Math.floor(rand() * MOODS.length)]!,
    };
  });
}
