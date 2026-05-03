import type { PokemonType } from "../types";

// Held-item battle effects. A separate registry from abilities so the
// battle resolver can read both independently. Most effects are simple
// damage/HP modifiers — no DSL, just direct lookups.

// Items that boost a specific move type by 20% when held by the attacker.
export const TYPE_BOOST_ITEMS: Record<string, PokemonType> = {
  charcoal:     "Fire",
  mysticwater:  "Water",
  magnet:       "Electric",
  miracleseed:  "Grass",
  nevermeltice: "Ice",
  blackbelt:    "Fighting",
  poisonbarb:   "Poison",
  softsand:     "Ground",
  sharpbeak:    "Flying",
  twistedspoon: "Psychic",
  silverpowder: "Bug",
  hardstone:    "Rock",
  spelltag:     "Ghost",
  dragonfang:   "Dragon",
  blackglasses: "Dark",
  silkscarf:    "Normal",
};

export const TYPE_BOOST_MULTIPLIER = 1.20;

// Life Orb: +30% damage; consumes 10% maxHP per attack landed.
export const LIFE_ORB_DAMAGE_MULT = 1.30;
export const LIFE_ORB_RECOIL_FRACTION = 0.10;

// Leftovers: heal 1/16 maxHP each end-of-turn while held.
export const LEFTOVERS_HEAL_FRACTION = 1 / 16;

// Focus Sash: like Sturdy, but consumed on trigger.
// (Implemented inline in the resolver since it needs to mutate heldItem.)

// Returns the item id that holds for this Pokémon, or null. Defensive
// against pokemon being undefined or heldItem being unset.
export function heldItemOf(p: { heldItem?: string } | null | undefined): string | null {
  return p?.heldItem ?? null;
}
