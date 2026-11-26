import { z } from "zod";

/**
 * A landing-page variant. The entire page is described by this JSON, which is
 * stored as a Flagsmith flag value, so a new variant goes live without a redeploy.
 */
export const LAYOUTS = ["centered", "split", "minimal", "bold"] as const;

export const VariantSpec = z.object({
  name: z.string().min(1).max(40).describe("Short fighter name, e.g. 'The Minimalist'"),
  strategy: z.string().max(200).describe("One sentence: why this variant should convert better"),
  layout: z.enum(LAYOUTS),
  headline: z.string().min(1).max(90),
  subheadline: z.string().max(220),
  bullets: z.array(z.string().max(90)).max(4),
  cta: z.string().min(1).max(32),
  socialProof: z.string().max(120).optional(),
  theme: z.object({
    background: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    text: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  }),
});
export type VariantSpec = z.infer<typeof VariantSpec>;

/** Parse a flag value back into a variant, tolerating bad data from the wire. */
export function parseVariant(raw: unknown): VariantSpec | null {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    const parsed = VariantSpec.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Plain-text rendering: what a synthetic visitor "reads". Order mirrors visual hierarchy. */
export function renderText(v: VariantSpec, product: string): string {
  const lines = [
    `[Landing page for ${product}, layout: ${v.layout}]`,
    `HEADLINE: ${v.headline}`,
    v.subheadline && `SUBHEADLINE: ${v.subheadline}`,
    ...v.bullets.map((b) => `• ${b}`),
    v.socialProof && `SOCIAL PROOF: ${v.socialProof}`,
    `BUTTON: [ ${v.cta} ]`,
  ];
  return lines.filter(Boolean).join("\n");
}

/** Full HTML rendering: what humans (and the arena) see. */
export function renderHtml(v: VariantSpec, opts: { ctaHref?: string } = {}): string {
  const { background: bg, text, accent } = v.theme;
  const href = opts.ctaHref ?? "#signup";
  const bullets = v.bullets.length
    ? `<ul class="bullets">${v.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`
    : "";
  const proof = v.socialProof ? `<p class="proof">${esc(v.socialProof)}</p>` : "";
  const copy = `
    <h1>${esc(v.headline)}</h1>
    ${v.subheadline ? `<p class="sub">${esc(v.subheadline)}</p>` : ""}
    ${bullets}
    <a class="cta" href="${esc(href)}">${esc(v.cta)}</a>
    ${proof}`;

  const body =
    v.layout === "split"
      ? `<div class="split"><div>${copy}</div><div class="art" aria-hidden="true"></div></div>`
      : `<div class="wrap">${copy}</div>`;

  return `<style>
  .tw-page{--bg:${bg};--fg:${text};--ac:${accent};background:var(--bg);color:var(--fg);
    font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;min-height:100%;padding:56px 28px;box-sizing:border-box}
  .tw-page *{box-sizing:border-box}
  .tw-page h1{font-size:clamp(28px,5vw,${v.layout === "bold" ? 64 : 44}px);line-height:1.1;margin:0 0 16px;
    letter-spacing:-.02em;${v.layout === "bold" ? "text-transform:uppercase;font-weight:900" : "font-weight:750"}}
  .tw-page .sub{font-size:1.15em;opacity:.85;margin:0 0 20px;max-width:46ch}
  .tw-page .bullets{padding:0;margin:0 0 24px;list-style:none}
  .tw-page .bullets li{padding-left:1.4em;position:relative;margin:6px 0}
  .tw-page .bullets li:before{content:"✓";position:absolute;left:0;color:var(--ac);font-weight:700}
  .tw-page .cta{display:inline-block;background:var(--ac);color:var(--bg);padding:14px 28px;border-radius:10px;
    font-weight:700;text-decoration:none;font-size:1.05em}
  .tw-page .proof{margin-top:18px;font-size:.9em;opacity:.7}
  .tw-page .wrap{max-width:720px;margin:0 auto;${v.layout === "minimal" ? "" : "text-align:center"}}
  .tw-page .wrap .sub{${v.layout === "minimal" ? "" : "margin-inline:auto"}}
  .tw-page .wrap .bullets{display:${v.layout === "minimal" ? "block" : "inline-block"};text-align:left}
  .tw-page .split{display:grid;grid-template-columns:1.2fr 1fr;gap:40px;align-items:center;max-width:1000px;margin:0 auto}
  .tw-page .art{aspect-ratio:1;border-radius:24px;background:
    radial-gradient(circle at 30% 30%,var(--ac),transparent 60%),
    radial-gradient(circle at 70% 70%,var(--fg),transparent 55%);opacity:.35}
  @media (max-width:640px){.tw-page .split{grid-template-columns:1fr}.tw-page .art{display:none}}
</style>
<div class="tw-page" data-layout="${v.layout}">${body}</div>`;
}
