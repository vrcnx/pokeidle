// Shared drawing primitives for the rendered cards.
//
// Everything visual that more than one card needs lives here: the palette, the
// panel/pill/bar shapes, text helpers, and sprite loading. The individual card
// files under this directory are layout only.
//
// ── FONTS ARE THE TRAP ──────────────────────────────────────────────
// @napi-rs/canvas draws text with whatever fonts the OS has. A
// node:20-bookworm-slim image has NONE, so text renders as nothing at all —
// and it fails silently: the canvas is produced, the card looks right in
// structure, and every label is blank. It works perfectly on a developer's
// machine and is empty in production.
//
// Two halves to the fix. The Dockerfile installs fonts-dejavu-core, and
// fontFamily() below resolves the first family that actually EXISTS at
// runtime rather than hard-coding a name — because the family that ships on
// Debian ("DejaVu Sans") is not the one on Windows ("Segoe UI") or macOS
// ("Helvetica"), and naming a missing family is the same silent blank.

import {
  createCanvas,
  loadImage,
  GlobalFonts,
  type Canvas,
  type SKRSContext2D,
  type Image,
} from "@napi-rs/canvas";

// ── Palette ─────────────────────────────────────────────────────────
export const C = {
  bg0: "#12151c",
  bg1: "#1a1f2b",
  panel: "#212838",
  panelEdge: "#2e3750",
  text: "#eef2fa",
  textDim: "#98a2b8",
  textFaint: "#6b7689",
  gold: "#f2c94c",
  goldDim: "#8a7430",
  green: "#4ade80",
  red: "#f87171",
  blue: "#60a5fa",
  shiny: "#ffd75e",
} as const;

// ── Fonts ───────────────────────────────────────────────────────────

let resolvedFamily: string | null = null;

/**
 * The first font family present on this machine, from a preference list that
 * covers Debian (DejaVu), Windows (Segoe UI), and macOS (Helvetica).
 *
 * Resolved once and cached. If NONE of them exist we fall back to "sans-serif"
 * and log loudly — that combination means the image will render with blank
 * text, and a loud log is the only warning anyone will get.
 */
export function fontFamily(): string {
  if (resolvedFamily) return resolvedFamily;
  const available = new Set(GlobalFonts.families.map((f) => f.family));
  const preferred = [
    "DejaVu Sans",
    "Liberation Sans",
    "Noto Sans",
    "Segoe UI",
    "Helvetica",
    "Arial",
  ];
  resolvedFamily = preferred.find((f) => available.has(f)) ?? "sans-serif";
  if (resolvedFamily === "sans-serif") {
    console.error(
      "[cards] no known font family is installed — card text will render BLANK. " +
        "Install fonts-dejavu-core (the Dockerfile does this; a bare dev machine may not have it).",
    );
  }
  return resolvedFamily;
}

export function font(size: number, weight: "normal" | "bold" = "normal"): string {
  return `${weight} ${size}px "${fontFamily()}"`;
}

// ── Sprite loading ──────────────────────────────────────────────────

/**
 * Decoded sprites, cached by URL.
 *
 * Bounded, because this is a long-lived process and the sprite set is
 * effectively unbounded (288 species × shiny, plus items). A busy #showcase
 * would otherwise re-download the same twenty files every time someone runs
 * /team, and an unbounded map would slowly accumulate every sprite anyone has
 * ever looked at.
 *
 * A NULL entry is cached too, and that is deliberate: a species whose sprite
 * 404s must not be re-requested on every render for the rest of the process's
 * life. Negative results are the ones worth remembering.
 */
const spriteCache = new Map<string, Image | null>();
const SPRITE_CACHE_MAX = 400;

export async function sprite(url: string): Promise<Image | null> {
  if (!url) return null;
  const hit = spriteCache.get(url);
  if (hit !== undefined) return hit;

  let img: Image | null = null;
  try {
    // A slow CDN must not hold a Discord interaction open past its deadline.
    // The card renders without the sprite instead.
    const res = await fetch(url, { signal: AbortSignal.timeout(6_000) });
    if (res.ok) {
      img = await loadImage(Buffer.from(await res.arrayBuffer()));
    }
  } catch {
    img = null;
  }

  // Simple FIFO eviction. An LRU would be better and is not worth the code:
  // the working set is "whatever is popular this week", which FIFO at this
  // size holds perfectly well.
  if (spriteCache.size >= SPRITE_CACHE_MAX) {
    const oldest = spriteCache.keys().next().value;
    if (oldest !== undefined) spriteCache.delete(oldest);
  }
  spriteCache.set(url, img);
  return img;
}

/** Draw a sprite scaled to FIT a box, centred, preserving aspect ratio.
 *  Sprites are pixel art, so smoothing is off — scaling them with
 *  interpolation is what makes a Pokémon sprite look like a smear. */
