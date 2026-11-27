import { createServer, type ServerResponse } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { answerApproval } from "../approval.js";
import { bus, type ArenaState } from "../bus.js";
import { config } from "../config.js";
import { PRODUCTION_FLAG, runArena } from "../evolve.js";
import { createSdk } from "../flagsmith/sdk.js";
import { playRun } from "../replay.js";
import { ARCHETYPES } from "../personas.js";
import { GENESIS, PRODUCT } from "../seed.js";
import { parseVariant, renderHtml } from "../variant.js";

const here = (name: string) => fileURLToPath(new URL(`./${name}`, import.meta.url));
const page = (name: string) => readFileSync(here(name), "utf8");
const arg = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

// ── Mode: live (Flagsmith + Gemini) or replay of a recorded run ─────────────
const replayArg = process.argv.includes("--replay") ? (arg("--replay") ?? "") : null;
function latestRun(): string | null {
  if (!existsSync("runs")) return null;
  const files = readdirSync("runs").filter((f) => f.endsWith(".jsonl"));
  const demo = files.find((f) => f === "demo.jsonl");
  if (demo) return `runs/${demo}`;
  const newest = files.map((f) => `runs/${f}`).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  return newest ?? null;
}
const replayFile = replayArg === null ? null : replayArg && !replayArg.startsWith("--") ? replayArg : latestRun();
if (replayArg !== null && !replayFile) throw new Error("No recorded run found. Run the arena once, or pass --replay <file>.");
const speed = Number(arg("--speed") ?? 8);

// ── Join link for real people: the machine's LAN address ────────────────────
function lanAddress(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return "localhost";
}
const joinUrl = process.env.PUBLIC_URL ?? `http://${lanAddress()}:${config.arena.port}/play`;
const qrSvg = QRCode.toString(joinUrl, { type: "svg", margin: 1, color: { dark: "#0b0d12", light: "#ffffff" } });

// ── Server-sent state stream ────────────────────────────────────────────────
/** State as sent to the browser: pages are pre-rendered for the previews. */
const view = (s: ArenaState) => ({
  ...s,
  joinUrl,
  fighters: s.fighters.map((f) => ({ ...f, html: renderHtml(f.spec) })),
  rounds: s.rounds.map((r) => ({ ...r, html: renderHtml(r.spec), parentHtml: renderHtml(r.parent) })),
  approval: s.approval && { ...s.approval, previewsHtml: (s.approval.previews ?? []).map((p) => renderHtml(p)) },
});

const clients = new Set<ServerResponse>();
let pendingFrame: NodeJS.Timeout | null = null;
bus.on("state", () => {
  // Coalesce bursts (a swarm emits hundreds of events) into ~12 frames/second.
  pendingFrame ??= setTimeout(() => {
    pendingFrame = null;
    const data = `data: ${JSON.stringify(view(bus.state))}\n\n`;
    for (const c of clients) c.write(data);
  }, 80);
});

let running = false;
async function start() {
  if (running) return;
  running = true;
  try {
    if (replayFile) await playRun(replayFile, speed);
    else await runArena();
  } catch (e) {
    console.error(e);
  } finally {
    running = false;
  }
}

const liveSdk = replayFile ? null : createSdk();
const humansSeen = new Set<string>();

