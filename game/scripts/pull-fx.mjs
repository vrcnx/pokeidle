#!/usr/bin/env node
/**
 * Vendor Pokémon Showdown's battle-effect sprites into public/fx/.
 *
 * Same shape as pull-tms.mjs: a snapshot is checked in rather than fetched at
 * runtime, so the game does not depend on a third party being up, and a
 * change to their assets cannot silently change ours.
 *
 * ── LICENSING, WHICH IS THE WHOLE REASON THIS IS A SCRIPT ────────────────
 * The fx/ folder is CC0 (public domain) per the header of Showdown's
 * battle-animations.ts — but with named exceptions, and the exceptions are
 * the interesting part:
 *
 *   "This license DOES extend to all images in the fx/ folder, with the
 *    exception of icicle.png, lightning.png, and bone.png."
 *   "icicle.png and lightning.png by Clint Bellanger are triple-licensed
 *    GPLv2/GPLv3/CC-BY-SA-3.0."
 *   "rocks.png, rock1.png, rock2.png by PO user 'Gilad' is licensed GPLv3."
 *
 * Encoding that as an EXCLUDED map with a reason per file — rather than as a
 * note in a README nobody reads — means the next person to run this cannot
 * accidentally pull GPL art into the bundle, and the reason travels with the
 * decision. Everything skipped is replaced by CSS we already have.
 *
 * Usage:  node scripts/pull-fx.mjs
 */

import { mkdir, writeFile, readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "public", "fx");
const TABLE_OUT = join(ROOT, "src", "data", "battleFxSprites.ts");
const BASE = "https://play.pokemonshowdown.com/fx/";
const SOURCE = "https://github.com/smogon/pokemon-showdown-client";

/**
 * Not downloaded, with the reason. Two kinds:
 *
 *   licence  — carved out of the CC0 grant. We are not shipping GPL art in a
 *              bundle we distribute to browsers just to draw an icicle.
 *   unused   — ripped from Nintendo (or elsewhere) AND for a mechanic this
 *              game does not have. No upside to carrying either risk.
 */
const EXCLUDED = {
  "icicle.png":      "licence: GPLv2/GPLv3/CC-BY-SA-3.0 (Clint Bellanger). Use our .ice-particle CSS.",
  "icicle-pink.png": "licence: recolour of icicle.png, so the same triple licence follows it.",
  "lightning.png":   "licence: GPLv2/GPLv3/CC-BY-SA-3.0 (Clint Bellanger). Use our .electric-bolt CSS.",
  "bone.png":        "licence: named as an exception to the CC0 grant with NO licence stated at all.",
  "rocks.png":       "licence: GPLv3 (PO user 'Gilad'). rock3.png is CC0 and covers the same moves.",
  "rock1.png":       "licence: GPLv3 (PO user 'Gilad').",
  "rock2.png":       "licence: GPLv3 (PO user 'Gilad').",
  "alpha.png":       "unused: ripped from Pokémon Global Link; Primal Reversion is Gen 6, we end at Gen 5.",
  "omega.png":       "unused: ripped from Pokémon Global Link; Primal Reversion is Gen 6, we end at Gen 5.",
  "z-symbol.png":    "unused: Z-moves are Gen 7.",
  "ultra.png":       "unused: Ultra Burst is Gen 7.",
};

/**
 * The table from Showdown's `BattleEffects`, with their DECLARED dimensions.
 *
 * The numbers are load-bearing, not documentation: showEffect scales a sprite
 * by `w`/`h` rather than by its intrinsic size, so a file whose real
 * dimensions disagree would render at the wrong size in every animation that
 * uses it. The script checks each download against them.
 */
