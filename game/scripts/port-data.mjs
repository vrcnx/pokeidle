// Convert recovered data files into TypeScript modules.
// Each recovered file declares `const X = { ... }` (or chained) — we strip
// that wrapper and replace with a typed `export const`.

import fs from "node:fs";
import path from "node:path";

const RECOVERED = "../recovered/data";
const OUT = "src/data";

// (recovered file, output file, exported name, type annotation, transform)
const files = [
  ["pokemon_table.js",      "pokemon.ts",            "pokemonTable",        "Record<string, PokemonSpecies>"],
  ["evolutions.js",         "evolutions.ts",         "evolutions",          "Record<string, EvolutionTrigger[]>"],
  ["level_up_moves.js",     "levelUpMoves.ts",       "levelUpMoves",        "Record<string, [number, string][]>"],
  ["routes.js",             "routes.ts",             "routes",              "Record<string, Route>"],
  ["consumables.js",        "consumables.ts",        "consumables",         "Record<string, ConsumableDef>"],
  ["pokeballs.js",          "pokeballs.ts",          "pokeballs",           "Record<string, BallDef>"],
  ["evolution_stones.js",   "evolutionStones.ts",    "evolutionStones",     "Record<string, EvolutionStone>"],
  ["moves.js",              "moves.ts",              "moves",               "Record<string, MoveDef>"],
  ["trainer_class_sprites.js", "trainerClassSprites.ts", "trainerClassSprites", "Record<string, string>"],
  ["trainer_class_levels.js",  "trainerClassLevels.ts",  "trainerClassLevels",  "Record<string, number>"],
  ["gym_leaders.js",        "gymLeaders.ts",         "gymLeaders",          "GymLeader[]"],
  ["type_chart.js",         "typeChart.ts",          "typeChart",           "Record<PokemonType, Partial<Record<PokemonType, number>>>"],
  ["catch_rates.js",        "catchRates.ts",         "catchRates",          "Record<string, number>"],
  ["shops.js",              "shops.ts",              "shops",               "Record<string, ShopDef>"],
  ["changelog.js",          "changelog.ts",          "changelog",           "ChangelogEntry[]"],
];

const TYPE_IMPORTS = {
  "pokemon.ts":            ["PokemonSpecies"],
  "evolutions.ts":         ["EvolutionTrigger"],
  "levelUpMoves.ts":       [],
  "routes.ts":             ["Route"],
  "consumables.ts":        ["ConsumableDef"],
  "pokeballs.ts":          ["BallDef"],
  "evolutionStones.ts":    ["EvolutionStone"],
  "moves.ts":              ["MoveDef"],
  "trainerClassSprites.ts": [],
  "trainerClassLevels.ts": [],
  "gymLeaders.ts":         ["GymLeader"],
  "typeChart.ts":          ["PokemonType"],
  "catchRates.ts":         [],
  "shops.ts":              ["ShopDef"],
  "changelog.ts":          [],
};

function normalize(src) {
  // Strip the leading recovery comments
  let s = src.replace(/^\/\/[^\n]*\n/gm, "");
  // Remove leading blank lines
  s = s.replace(/^\s+/, "");
  return s;
}

function extractObjectBody(src) {
  // Source is either:
  //   const Foo = { ... };
  //   const Foo = { ... }, Bar = ...;     (chain — we want only the first)
  //   Foo = { ... },                       (continuation of an outer chain)
  // We slice from the first '{' to its matching '}' (or '[' .. ']').
  let i = 0;
  while (i < src.length && src[i] !== "{" && src[i] !== "[") i++;
  if (i === src.length) throw new Error("no { or [ found");
  const open = src[i];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = null;
  let j = i;
  while (j < src.length) {
    const ch = src[j];
    if (inStr) {
      if (ch === "\\") { j += 2; continue; }
      if (ch === inStr) inStr = null;
    } else {
      if (ch === '"' || ch === "'" || ch === "`") inStr = ch;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) { j++; break; }
      }
    }
    j++;
  }
  return src.slice(i, j);
}

fs.mkdirSync(OUT, { recursive: true });

for (const [inFile, outFile, exportName, typeAnnot] of files) {
  const inPath = path.join(RECOVERED, inFile);
  const outPath = path.join(OUT, outFile);
  const src = fs.readFileSync(inPath, "utf8");
  const cleaned = normalize(src);
  const body = extractObjectBody(cleaned);
  const imports = TYPE_IMPORTS[outFile] || [];
  const importLine = imports.length
    ? `import type { ${imports.join(", ")} } from "../types";\n`
    : "";
  const out = importLine
    ? `${importLine}\nexport const ${exportName}: ${typeAnnot} = ${body};\n`
    : `export const ${exportName}: ${typeAnnot} = ${body};\n`;
  fs.writeFileSync(outPath, out);
  console.log(`wrote ${outPath}`);
}
