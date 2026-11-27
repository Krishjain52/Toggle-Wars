import { existsSync } from "node:fs";
import puppeteer, { type Browser } from "puppeteer-core";
import { renderHtml, type VariantSpec } from "./variant.js";

/**
 * Renders a variant in a real browser and screenshots it, so synthetic visitors
 * judge what a person would actually SEE (layout, colour, contrast, hierarchy),
 * not just the words. Uses the Chrome/Chromium already installed on the machine
 * (no download); without one, the arena falls back to text-only judging.
 */
const CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter((p): p is string => !!p);

export const chromePath = (): string | null =>
  process.env.VISION === "0" ? null : (CANDIDATES.find((p) => existsSync(p)) ?? null);

let browser: Promise<Browser> | null = null;
const cache = new Map<string, string>();

/** JPEG screenshot (base64) of the page's first screen at a laptop viewport. */
export async function screenshot(spec: VariantSpec): Promise<string | null> {
  const exe = chromePath();
  if (!exe) return null;
  const key = JSON.stringify(spec);
  const hit = cache.get(key);
  if (hit) return hit;
  browser ??= puppeteer.launch({ executablePath: exe, headless: true, args: ["--no-first-run", "--no-default-browser-check"] });
  const page = await (await browser).newPage();
  try {
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;background:${spec.theme.background}">${renderHtml(spec)}`, {
      waitUntil: "load",
    });
    const data = (await page.screenshot({ type: "jpeg", quality: 70, encoding: "base64" })) as string;
    cache.set(key, data);
    return data;
  } finally {
    await page.close();
  }
}

export async function closeVision() {
  if (browser) await (await browser).close().catch(() => {});
  browser = null;
}
