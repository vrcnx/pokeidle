// Generate src/data/tms.ts (the machine catalog + per-species compatibility)
// and the move definitions the machines need, from the PokéAPI snapshot in
// scripts/tmdata/. Re-pull that snapshot with `node scripts/pull-tms.mjs`.
//
// ── WHY GEN 5 ─────────────────────────────────────────────────────────────
// The roster ends at genesect (#649), which is exactly the Gen 5 national
// dex. So `black-2-white-2` is the one version group in which every species
// this game has exists AND has complete machine data. Nothing is guessed and
// nothing is missing.
//
// ── WHY NOT ALL 101 MACHINES ──────────────────────────────────────────────
// A TM is a promise: "this teaches your Pokémon THIS move". The battle engine
// (utils/battle.ts) models a specific vocabulary of effects — stat stages,
// the six status conditions, confusion, weather, recoil, recharge, multi-hit,
// self-destruct. It does NOT model screens, entry hazards, Protect,
// Substitute, switching mid-turn, evasion/accuracy stages, healing, or power
// that varies with happiness / weight / held items / turn order.
//
// So every machine whose move needs a mechanic we don't have is excluded, by
// name, with the reason recorded below. The alternative — shipping Light
// Screen as a TM that does nothing — is worse than not shipping it, and we
// already have proof: `lightScreen`, `reflect` and `rest` are in the level-up
// pool TODAY with no effect attached, and are silently no-ops in battle.
//
// The result is a catalog where every TM does exactly what its description
// says, in every battle, with canonical Gen 5 numbering kept intact. The gaps
// in the numbering are invisible in play — you only ever see TMs you own.

import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
const DATA = path.join(HERE, "tmdata");
const OUT = path.join(HERE, "..", "src", "data");

const machines = JSON.parse(fs.readFileSync(path.join(DATA, "machines.json"), "utf8"));
const apiMoves = JSON.parse(fs.readFileSync(path.join(DATA, "moves.json"), "utf8"));
const compat = JSON.parse(fs.readFileSync(path.join(DATA, "compat.json"), "utf8"));
const byName = Object.fromEntries(apiMoves.map((m) => [m.name, m]));

const camel = (s) => s.replace(/-(\w)/g, (_, c) => c.toUpperCase());

// ── Excluded machines, and why ────────────────────────────────────────────
// Grouped by the mechanic that is missing. If one of these mechanics ever
// lands in utils/battle.ts, delete the matching lines and re-run — the moves,
// the compatibility data and the shop stocking all follow automatically.
const EXCLUDED = {
  // Power depends on state the game does not track.
  tm21: "Frustration's power scales with friendship, which we don't track.",
  tm27: "Return's power scales with friendship, which we don't track.",
  tm74: "Gyro Ball's power is derived from the speed gap; not modeled.",
  tm86: "Grass Knot's power is derived from target weight; not modeled.",
  tm56: "Fling throws the held item; item-as-projectile is not modeled.",
  tm10: "Hidden Power's type and power come from IVs; not modeled.",
  tm42: "Facade doubles when statused; conditional power is not modeled.",
  tm09: "Venoshock doubles against a poisoned target; not modeled.",
  tm66: "Payback doubles when moving second; not modeled.",
  tm62: "Acrobatics doubles with no held item; not modeled.",
  tm67: "Retaliate doubles after an ally faints; not modeled.",
  tm49: "Echoed Voice grows each consecutive turn; not modeled.",

  // Needs a battle mechanic we don't have.
  tm05: "Roar forces a switch. The engine has no phazing.",
  tm82: "Dragon Tail forces a switch — that IS the move, so a plain 60 BP Dragon hit would misrepresent it.",
  tm72: "Volt Switch pivots out after damage. No mid-turn switching.",
  tm89: "U-turn pivots out after damage. No mid-turn switching.",
  tm58: "Sky Drop is a two-turn carry with a semi-invulnerable phase.",
  tm23: "Smack Down grounds a Flying target; grounding is not modeled.",
  tm46: "Thief steals the held item; item theft is not modeled.",
  tm17: "Protect blocks a turn. No per-turn protection state.",
  tm90: "Substitute needs a HP-buffered decoy. No substitute state.",
  tm16: "Light Screen halves special damage for 5 turns. No screens.",
  tm33: "Reflect halves physical damage for 5 turns. No screens.",
  tm20: "Safeguard blocks status for 5 turns. No side conditions.",
  tm92: "Trick Room inverts the speed order. No field state.",
  tm44: "Rest is a full heal plus forced sleep. No in-battle healing.",
  tm85: "Dream Eater drains HP from a sleeping target. No drain.",
  tm12: "Taunt bans status moves for a few turns. No move locking.",
  tm41: "Torment bans repeating a move. No move locking.",
  tm45: "Attract immobilises via infatuation. Not modeled.",
  tm63: "Embargo blocks item use. Item lockout is not modeled.",
  tm19: "Telekinesis lifts the target for guaranteed hits. Not modeled.",
  tm77: "Psych Up copies the target's stat stages. No stage copying.",
  tm60: "Quash reorders turns; a doubles move with no singles meaning.",
  tm51: "Ally Switch is a doubles-only positional move.",
  tm87: "Swagger both confuses AND raises Attack; a move carries one effect.",

  // Stat stages we don't have. StatStages is Omit<Stats,"hp"> — there is no
  // accuracy or evasion stage for these to move.
  tm32: "Double Team raises evasion; there is no evasion stage.",
  tm70: "Flash lowers accuracy; there is no accuracy stage.",
  tm01: "Hone Claws raises Attack AND accuracy; the accuracy half has no stage.",
  tm79: "Frost Breath always crits; guaranteed crits are not modeled.",
  tm03: "Psyshock deals special damage against physical Defense; not modeled.",
  tm54: "False Swipe always leaves 1 HP; a damage floor is not modeled.",
};

