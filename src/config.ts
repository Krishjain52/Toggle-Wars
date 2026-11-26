import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
  return v;
}

const int = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

export const config = {
  gemini: {
    apiKey: () => required("GEMINI_API_KEY"),
    designerModel: process.env.DESIGNER_MODEL ?? "gemini-3.8-flash",
    visitorModel: process.env.VISITOR_MODEL ?? "gemini-3.5-flash-lite",
  },
  flagsmith: {
    /** Client-side environment key: used by the SDK and in Admin API paths. */
    environmentKey: () => required("FLAGSMITH_ENVIRONMENT_KEY"),
    /** Set both for self-hosted; leave unset for Flagsmith Cloud. */
    apiUrl: process.env.FLAGSMITH_SDK_API_URL,
    eventsUrl: process.env.FLAGSMITH_EVENTS_URL,
    dashboardUrl: process.env.FLAGSMITH_DASHBOARD_URL ?? "https://app.flagsmith.com",
  },
  arena: {
    generations: int("GENERATIONS", 3),
    challengers: int("CHALLENGERS", 3),
    /** Flagsmith shows results only after 50 identities per variation. */
    visitorsPerGeneration: int("VISITORS_PER_GENERATION", 240),
    visitorsPerLlmCall: int("VISITORS_PER_LLM_CALL", 12),
    concurrency: int("LLM_CONCURRENCY", 6),
    /** Win probability a challenger needs to dethrone the champion. */
    winThreshold: Number(process.env.WIN_THRESHOLD ?? 0.9),
    port: int("PORT", 4040),
    seed: int("SEED", 1),
  },
};
