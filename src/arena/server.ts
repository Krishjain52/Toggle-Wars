import { createServer, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { answerApproval } from "../approval.js";
import { bus, type ArenaState } from "../bus.js";
import { config } from "../config.js";
import { PRODUCTION_FLAG, runArena } from "../evolve.js";
import { createSdk } from "../flagsmith/sdk.js";
import { GENESIS, PRODUCT } from "../seed.js";
import { parseVariant, renderHtml } from "../variant.js";

const page = (name: string) => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");

/** State as sent to the browser: each fighter carries its rendered page for the live preview. */
const view = (s: ArenaState) => ({
  ...s,
  fighters: s.fighters.map((f) => ({ ...f, html: renderHtml(f.spec) })),
  rounds: s.rounds.map((r) => ({ ...r, html: renderHtml(r.spec) })),
});

const clients = new Set<ServerResponse>();
let pendingFrame: NodeJS.Timeout | null = null;
bus.on("state", () => {
  // Coalesce bursts of updates (a swarm emits hundreds) into ~10 frames/second.
  pendingFrame ??= setTimeout(() => {
    pendingFrame = null;
    const data = `data: ${JSON.stringify(view(bus.state))}\n\n`;
    for (const c of clients) c.write(data);
  }, 100);
});

let running = false;
async function start() {
  if (running) return;
  running = true;
  try {
    await runArena();
  } catch (e) {
    bus.phase("error", `Run failed: ${(e as Error).message}`);
    console.error(e);
  } finally {
    running = false;
  }
}

const liveSdk = createSdk();

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("arena.html"));
    } else if (url.pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify(view(bus.state))}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
    } else if (url.pathname === "/api/start" && req.method === "POST") {
      void start();
      res.writeHead(202).end();
    } else if (url.pathname === "/api/approval" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { id, ok } = JSON.parse(body || "{}");
      res.writeHead(answerApproval(String(id), ok === true) ? 200 : 409).end();
    } else if (url.pathname === "/live") {
      // The real landing page: reads the production flag on every request.
      const flags = await liveSdk.getEnvironmentFlags();
      const spec = parseVariant(flags.getFeatureValue(PRODUCTION_FLAG)) ?? GENESIS;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
          `<title>${PRODUCT.name}</title><body style="margin:0;min-height:100vh;background:${spec.theme.background}">${renderHtml(spec)}`,
      );
    } else {
      res.writeHead(404).end("Not found");
    }
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500).end("Server error");
  }
});

server.listen(config.arena.port, () => {
  console.log(`\n⚔️  Toggle Wars arena: http://localhost:${config.arena.port}`);
  console.log(`🌐 Live landing page: http://localhost:${config.arena.port}/live\n`);
  if (process.argv.includes("--start")) void start();
});
