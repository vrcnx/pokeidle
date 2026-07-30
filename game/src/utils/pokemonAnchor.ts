import type { Pokemon } from "../types";

/**
 * Turn a frozen `{ index, pokemonId }` reference into the index that Pokémon
 * occupies RIGHT NOW, or -1 if it has left the list.
 *
 * Every surface that acts on a Pokémon freezes its position when it opens:
 * openContextMenu snapshots an item array with its onClick closures inside it,
 * and the detail modal keeps a module-level `{ type, index }`. The list moves
 * underneath that snapshot without any input from the player —
 * AUCTION_SETTLED filters a sold mon out by id and shifts every later index
 * down by one, a mid-session LOAD_SAVE cloud reconcile replaces the box
 * outright, and SORT_BOX / REORDER_BOX permute it. A frozen index then
 * addresses a DIFFERENT Pokémon.
 *
 * The reducer already defends its own irreversible case (RELEASE_POKEMON
 * re-anchors on pokemonId). This is the same idea one layer up, for the modal
 * that had NO id at all: it read `state.box[index]` every render, so a reconcile
 * landing while it was open silently re-aimed the whole sheet — header, sprite,
 * stats, and every button in the footer — at whoever now occupied the slot.
 *
 * Two rules, in this order:
 *
 *  1. If the frozen index STILL holds that id, keep it. Not an optimisation:
 *     ids are not guaranteed unique (see duplicateIdSet), and a bare
 *     `findIndex` would re-aim the modal from the second of two identical ids
 *     onto the first the moment anything re-rendered. Trusting the index while
 *     it is still correct means the sheet never moves on its own.
 *  2. Otherwise find the id. Gone means gone — -1, and the caller shows
 *     nothing, rather than acting on the stranger who took the slot.
 *
 * An anchor with no `pokemonId` is passed through unchanged so an older or
 * deliberately index-only caller behaves exactly as before.
 */
export function resolveAnchoredIndex(
  list: readonly Pokemon[],
  anchor: { index: number; pokemonId?: string },
): number {
  const { index, pokemonId } = anchor;
  if (!pokemonId) return index;
  if (index >= 0 && list[index]?.id === pokemonId) return index;
  return list.findIndex((p) => p.id === pokemonId);
}