// ── Hand-mapped effects ───────────────────────────────────────────────────
// PokéAPI's `meta` block covers stat changes, ailments and multi-hit, but has
// no field for "recharge" or "self-destruct" — those live in prose. These are
// the only machines that need it.
const MANUAL_EFFECT = {
  hyperBeam:  { type: "recharge" },
  gigaImpact: { type: "recharge" },
  explosion:  { type: "selfDestruct" },
  wildCharge: { type: "recoil", fraction: 0.25 },
};

// PokéAPI ailment name -> our StatusCondition.
const AILMENT = {
  paralysis: "paralyzed",
  burn: "burned",
  freeze: "frozen",
  poison: "poisoned",
  "bad-poison": "badlyPoisoned",
  sleep: "asleep",
};

// PokéAPI stat name -> our StatStages key.
const STAT = {
  attack: "attack",
  defense: "defense",
  "special-attack": "spAttack",
  "special-defense": "spDefense",
  speed: "speed",
};

const WEATHER = { hail: "hail", "sunny-day": "sun", "rain-dance": "rain", sandstorm: "sand" };

/** Build our MoveDef shape from the API record. Returns null if the move
 *  needs something the engine can't express — a second safety net under the
 *  hand-written EXCLUDED list above. */
function toMoveDef(api) {
  const category =
    api.damage_class === "physical" ? "physical" :
    api.damage_class === "special" ? "special" : "status";
  const power = api.power ?? 0;
  // A null accuracy in the API means "never misses". This engine rolls
  // `Math.random() * 100 >= accuracy`, and random*100 never reaches 100 —
  // so accuracy 100 already IS never-miss. Aerial Ace lands every time.
  const accuracy = api.accuracy ?? 100;

  const def = {
    name: api.display,
    type: api.type[0].toUpperCase() + api.type.slice(1),
    category,
    power,
    accuracy,
    pp: api.pp,
    priority: api.priority,
  };

  const id = camel(api.name);
  if (MANUAL_EFFECT[id]) {
    def.effect = MANUAL_EFFECT[id];
    return def;
  }

  // Weather.
  if (WEATHER[api.name]) {
    def.effect = { type: "setWeather", weather: WEATHER[api.name], turns: 5 };
    return def;
  }

  // Stat changes. `stat_chance` 0 on a status move means "always"; on a
  // damaging move it is a genuine secondary chance.
  if (api.stat_changes.length > 0) {
    const changes = {};
    for (const sc of api.stat_changes) {
      const key = STAT[sc.stat];
      if (!key) return null; // accuracy / evasion — no such stage here
      changes[key] = sc.change;
    }
    // WHO the change lands on.
    //
    // Not derivable from `target`: Overheat's target is the opposing Pokémon
    // — it is a 130 BP attack — but the Sp. Atk it crashes is the USER's.
    // Reading `target` put that debuff on the wrong side, which turned the
    // game's biggest Fire move into a free Sp. Atk drop on the enemy.
    //
    // PokéAPI's `meta.category` is the field that actually knows: "damage+
    // raise" and "net-good-stats" are about the user (Overheat is filed
    // under damage+raise despite the change being negative), "damage+lower"
    // is about the target.
    const cat = api.category ?? "";
    const selfTargeted =
      cat.includes("raise") || cat === "net-good-stats"
        ? true
        : cat.includes("lower")
          ? false
          : api.target === "user";
    const chance = api.stat_chance > 0 ? api.stat_chance / 100 : 1;
    def.effect = { type: "statChange", target: selfTargeted ? "self" : "opponent", changes };
    if (chance < 1) def.effect.chance = chance;
    return def;
  }

  // Status conditions.
  if (api.ailment && api.ailment !== "none") {
    if (api.ailment === "confusion") {
      def.effect = { type: "confuse", chance: (api.ailment_chance || 100) / 100 };
      return def;
    }
    const status = AILMENT[api.ailment];
    if (!status) return null;
    def.effect = { type: "inflictStatus", status, chance: (api.ailment_chance || 100) / 100 };
    return def;
  }

  // Multi-hit.
  if (api.min_hits && api.max_hits) {
    def.effect = { type: "multiHit", minHits: api.min_hits, maxHits: api.max_hits };
    return def;
  }

  // A status move that reaches here has no effect we can represent, which
  // would make it a no-op in battle. Refuse it rather than ship it.
  if (category === "status") return null;

  return def;
}

