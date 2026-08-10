#!/usr/bin/env node
/**
 * Generate the Gen 3 (Hoenn) species data into src/data/gen3/.
 *
 *   npx vite-node scripts/gen-gen3.mjs
 *
 * ── TWO SOURCES, BECAUSE NEITHER HAS EVERYTHING ──────────────────────────
 *
 * @pkmn/dex (MIT, already a dependency) — types, base stats, abilities,
 *   evolutions, learnsets. Everything a battle simulator needs.
 *
 * PokéAPI — base experience yield, growth rate, catch rate, EV yield.
 *   Showdown does not model any of these because a competitive simulator
 *   never levels anything up or throws a ball, and this game does both. It is
 *   fetched ONCE, here, and the values are written into committed files: no
 *   runtime dependency on a third-party API, and the numbers are reviewable
 *   in a diff rather than arriving silently at boot.
 *
 * ── WHY SEPARATE MODULES RATHER THAN EDITS TO THE BIG TABLES ─────────────
 *
 * pokemon.ts, evolutions.ts, levelUpMoves.ts and friends are large, partly
 * hand-tuned, and generated once from `recovered/` by port-data.mjs. A
 * generator that rewrote them would put 125 new species and 288 existing ones
 * through the same code path, and the first time it got something subtly
 * wrong it would be wrong about Gen 1 too.
 *
 * So this only ever writes src/data/gen3/*, and the host tables spread those
 * in. The generated files are re-runnable and disposable; nothing that was
 * hand-tuned is ever in the blast radius.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────
 *
 * Alternate formes. Deoxys, Castform and the Megas are separate entries in
 * Showdown's dex and would each need their own key, sprite handling and
 * forme-change rules. Base formes only, which is exactly the 135 national dex
 * numbers 252–386.
 *
 * Sprites need nothing: utils/sprites.ts resolves them remotely by dex id.
 * Moves need nothing either — all 407 level-up moves these species use are
 * already in src/data/moves.ts, verified before this script was written.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { Dex } from "@pkmn/dex";
import { Generations } from "@pkmn/data";
import { moves as ourMoves } from "../src/data/moves.ts";
import { pokemonTable } from "../src/data/pokemon.ts";
import { abilityInfo } from "../src/data/abilities.ts";

// Newline as a named constant purely so the emit templates below never have
// to carry a backslash escape inside a nested template literal.
const LINE = String.fromCharCode(10);
const FIRST = 252;
const LAST = 386;
const OUT = new URL("../src/data/gen3/", import.meta.url);

const gens = new Generations(Dex);
const gen = gens.get(9);

/** Our species key: camelCase of the display name, punctuation stripped.
 *  "Mr. Mime" → mrMime, "Ho-Oh" → hoOh. Matches the existing table. */
function speciesKey(name) {
  const parts = name.replace(/[^A-Za-z0-9 -]/g, "").split(/[ -]+/).filter(Boolean);
  return parts
    .map((p, i) => (i === 0 ? p[0].toLowerCase() + p.slice(1) : p[0].toUpperCase() + p.slice(1)))
    .join("")
    .replace(/^(.)/, (c) => c.toLowerCase());
}

/** Showdown move id → OUR move key, built from our own table so a rename on
 *  either side shows up as a missing move rather than a silent mismatch. */
const moveKeyById = new Map(
  Object.entries(ourMoves).map(([key, m]) => [m.name.toLowerCase().replace(/[^a-z0-9]/g, ""), key]),
);

const GROWTH = {
  "slow": "slow", "medium": "mediumFast", "medium-slow": "mediumSlow",
  "fast": "fast", "slow-then-very-fast": "erratic", "fast-then-very-slow": "fluctuating",
};
const STAT = {
  hp: "hp", attack: "attack", defense: "defense",
  "special-attack": "spAttack", "special-defense": "spDefense", speed: "speed",
};

const species = Dex.species.all()
  .filter((s) => s.num >= FIRST && s.num <= LAST && !s.forme)
  .sort((a, b) => a.num - b.num);

