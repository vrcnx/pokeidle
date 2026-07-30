// Which PvP surface a phone should be showing.
//
// WHY THIS IS A MODULE AND NOT AN `if` INSIDE MobileShell
//
// On a phone the arena cannot show the console, both teams and the transcript
// at once — the desktop layout is a centre column PLUS a right rail, and there
// is no second column on a 390px screen. So the four surfaces become four
// bottom-bar tabs and the player is looking at exactly one of them at a time.
//
// That creates a failure mode desktop does not have: the player can be reading
// the battle log at the exact moment the battle demands an action from them.
// A competitive battle has a turn clock and the server's AFK watchdog forfeits
// a side that misses it, so "the control you needed was one tab away and you
// did not know" is a LOST MATCH, not a cosmetic annoyance.
//
// The rule below is therefore a real piece of game logic, and it is pure and
// separate so it can be tested by execution rather than by reading it. The
// three moments that override the player's own tab choice are exactly the
// three where the alternative is losing the battle to the clock:
//
//   * a new battle (or a rematch swapping the room underneath) — you are
//     never dropped into a fresh match already looking at an empty log;
//   * a forced switch — your Pokémon fainted and the battle cannot continue
//     until you send out a replacement;
//   * the battle ending — the result dialog, the rematch and the only control
//     that clears the room all live on the battle tab.
//
// Everything else leaves the player where they put themselves. In particular a
// normal turn does NOT yank the tab: a player who deliberately opened the
// transcript mid-battle is reading it on purpose, and stealing the view every
// time the opponent moves would make the log unusable.

export type PvpMobileView = "battle" | "team" | "log" | "chat";

/** Tab order, left to right. Exported so the shell and the tests agree on it. */
export const PVP_MOBILE_VIEWS: readonly PvpMobileView[] = ["battle", "team", "log", "chat"];

/** The slice of battle state navigation depends on. Deliberately three flat
 *  fields rather than the room: this file must stay free of the pvp store so
 *  it can be tested without one. */
export interface PvpNavSignals {
  /** null when no battle is live. */
  battleId: string | null;
  /** The request has forceSwitch set — the player must send out a Pokémon. */
  forceSwitch: boolean;
  /** A result landed, or the battle was voided by a server restart. */
  over: boolean;
}

export const NO_PVP: PvpNavSignals = { battleId: null, forceSwitch: false, over: false };

/**
 * The view to show, given what the player last chose and how the battle changed.
 *
 * `prev` is null on the first evaluation. Every override is EDGE-triggered
 * (`next.x && !prev.x`) rather than level-triggered, which is the whole
 * difference between "the shell takes you to the console when you must act"
 * and "the shell will not let you leave the console while a switch is
 * pending" — the second is a trap, since checking the opponent's team is a
 * perfectly reasonable thing to do while deciding who to send out.
 */
export function nextPvpMobileView(
  current: PvpMobileView,
  prev: PvpNavSignals | null,
  next: PvpNavSignals,
): PvpMobileView {
  // No battle: the PvP tabs are not on screen at all, so there is nothing to
  // choose. Returning `current` keeps the value stable so the next battle does
  // not inherit a stale forced view.
  if (next.battleId == null) return current;
  if (prev == null || prev.battleId !== next.battleId) return "battle";
  if (next.forceSwitch && !prev.forceSwitch) return "battle";
  if (next.over && !prev.over) return "battle";
  return current;
}