const SPRITES = [
  { name: "wisp", file: "wisp.png", w: 100, h: 100 },
  { name: "poisonwisp", file: "poisonwisp.png", w: 100, h: 100 },
  { name: "waterwisp", file: "waterwisp.png", w: 100, h: 100 },
  { name: "mudwisp", file: "mudwisp.png", w: 100, h: 100 },
  { name: "blackwisp", file: "blackwisp.png", w: 100, h: 100 },
  { name: "fireball", file: "fireball.png", w: 64, h: 64 },
  { name: "bluefireball", file: "bluefireball.png", w: 64, h: 64 },
  { name: "icicle", file: "icicle.png", w: 80, h: 60 },
  { name: "pinkicicle", file: "icicle-pink.png", w: 80, h: 60 },
  { name: "lightning", file: "lightning.png", w: 41, h: 229 },
  { name: "rocks", file: "rocks.png", w: 100, h: 100 },
  { name: "rock1", file: "rock1.png", w: 64, h: 80 },
  { name: "rock2", file: "rock2.png", w: 66, h: 72 },
  { name: "rock3", file: "rock3.png", w: 66, h: 72 },
  { name: "leaf1", file: "leaf1.png", w: 32, h: 26 },
  { name: "leaf2", file: "leaf2.png", w: 40, h: 26 },
  { name: "bone", file: "bone.png", w: 29, h: 29 },
  { name: "caltrop", file: "caltrop.png", w: 80, h: 80 },
  { name: "greenmetal1", file: "greenmetal1.png", w: 45, h: 45 },
  { name: "greenmetal2", file: "greenmetal2.png", w: 45, h: 45 },
  { name: "poisoncaltrop", file: "poisoncaltrop.png", w: 80, h: 80 },
  { name: "shadowball", file: "shadowball.png", w: 100, h: 100 },
  { name: "energyball", file: "energyball.png", w: 100, h: 100 },
  { name: "electroball", file: "electroball.png", w: 100, h: 100 },
  { name: "mistball", file: "mistball.png", w: 100, h: 100 },
  { name: "iceball", file: "iceball.png", w: 100, h: 100 },
  { name: "flareball", file: "flareball.png", w: 100, h: 100 },
  { name: "moon", file: "moon.png", w: 100, h: 100 },
  { name: "pokeball", file: "pokeball.png", w: 24, h: 24 },
  { name: "fist", file: "fist.png", w: 55, h: 49 },
  { name: "fist1", file: "fist1.png", w: 49, h: 55 },
  { name: "foot", file: "foot.png", w: 50, h: 75 },
  { name: "topbite", file: "topbite.png", w: 108, h: 64 },
  { name: "bottombite", file: "bottombite.png", w: 108, h: 64 },
  { name: "web", file: "web.png", w: 120, h: 122 },
  { name: "leftclaw", file: "leftclaw.png", w: 44, h: 60 },
  { name: "rightclaw", file: "rightclaw.png", w: 44, h: 60 },
  { name: "leftslash", file: "leftslash.png", w: 57, h: 56 },
  { name: "rightslash", file: "rightslash.png", w: 57, h: 56 },
  { name: "leftchop", file: "leftchop.png", w: 100, h: 130 },
  { name: "rightchop", file: "rightchop.png", w: 100, h: 130 },
  { name: "angry", file: "angry.png", w: 30, h: 30 },
  { name: "heart", file: "heart.png", w: 30, h: 30 },
  { name: "pointer", file: "pointer.png", w: 100, h: 100 },
  { name: "sword", file: "sword.png", w: 48, h: 100 },
  { name: "impact", file: "impact.png", w: 127, h: 119 },
  { name: "stare", file: "stare.png", w: 100, h: 35 },
  { name: "shine", file: "shine.png", w: 127, h: 119 },
  { name: "feather", file: "feather.png", w: 100, h: 38 },
  { name: "shell", file: "shell.png", w: 100, h: 91.5 },
  { name: "petal", file: "petal.png", w: 60, h: 60 },
  { name: "gear", file: "gear.png", w: 100, h: 100 },
  { name: "alpha", file: "alpha.png", w: 80, h: 80 },
  { name: "omega", file: "omega.png", w: 80, h: 80 },
  { name: "rainbow", file: "rainbow.png", w: 128, h: 128 },
  { name: "zsymbol", file: "z-symbol.png", w: 150, h: 100 },
  { name: "ultra", file: "ultra.png", w: 113, h: 165 },
  { name: "hitmark", file: "hitmarker.png", w: 100, h: 100 },
];

/** Width/height out of a PNG's IHDR — 8-byte signature, 4-byte length,
 *  4-byte "IHDR", then two big-endian uint32s. Enough to catch a 404 page
 *  saved as a .png, or a sprite that has been resized since the table was
 *  written. */