console.log(`gen 3 base formes: ${species.length}`);

// ── PokéAPI, once ────────────────────────────────────────────────────────
// Serial with a small pause rather than 135 parallel requests: this runs by
// hand, occasionally, and being a good citizen of a free API costs a minute.
// Cached to disk between runs. 270 requests is a minute of waiting, and this
// script gets re-run every time the emit logic changes — which is exactly when
// you do NOT want a two-minute feedback loop, or to hammer a free API for
// numbers that have not changed since 2003.
const CACHE = new URL("../.gen3-pokeapi-cache.json", import.meta.url);
const cached = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};

const extra = new Map();
for (const [i, sp] of species.entries()) {
  if (cached[sp.num]) { extra.set(sp.num, cached[sp.num]); continue; }
  const r = await fetch(`https://pokeapi.co/api/v2/pokemon-species/${sp.num}/`);
  if (!r.ok) throw new Error(`pokeapi species ${sp.num}: ${r.status}`);
  const s = await r.json();
  const r2 = await fetch(`https://pokeapi.co/api/v2/pokemon/${sp.num}/`);
  if (!r2.ok) throw new Error(`pokeapi pokemon ${sp.num}: ${r2.status}`);
  const p = await r2.json();

  const growth = GROWTH[s.growth_rate?.name];
  if (!growth) throw new Error(`${sp.name}: unmapped growth rate ${s.growth_rate?.name}`);

  const evs = {};
  for (const st of p.stats ?? []) {
    if (st.effort > 0) evs[STAT[st.stat.name]] = st.effort;
  }
  extra.set(sp.num, {
    baseExpYield: p.base_experience,
    growthRate: growth,
    catchRate: s.capture_rate,
    evYield: evs,
  });
  cached[sp.num] = extra.get(sp.num);
  if ((i + 1) % 25 === 0) console.log(`  fetched ${i + 1}/${species.length}`);
  await new Promise((r) => setTimeout(r, 60));
}
writeFileSync(CACHE, JSON.stringify(cached), "utf8");

// ── Build ────────────────────────────────────────────────────────────────
const pokemon = [], evolutions = [], abilities = [], learn = [], evYields = [], catchRates = [];
const missingMoves = new Set();
// Evolution methods our trigger type cannot express, collected for the report
// at the end rather than swallowed.
const unusual = [];
// Evolution targets that are not in this game at all, dropped rather than
// emitted as a line the player could never complete.
const unreachable = [];
// Ability ids Showdown does not recognise — a key-derivation mismatch rather
// than a missing description, so worth reporting loudly.
const unknownAbilities = [];
const knownAbilityIds = new Set(Object.keys(abilityInfo));