export function drawSpriteFit(
  ctx: SKRSContext2D,
  img: Image | null,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  if (!img) return;
  ctx.imageSmoothingEnabled = false;
  const scale = Math.min(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

// ── Shapes ──────────────────────────────────────────────────────────

export function roundRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function panel(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  opts: { fill?: string; edge?: string; radius?: number; accent?: string } = {},
): void {
  roundRect(ctx, x, y, w, h, opts.radius ?? 14);
  ctx.fillStyle = opts.fill ?? C.panel;
  ctx.fill();
  ctx.strokeStyle = opts.edge ?? C.panelEdge;
  ctx.lineWidth = 1;
  ctx.stroke();
  // Optional left accent stripe — used to colour a party row by the mon's
  // primary type without tinting the whole panel.
  if (opts.accent) {
    ctx.save();
    roundRect(ctx, x, y, w, h, opts.radius ?? 14);
    ctx.clip();
    ctx.fillStyle = opts.accent;
    ctx.fillRect(x, y, 5, h);
    ctx.restore();
  }
}

/** Rounded label chip — type badges, "SHINY", stat tags. */
export function pill(
  ctx: SKRSContext2D,
  text: string,
  x: number,
  y: number,
  opts: { fill?: string; color?: string; size?: number; padX?: number } = {},
): number {
  const size = opts.size ?? 15;
  const padX = opts.padX ?? 10;
  ctx.font = font(size, "bold");
  const w = ctx.measureText(text).width + padX * 2;
  const h = size + 10;
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = opts.fill ?? C.panelEdge;
  ctx.fill();
  ctx.fillStyle = opts.color ?? C.text;
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + padX, y + h / 2 + 1);
  return w;
}

/** Horizontal progress bar. `value` and `max` are clamped, so a stat that
 *  exceeds its nominal ceiling fills the bar rather than overflowing it. */
export function bar(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  value: number,
  max: number,
  color: string,
): void {
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = "#161b26";
  ctx.fill();
  const frac = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  if (frac > 0) {
    roundRect(ctx, x, y, Math.max(h, w * frac), h, h / 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
}

// ── Text ────────────────────────────────────────────────────────────

export function text(
  ctx: SKRSContext2D,
  s: string,
  x: number,
  y: number,
  opts: {
    size?: number;
    weight?: "normal" | "bold";
    color?: string;
    align?: "left" | "right" | "center";
    maxWidth?: number;
  } = {},
): void {
  ctx.font = font(opts.size ?? 16, opts.weight ?? "normal");
  ctx.fillStyle = opts.color ?? C.text;
  ctx.textAlign = opts.align ?? "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(opts.maxWidth ? ellipsize(ctx, s, opts.maxWidth) : s, x, y);
  ctx.textAlign = "left";
}

/** Truncate with an ellipsis to fit a width. Player-supplied strings
 *  (nicknames, trade text) reach these cards, and an over-long one must not
 *  run off the edge or overlap the next column. */
export function ellipsize(ctx: SKRSContext2D, s: string, maxWidth: number): string {
  if (ctx.measureText(s).width <= maxWidth) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(s.slice(0, mid) + "…").width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo) + "…";
}

// ── Card scaffold ───────────────────────────────────────────────────

export interface Card {
  // `Canvas`, not `ReturnType<typeof createCanvas>` — that signature is
  // overloaded and widens to a union with SvgCanvas, which has no toBuffer.
  canvas: Canvas;
  ctx: SKRSContext2D;
  w: number;
  h: number;
}

/** A card with the standard background: a vertical gradient plus a soft gold
 *  glow behind the header, so every card reads as the same product. */
export function newCard(w: number, h: number): Card {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");

  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, C.bg1);
  g.addColorStop(1, C.bg0);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  const glow = ctx.createRadialGradient(w * 0.5, -40, 0, w * 0.5, -40, w * 0.7);
  glow.addColorStop(0, "rgba(242,201,76,0.16)");
  glow.addColorStop(1, "rgba(242,201,76,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, 240);

  return { canvas, ctx, w, h };
}

/** Standard header: title, optional subtitle, and the brand mark on the right. */
export function header(card: Card, title: string, subtitle?: string): void {
  const { ctx, w } = card;
  text(ctx, title, 32, 56, { size: 32, weight: "bold", maxWidth: w - 220 });
  if (subtitle) text(ctx, subtitle, 32, 84, { size: 17, color: C.textDim, maxWidth: w - 220 });
  text(ctx, "POKÉMON IDLE", w - 32, 46, { size: 13, weight: "bold", color: C.goldDim, align: "right" });
}

export function toPng(card: Card): Buffer {
  return card.canvas.toBuffer("image/png");
}
