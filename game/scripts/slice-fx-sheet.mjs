#!/usr/bin/env node
/**
 * Slice a generated FX sheet into individual transparent sprites.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 * The vendored Showdown sprites are mostly soft radial gradients — eleven of
 * the most-used ones (wisp, shadowball, energyball, electroball, mistball,
 * iceball, flareball and friends) are literally fuzzy coloured circles with
 * no shape or texture. On this game's detailed painted backgrounds they read
 * as smudges, which is the ceiling the animations kept running into after the
 * timing, opacity and blending were all fixed.
 *
 * The replacements are generated as one sheet (see docs/battle-fx-art.md for
 * the prompt). A generated sheet is not a sprite set, though: it arrives as a
 * grid on an opaque background at whatever size the model felt like. This
 * turns one into the other, deterministically, so re-generating the art is a
 * two-command operation rather than an afternoon in an image editor.
 *
 * ── WHAT IT DOES ─────────────────────────────────────────────────────────
 *   1. Cuts the sheet into cells on a fixed grid.
 *   2. Makes the background transparent by flood-filling from the cell's
 *      corners, NOT by keying every pixel of that colour — a white key would
 *      punch holes through the white highlight in the middle of a flame.
 *   3. Trims each cell to its ink and writes it at the size the sprite table
 *      declares, so nothing downstream has to change.
 *
 * Usage:  node scripts/slice-fx-sheet.mjs <sheet.png>
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// Resolved out of bot/, which already depends on it for the Discord card
// renderer. Deliberately NOT added to game/package.json: this runs by hand
// when the art is regenerated and has no business in the client's install.
const { createCanvas, loadImage } = await import(
  pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bot",
    "node_modules", "@napi-rs", "canvas", "index.js")).href
);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "public", "fx");

/** Grid position -> the sprite it replaces, and the size to write it at.
 *  The sizes are the DISPLAY sizes already in battleFxSprites.ts, so the
 *  engine and every ported animation keep working untouched. */
const CELLS = [
  { col: 0, row: 0, file: "fireball.png",    w: 64,  h: 64  },
  { col: 1, row: 0, file: "electroball.png", w: 100, h: 100 },
  { col: 2, row: 0, file: "iceball.png",     w: 100, h: 100 },
  { col: 0, row: 1, file: "energyball.png",  w: 100, h: 100 },
  { col: 1, row: 1, file: "shadowball.png",  w: 100, h: 100 },
  { col: 2, row: 1, file: "mistball.png",    w: 100, h: 100 },
];

const COLS = 3;
const ROWS = 2;

/** Colour distance, squared, in plain RGB. Good enough to tell "the paper"
 *  from "the drawing" and cheap enough to run per pixel. */
function near(d, i, r, g, b, tol) {
  const dr = d[i] - r, dg = d[i + 1] - g, db = d[i + 2] - b;
  return dr * dr + dg * dg + db * db <= tol * tol;
}

/**
 * Erase the background by flooding inward from the edges.
 *
 * Keying on colour alone would delete every pixel matching the background,
 * including the pale highlight at the heart of the flame and the white
 * glints inside the ice. Only pixels REACHABLE from the border are outside
 * the sprite, so that is the rule.
 */
function cutBackground(img, tol = 60) {
  const { width: w, height: h, data } = img;
  // Sample the four corners and take the median-ish one, so a stray dark
  // pixel in one corner does not define the whole background.
  const corners = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + w - 1) * 4];
  const r = Math.round(corners.reduce((s, i) => s + data[i], 0) / 4);
  const g = Math.round(corners.reduce((s, i) => s + data[i + 1], 0) / 4);
  const b = Math.round(corners.reduce((s, i) => s + data[i + 2], 0) / 4);

  const seen = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) { stack.push(x, x + (h - 1) * w); }
  for (let y = 0; y < h; y++) { stack.push(y * w, y * w + w - 1); }

  while (stack.length) {
    const p = stack.pop();
    if (seen[p]) continue;
    const i = p * 4;
    if (!near(data, i, r, g, b, tol)) continue;
    seen[p] = 1;
    data[i + 3] = 0;
    const x = p % w, y = (p / w) | 0;
    if (x > 0)     stack.push(p - 1);
    if (x < w - 1) stack.push(p + 1);
    if (y > 0)     stack.push(p - w);
    if (y < h - 1) stack.push(p + w);
  }
  return img;
}

/** The bounding box of everything still opaque. */
function inkBounds(img) {
  const { width: w, height: h, data } = img;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

async function main() {
  const sheetPath = process.argv[2];
  if (!sheetPath) {
    console.error("usage: node scripts/slice-fx-sheet.mjs <sheet.png>");
    process.exit(1);
  }
  await mkdir(OUT_DIR, { recursive: true });
  const sheet = await loadImage(await readFile(sheetPath));
  const cellW = Math.floor(sheet.width / COLS);
  const cellH = Math.floor(sheet.height / ROWS);
  console.log(`sheet ${sheet.width}x${sheet.height}, cells ${cellW}x${cellH}`);

  for (const cell of CELLS) {
    // Cut the cell.
    const c = createCanvas(cellW, cellH);
    const cx = c.getContext("2d");
    cx.drawImage(sheet, cell.col * cellW, cell.row * cellH, cellW, cellH, 0, 0, cellW, cellH);

    const img = cx.getImageData(0, 0, cellW, cellH);
    cutBackground(img);
    cx.putImageData(img, 0, 0);

    const box = inkBounds(cx.getImageData(0, 0, cellW, cellH));
    if (!box) { console.log(`  ${cell.file.padEnd(18)} EMPTY — skipped`); continue; }

    // Trim to the ink and scale to the declared display size. Nearest
    // neighbour: this is pixel art, and smoothing it would undo the entire
    // reason for replacing the old blurry sprites.
    const out = createCanvas(cell.w, cell.h);
    const ox = out.getContext("2d");
    ox.imageSmoothingEnabled = false;
    ox.drawImage(c, box.x, box.y, box.w, box.h, 0, 0, cell.w, cell.h);

    await writeFile(join(OUT_DIR, cell.file), out.toBuffer("image/png"));
    console.log(`  ${cell.file.padEnd(18)} ink ${box.w}x${box.h} -> ${cell.w}x${cell.h}`);
  }
  console.log(`\nWrote ${CELLS.length} sprites to public/fx/`);
}

main().catch((e) => { console.error(e); process.exit(1); });
