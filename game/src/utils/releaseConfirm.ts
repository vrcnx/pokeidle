import type { Pokemon } from "../types";

/**
 * Release confirmation policy — br_ff6112fc5180462b81 asked for a toggle that
 * skips the prompt, alongside bulk release.
 *
 * A pure predicate, and shared by all four release call sites (the PC cell menu,
 * the party row menu, the detail modal, and the bulk bar), because "the toggle
 * is on" is NOT the whole answer and a copy of that thought at each call site is
 * how one of them ends up wrong. Releasing is the only irreversible action in
 * the game, so the two exceptions below are structural rather than advisory.
 */

/** Should this SINGLE release ask before it happens? */
export function needsReleaseConfirm(mon: Pokemon, skipReleaseConfirm: boolean): boolean {
  // A shiny ALWAYS asks. The whole reason the toggle exists is bulk chaff —
  // 500 Magikarp — and the setting is enabled once and then forgotten, months
  // before the shiny shows up. Letting it cover a 1/8192 encounter would turn a
  // convenience into the most expensive misclick in the game.
  if (mon.isShiny) return true;
  return !skipReleaseConfirm;
}

/**
 * The BULK confirmation is never skippable and always states the exact count.
 * `skipReleaseConfirm` is deliberately not a parameter — there is no argument
 * that could turn this off, which is the point.
 */
export function bulkReleaseConfirmMessage(count: number): string {
  return count === 1
    ? "Release 1 Pokémon? This cannot be undone."
    : `Release ${count} Pokémon? This cannot be undone.`;
}

/** Can this Pokémon be picked up by a multi-select bulk release?
 *
 *  Mirrors the reducer's RELEASE_MANY guards so the UI cannot even offer what
 *  the reducer would refuse. The reducer keeps its own copy on purpose — this
 *  one is about not showing the player a lie, that one is about not losing a
 *  Pokémon if this one is ever wrong. */
export function isBulkReleasable(mon: Pokemon, listedPokemonIds: string[]): boolean {
  if (mon.isShiny) return false;
  return !listedPokemonIds.includes(mon.id);
}