for (const sp of species) {
  const key = speciesKey(sp.name);
  const x = extra.get(sp.num);
  const bs = sp.baseStats;

  pokemon.push(`  ${key}: {
    id: ${sp.num},
    name: ${JSON.stringify(sp.name)},
    types: [${sp.types.map((t) => JSON.stringify(t)).join(", ")}],
    baseStats: { hp: ${bs.hp}, attack: ${bs.atk}, defense: ${bs.def}, spAttack: ${bs.spa}, spDefense: ${bs.spd}, speed: ${bs.spe} },
    baseExpYield: ${x.baseExpYield},
    growthRate: ${JSON.stringify(x.growthRate)},
  },`);

  catchRates.push(`  ${key}: ${x.catchRate},`);
  if (Object.keys(x.evYield).length) {
    const pairs = Object.entries(x.evYield).map(([k, v]) => `${k}: ${v}`).join(", ");
    evYields.push(`  ${key}: { ${pairs} },`);
  }

  // Abilities. Showdown's slot 0/1 are the primaries and H is hidden, which is
  // exactly the shape src/data/abilities.ts uses — and the shape the evolution
  // slot-mapping depends on.
  const prim = [sp.abilities[0], sp.abilities[1]].filter(Boolean).map((a) => abilityKey(a));
  const hidden = sp.abilities.H ? abilityKey(sp.abilities.H) : null;
  abilities.push(
    `  ${key}: { primary: [${prim.map((a) => JSON.stringify(a)).join(", ")}]${hidden ? `, hidden: ${JSON.stringify(hidden)}` : ""} },`,
  );

  // Evolutions. Read from the CHILD (`prevo` + `evoLevel`) because that is
  // where Showdown records the condition, then emitted parent-first to match
  // our table's direction.
  //
  // `prevo` is the DISPLAY NAME ("Treecko"), not the id — comparing it to
  // `sp.id` matched nothing and produced a file with zero evolutions, which
  // is the kind of empty output that looks like "this species has no
  // evolutions" rather than like a bug.
  const kids = Dex.species.all().filter((c) => c.prevo === sp.name && !c.forme)
    // Only evolutions we can actually REACH. Several Gen 3 species evolve into
    // Gen 4 ones — Nosepass into Probopass, Roselia into Roserade, Dusclops
    // into Dusknoir — and those species are not in this game. An evolution
    // pointing at a species the dex has never heard of is a line the player
    // can see, be told they are ready for, and never complete.
    //
    // COMPLETE_EVOLUTION does degrade politely ("its evolution isn't available
    // yet") rather than crashing, but that message is for a data mistake, not
    // for something we knew at generation time.
    .filter((c) => {
      const k = speciesKey(c.name);
      const inRange = c.num >= FIRST && c.num <= LAST;
      if (inRange || pokemonTable[k]) return true;
      unreachable.push(`${sp.name} -> ${c.name} (#${c.num}, not in this game)`);
      return false;
    });
  if (kids.length) {
    const triggers = kids.map((c) => {
      const into = speciesKey(c.name);
      if (c.evoType === "levelFriendship") return `{ into: ${JSON.stringify(into)}, level: ${c.evoLevel ?? 20} }`;
      if (c.evoLevel) return `{ into: ${JSON.stringify(into)}, level: ${c.evoLevel} }`;
      // `item`, not `stone` — EvolutionTrigger's field name, and the existing
      // table already uses lowercase-no-punctuation keys ("thunderstone",
      // "moonstone"), which is what stoneKey produces.
      if (c.evoType === "useItem" && c.evoItem) return `{ into: ${JSON.stringify(into)}, item: ${JSON.stringify(stoneKey(c.evoItem))} }`;
      if (c.evoType === "trade") return `{ into: ${JSON.stringify(into)}, trade: true }`;
      // Anything else (location, move-known, time-of-day, party state) has no
      // representation in our trigger type. Emitted as a plain level so the
      // line is REACHABLE rather than a dead end, and listed at the end of the
      // run so the odd ones can be hand-tuned.
      unusual.push(`${sp.name} -> ${c.name} (${c.evoType ?? "?"})`);
      return `{ into: ${JSON.stringify(into)}, level: ${c.evoLevel ?? 30} }`;
    });
    evolutions.push(`  ${key}: [${triggers.join(", ")}],`);
  }

  // Level-up moves, gen 9 learnset.
  const ls = await gen.learnsets.get(sp.id);
  const rows = [];
  for (const [mv, srcs] of Object.entries(ls?.learnset ?? {})) {
    const lv = srcs.map((s) => /^\d+L(\d+)$/.exec(s)).filter(Boolean).map((m) => Number(m[1]));
    if (!lv.length) continue;
    const ourKey = moveKeyById.get(mv);
    if (!ourKey) { missingMoves.add(mv); continue; }
    rows.push([Math.min(...lv), ourKey]);
  }
  rows.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
  learn.push(`  ${key}: [\n${rows.map(([l, m]) => `    [${l}, ${JSON.stringify(m)}],`).join("\n")}\n  ],`);
}

function abilityKey(name) {
  const parts = String(name).replace(/[^A-Za-z0-9 -]/g, "").split(/[ -]+/).filter(Boolean);
  return parts.map((p, i) => (i === 0 ? p.toLowerCase() : p[0].toUpperCase() + p.slice(1).toLowerCase())).join("");
}
function stoneKey(item) {
  return String(item).toLowerCase().replace(/[^a-z0-9]/g, "");
}

