# ⚔️ Toggle Wars

**Your landing page evolves itself.** An AI agent breeds challenger versions of your page, a swarm of synthetic visitors fights it out inside a real **Flagsmith Experiment**, Flagsmith's Bayesian engine crowns the winner, and the winner's offspring battle again in the next generation. When evolution ends, the champion ships to production through a feature flag: no deploy, no code change.

> Built for the WeMakeDevs × Flagsmith **Toggle Wars** hackathon, Track 02: *AI Agents and Feature Flags*.

---

## The problem

A/B testing is the right way to improve a product, but each experiment costs hours of setup (flags, variants, metrics, instrumentation) and then weeks of real traffic. Most teams run a handful of tests a year, and they often test weak ideas, because generating good hypotheses is hard too.

## What Toggle Wars does

It turns one goal ("get more trial sign-ups") into a self-running evolution loop, with a human approving every change:

```
            ┌────────────────────────── next generation ◀──────────────────────────┐
            ▼                                                                       │
 1. BREED            2. APPROVE           3. DEPLOY               4. BATTLE              5. JUDGE
 Gemini designs  ─▶  human approves  ─▶  Flagsmith CLI creates ─▶ 400 synthetic     ─▶  Flagsmith computes
 3 challengers       in the arena        flag + experiment       visitors are          win probability;
 from the champion   (or terminal)       (champion = control)    bucketed by Flagsmith  winner becomes the
 + visitor feedback                                              and convert (or not)   new champion
                                                                                              │
                                                     6. SHIP: champion → `landing_page` flag ◀┘
                                                        old battle flags archived
```

- **Breed:** Gemini acts as a conversion designer. It reads the reigning champion plus *why visitors left it* in the last round, and writes three challengers, each testing one explainable idea. It may only use the product facts it is given.
- **Approve:** nothing touches Flagsmith until a human clicks **Approve** in the arena (or types `y` in the terminal). The approval lists every flag, experiment and variant about to be created.
- **Deploy:** the agent drives the official **Flagsmith CLI**: a multivariate flag whose control is the champion and whose keyed variants are the challengers, plus an occurrence metric and an experiment split evenly between them.
- **Battle:** each synthetic visitor is a Flagsmith identity. `getExperimentFlag` decides which page they see *and* records the exposure. A fast Gemini model role-plays the visitor (a busy CTO, a sceptical engineer, a broke student…) reading exactly the page Flagsmith served, and sign-ups are sent with `trackEvent`.
- **Judge:** the agent asks Flagsmith to compute results and reads the Bayesian **chance to win** for each challenger. A challenger must beat the champion with ≥ 90% probability to take the title. The experiment is then completed with Flagsmith's own rollout decision.
- **Ship:** the final champion is written to the `landing_page` flag. The real page at `/live` reads that flag on every request, so it changes instantly. Battle flags are archived, not deleted, so every experiment stays browsable in Flagsmith.

## Why synthetic visitors?

They are a **pre-test, not a replacement for users**. Real traffic is precious: you do not want to burn two weeks of it on a headline that a sceptical engineer would reject in two seconds. Toggle Wars weeds out weak ideas in minutes, and the survivors then run against real users through the *same* flags and experiments, with no code changes. The pipeline is identical for real traffic; only the source of events changes.

## How Flagsmith is used

