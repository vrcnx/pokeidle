// What actually happened, in words a player can act on.
//
// The inline result bar this replaces derived its verdict as
// `cancelled = winnerId == null`, which had two consequences a live battle
// confirmed:
//
//   * A GENUINE DRAW rendered as "Battle cancelled" while the transcript two
//     panels away correctly said "The battle ended in a tie." The board and
//     the verdict contradicted each other.
//   * THE END REASON WAS DROPPED for everything except forfeit and timeout, so
//     a KO win and a win by opponent-disconnect both rendered as a bare
//     "You win! +17" with nothing saying why the battle stopped.
//
// Both are fixed here by deriving the outcome from the whole payload rather
// than from one nullable field, and by covering the server's COMPLETE reason
// vocabulary. That vocabulary is `"ko" | "tie" | "forfeit" | "timeout" |
// "cancelled"` (server/src/pvp.ts's `endBattle` signature) plus the client's
// own `voided` flag for a server restart, and there is deliberately no
// "disconnect": an opponent whose reconnect grace expires is forfeited, so it
// arrives as "forfeit". The forfeit wording says both, because from this side
// of the socket the two are genuinely indistinguishable and claiming one would
// be a guess.
//
// Pure so it can be asserted directly — every branch below is a test case.

export type PvpOutcome = "win" | "loss" | "draw" | "cancelled" | "voided";

/** Just the parts of a BattleRoom this needs. Structural rather than the
 *  imported type so the tests can build a case in three lines. */
export interface PvpResultInput {
  voided: boolean;
  format: string;
  opponent: { id: string; username: string };
  result: {
    winnerId: string | null;
    loserId: string | null;
    reason: string;
    ratingDelta: { aDelta: number; bDelta: number; aRating: number; bRating: number } | null;
  } | null;
  /** The decoded battle's own terminal state, from |win| / |tie|. A second,
   *  independent witness to a draw: the simulator's own word for it. */
  ended?: { winner: string | null; tie: boolean } | null;
}

export interface PvpResultSummary {
  outcome: PvpOutcome;
  /** The verdict, stated plainly. */
  headline: string;
  /** Why the battle stopped. Never null for a finished battle. */
  reasonText: string;
  /** Did this move the ladder? */
  rated: boolean;
  /** Said out loud either way, so an unrated bot win can never be mistaken
   *  for a rating that failed to update. */
  ratedNote: string;
  /** Signed rating change for the LOCAL player, when rated. */
  delta: number | null;
  /** Local player's rating after the match, when rated. */
  rating: number | null;
}

/** `a` in a RatingDelta is the WINNER and `b` the loser — verified in
 *  server/src/lib/pvpLadder.ts ("`a` is the WINNER, `b` is the loser"), not
 *  the protocol seats. Reading it as a seat would hand the loser the winner's
 *  gain on side b. */
function localDelta(
  d: NonNullable<NonNullable<PvpResultInput["result"]>["ratingDelta"]>,
  won: boolean,
): { delta: number; rating: number } {
  return won
    ? { delta: d.aDelta, rating: d.aRating }
    : { delta: d.bDelta, rating: d.bRating };
}

export function isBotFormat(format: string): boolean {
  return format === "bot";
}

export function summarisePvpResult(room: PvpResultInput): PvpResultSummary {
  const r = room.result;
  const bot = isBotFormat(room.format);

  // A server restart wins over everything: the room it describes is gone, so
  // whatever verdict was in flight cannot be trusted or rated.
  if (room.voided) {
    return {
      outcome: "voided",
      headline: "Battle voided",
      reasonText: "The server restarted mid-battle, so this match could not be finished.",
      rated: false,
      ratedNote: "Not rated — your ranking is unchanged.",
      delta: null,
      rating: null,
    };
  }

  const tie = r?.reason === "tie" || room.ended?.tie === true;
  const winnerId = r?.winnerId ?? null;
  // The client never learns its own userId, but it always knows the
  // opponent's — so "did I win" is "the winner exists and is not them".
  const won = winnerId != null && winnerId !== room.opponent.id;
  const lost = winnerId != null && winnerId === room.opponent.id;

  const outcome: PvpOutcome = tie ? "draw" : won ? "win" : lost ? "loss" : "cancelled";

  const rd = r?.ratingDelta ?? null;
  const rated = !bot && rd != null && (outcome === "win" || outcome === "loss");
  const local = rated && rd ? localDelta(rd, outcome === "win") : null;

  return {
    outcome,
    headline: headlineFor(outcome),
    reasonText: reasonTextFor(r?.reason ?? (tie ? "tie" : "cancelled"), outcome),
    rated,
    ratedNote: ratedNoteFor(room.format, outcome, rated),
    delta: local?.delta ?? null,
    rating: local?.rating ?? null,
  };
}

function headlineFor(outcome: PvpOutcome): string {
  switch (outcome) {
    case "win": return "You win!";
    case "loss": return "You lose.";
    // Named as its own outcome rather than folded into "cancelled" — a draw is
    // a RESULT, and calling it a cancellation was the bug.
    case "draw": return "It's a draw.";
    case "voided": return "Battle voided";
    default: return "Battle cancelled";
  }
}

function reasonTextFor(reason: string, outcome: PvpOutcome): string {
  if (outcome === "draw") {
    return "Both sides were knocked out on the same turn.";
  }
  switch (reason) {
    case "ko":
      return outcome === "win"
        ? "By knockout — your opponent has no Pokémon left standing."
        : "By knockout — your last Pokémon fainted.";
    case "forfeit":
      // Genuinely ambiguous from here: a grace-window expiry after a
      // disconnect is forfeited by the server under this same reason.
      return outcome === "win"
        ? "Your opponent forfeited or lost their connection."
        : "You forfeited the battle.";
    case "timeout":
      return outcome === "win"
        ? "Your opponent ran out of time on the turn clock."
        : "You ran out of time on the turn clock.";
    case "tie":
      return "Both sides were knocked out on the same turn.";
    case "cancelled":
      return "The battle was cancelled before it could finish.";
    default:
      return outcome === "win"
        ? "Your opponent is out of the battle."
        : "The battle ended.";
  }
}

function ratedNoteFor(format: string, outcome: PvpOutcome, rated: boolean): string {
  if (isBotFormat(format)) {
    return "Practice battle against the AI — not rated. Your ladder rating is unchanged.";
  }
  if (rated) return "Ranked ladder match — your rating moved.";
  if (format === "random50") {
    return outcome === "win" || outcome === "loss"
      // The delta is applied inside endBattle and can fail (it is logged
      // server-side as pvp_elo_update_failed). Saying so beats an absent
      // number, which reads as "the rating update silently broke".
      ? "Ranked match — no rating change was reported for this battle."
      : "Ranked match — an unfinished battle does not move the ladder.";
  }
  if (format === "tournament") return "Tournament match — the ladder rating is unchanged.";
  return "Friendly battle — not rated.";
}

/** Do the win/loss/draw colours. Kept beside the derivation so the class and
 *  the wording can never disagree about which case they are in. */
export function outcomeClass(outcome: PvpOutcome): string {
  return outcome === "win" ? "win"
    : outcome === "loss" ? "loss"
    : outcome === "draw" ? "draw"
    : "void";
}