const HEAD = (what) => `// GENERATED by scripts/gen-gen3.mjs — do not edit by hand.
//
// ${what} for the 135 Gen 3 species (national dex ${FIRST}–${LAST}, base formes
// only). Sources: @pkmn/dex for battle data, PokéAPI for the growth/catch/EV
// numbers Showdown does not model. Regenerate with:
//     npx vite-node scripts/gen-gen3.mjs
`;

mkdirSync(OUT, { recursive: true });
const w = (file, body) => writeFileSync(new URL(file, OUT), body, "utf8");

w("pokemon.ts", `${HEAD("Species entries")}
import type { PokemonSpecies } from "../../types";

export const gen3Pokemon: Record<string, PokemonSpecies> = {
${pokemon.join("\n")}
};
`);
w("evolutions.ts", `${HEAD("Evolution triggers")}
import type { EvolutionTrigger } from "../../types";

export const gen3Evolutions: Record<string, EvolutionTrigger[]> = {
${evolutions.join("\n")}
};
`);
w("abilities.ts", `${HEAD("Ability slots")}
export const gen3Abilities: Record<string, { primary: string[]; hidden?: string }> = {
${abilities.join("\n")}
};
`);
w("levelUpMoves.ts", `${HEAD("Level-up learnsets")}
export const gen3LevelUpMoves: Record<string, [number, string][]> = {
${learn.join("\n")}
};
`);
w("evYields.ts", `${HEAD("EV yields")}
import type { Stats } from "../../types";

export const gen3EvYields: Record<string, Partial<Stats>> = {
${evYields.join("\n")}
};
`);
// Ability descriptions for anything Gen 3 introduces that the hand-written
// abilityInfo table does not already cover.
//
// Without these the UI renders a blank chip: the mon HAS the ability, the
// battle engine may or may not implement it, and the player is shown nothing
// at all where a name and a sentence belong. Twenty of them on first run.
//
// The text is Showdown's own shortDesc, same source as the move descriptions,
// and it describes MECHANICS rather than flavour — which is the right register
// for a tooltip whose job is "what does this do to my battle".
const abilityDocs = [];
for (const id of [...new Set(
  abilities.flatMap((line) => [...line.matchAll(/"([a-zA-Z0-9]+)"/g)].map((m) => m[1])),
)].sort()) {
  if (knownAbilityIds.has(id)) continue;
  const a = Dex.abilities.all().find((x) => abilityKey(x.name) === id);
  if (!a) { unknownAbilities.push(id); continue; }
  abilityDocs.push(`  ${id}: { name: ${JSON.stringify(a.name)}, description: ${JSON.stringify(a.shortDesc || a.desc || "No in-battle effect yet.")} },`);
}

w("abilityInfo.ts", `${HEAD("Ability descriptions")}
import type { AbilityInfo } from "../abilities";

export const gen3AbilityInfo: Record<string, AbilityInfo> = {
${abilityDocs.join(LINE)}
};
`);

w("catchRates.ts", `${HEAD("Catch rates")}
export const gen3CatchRates: Record<string, number> = {
${catchRates.join("\n")}
};
`);

console.log(`\nwrote ${species.length} species`);
console.log(`evolution lines: ${evolutions.length}`);
if (unreachable.length) {
  console.log(`
evolution targets dropped as not-in-this-game (${unreachable.length}):`);
  unreachable.forEach((u) => console.log("  " + u));
}
if (unusual.length) {
  console.log(`\nevolution methods with no representation in our trigger type (${unusual.length}) — emitted as plain level, hand-tune if it matters:`);
  unusual.forEach((u) => console.log("  " + u));
}
if (unknownAbilities.length) {
  console.log(`
ability ids Showdown does not know (${unknownAbilities.length}) — key derivation mismatch:`);
  console.log("  " + unknownAbilities.join(", "));
}
if (missingMoves.size) {
  console.log(`\nlearnset moves absent from our move table (${missingMoves.size}):`);
  console.log("  " + [...missingMoves].join(", "));
}
