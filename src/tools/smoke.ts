/**
 * Pipeline smoke test: sends N identities to a running experiment flag, converts
 * some of them, and flushes. Usage: tsx src/tools/smoke.ts <flag> <event> [n]
 */
import { Flagsmith } from "@flagsmith/nodejs";
import { config } from "../config.js";

const [flag, event, n = "150"] = process.argv.slice(2);
if (!flag || !event) throw new Error("usage: smoke.ts <flag> <event> [n]");

const sdk = new Flagsmith({ environmentKey: config.flagsmith.environmentKey(), enableEvents: true });
const counts: Record<string, { seen: number; converted: number }> = {};
const run = Date.now().toString(36);

for (let i = 0; i < Number(n); i++) {
  const id = `smoke-${run}-${i}`;
  const f = (await sdk.getExperimentFlag(flag, id)) as { variant?: string; experiment?: { inExperiment: boolean } };
  const key = f.variant ?? "control";
  const c = (counts[key] ??= { seen: 0, converted: 0 });
  c.seen++;
  if (Math.random() < (key === "control" ? 0.1 : 0.25)) {
    sdk.trackEvent(event, { identifier: id });
    c.converted++;
  }
  if (i === 0) console.log("first flag:", JSON.stringify({ variant: f.variant, experiment: f.experiment }));
}
await sdk.close();
console.log(counts);
