import type { GameState, Pokemon } from "../types";
import { evolutions } from "../data/evolutions";
import { abilitiesFor, abilitySlotOf, isLegalAbility } from "../data/abilities";

// Fixing Pokémon that are already holding an ability their species cannot have.
//
// ── WHERE THEY CAME FROM ────────────────────────────────────────────
// COMPLETE_EVOLUTION spread the pre-evolution wholesale and changed only the
// species and the stats, so the ability string came across verbatim. An
// ability belongs to a SPECIES and what survives an evolution is the SLOT, so
// every Pokémon evolved before that was fixed is wrong.
//
// It is not a rare corner: 34 of the game's 122 evolution edges carry an
// ability that is illegal on the evolved form. Magikarp → Gyarados is the one
// that actually cost people something — Gyarados should have Intimidate, which
// is one of the four abilities fully wired into the battle resolver, and
// instead it had Magikarp's Swift Swim, which does nothing here.
//
// Reported by Gshow, who used Dragonite as the example.
//
// ── WHY THIS WALKS BACK UP THE CHAIN ────────────────────────────────
// The naive repair is "if the ability is illegal, give it the species' first
// primary". That works, and it throws away information: a Dragonite holding
// Marvel Scale is holding DRATINI'S HIDDEN ABILITY, and the correct answer is
// Dragonite's hidden ability (Multiscale), not its first primary (Inner
// Focus). The slot is recoverable — it is just recorded on an ancestor rather
// than on the species itself.
//
// So this finds the pre-evolution the ability IS legal for, reads the slot
// there, and carries it forward. Only when no ancestor claims it either does
// it fall back to the first primary.

/** speciesKey → the species it evolves FROM. Built once. */
const preEvolutionOf: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [from, list] of Object.entries(evolutions)) {
    for (const ev of list) {
      // A branching line gives several children one parent, which is the
      // direction this map needs, so branches are not a problem here. Eevee's
      // eight evolutions all record `eevee`.
      out[ev.into] = from;
    }
  }
  return out;
})();

/**
 * The ability this Pokémon should be holding.
 *
 * Returns the current one untouched when it is already legal, so this is safe
 * to run over every Pokémon on every load — only the broken ones move.
 */
export function correctAbility(
  speciesKey: string,
  ability: string | undefined,
): string | undefined {
  const own = abilitiesFor(speciesKey);
  // A species with no ability data is left completely alone. Blanking an
  // ability because this table has not been filled in yet would be a
  // regression wearing a fix's clothes.
  if (!own || own.primary.length === 0) return ability;
  if (!ability) return ability;
  if (isLegalAbility(speciesKey, ability)) return ability;

  // Walk back up the line looking for whoever this ability really belongs to.
  // Bounded by a hop count rather than trusting the data to be acyclic — a
  // bad evolution entry that pointed a species at itself would otherwise hang
  // the game on load, which is a much worse bug than the one being fixed.
  let cursor: string | undefined = preEvolutionOf[speciesKey];
  for (let hops = 0; cursor && hops < 8; hops++) {
    const slot = abilitySlotOf(cursor, ability);
    if (slot) {
      if (slot.kind === "hidden") return own.hidden ?? own.primary[0];
      return own.primary[slot.index] ?? own.primary[0];
    }
    cursor = preEvolutionOf[cursor];
  }

  // Nobody in the line claims it. Could be a species rename, a hand-edited
  // save, or a mon from before this table existed. The first primary is the
  // only defensible answer left, and it is at least legal.
  return own.primary[0];
}

function fixMon(mon: Pokemon): Pokemon {
  const next = correctAbility(mon.speciesKey, mon.ability);
  // Identity preserved when nothing changes, so React sees no new object and
  // an already-healthy save costs one comparison per Pokémon.
  return next === mon.ability ? mon : { ...mon, ability: next };
}

/**
 * Repair every Pokémon in a loaded save.
 *
 * Idempotent and identity-preserving: a save with nothing wrong comes back as
 * the same object, arrays included. Wired into repairLoadedSave so it runs on
 * BOTH entry points — the localStorage boot and the cloud LOAD_SAVE — because
 * a repair on only one of them silently skips half the players.
 */
export function repairAbilities<T extends GameState>(state: T): T {
  let changed = false;

  const fixList = <L extends (Pokemon | null)[]>(list: L | undefined): L | undefined => {
    if (!list) return list;
    let listChanged = false;
    const next = list.map((mon) => {
      if (!mon) return mon;
      const fixed = fixMon(mon);
      if (fixed !== mon) listChanged = true;
      return fixed;
    }) as L;
    if (!listChanged) return list;
    changed = true;
    return next;
  };

  const party = fixList(state.party);
  const box = fixList(state.box);
  if (!changed) return state;

  // The active Pokémon is a SEPARATE reference to the same mon, not a lookup
  // into the party, so repairing the party alone would leave the one currently
  // in battle still holding the wrong ability until the next switch.
  const active =
    state.playerPokemon && party
      ? (party[state.activePlayerPokemonIndex] ?? fixMon(state.playerPokemon))
      : state.playerPokemon;

  return { ...state, party, box, playerPokemon: active } as T;
}
