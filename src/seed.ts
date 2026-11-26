import type { VariantSpec } from "./variant.js";

/** The demo product whose landing page we evolve. Swap this for your own. */
export const PRODUCT = {
  name: "Patchwork",
  pitch: "An AI code reviewer for small teams. It comments on pull requests within a minute, catches bugs and security issues, and learns your team's style.",
  goal: "Maximise free-trial sign-ups from the landing page.",
  facts: [
    "Free for repos with up to 3 contributors",
    "Installs as a GitHub App in under 2 minutes",
    "Reviews arrive in about 60 seconds",
    "Used by 1,200 teams",
    "Never trains on your code",
  ],
};

/** Generation 0 champion: a deliberately mediocre, buzzword-heavy page with room to improve. */
export const GENESIS: VariantSpec = {
  name: "The Original",
  strategy: "Baseline page written by marketing.",
  layout: "centered",
  headline: "Revolutionising Code Quality With Next-Gen AI Synergy",
  subheadline: "Patchwork leverages cutting-edge machine learning to empower development teams to unlock their full potential.",
  bullets: ["AI-powered insights", "Seamless integration", "Enterprise-grade platform"],
  cta: "Learn More",
  theme: { background: "#f4f4f5", text: "#27272a", accent: "#6366f1" },
};
