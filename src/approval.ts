import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { randomUUID } from "node:crypto";
import { bus } from "./bus.js";
import type { VariantSpec } from "./variant.js";

/**
 * Human-in-the-loop gate. Every change to Flagsmith waits here until a human
 * answers, either in the terminal or with the Approve/Reject buttons in the
 * arena. The request shows the exact Flagsmith CLI commands that will run.
 * AUTO_APPROVE=1 exists for unattended replays and is logged loudly.
 */
let pending: { id: string; resolve: (ok: boolean) => void } | null = null;

export function answerApproval(id: string, ok: boolean): boolean {
  if (!pending || pending.id !== id) return false;
  pending.resolve(ok);
  return true;
}

export async function approve(
  title: string,
  details: string[],
  extra: { commands?: string[]; previews?: VariantSpec[] } = {},
): Promise<boolean> {
  console.log(`\n\x1b[1m\x1b[33m⚑ APPROVAL NEEDED: ${title}\x1b[0m`);
  for (const d of details) console.log(`  ${d}`);
  for (const c of extra.commands ?? []) console.log(`  \x1b[2m$ ${c}\x1b[0m`);
  const id = randomUUID();
  const request = { id, title, details, commands: extra.commands ?? [], previews: extra.previews };

  if (process.env.AUTO_APPROVE === "1") {
    // Show the request briefly so recordings and the arena still display it.
    bus.update({ approval: request });
    await new Promise((r) => setTimeout(r, 2500));
    bus.update({ approval: null });
    bus.log(`Auto-approved (AUTO_APPROVE=1): ${title}`);
    return true;
  }

  bus.update({ approval: request });
  const ac = new AbortController();
  const rl = stdin.isTTY ? createInterface({ input: stdin, output: stdout }) : null;

  const ok = await new Promise<boolean>((resolve) => {
    pending = { id, resolve };
    rl?.question("  Approve in the arena, or type y/N here: ", { signal: ac.signal })
      .then((a) => resolve(["y", "yes"].includes(a.trim().toLowerCase())))
      .catch(() => {}); // aborted because the arena answered first
  });

  pending = null;
  ac.abort();
  rl?.close();
  bus.update({ approval: null });
  bus.log(`${ok ? "✅ Approved" : "❌ Rejected"}: ${title}`);
  return ok;
}
