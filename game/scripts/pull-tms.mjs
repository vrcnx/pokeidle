// Pull TM/HM machine data + per-species machine compatibility from PokeAPI.
// Version group: black-2-white-2 — the roster ends at genesect (#649), which
// is exactly the Gen 5 national dex, so every species in the game exists in
// that version group and has complete machine data.
import fs from "node:fs";

const VG = "black-2-white-2";
const OUT = process.argv[2] || "./api";
fs.mkdirSync(OUT, { recursive: true });

const cache = new Map();
async function get(url) {
  if (cache.has(url)) return cache.get(url);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(r.status + " " + url);
      const j = await r.json();
      cache.set(url, j);
      return j;
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
        if (k % 25 === 0) process.stderr.write(`  ${k}/${items.length}\n`);
      }
    })
  );
  return out;
}

// ── 1. TM/HM number -> move, for this version group ────────────────────────
const machineIds = [];
for (let i = 1; i <= 95; i++) machineIds.push(`tm${String(i).padStart(2, "0")}`);
for (let i = 1; i <= 6; i++) machineIds.push(`hm${String(i).padStart(2, "0")}`);

process.stderr.write("machines...\n");
const machines = await pool(machineIds, 8, async (id) => {
  const item = await get(`https://pokeapi.co/api/v2/item/${id}`);
  const entry = item.machines.find((m) => m.version_group.name === VG);
  if (!entry) return null;
  const mach = await get(entry.machine.url);
  return { id, move: mach.move.name };
});
const machineList = machines.filter(Boolean);
fs.writeFileSync(`${OUT}/machines.json`, JSON.stringify(machineList, null, 2));
process.stderr.write(`machines: ${machineList.length}\n`);

// ── 2. Move detail for every machine move ──────────────────────────────────
const moveNames = [...new Set(machineList.map((m) => m.move))];
process.stderr.write("move details...\n");
const moveDefs = await pool(moveNames, 8, async (name) => {
  const m = await get(`https://pokeapi.co/api/v2/move/${name}`);
  const pastVals = (m.past_values || []).find(
    (p) => p.version_group && p.version_group.name === VG
  );
  return {
    name: m.name,
    display: m.names.find((n) => n.language.name === "en")?.name ?? m.name,
    type: m.type.name,
    damage_class: m.damage_class.name,
    power: pastVals?.power ?? m.power,
    accuracy: pastVals?.accuracy ?? m.accuracy,
    pp: pastVals?.pp ?? m.pp,
    priority: m.priority,
    effect_chance: pastVals?.effect_chance ?? m.effect_chance,
    ailment: m.meta?.ailment?.name ?? null,
    ailment_chance: m.meta?.ailment_chance ?? 0,
    category: m.meta?.category?.name ?? null,
    crit_rate: m.meta?.crit_rate ?? 0,
    drain: m.meta?.drain ?? 0,
    flinch_chance: m.meta?.flinch_chance ?? 0,
    stat_chance: m.meta?.stat_chance ?? 0,
    min_hits: m.meta?.min_hits ?? null,
    max_hits: m.meta?.max_hits ?? null,
    stat_changes: m.stat_changes.map((s) => ({ stat: s.stat.name, change: s.change })),
    target: m.target.name,
    short_effect:
      m.effect_entries.find((e) => e.language.name === "en")?.short_effect ?? "",
    flavor:
      m.flavor_text_entries.find((e) => e.language.name === "en")?.flavor_text?.replace(/\s+/g, " ") ?? "",
  };
});
fs.writeFileSync(`${OUT}/moves.json`, JSON.stringify(moveDefs, null, 2));

// ── 3. Per-species machine compatibility ───────────────────────────────────
const species = JSON.parse(fs.readFileSync(`${OUT}/species.json`, "utf8"));
process.stderr.write(`species compat (${species.length})...\n`);
const compat = await pool(species, 8, async (s) => {
  try {
    const p = await get(`https://pokeapi.co/api/v2/pokemon/${s.api}`);
    const list = p.moves
      .filter((mv) =>
        mv.version_group_details.some(
          (d) => d.version_group.name === VG && d.move_learn_method.name === "machine"
        )
      )
      .map((mv) => mv.move.name);
    return { key: s.key, api: s.api, moves: list };
  } catch (e) {
    return { key: s.key, api: s.api, moves: [], error: String(e) };
  }
});
fs.writeFileSync(`${OUT}/compat.json`, JSON.stringify(compat, null, 2));
process.stderr.write("done\n");
