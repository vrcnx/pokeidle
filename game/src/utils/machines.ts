// TMs and HMs — the rules around them, in one place.
//
// The data (which machine teaches what, which species can learn it) is
// generated into data/tms.ts from the Gen 5 machine list. This module is the
// behaviour: what a machine says about itself, whether a given Pokémon can be
// taught by it, and why not when it can't.
//
// ── ONE OF EACH ───────────────────────────────────────────────────────────
// A machine here is REUSABLE — teaching never consumes it — which makes a
// second copy of the same TM worth exactly nothing. So ownership is a
// boolean, not a count: the Mart won't sell you a TM24 you already have, and
// a drop that would duplicate one is re-rolled rather than stacked. Anything
// that reads inventory still sees a normal `{ tm24: 1 }` entry, so no save
// migration and no special case anywhere else.

import { moves as movesTable } from "../data/moves";
import { machineList, machines, machineLearnsets, type MachineDef } from "../data/tms";
import type { Pokemon } from "../types";

export type { MachineDef };
export { machineList, machines };

/** Every machine, as inventory ids. Used to tell a TM apart from a potion. */
export const MACHINE_IDS: ReadonlySet<string> = new Set(machineList.map((m) => m.id));

export function isMachineId(itemId: string): boolean {
  return MACHINE_IDS.has(itemId);
}

// ── Description ───────────────────────────────────────────────────────────
// Built from the LIVE move definition rather than baked in at generation
// time. That is not a style preference: Toxic's canonical ailment is
// "poison", but this game's Toxic inflicts `badlyPoisoned`, so a description
// generated from the API would have promised the weaker one. Reading the same
// table the battle engine reads makes the promise and the behaviour the same
// object — a balance tweak to a move rewrites its TM's text for free.

const STATUS_VERB: Record<string, string> = {
  paralyzed: "paralyse",
  burned: "burn",
  frozen: "freeze",
  poisoned: "poison",
  badlyPoisoned: "badly poison",
  asleep: "put to sleep",
};
const STAT_LABEL: Record<string, string> = {
  attack: "Attack",
  defense: "Defense",
  spAttack: "Sp. Atk",
  spDefense: "Sp. Def",
  speed: "Speed",
};
const WEATHER_LABEL: Record<string, string> = {
  sun: "harsh sunlight",
  rain: "rain",
  sand: "a sandstorm",
  hail: "hail",
};

const VOWEL_TYPES = new Set(["Electric", "Ice"]);
const article = (word: string) => (VOWEL_TYPES.has(word) ? "an" : "a");

/** The one-line effect clause, or "" when the move is plain damage. */
export function machineEffectText(machineId: string): string {
  const m = machines[machineId];
  const def = m && movesTable[m.moveId];
  const e = def?.effect;
  if (!e) return "";

  switch (e.type) {
    case "inflictStatus": {
      const verb = STATUS_VERB[e.status] ?? e.status;
      const pct = Math.round((e.chance ?? 1) * 100);
      return pct >= 100
        ? `${cap(verb)}s the target.`
        : `${pct}% chance to ${verb} the target.`;
    }
    case "statChange": {
      const whose = e.target === "self" ? "the user's" : "the target's";
      const raised: string[] = [];
      const lowered: string[] = [];
      for (const [stat, delta] of Object.entries(e.changes)) {
        const label = STAT_LABEL[stat] ?? stat;
        const sharp = Math.abs(delta as number) >= 2 ? " sharply" : "";
        ((delta as number) > 0 ? raised : lowered).push(label + sharp);
      }
      const parts: string[] = [];
      if (raised.length) parts.push(`raises ${whose} ${list(raised)}`);
      if (lowered.length) parts.push(`lowers ${whose} ${list(lowered)}`);
      const body = list(parts);
      const pct = e.chance === undefined ? 100 : Math.round(e.chance * 100);
      return pct >= 100 ? `${cap(body)}.` : `${pct}% chance it ${body}.`;
    }
    case "setWeather":
      return `Summons ${WEATHER_LABEL[e.weather] ?? e.weather} for ${e.turns} turns.`;
    case "confuse":
      return `${Math.round((e.chance ?? 1) * 100)}% chance to confuse the target.`;
    case "recharge":
      return "The user must spend the next turn recharging.";
    case "selfDestruct":
      return "The user faints.";
    case "recoil":
      return `The user takes ${Math.round(e.fraction * 100)}% of the damage dealt as recoil.`;
    case "multiHit":
      return `Hits ${e.minHits}-${e.maxHits} times in one turn.`;
    default:
      return "";
  }
}

