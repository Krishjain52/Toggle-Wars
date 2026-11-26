import { Flagsmith } from "@flagsmith/nodejs";
import { config } from "../config.js";

/**
 * The SDK side: what a real app does. Each synthetic visitor is a Flagsmith
 * identity; `getExperimentFlag` buckets them and records the exposure, and
 * `trackEvent` records the conversion. Flagsmith joins the two per identity.
 */
export function createSdk(): Flagsmith {
  const { apiUrl, eventsUrl } = config.flagsmith;
  return new Flagsmith({
    environmentKey: config.flagsmith.environmentKey(),
    enableEvents: true,
    ...(apiUrl ? { apiUrl } : {}),
    ...(eventsUrl ? { eventProcessorConfig: { eventsApiUrl: eventsUrl } } : {}),
  });
}

export interface Exposure {
  /** Variant key the visitor was bucketed into ("control" for the champion). */
  variantKey: string;
  /** Raw flag value: the page JSON this visitor sees. */
  value: string;
  inExperiment: boolean;
}

export async function expose(sdk: Flagsmith, flagName: string, visitorId: string): Promise<Exposure> {
  const flag = await sdk.getExperimentFlag(flagName, visitorId);
  const f = flag as { value: unknown; variant?: string; experiment?: { inExperiment?: boolean } };
  return {
    variantKey: f.variant ?? "control",
    value: String(f.value ?? ""),
    inExperiment: f.experiment?.inExperiment ?? true,
  };
}

export const SIGNUP_EVENT = "arena_signup";

export function convert(sdk: Flagsmith, visitorId: string) {
  sdk.trackEvent(SIGNUP_EVENT, { identifier: visitorId });
}
