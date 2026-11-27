import { readFileSync } from "node:fs";
import { bus, type ArenaEvent } from "./bus.js";

/**
 * Replays a recorded run (runs/*.jsonl) through the same reducer the live
 * arena uses. Long waits (Flagsmith ingestion, Gemini thinking) are
 * compressed so a 25-minute run plays in a couple of minutes, while bursts of
 * visitors keep their natural rhythm. No API keys needed.
 */
type Recorded = ArenaEvent & { t: number; endsInMs?: number };

export function loadRun(file: string): Recorded[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Recorded);
}

let playing: AbortController | null = null;

export async function playRun(file: string, speed = 8, maxGapMs = 2500) {
  playing?.abort();
  const ac = (playing = new AbortController());
  const events = loadRun(file);
  bus.reset({ replay: true });
  let prev = 0;
  for (const rec of events) {
    if (ac.signal.aborted) return;
    const { t, endsInMs, ...e } = rec;
    const gap = Math.min(t - prev, maxGapMs * speed) / speed;
    prev = t;
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    const event = e as ArenaEvent;
    if (event.type === "phase" && endsInMs) event.endsAt = Date.now() + Math.min(endsInMs, maxGapMs * speed) / speed;
    if (event.type === "patch") event.patch.replay = true;
    bus.emitEvent(event);
  }
}
