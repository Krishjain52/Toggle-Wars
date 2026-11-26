import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { config } from "./config.js";

let client: GoogleGenAI | null = null;
const ai = () => (client ??= new GoogleGenAI({ apiKey: config.gemini.apiKey() }));

/** Models that recently failed with overload; skipped for a minute. */
const cooling = new Map<string, number>();

/** Call the first healthy model in the chain, falling through on persistent overload. */
async function generate(models: string[], request: (model: string) => Promise<{ text?: string }>) {
  const ordered = [...models].sort((a, b) => Number((cooling.get(a) ?? 0) > Date.now()) - Number((cooling.get(b) ?? 0) > Date.now()));
  let lastError: unknown;
  for (const model of ordered) {
    try {
      return await withRetry(() => request(model), 3);
    } catch (e) {
      lastError = e;
      const status = (e as { status?: number }).status ?? 0;
      if (status !== 429 && status < 500) throw e;
      cooling.set(model, Date.now() + 60_000);
    }
  }
  throw lastError;
}

/**
 * Ask Gemini for JSON that matches a zod schema. The schema is sent as a JSON
 * Schema so the model is constrained, then validated again locally; one retry
 * with the validation error if the model still gets it wrong.
 */
export async function generateJson<T extends z.ZodType>(opts: {
  models: string[];
  system: string;
  prompt: string;
  schema: T;
  temperature?: number;
}): Promise<z.infer<T>> {
  const jsonSchema = z.toJSONSchema(opts.schema, { target: "draft-7" });
  let prompt = opts.prompt;
  for (let attempt = 1; ; attempt++) {
    const res = await generate(opts.models, (model) => ai().models.generateContent({
      model,
      contents: prompt,
      config: {
        systemInstruction: opts.system,
        temperature: opts.temperature ?? 0.9,
        responseMimeType: "application/json",
        responseJsonSchema: jsonSchema,
      },
    }));
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

/** Retry transient API failures (overload, rate limits, 5xx) with jittered exponential backoff. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const status = (e as { status?: number }).status ?? 0;
      const transient = status === 429 || status >= 500 || /fetch failed|ECONNRESET|ETIMEDOUT/i.test(String(e));
      if (!transient || i >= attempts) throw e;
      const delay = Math.min(30_000, 1000 * 2 ** (i - 1)) * (0.5 + Math.random());
      await new Promise((r) => setTimeout(r, delay));
    }
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
