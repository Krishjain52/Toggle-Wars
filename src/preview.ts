import { writeFileSync, mkdirSync } from "node:fs";
import { GENESIS, PRODUCT } from "./seed.js";
import { renderHtml, renderText } from "./variant.js";

/** Render the genesis page to out/preview.html and print what a visitor "reads". */
mkdirSync("out", { recursive: true });
writeFileSync(
  "out/preview.html",
  `<!doctype html><meta charset="utf-8"><title>${PRODUCT.name} preview</title><body style="margin:0">${renderHtml(GENESIS)}`,
);
console.log(renderText(GENESIS, PRODUCT.name));
console.log("\nWrote out/preview.html");
