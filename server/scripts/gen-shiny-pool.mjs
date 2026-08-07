// Generates the default shiny pool the referral milestone draws from.
//
// ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────
// The 10-friend bonus is meant to hand over "a random shiny", and the server
// cannot build a Pokémon: it has no species table and no stat formula, so a
// mon it invented would have invented stats — the bug that once handed out a
// Lv50 Charizard with 24 HP.
//
// The first answer was an admin panel button. That works, and it was still
// wrong: it made the feature depend on somebody pressing something before it
// did what it says. A referral card that promises a shiny only after an
// operator remembers to stock a pool is a card that lies by default.
//
// So the pool is built ONCE, here, and committed. The mons are real, built by
// the SAME createPokemon the prize builder uses — this script bundles the
// admin's gameCatalog with esbuild rather than reimplementing the formula,
// because a second implementation of a stat formula is exactly the bug above
// wearing a different hat.
//
// The admin button stays. It is how an operator curates a pool they care
// about; this is what everyone gets until they do.
//
//   cd server && node scripts/gen-shiny-pool.mjs
//
// Re-run it if the species snapshot changes. The output is deterministic —
// the species are chosen by a fixed stride, not at random — so re-running it
// without a catalog change produces no diff.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ADMIN = resolve(import.meta.dirname, "..", "..", "admin");
const OUT = resolve(import.meta.dirname, "..", "src", "data", "defaultShinyPool.json");

/** How many mons the pool holds. */
const POOL_SIZE = 24;
/** The level every one is built at. */
const LEVEL = 5;

// gameCatalog.ts is TypeScript importing JSON, which Node cannot load
// directly. esbuild already ships with the admin's vite, so bundle it to a
// throwaway ESM file and import THAT — the real module, not a copy of it.
const tmp = mkdtempSync(join(tmpdir(), "shinypool-"));
const bundle = join(tmp, "catalog.mjs");
try {
  // `shell: true` because on Windows npx is a .cmd, and spawnSync refuses to
  // exec one directly (EINVAL) — the shell is what knows how to run it.
  execFileSync(
    "npx",
    ["esbuild", "src/data/gameCatalog.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${bundle}`],
    { cwd: ADMIN, stdio: ["ignore", "ignore", "inherit"], shell: true },
  );

  const { createPokemon, POKEMON_LIST } = await import(`file:///${bundle.replace(/\\/g, "/")}`);

  // ── NOTHING RAIDS EXIST TO AWARD ─────────────────────────────────
  // The first run of this generator handed out Zapdos, Regice, Dialga and
  // Cobalion. Raids are the content built to make those species worth
  // chasing, and a referral link that pays one out for free is that content
  // undercut by a promotion.
  //
  // The exclusion is the raid POOL rather than a hand-kept list of
  // legendaries, because the pool is already the game's own answer to "what
  // is rare enough to be raid-worthy" — it costs a few ordinary species
  // (Pichu, Larvitar) that happen to live in the lower tiers, and 230 remain
  // to draw 24 from.
  const legBundle = join(tmp, "legendaries.mjs");
  execFileSync(
    "npx",
    ["esbuild", "../game/src/data/raidLegendaries.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${legBundle}`],
    { cwd: ADMIN, stdio: ["ignore", "ignore", "inherit"], shell: true },
  );
  const { raidLegendaries } = await import(`file:///${legBundle.replace(/\\/g, "/")}`);
  const excluded = new Set(raidLegendaries.map((l) => l.speciesKey));

  const eligible = POKEMON_LIST.filter((sp) => !excluded.has(sp.speciesKey));

  // A fixed stride rather than Math.random(): a generator that emits a
  // different file every run turns "did the catalog change?" into a question
  // nobody can answer from the diff.
  const stride = Math.max(1, Math.floor(eligible.length / POOL_SIZE));
  const pool = [];
  for (let i = 0; pool.length < POOL_SIZE && i < eligible.length; i += stride) {
    const sp = eligible[i];
    if (!sp) continue;
    try {
      const mon = createPokemon(sp.speciesKey, LEVEL, 1_000_000 + pool.length, true);
      pool.push({ kind: "pokemon", label: `Shiny ${sp.name} Lv${LEVEL}`, mon });
    } catch {
      // A species the catalog cannot build (missing base stats) is skipped
      // rather than allowed to abort the whole pool.
    }
  }

  if (pool.length < 8) {
    throw new Error(`only built ${pool.length} shinies — the catalog is probably broken`);
  }

  writeFileSync(OUT, JSON.stringify(pool, null, 2) + "\n", "utf8");
  console.log(`wrote ${pool.length} shinies to ${OUT}`);
  console.log(pool.map((p) => p.label).join(", "));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