// ── Build the machine catalog ─────────────────────────────────────────────
const included = [];
const skipped = [];
for (const m of machines) {
  if (EXCLUDED[m.id]) { skipped.push([m.id, m.move, EXCLUDED[m.id]]); continue; }
  const api = byName[m.move];
  const def = toMoveDef(api);
  if (!def) { skipped.push([m.id, m.move, "auto-rejected: no representable effect"]); continue; }
  included.push({ ...m, moveId: camel(m.move), def, api });
}

// ── Price ─────────────────────────────────────────────────────────────────
// TMs here are REUSABLE (Gen 5 behaviour, which is where the data comes
// from), so the scarcity is in obtaining the machine at all, not in rationing
// charges. Price follows what the move is worth in a fight, so the strongest
// TMs stay a goal rather than a first-hour purchase.
function priceFor(x) {
  if (x.id.startsWith("hm")) return null; // HMs are never sold
  const p = x.def.power;
  const acc = x.def.accuracy / 100;
  if (p === 0) {
    // Status: setup and status-infliction are the competitive backbone.
    return x.def.effect?.type === "setWeather" ? 12000 : 30000;
  }
  const worth = p * acc;
  if (worth >= 110) return 60000;
  if (worth >= 85) return 40000;
  if (worth >= 65) return 25000;
  if (worth >= 50) return 15000;
  return 8000;
}

// ── Emit src/data/tms.ts ──────────────────────────────────────────────────
const compatByKey = Object.fromEntries(compat.map((c) => [c.key, new Set(c.moves)]));
const includedApiNames = new Set(included.map((x) => x.move));

const learnsets = {};
for (const c of compat) {
  const owned = included.filter((x) => compatByKey[c.key].has(x.move)).map((x) => x.id);
  if (owned.length) learnsets[c.key] = owned;
}

