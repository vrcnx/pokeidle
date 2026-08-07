import type { PokemonType, MoveCategory } from "../types";

// Visual archetypes for move animations. Each move falls into a bucket
// keyed by (type, category), with optional per-move signature overrides
// for iconic moves. The MoveAnimation component reads this to decide
// which CSS keyframe class to mount.
//
// Why bucketed: 131 moves × bespoke art = months of work. Bucketed gives
// 80% of the visual identity (every Fire move feels fire-y) for a fraction
// of the effort, with signature overrides as a strict opt-in upgrade.

export type EffectArchetype =
  // Special / projectile-type effects fly from attacker → defender.
  | "fire-special"
  | "water-special"
  | "electric-special"
  | "grass-special"
  | "ice-special"
  | "psychic-special"
  | "ghost-special"
  | "dragon-special"
  | "dark-special"
  | "poison-special"
  | "rock-special"
  | "ground-special"
  | "bug-special"
  | "flying-special"
  | "normal-special"
  | "fighting-special"
  // Physical = slash impact at the defender slot, tinted by type.
  | "physical-impact"
  // Status = colored aura on the target (or self for self-buffs).
  | "status-aura"
  // Signature overrides for iconic moves.
  | "hyper-beam"
  | "solar-beam"
  | "explosion"
  // Fallback when no archetype matches yet.
  | "generic-flash";

// Every type now has a special-projectile archetype. Physical and status
// moves use type-agnostic visuals (impact / aura) but pick up the type
// color via a CSS variable on the wrapper.
const TYPE_TO_SPECIAL: Record<PokemonType, EffectArchetype> = {
  Fire:     "fire-special",
  Water:    "water-special",
  Electric: "electric-special",
  Grass:    "grass-special",
  Ice:      "ice-special",
  Psychic:  "psychic-special",
  Ghost:    "ghost-special",
  Dragon:   "dragon-special",
  Dark:     "dark-special",
  Poison:   "poison-special",
  Rock:     "rock-special",
  Ground:   "ground-special",
  Bug:      "bug-special",
  Flying:   "flying-special",
  Normal:   "normal-special",
  Fighting: "fighting-special",
  // Steel and Fairy aren't on Gen 1 moves; map for completeness.
  Steel:    "rock-special",
  Fairy:    "psychic-special",
};

// Per-type color used by physical-impact and status-aura overlays so
// they're visually distinct between, say, an Ice Punch and a Fire Punch.
export const TYPE_COLOR: Record<PokemonType, string> = {
  Normal:   "#a8a878",
  Fire:     "#f08030",
  Water:    "#6890f0",
  Electric: "#f8d030",
  Grass:    "#78c850",
  Ice:      "#98d8d8",
  Fighting: "#c03028",
  Poison:   "#a040a0",
  Ground:   "#e0c068",
  Flying:   "#a890f0",
  Psychic:  "#f85888",
  Bug:      "#a8b820",
  Rock:     "#b8a038",
  Ghost:    "#705898",
  Dragon:   "#7038f8",
  Dark:     "#705848",
  Steel:    "#b8b8d0",
  Fairy:    "#ee99ac",
};

// Moves that rattle the battle scene as part of their effect. This is
// a per-move opt-in (not derived from type) because Ground-physical
// covers both heavy quakes (Earthquake) and small jabs (Bonemerang) —
// only the genuinely earth-shaking moves should shake the screen.
export const SHAKE_MOVES: ReadonlySet<string> = new Set([
  "earthquake",
  "magnitude",
  "selfDestruct",
  "hyperBeam",
  // ── Added after auditing the list against the move table ──────────
  // The three the original set plainly should have had. Each was found by
  // asking the same question of every move rather than by remembering:
  //
  //   explosion   250 power — the single hardest hit in the game, and the
  //               only one named after the thing this list is FOR. Its
  //               weaker twin selfDestruct (200) was already here, which is
  //               how the omission stayed invisible: the pair looked
  //               covered because one of them was.
  //   gigaImpact  150 power, and the physical mirror of hyperBeam — same
  //               power, same recharge, same "everything you have in one
  //               blow". One shaking and not the other is an inconsistency
  //               a player feels without being able to name.
  //   bulldoze    Ground, and its entire flavour is shaking the ground. Low
  //               power (60), which is exactly why the rule below is an
  //               opt-in list and not `power >= N`.
  //
  // Deliberately NOT added: Fire Blast, Hydro Pump, Blizzard, Thunder,
  // Focus Blast and the rest of the 110-120 club. They hit hard, but a
  // screen that lurches on every strong special is a screen that lurches
  // constantly, and the shake stops meaning anything. The bar is what the
  // move IS, not what it rolls for.
  "explosion",
  "gigaImpact",
  "bulldoze",
]);

// Per-move signature overrides — iconic moves with custom visuals that
// supersede the generic type+category bucketing.
const SIGNATURE_MOVES: Record<string, EffectArchetype> = {
  hyperBeam:    "hyper-beam",
  solarBeam:    "solar-beam",
  selfDestruct: "explosion",
};

export function archetypeFor(
  moveId: string,
  type: PokemonType,
  category: MoveCategory,
): EffectArchetype {
  if (SIGNATURE_MOVES[moveId]) return SIGNATURE_MOVES[moveId];
  if (category === "status") return "status-aura";
  if (category === "physical") return "physical-impact";
  // Special moves use type-driven archetype.
  return TYPE_TO_SPECIAL[type] ?? "generic-flash";
}
