import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

/**
 * Human-in-the-loop gate. Every change to Flagsmith goes through here.
 * `--yes` (AUTO_APPROVE=1) exists for CI/demo replays and is logged loudly.
 */
export async function approve(title: string, details: string[]): Promise<boolean> {
  console.log(`\n\x1b[1m\x1b[33m⚑ APPROVAL NEEDED: ${title}\x1b[0m`);
  for (const d of details) console.log(`  ${d}`);
  if (process.env.AUTO_APPROVE === "1") {
    console.log("  \x1b[2m(auto-approved: AUTO_APPROVE=1)\x1b[0m");
    return true;
  }
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question("  Apply these changes? [y/N] ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
