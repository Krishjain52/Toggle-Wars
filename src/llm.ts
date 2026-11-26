import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { config } from "./config.js";

let client: GoogleGenAI | null = null;
const ai = () => (client ??= new GoogleGenAI({ apiKey: config.gemini.apiKey() }));

/**
 * Ask Gemini for JSON that matches a zod schema. The schema is sent as a JSON
 * Schema so the model is constrained, then validated again locally; one retry
 * with the validation error if the model still gets it wrong.
 */
export async function generateJson<T extends z.ZodType>(opts: {
  model: string;
  system: string;
  prompt: string;
  schema: T;
  temperature?: number;
}): Promise<z.infer<T>> {
  const jsonSchema = z.toJSONSchema(opts.schema, { target: "draft-7" });
  let prompt = opts.prompt;
  for (let attempt = 1; ; attempt++) {
    const res = await ai().models.generateContent({
      model: opts.model,
      contents: prompt,
      config: {
        systemInstruction: opts.system,
        temperature: opts.temperature ?? 0.9,
        responseMimeType: "application/json",
        responseJsonSchema: jsonSchema,
      },
    });
    const text = res.text ?? "";
    let parsed: z.ZodSafeParseResult<z.infer<T>>;
    try {
      parsed = opts.schema.safeParse(JSON.parse(text));
    } catch (e) {
      parsed = { success: false, error: new z.ZodError([{ code: "custom", path: [], message: String(e), input: text }]) } as never;
    }
    if (parsed.success) return parsed.data;
    if (attempt >= 2) throw new Error(`Model output failed validation: ${parsed.error.message}`);
    prompt = `${opts.prompt}\n\nYour previous answer was invalid (${parsed.error.message.slice(0, 500)}). Return valid JSON only.`;
  }
}

/** Run async jobs with a concurrency cap. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