| Flagsmith feature | Where | What it does in Toggle Wars |
|---|---|---|
| Multivariate flags with JSON values | [`src/flagsmith/admin.ts`](src/flagsmith/admin.ts) | Each page is a JSON spec stored as a flag value, so variants go live with no deploy |
| Flagsmith CLI (`feature create`, `variant add`, `flag update`, `feature update --archive`, `api`) | [`src/flagsmith/admin.ts`](src/flagsmith/admin.ts) | Every admin change is an auditable CLI command |
| Experimentation API (metrics, experiments, start, results refresh, complete) | [`src/flagsmith/admin.ts`](src/flagsmith/admin.ts) | Creates, runs and concludes one experiment per generation |
| Node SDK `getExperimentFlag` + `trackEvent` | [`src/flagsmith/sdk.ts`](src/flagsmith/sdk.ts), [`src/swarm.ts`](src/swarm.ts) | Buckets each visitor, records exposures and conversions |
| Bayesian results (`chance_to_win`, lift, SRM check) | [`src/evolve.ts`](src/evolve.ts) | Decides who wins each round; warns on sample ratio mismatch |
| `rollout_decision` on complete | [`src/evolve.ts`](src/evolve.ts) | Rolls out the winning variant, or keeps the champion |
| Environment flags at request time | [`src/arena/server.ts`](src/arena/server.ts) | `/live` renders whatever `landing_page` holds right now |

## Quick start

**Requirements:** Node 20+, a free [Flagsmith](https://app.flagsmith.com) account, a [Gemini API key](https://aistudio.google.com/apikey).

```bash
git clone https://github.com/Krishjain52/Toggle-Wars.git
cd Toggle-Wars
npm install
cp .env.example .env        # then fill in the keys below
```

1. In Flagsmith, create an **Organisation API key** (Organisation settings → API Keys) and put it in `FLAGSMITH_API_KEY`.
2. Create a project and environment (or use the CLI: `npx flagsmith project create "Toggle Wars"`), then bind this folder to it:
   ```bash
   npx flagsmith init --project <project id> --environment <client-side environment key>
   ```
   Put the same client-side key in `FLAGSMITH_ENVIRONMENT_KEY`.
3. Make sure the environment has a warehouse (Environment settings → Warehouse → *Flagsmith database*).
4. Put your Gemini key in `GEMINI_API_KEY`.

Then start the arena:

```bash
npm run arena
```

Open **http://localhost:4040**, press **Start evolution**, and approve each generation as it is proposed. The live landing page is at **http://localhost:4040/live**.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `GENERATIONS` | `3` | Rounds of evolution |
| `CHALLENGERS` | `3` | Challengers per round (plus the champion) |
| `VISITORS_PER_GENERATION` | `400` | Synthetic visitors per round (Flagsmith needs ≥ 50 per variant) |
| `WIN_THRESHOLD` | `0.9` | Chance to win a challenger needs to dethrone the champion |
| `DESIGNER_MODELS` | `gemini-3.8-flash,gemini-3.6-flash,gemini-4-hydrogen` | Fallback chain for the designer |
| `VISITOR_MODELS` | `gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.6-flash` | Fallback chain for visitors |
| `AUTO_APPROVE` | unset | `1` skips approvals (unattended replays only) |
| `FLAGSMITH_SDK_API_URL`, `FLAGSMITH_EVENTS_URL`, `FLAGSMITH_DASHBOARD_URL` | Flagsmith Cloud | Point at a self-hosted Flagsmith |

### Timing

Flagsmith ingests events within about a minute and allows a results refresh every 5 minutes, so a generation takes roughly 3–7 minutes. A 3-generation run takes about 15–20 minutes.

## Project layout

```
src/
  arena/server.ts     web server: arena UI over Server-Sent Events, approvals, /live page
  arena/arena.html    the arena screen
  evolve.ts           the agent loop: breed → approve → deploy → battle → judge → ship
  designer.ts         Gemini challenger designer (learns from visitor objections)
  judge.ts            Gemini visitor simulation, batched
  swarm.ts            runs visitors through the live Flagsmith experiment
  personas.ts         visitor archetypes, seeded and reproducible
  flagsmith/admin.ts  Flagsmith CLI + Experimentation API
  flagsmith/sdk.ts    Flagsmith Node SDK: exposures and conversions
  variant.ts          page spec schema and renderer
  seed.ts             demo product and the generation-0 page
  approval.ts         human-in-the-loop gate (arena button or terminal)
```

## Use it on your own product

Edit [`src/seed.ts`](src/seed.ts): describe your product, list the facts the designer is allowed to use, and write your current page as the generation-0 champion. Everything else stays the same.

## License

MIT
