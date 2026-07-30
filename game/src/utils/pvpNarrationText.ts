// Presentation-layer fixes to decoded narration.
//
// state/pvpBattleView.ts builds the `|win|` line as `${parts[2]} wins!`, which
// is correct for a third-person username in a spectator transcript and
// ungrammatical for the local player's own name — a live battle produced
// literally "You wins!". That was survivable while the line was buried at the
// bottom of the rail transcript; a message box puts it centre-screen as the
// last thing the player reads before the result dialog opens, so it has to be
// right. The decoder is not this task's file to change, so the fix is applied
// where the text is rendered, for BOTH the box and the rail, from one function
// so the two can never disagree.

import type { BattleView, NarrationLine } from "../state/pvpBattleView";

/**
 * The text to actually show for a narration line.
 *
 * `view` supplies the two trainer names the protocol announced (`|player|`), so
 * "did the winner's name mean me" is answered against ground truth rather than
 * by string-matching "You".
 */
export function displayNarration(line: NarrationLine, view: Pick<BattleView, "you" | "foe">): string {
  if (line.kind !== "win") return line.text;
  const winner = winnerNameOf(line.text);
  if (!winner) return line.text;
  if (namesMatch(winner, view.you.player)) return "You win!";
  if (namesMatch(winner, view.foe.player)) return `${view.foe.player} wins!`;
  return line.text;
}

/** Pull the name back out of "<name> wins!". Greedy so a name containing
 *  " wins!" cannot truncate it. */
function winnerNameOf(text: string): string | null {
  const m = /^(.*) wins!$/.exec(text.trim());
  const name = m?.[1]?.trim();
  return name ? name : null;
}

function namesMatch(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
