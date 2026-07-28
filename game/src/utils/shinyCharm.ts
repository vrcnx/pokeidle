import { isDexComplete } from "./obtainable";

// The Shiny Charm, as an object the player can actually hold.
//
// It used to be a pure predicate — `pokedexCaught.length >= 245` — consumed by
// three rollShiny() call sites and surfaced nowhere except a status row buried
// in Settings. So a player who finished the Pokédex got a silently doubled
// shiny rate, no notification, no item, and a catalog entry ("Earned
// automatically by completing the Pokédex") for something that was added to no
// inventory by any code path in the repo. The report was "I completed the dex
// and nobody gave me the charm", and it was correct.
//
// Two things changed:
//
//  1. The charm is GRANTED: crossing the threshold puts the real `shinycharm`
//     item in the Bag, with a log line. The catalog entry stops being a phantom.
//
//  2. The threshold is DERIVED. 245 was a hardcoded literal whose own comment
//     claimed it excluded raid legendaries — but it was a flat length check on
//     an unfiltered array, so raid legendaries counted anyway and the documented
//     exclusion was never implemented. Completion now means "every species in
//     the obtainable set", the same set the Dex tab's ring already used.
//
// Ownership, not the threshold, is what `hasShinyCharm` reads. That is what
// makes raising the bar from 245 to the full obtainable dex safe: the charm is
// unsellable (sellPrice 0) and unbuyable, so once earned it cannot be taken
// away by a later change to what "complete" means.

export const SHINY_CHARM_ITEM = "shinycharm";

/** Saves written under the old rule got the doubled rate at 245 registrations. */
export const LEGACY_SHINY_CHARM_THRESHOLD = 245;

// Deliberately loose: the grant/migration helpers run on the save-load path,
// where the blob is whatever the server last stored. A cloud copy written by
// an older client can be missing either field entirely, and a boot-time throw
// would lock that player out of the game over a cosmetic reward.
type CharmHolder = { inventory?: Record<string, number> | null };
type DexHolder = { pokedexCaught?: string[] | null };

/**
 * Does the player have the charm? One question, one answer, no thresholds —
 * every shiny roll and every UI surface asks this.
 */
export function hasShinyCharm(s: { inventory?: Record<string, number> | null }): boolean {
  return (s.inventory?.[SHINY_CHARM_ITEM] ?? 0) > 0;
}

/**
 * Idempotent grant. Safe to call on every dex registration: it is a no-op once
 * the charm is held, and a no-op until the dex is complete.
 */
export function grantShinyCharmIfEarned<S extends CharmHolder & DexHolder>(s: S): S {
  if (hasShinyCharm(s)) return s;
  if (!isDexComplete(s.pokedexCaught)) return s;
  return { ...s, inventory: { ...s.inventory, [SHINY_CHARM_ITEM]: 1 } };
}

/**
 * One-time migration, applied where saves are loaded (local blob and cloud
 * adopt alike).
 *
 * Anyone who satisfied the OLD rule was already getting the doubled rate, and
 * moving the goalpost to full completion must not quietly halve it again.
 * Their save predates the item existing, so there is nothing in the inventory
 * to read — this materialises the charm they had already earned. Idempotent,
 * and inert for saves below the old threshold: those follow the new rule.
 */
export function grandfatherShinyCharm<S extends CharmHolder & DexHolder>(s: S): S {
  const granted = grantShinyCharmIfEarned(s);
  if (hasShinyCharm(granted)) return granted;
  if ((s.pokedexCaught?.length ?? 0) < LEGACY_SHINY_CHARM_THRESHOLD) return granted;
  return { ...granted, inventory: { ...granted.inventory, [SHINY_CHARM_ITEM]: 1 } };
}