function pngSize(buf) {
  const sig = "89504e470d0a1a0a";
  if (buf.length < 24 || buf.subarray(0, 8).toString("hex") !== sig) return null;
  if (buf.subarray(12, 16).toString("ascii") !== "IHDR") return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const wanted = SPRITES.filter((s) => !EXCLUDED[s.file]);
  const skipped = SPRITES.filter((s) => EXCLUDED[s.file]);

  console.log(`${SPRITES.length} sprites in BattleEffects`);
  console.log(`  ${wanted.length} to download`);
  console.log(`  ${skipped.length} skipped:`);
  for (const s of skipped) console.log(`     ${s.file.padEnd(18)} ${EXCLUDED[s.file]}`);
  console.log();

  const mismatched = [];
  const failed = [];
  let bytes = 0;

  for (const s of wanted) {
    const res = await fetch(BASE + s.file);
    if (!res.ok) {
      failed.push(`${s.file}: HTTP ${res.status}`);
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const real = pngSize(buf);
    if (!real) {
      failed.push(`${s.file}: not a PNG (${buf.length} bytes)`);
      continue;
    }
    // Showdown's table rounds: `shell` is declared 100×91.5. Allow a pixel.
    if (Math.abs(real.w - s.w) > 1 || Math.abs(real.h - s.h) > 1) {
      mismatched.push(`${s.file}: table says ${s.w}×${s.h}, file is ${real.w}×${real.h}`);
    }
    await writeFile(join(OUT_DIR, s.file), buf);
    bytes += buf.length;
  }

  await writeFile(join(OUT_DIR, "PROVENANCE.md"), provenance(wanted, skipped), "utf8");
  await writeFile(TABLE_OUT, spriteTable(wanted), "utf8");

  console.log(`Wrote ${wanted.length - failed.length} files, ${(bytes / 1024).toFixed(0)} KB`);
  if (mismatched.length) {
    console.log(`\nDIMENSION MISMATCHES (showEffect scales by the TABLE, not the file):`);
    for (const m of mismatched) console.log(`  ${m}`);
  }
  if (failed.length) {
    console.log(`\nFAILED:`);
    for (const f of failed) console.log(`  ${f}`);
    process.exitCode = 1;
  }
}

/**
 * Emit the sprite table the client reads.
 *
 * Generated rather than hand-kept because the download and the table have to
 * agree: a name in the table with no file behind it is a silent broken image
 * mid-battle, and a file nobody references is dead weight in the bundle.
 */
function spriteTable(wanted) {
  return `// GENERATED by scripts/pull-fx.mjs — do not edit.
//
// Pokémon Showdown's \`BattleEffects\`, limited to the sprites we actually
// vendored. See public/fx/PROVENANCE.md for the licence and for what was
// deliberately left out.
//
// ── w/h ARE THE DISPLAY SIZE, NOT THE FILE'S ────────────────────────────
// showEffect scales a sprite by these numbers, and several files on disk are
// a different size on purpose: fireball.png is 32×32 drawn at 64×64 (pixel
// art, doubled), shell.png is 200×183 drawn at 100×91.5 (a 2× asset). Sizing
// from the image's intrinsic dimensions instead would render half of these
// at the wrong scale, so the table is authoritative and the images are told
// what size to be.

export interface FxSprite {
  /** Path under public/. */
  url: string;
  w: number;
  h: number;
}

export const FX_SPRITES: Record<string, FxSprite> = {
${wanted.map((s) => `  ${s.name}: { url: "/fx/${s.file}", w: ${s.w}, h: ${s.h} },`).join("\n")}
};

export type FxSpriteName = keyof typeof FX_SPRITES;
`;
}

function provenance(wanted, skipped) {
  return `# Battle effect sprites

Vendored from Pokémon Showdown's client by \`scripts/pull-fx.mjs\`.
Do not edit by hand — re-run the script.

Source: ${SOURCE}
        ${BASE}

## Licence

These images are **CC0 (public domain)**, per the header of Showdown's
\`battle-animations.ts\`:

> Most of this file is: CC0 (public domain)
> This license DOES extend to all images in the fx/ folder, with the
> exception of icicle.png, lightning.png, and bone.png.

CC0 requires no attribution. The individual artists are credited in
Showdown's source anyway, and several of these are theirs rather than
Nintendo's — Kalalokki, SailorCosmos, Modeling Clay, Jajoken, Ridaz.

## Deliberately NOT vendored

The exceptions above are excluded, along with art for mechanics this game
does not have. Each one is listed in \`EXCLUDED\` in the script with its
reason, so the decision cannot be lost.

${skipped.map((s) => `- \`${s.file}\` — ${EXCLUDED[s.file]}`).join("\n")}

## Files (${wanted.length})

${wanted.map((s) => `- \`${s.file}\` — \`${s.name}\`, ${s.w}×${s.h}`).join("\n")}
`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
