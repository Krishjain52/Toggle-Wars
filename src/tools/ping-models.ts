import { GoogleGenAI } from "@google/genai";
import { config } from "../config.js";
const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey() });
for (const model of ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-4-hydrogen", "gemini-4-argon"]) {
  const t = Date.now();
  try {
    const r = await ai.models.generateContent({ model, contents: "Reply with the word ok." });
    console.log(`✓ ${model} ${Date.now() - t}ms: ${r.text?.trim().slice(0, 20)}`);
  } catch (e) {
    console.log(`✗ ${model}: ${(e as { status?: number }).status} ${String((e as Error).message).slice(0, 90)}`);
  }
}