const q = (s) => JSON.stringify(s);
const lines = [];
lines.push(`// GENERATED by scripts/gen-tms.mjs — do not edit by hand.`);
lines.push(`// Source: PokéAPI, version group black-2-white-2 (see scripts/tmdata/).`);
lines.push(`//`);
lines.push(`// ${included.length} machines of the ${machines.length} Gen 5 has. The ${skipped.length} left out need`);
lines.push(`// a battle mechanic this engine doesn't model; every reason is recorded in`);
lines.push(`// the generator. A TM in this file always does what its description says.`);
lines.push(``);
lines.push(`export interface MachineDef {`);
lines.push(`  /** Inventory id, e.g. "tm24". */`);
lines.push(`  id: string;`);
lines.push(`  /** Display label, e.g. "TM24". */`);
lines.push(`  label: string;`);
lines.push(`  /** Move id in data/moves.ts. */`);
lines.push(`  moveId: string;`);
lines.push(`  /** Move display name, e.g. "Thunderbolt". */`);
lines.push(`  moveName: string;`);
lines.push(`  /** Move type — also picks the machine's disc colour. */`);
lines.push(`  moveType: string;`);
lines.push(`  kind: "tm" | "hm";`);
lines.push(`  /** Mart price, or null when it is never sold. */`);
lines.push(`  price: number | null;`);
lines.push(`}`);
lines.push(``);
lines.push(`export const machineList: MachineDef[] = [`);
for (const x of included) {
  const label = x.id.toUpperCase();
  lines.push(`  {`);
  lines.push(`    id: ${q(x.id)}, label: ${q(label)}, moveId: ${q(x.moveId)},`);
  lines.push(`    moveName: ${q(x.def.name)}, moveType: ${q(x.def.type)},`);
  lines.push(`    kind: ${q(x.id.slice(0, 2))}, price: ${priceFor(x)},`);
  lines.push(`  },`);
}
lines.push(`];`);
lines.push(``);
lines.push(`export const machines: Record<string, MachineDef> = Object.fromEntries(`);
lines.push(`  machineList.map((m) => [m.id, m]),`);
lines.push(`);`);
lines.push(``);
lines.push(`/** moveId -> machine id. Lets a move say which TM taught it. */`);
lines.push(`export const machineByMove: Record<string, string> = Object.fromEntries(`);
lines.push(`  machineList.map((m) => [m.moveId, m.id]),`);
lines.push(`);`);
lines.push(``);
lines.push(`/**`);
lines.push(` * Which machines each species can learn — the whole point of the system.`);
lines.push(` * Straight from the Gen 5 games: a Magikarp learns nothing, a Mew learns`);
lines.push(` * everything, and the gap between them is what makes a moveset a choice.`);
lines.push(` *`);
lines.push(` * Species with no compatible machine are absent rather than empty.`);
lines.push(` */`);
lines.push(`export const machineLearnsets: Record<string, string[]> = {`);
for (const key of Object.keys(learnsets).sort()) {
  lines.push(`  ${key}: [${learnsets[key].map(q).join(", ")}],`);
}
lines.push(`};`);
lines.push(``);
lines.push(`/** Machines this species can learn, as MachineDefs, in catalog order. */`);
lines.push(`export function machinesForSpecies(speciesKey: string): MachineDef[] {`);
lines.push(`  return (machineLearnsets[speciesKey] ?? []).map((id) => machines[id]).filter(Boolean);`);
lines.push(`}`);
lines.push(``);
lines.push(`/** Can this species learn this machine? */`);
lines.push(`export function canLearnMachine(speciesKey: string, machineId: string): boolean {`);
lines.push(`  return (machineLearnsets[speciesKey] ?? []).includes(machineId);`);
lines.push(`}`);
lines.push(``);
fs.writeFileSync(path.join(OUT, "tms.ts"), lines.join("\n"), "utf8");

// ── Patch src/data/moves.ts ───────────────────────────────────────────────
// Add every machine move that isn't there yet. For moves that ARE already
// there we keep their existing stats — power and accuracy are balance, and
// re-pointing them at the API would silently re-tune fights that already
// work — but we DO attach a secondary effect when the move currently has
// none and the API says it has one. That is strictly additive: a move that
// did nothing extra now does the thing its name promises.
const movesPath = path.join(OUT, "moves.ts");
let src = fs.readFileSync(movesPath, "utf8");
const existing = new Set([...src.matchAll(/^ {4}(\w+):\s*\{/gm)].map((m) => m[1]));

function fmtEffect(e) {
  const parts = Object.entries(e).map(([k, v]) =>
    k === "changes"
      ? `changes: { ${Object.entries(v).map(([s, n]) => `${s}: ${n}`).join(", ")} }`
      : `${k}: ${typeof v === "string" ? q(v) : v}`
  );
  return `{ ${parts.join(", ")} }`;
}

function fmtMove(id, d) {
  const bits = [
    `name: ${q(d.name)}`,
    `type: ${q(d.type)}`,
    `category: ${q(d.category)}`,
    `power: ${d.power}`,
    `accuracy: ${d.accuracy}`,
    `pp: ${d.pp}`,
    `priority: ${d.priority}`,
  ];
  if (d.effect) bits.push(`effect: ${fmtEffect(d.effect)}`);
  return `    ${id}: {\n      ${bits.join(",\n      ")},\n    },`;
}

/**
 * The exact text of one move entry, found by BALANCING BRACES rather than by
 * regex.
 *
 * A regex was tried and it corrupted the file. Entries in moves.ts come in
 * two shapes — one line (`psychic: { ... },`) and many (`iceBeam: {\n ...\n
 * },`) — and `^ {4}id: \{[\s\S]*?\n? {4}\},` cannot end at a single-line
 * entry, so it ran past Psychic and stopped at the end of the NEXT
 * multi-line move. The "upgrade" then appended Psychic's Sp. Def drop to
 * Dream Eater, which reported as a success and left Psychic untouched.
 * Counting braces cannot make that mistake.
 */
function findEntry(text, id) {
  const start = text.search(new RegExp(`^ {4}${id}: \\{`, "m"));
  if (start === -1) return null;
  let i = text.indexOf("{", start);
  let depth = 0;
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        const end = text[i + 1] === "," ? i + 2 : i + 1;
        return { start, end, text: text.slice(start, end) };
      }
    }
  }
  return null;
}

