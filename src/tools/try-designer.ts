import { breedChallengers } from "../designer.js";
import { GENESIS } from "../seed.js";
const t = Date.now();
const cs = await breedChallengers(GENESIS, 1, null);
for (const c of cs) console.log(`\n🥊 ${c.name} [${c.layout}] ${c.theme.background}/${c.theme.accent}\n   strategy: ${c.strategy}\n   H: ${c.headline}\n   S: ${c.subheadline}\n   B: ${c.bullets.join(" | ")}\n   CTA: ${c.cta}${c.socialProof ? `\n   proof: ${c.socialProof}` : ""}`);
console.log(`\n${((Date.now() - t) / 1000).toFixed(1)}s`);