/** Full item text for the Bag and the Mart. */
export function describeMachine(machineId: string): string {
  const m = machines[machineId];
  if (!m) return "";
  const def = movesTable[m.moveId];
  if (!def) return `Teaches ${m.moveName}.`;

  const head =
    def.power > 0
      ? `Teaches ${def.name} — ${def.type}, ${def.category}, ${def.power} power, ${def.accuracy}% accuracy.`
      : `Teaches ${def.name} — ${article(def.type)} ${def.type} status move.`;

  const effect = machineEffectText(machineId);
  const reusable =
    m.kind === "hm"
      ? "A Hidden Machine — it can never be used up."
      : "Reusable: teaching it does not use it up.";
  return [head, effect, reusable].filter(Boolean).join(" ");
}

// ── Compatibility ─────────────────────────────────────────────────────────

/** Machines this species can learn, whether or not the player owns them. */
export function machinesForSpecies(speciesKey: string): MachineDef[] {
  return (machineLearnsets[speciesKey] ?? [])
    .map((id) => machines[id])
    .filter((m): m is MachineDef => !!m);
}

/** Machines this species can learn AND the player owns. */
export function ownedMachinesForSpecies(
  speciesKey: string,
  inventory: Record<string, number>,
): MachineDef[] {
  return machinesForSpecies(speciesKey).filter((m) => (inventory[m.id] ?? 0) > 0);
}

/** Species that can learn a given machine. Powers "who can use this?" in the
 *  Bag, which is the question a player actually has when holding a new TM. */
export function speciesForMachine(machineId: string): string[] {
  const out: string[] = [];
  for (const [key, ids] of Object.entries(machineLearnsets)) {
    if (ids.includes(machineId)) out.push(key);
  }
  return out;
}

export type TeachCheck =
  | { ok: true; machine: MachineDef }
  | { ok: false; reason: string };

/**
 * Everything that can stop a teach, checked in the order a player would ask
 * it. Returning the reason rather than a bare false is the point: "Machoke
 * can't learn TM24" and "you don't own TM24" are different problems with
 * different fixes, and a disabled button that says neither is the version
 * players file bugs about.
 */
export function canTeachMachine(
  pokemon: Pokemon | undefined,
  machineId: string,
  inventory: Record<string, number>,
): TeachCheck {
  const m = machines[machineId];
  if (!m) return { ok: false, reason: "That machine doesn't exist." };
  if (!pokemon) return { ok: false, reason: "Pick a Pokémon first." };
  if ((inventory[machineId] ?? 0) <= 0) {
    return { ok: false, reason: `You don't have ${m.label}.` };
  }
  if (!(machineLearnsets[pokemon.speciesKey] ?? []).includes(machineId)) {
    return {
      ok: false,
      reason: `${pokemon.nickname ?? pokemon.name} can't learn ${m.moveName}.`,
    };
  }
  if (pokemon.moves.some((mv) => mv.id === m.moveId)) {
    return {
      ok: false,
      reason: `${pokemon.nickname ?? pokemon.name} already knows ${m.moveName}.`,
    };
  }
  return { ok: true, machine: m };
}

// ── helpers ───────────────────────────────────────────────────────────────
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "a", "a and b", "a, b and c" — an Oxford-less list, which is how the rest
 *  of the game's battle text reads. */
function list(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
