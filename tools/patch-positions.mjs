// One-shot script: read positions JSON, patch routes.ts in-place.
// Usage: node tools/patch-positions.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROUTES_TS = join(__dirname, "..", "game", "src", "data", "routes.ts");

const positions = {
  "palletTown":      { x: 29.93, y: 75.7 },
  "viridianCity":    { x: 29.44, y: 56.58 },
  "pewterCity":      { x: 29.44, y: 33.1 },
  "ceruleanCity":    { x: 61.92, y: 28.37 },
  "vermilionCity":   { x: 61.67, y: 62.62 },
  "saffronCity":     { x: 61.92, y: 45.25 },
  "celadonCity":     { x: 49.78, y: 44.43 },
  "lavenderTown":    { x: 74.17, y: 43.83 },
  "fuchsiaCity":     { x: 54.44, y: 81.8 },
  "cinnabarIsland":  { x: 29.19, y: 91.38 },
  "indigoPlat":      { x: 23.56, y: 27.11 },
  "route1":          { x: 29.56, y: 65.46 },
  "route2":          { x: 29.56, y: 49.55 },
  "viridianForest":  { x: 29.44, y: 41.06 },
  "route3":          { x: 36.43, y: 33 },
  "mtMoon":          { x: 48.07, y: 27.98 },
  "route4":          { x: 54.81, y: 28.2 },
  "route5":          { x: 61.55, y: 36.26 },
  "route6":          { x: 61.79, y: 53.26 },
  "route7":          { x: 54.44, y: 45.2 },
  "route8":          { x: 68.17, y: 44.76 },
  "route9":          { x: 68.04, y: 27.33 },
  "route10":         { x: 74.29, y: 33.87 },
  "rockTunnel":      { x: 74.42, y: 27.98 },
  "powerPlant":      { x: 74.29, y: 38.22 },
  "route11":         { x: 67.43, y: 62.62 },
  "diglettsCave":    { x: 65.22, y: 58.92 },
  "route12":         { x: 73.56, y: 69.38 },
  "route13":         { x: 68.66, y: 75.26 },
  "route14":         { x: 64.98, y: 78.96 },
  "route15":         { x: 59.83, y: 82.23 },
  "route16":         { x: 42.19, y: 44.32 },
  "route17":         { x: 39.12, y: 58.92 },
  "route18":         { x: 45.98, y: 80.71 },
  "route19":         { x: 54.69, y: 86.37 },
  "route20":         { x: 47.82, y: 92.25 },
  "seafoamIslands":  { x: 39.12, y: 92.04 },
  "route21":         { x: 29.44, y: 83.76 },
  "pokemonMansion":  { x: 26.74, y: 92.25 },
  "route22":         { x: 26.01, y: 56.31 },
  "victoryRoad":     { x: 23.56, y: 35.17 },
  "route23":         { x: 23.56, y: 46.72 },
  "route24":         { x: 61.55, y: 22.32 },
  "route25":         { x: 64.86, y: 18.18 },
  "safariZone":      { x: 55.05, y: 76.35 },
  "pokemonTower":    { x: 74.42, y: 49.12 },
  "ceruleanCave":    { x: 68.9,  y: 17.74 },
  "raidIsland":      { x: 91.57, y: 11.86 },
};

let src = readFileSync(ROUTES_TS, "utf8");
let patched = 0;
let missing = [];

for (const [id, pos] of Object.entries(positions)) {
  // Match the entry's `id: { ... }` block, then within it the position
  // line, replacing only the x/y numbers. We only allow the regex to
  // span up to the next top-level `},` so we don't accidentally cross
  // into a different location's block.
  const blockRe = new RegExp(
    `(    ${id}:\\s*\\{[\\s\\S]*?position:\\s*\\{\\s*x:\\s*)[\\d.]+(\\s*,\\s*y:\\s*)[\\d.]+(\\s*\\})`,
    "m"
  );
  if (!blockRe.test(src)) {
    missing.push(id);
    continue;
  }
  src = src.replace(blockRe, (_, p1, p2, p3) => `${p1}${pos.x}${p2}${pos.y}${p3}`);
  patched++;
}

writeFileSync(ROUTES_TS, src, "utf8");
console.log(`Patched ${patched} positions in routes.ts`);
if (missing.length) console.log(`Missing entries (no change made): ${missing.join(", ")}`);