const added = [];
const upgraded = [];
for (const x of included) {
  if (!existing.has(x.moveId)) { added.push(fmtMove(x.moveId, x.def)); continue; }
  if (!x.def.effect) continue;
  // Already present — attach the secondary effect only if it has none. Power
  // and accuracy are left alone: those are balance, and re-pointing them at
  // the API would silently re-tune fights that already work.
  const entry = findEntry(src, x.moveId);
  if (!entry || /effect:/.test(entry.text)) continue;
  // Insert before the entry's closing brace. A single-line entry ends
  // `priority: 0 },` with no trailing comma on the last field, so one has to
  // be added or the result is `priority: 0 effect: {...}` — valid-looking
  // text that is a syntax error.
  const inner = entry.text.replace(/\}\s*,?\s*$/, "").replace(/\s+$/, "");
  const sep = inner.endsWith(",") ? "" : ",";
  const patched = `${inner}${sep}\n      effect: ${fmtEffect(x.def.effect)},\n    },`;
  src = src.slice(0, entry.start) + patched + src.slice(entry.end);
  upgraded.push(x.moveId);
}

if (added.length) {
  const banner = [
    ``,
    `    // ── Machine moves (TM/HM) ────────────────────────────────────────────`,
    `    // Generated by scripts/gen-tms.mjs from the Gen 5 machine list. Taught`,
    `    // from the Bag rather than by levelling — see data/tms.ts for which`,
    `    // species can learn which.`,
    `    //`,
    `    // These have to be HAND-AUTHORED entries rather than left to the`,
    `    // @pkmn/dex backfill at the bottom of this file. That backfill copies`,
    `    // stats only — power, accuracy, PP, type — and deliberately drops`,
    `    // effects, because Showdown's effect format isn't ours. A TM move left`,
    `    // to it would have the right numbers and never freeze, never paralyse,`,
    `    // never lower a stat. Every machine move therefore lands here, with its`,
    `    // effect translated into the union the engine actually reads.`,
    ...added,
  ].join("\n");
  // The `moves` object literal closes with `  };` on its own line — anchor on
  // that rather than the end of the file, which is the @pkmn backfill loop.
  const close = src.match(/^ {2}\};$/m);
  if (!close) throw new Error("could not find the end of the moves object in moves.ts");
  src = src.replace(/^ {2}\};$/m, `${banner}\n  };`);
}
fs.writeFileSync(movesPath, src, "utf8");

// ── Report ────────────────────────────────────────────────────────────────
console.log(`machines included : ${included.length} / ${machines.length}`);
console.log(`  TMs ${included.filter((x) => x.kind !== "hm" && x.id.startsWith("tm")).length}, HMs ${included.filter((x) => x.id.startsWith("hm")).length}`);
console.log(`moves added       : ${added.length}`);
console.log(`moves upgraded    : ${upgraded.length}${upgraded.length ? " — " + upgraded.join(", ") : ""}`);
console.log(`species w/ TMs    : ${Object.keys(learnsets).length} / ${compat.length}`);
console.log(`\nexcluded (${skipped.length}):`);
for (const [id, move, why] of skipped) console.log(`  ${id} ${move.padEnd(14)} ${why}`);
