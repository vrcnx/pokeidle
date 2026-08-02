import { useEffect, useRef } from "react";
import { useGame } from "../state/GameContext";

// Where you were before the raid, and going back there when it is over.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────
// Raids are started from the Map's Raids tab now, and that button does the
// travelling — so a player who was restocking in Goldenrod gets pulled to
// Raid Island, fights, and is then left standing on an empty island with
// nothing to do and a trip back to make. The trip out was never a decision
// they made; the trip home should not be a chore they are handed.
//
// ── WHY NOT IN THE REDUCER ──────────────────────────────────────────
// A raid ends in FIVE different places — victory, catch, the whole party
// fainting, END_RAID, and the raid-wipe branch — and each is its own object
// spread. One more field to set correctly in five places is five chances to
// miss one, and the one that gets missed is the one nobody tests.
//
// This watches `inRaid` fall instead. There is exactly one edge to catch
// however many ways the raid can finish.
//
// The target is module-level rather than in the save. A reload mid-raid
// forgets it, and the behaviour degrades to "you are still on Raid Island",
// which is exactly where the game left you before any of this existed.

let _returnTo: string | null = null;

/** Called just before travelling out to a raid. */
export function rememberRaidReturn(locationId: string) {
  if (locationId === "raidIsland") return;
  _returnTo = locationId;
}

export function useRaidReturn() {
  const { state, dispatch } = useGame();
  const wasInRaid = useRef(state.inRaid);

  useEffect(() => {
    const was = wasInRaid.current;
    wasInRaid.current = state.inRaid;
    if (!was || state.inRaid) return;
    // The raid just ended.
    const back = _returnTo;
    _returnTo = null;
    if (!back) return;
    // Only if the game left the player on the island. A raid that ended with
    // them somewhere else — a white-out that already sent them to a Pokémon
    // Centre — has been handled, and overriding that would undo it.
    if (state.currentLocation !== "raidIsland") return;
    if (!state.unlockedLocations.includes(back)) return;
    dispatch({ type: "TRAVEL", payload: { locationId: back } });
  }, [state.inRaid, state.currentLocation, state.unlockedLocations, dispatch]);
}
