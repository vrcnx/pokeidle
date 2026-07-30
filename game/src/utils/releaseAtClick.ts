import type { GameState, Pokemon } from "../types";
import {
  duplicateIdSet,
  needsReleaseConfirm,
  releaseBlockedReason,
  releaseConfirmMessage,
  type ReleaseSource,
} from "./releaseConfirm";

/** What a context menu should do when its Release row is clicked. */
export type ReleaseDecision =
  | { act: "release"; mon: Pokemon }
  /** The subject is no longer in that list, or a guard now refuses it. Nothing
   *  was asked and nothing should be dispatched; `note` is safe to show. */
  | { act: "skip"; note: string }
  /** The player was asked and said no. */
  | { act: "cancelled" };

/**
 * Decide a single release AT THE MOMENT THE ROW IS CLICKED, against the state
 * as it is then — not as it was when the menu opened.
 *
 * openContextMenu freezes an item array with its onClick closures inside it, so
 * every value those closures captured is a snapshot of one render. The menu can
 * then sit open for as long as the player leaves it, and the box moves
 * underneath: an auction settles, a cloud reconcile lands, the player drags the
 * mon into the party from the grid behind the menu.
 *
 * Releasing already survives that — RELEASE_POKEMON re-anchors on pokemonId and
 * drops the action when the id is gone, so nothing is destroyed. What did NOT
 * survive it was the promise: the frozen closure asked "Release BOX006? This
 * cannot be undone.", took the player's yes, dispatched, and the reducer
 * correctly did nothing. Confirming a permanent deletion and watching nothing
 * happen is indistinguishable from a lost save, and is the exact papercut
 * releaseBlockedReason was written to remove one layer up.
 *
 * So: look the subject up by ID in the live list, re-run the guards against the
 * live state, and only then ask. A caller passes a getter for the live state
 * (a ref updated on commit) rather than a captured value — passing the value
 * would reintroduce the bug this exists to fix.
 */
export function decideRelease(
  pokemonId: string,
  source: ReleaseSource,
  live: GameState,
): ReleaseDecision {
  const list = source === "party" ? live.party : live.box;
  const mon = list.find((x) => x.id === pokemonId);
  if (!mon) {
    return {
      act: "skip",
      note:
        source === "party"
          ? "That Pokémon has already left your party."
          : "That Pokémon has already left your PC.",
    };
  }
  const reason = releaseBlockedReason(mon, source, {
    listedPokemonIds: live.listedPokemonIds ?? [],
    party: live.party,
    duplicateIds: duplicateIdSet(list),
  });
  if (reason) return { act: "skip", note: reason };
  // needsReleaseConfirm, not the raw setting — a shiny always asks even with
  // "skip confirmation" on. See releaseConfirm.ts.
  if (
    needsReleaseConfirm(mon, live.skipReleaseConfirm) &&
    !window.confirm(releaseConfirmMessage(mon, live.skipReleaseConfirm))
  ) {
    return { act: "cancelled" };
  }
  return { act: "release", mon };
}