async function readJson(req: import("node:http").IncomingMessage) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || "{}");
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    switch (url.pathname) {
      case "/":
        return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("arena.html"));
      case "/play":
        return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("play.html"));
      case "/vendor/flagsmith.js":
        return void res
          .writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "max-age=3600" })
          .end(readFileSync("node_modules/@flagsmith/flagsmith/index.js"));
      case "/qr.svg":
        return void res.writeHead(200, { "content-type": "image/svg+xml" }).end(await qrSvg);
      case "/favicon.svg":
      case "/favicon.ico":
        return void res
          .writeHead(200, { "content-type": "image/svg+xml" })
          .end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0b0d12"/><path d="M18 46 46 18M18 18l28 28" stroke="#f5c542" stroke-width="7" stroke-linecap="round"/></svg>`);
      case "/events":
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(`data: ${JSON.stringify(view(bus.state))}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      case "/api/start":
        if (req.method !== "POST") break;
        void start();
        return void res.writeHead(202).end();
      case "/api/approval": {
        if (req.method !== "POST") break;
        const { id, ok } = await readJson(req);
        return void res.writeHead(answerApproval(String(id), ok === true) ? 200 : 409).end();
      }
      case "/api/current": {
        // What a real visitor on /play should be shown right now.
        const s = bus.state;
        const battling = !s.replay && s.phase === "battling" && !!s.flagName;
        return void res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            battling,
            flagName: battling ? s.flagName : null,
            generation: s.generation,
            environmentKey: replayFile ? null : config.flagsmith.environmentKey(),
            apiUrl: config.flagsmith.apiUrl ?? null,
            eventsUrl: config.flagsmith.eventsUrl ?? null,
            product: PRODUCT.name,
            productionFlag: PRODUCTION_FLAG,
          }),
        );
      }
      case "/api/render": {
        // Renders a flag value (page JSON) the browser received from Flagsmith.
        if (req.method !== "POST") break;
        const { value } = await readJson(req);
        const spec = parseVariant(value);
        if (!spec) return void res.writeHead(400).end("Not a page spec");
        return void res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ html: renderHtml(spec, { ctaHref: "#signup" }), background: spec.theme.background, name: spec.name }));
      }
      case "/api/human": {
        // Mirrors a real visitor's Flagsmith exposure/conversion into the arena.
        if (req.method !== "POST") break;
        const { id, flagName, fighterKey, action } = await readJson(req);
        const key = `${id}:${flagName}:${action}`;
        if (flagName === bus.state.flagName && (action === "view" || action === "signup") && !humansSeen.has(key)) {
          humansSeen.add(key);
          bus.human(String(fighterKey), action);
          if (action === "signup") bus.log(`🧑 A real person signed up on "${bus.state.fighters.find((f) => f.key === fighterKey)?.spec.name ?? fighterKey}"`);
        }
        return void res.writeHead(204).end();
      }
      case "/live": {
        // The production landing page: Flagsmith evaluates the flag on every request.
        // ?as=<visitor type> evaluates it for an identity with that trait, so
        // segment overrides shipped by Toggle Wars become visible.
        const as = url.searchParams.get("as");
        const persona = ARCHETYPES.find((a) => a.id === as) ?? null;
        let spec = GENESIS;
        let personalised = false;
        if (liveSdk) {
          const base = parseVariant((await liveSdk.getEnvironmentFlags()).getFeatureValue(PRODUCTION_FLAG)) ?? GENESIS;
          spec = base;
          if (persona) {
            const flags = await liveSdk.getIdentityFlags(`live-viewer-${persona.id}`, { visitor_type: persona.id });
            spec = parseVariant(flags.getFeatureValue(PRODUCTION_FLAG)) ?? base;
            personalised = spec.name !== base.name;
          }
        } else if (bus.state.rounds.length) {
          spec = bus.state.rounds[bus.state.rounds.length - 1]!.spec;
          const seg = persona && bus.state.insights?.segments?.find((g) => g.persona === persona.id);
          if (seg) { spec = seg.page; personalised = true; }
        }
        const segs = new Set((bus.state.insights?.segments ?? []).map((g) => g.persona));
        const chip = (id: string | null, label: string) =>
          `<a href="/live${id ? `?as=${id}` : ""}" style="padding:6px 10px;border-radius:999px;text-decoration:none;font:600 12px/1 system-ui;white-space:nowrap;` +
          `${(as ?? null) === id ? "background:#f5c542;color:#111" : "background:#1a1f2b;color:#cfd4e3"}">${label}${id && segs.has(id) ? " 🎯" : ""}</a>`;
        const switcher =
          `<div style="position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:9;max-width:calc(100vw - 24px);overflow-x:auto;` +
          `display:flex;gap:6px;align-items:center;padding:8px;border-radius:999px;background:rgba(11,13,18,.92);box-shadow:0 10px 40px rgba(0,0,0,.4)">` +
          `<span style="color:#8c93a8;font:600 11px/1 ui-monospace,monospace;padding:0 6px;white-space:nowrap">VIEW AS</span>` +
          chip(null, "Everyone") + ARCHETYPES.map((a) => chip(a.id, a.label)).join("") + `</div>` +
          (personalised
            ? `<div style="position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:9;padding:8px 14px;border-radius:999px;background:#3ddc84;color:#06210f;font:700 13px/1.2 system-ui;text-align:center;max-width:calc(100vw - 24px)">🎯 Personalised by Flagsmith segment for ${persona!.label}s: “${spec.name}”</div>`
            : "");
        return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
          `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
            `<link rel="icon" href="/favicon.svg"><title>${PRODUCT.name}</title>` +
            `<body style="margin:0;min-height:100vh;background:${spec.theme.background}">${renderHtml(spec)}${switcher}`,
        );
      }
    }
    res.writeHead(404).end("Not found");
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500).end("Server error");
  }
});

server.listen(config.arena.port, () => {
  console.log(`\n⚔️  Toggle Wars arena: http://localhost:${config.arena.port}`);
  if (replayFile) console.log(`⏯️  Replaying ${replayFile} at ${speed}× (press Start in the arena)`);
  else console.log(`🧑 Real visitors join at: ${joinUrl}`);
  console.log(`🌐 Live landing page: http://localhost:${config.arena.port}/live\n`);
  if (process.argv.includes("--start")) void start();
});
