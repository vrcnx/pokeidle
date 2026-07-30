// The post-battle verdict.
//
// Two confirmed bugs in the inline result bar this replaces, both reproduced
// below before being fixed:
//
//   * A GENUINE DRAW rendered as "Battle cancelled". The bar derived
//     `cancelled = winnerId == null`, so a tie and an abort were the same case —
//     and the battle log two panels away simultaneously said "The battle ended
//     in a tie." The board and the verdict contradicted each other.
//   * THE END REASON WAS DROPPED for everything except forfeit and timeout, so a
//     KO win and a win by opponent disconnect both rendered as a bare
//     "You win! +17" with nothing saying why the battle stopped.
//
// The server's complete reason vocabulary is `"ko" | "tie" | "forfeit" |
// "timeout" | "cancelled"` (server/src/pvp.ts's `endBattle` signature) plus the
// client's own `voided` flag, and there is a case here for each.

import { describe, expect, it } from "vitest";
import { summarisePvpResult, outcomeClass, type PvpResultInput } from "../src/utils/pvpResult";

const OPP = { id: "opp-1", username: "Rival" };
const ME = "me-1";

function room(over: Partial<PvpResultInput> = {}): PvpResultInput {
  return {
    voided: false,
    format: "random50",
    opponent: OPP,
    result: { winnerId: ME, loserId: OPP.id, reason: "ko", ratingDelta: null },
    ended: null,
    ...over,
  };
}

describe("who won", () => {
  it("reads a win as a win — the winner is a real userId that is not the opponent's", () => {
    const s = summarisePvpResult(room());
    expect(s.outcome).toBe("win");
    expect(s.headline).toBe("You win!");
  });

  it("reads a loss as a loss", () => {
    const s = summarisePvpResult(room({
      result: { winnerId: OPP.id, loserId: ME, reason: "ko", ratingDelta: null },
    }));
    expect(s.outcome).toBe("loss");
    expect(s.headline).toBe("You lose.");
  });
});

describe("REGRESSION: a genuine draw is a draw, not a cancellation", () => {
  it("calls a tie a draw when the server says so", () => {
    // Live reproduction: protocol "|tie" plus battle:complete { winnerId: null,
    // reason: "tie" } rendered the verdict "Battle cancelled".
    const s = summarisePvpResult(room({
      result: { winnerId: null, loserId: null, reason: "tie", ratingDelta: null },
    }));
    expect(s.outcome).toBe("draw");
    expect(s.headline).toBe("It's a draw.");
    expect(s.headline).not.toContain("cancelled");
  });

  it("calls it a draw off the decoded battle's own |tie| too, as a second witness", () => {
    // Belt and braces: if battle:complete's reason is ever something else while
    // the simulator has already said tie, the board and the verdict still agree.
    const s = summarisePvpResult(room({
      result: { winnerId: null, loserId: null, reason: "cancelled", ratingDelta: null },
      ended: { winner: null, tie: true },
    }));
    expect(s.outcome).toBe("draw");
  });

  it("still calls a real cancellation a cancellation", () => {
    const s = summarisePvpResult(room({
      result: { winnerId: null, loserId: null, reason: "cancelled", ratingDelta: null },
    }));
    expect(s.outcome).toBe("cancelled");
    expect(s.headline).toBe("Battle cancelled");
  });

  it("gives a draw its own colour rather than borrowing the void one", () => {
    expect(outcomeClass("draw")).toBe("draw");
    expect(outcomeClass("cancelled")).toBe("void");
    expect(outcomeClass("win")).toBe("win");
    expect(outcomeClass("loss")).toBe("loss");
    expect(outcomeClass("voided")).toBe("void");
  });
});

describe("REGRESSION: the end reason is always stated", () => {
  it("explains a KO win", () => {
    // Live reproduction: reason "ko" rendered "You win! | +17 → 1217" with no
    // mention of why the battle stopped.
    const s = summarisePvpResult(room());
    expect(s.reasonText).toContain("knockout");
    expect(s.reasonText).toContain("opponent");
  });

  it("explains a KO loss from the loser's side", () => {
    const s = summarisePvpResult(room({
      result: { winnerId: OPP.id, loserId: ME, reason: "ko", ratingDelta: null },
    }));
    expect(s.reasonText).toContain("knockout");
    expect(s.reasonText).toContain("your last Pokémon");
  });

  it("explains a forfeit in both directions, and is honest that a disconnect looks the same", () => {
    // The server has no "disconnect" reason: a grace-window expiry after a
    // disconnect is forfeited under this same reason, so claiming one would be a
    // guess. Saying both is the honest answer.
    const win = summarisePvpResult(room({
      result: { winnerId: ME, loserId: OPP.id, reason: "forfeit", ratingDelta: null },
    }));
    expect(win.reasonText).toContain("forfeited");
    expect(win.reasonText).toContain("connection");

    const loss = summarisePvpResult(room({
      result: { winnerId: OPP.id, loserId: ME, reason: "forfeit", ratingDelta: null },
    }));
    expect(loss.reasonText).toBe("You forfeited the battle.");
  });

  it("explains a timeout in both directions", () => {
    expect(summarisePvpResult(room({
      result: { winnerId: ME, loserId: OPP.id, reason: "timeout", ratingDelta: null },
    })).reasonText).toContain("Your opponent ran out of time");
    expect(summarisePvpResult(room({
      result: { winnerId: OPP.id, loserId: ME, reason: "timeout", ratingDelta: null },
    })).reasonText).toContain("You ran out of time");
  });

  it("explains a draw", () => {
    expect(summarisePvpResult(room({
      result: { winnerId: null, loserId: null, reason: "tie", ratingDelta: null },
    })).reasonText).toContain("same turn");
  });

  it("explains a voided battle", () => {
    const s = summarisePvpResult(room({ voided: true }));
    expect(s.outcome).toBe("voided");
    expect(s.reasonText).toContain("server restarted");
  });

  it("never leaves the reason empty, for any reason string the server could add", () => {
    for (const reason of ["ko", "tie", "forfeit", "timeout", "cancelled", "disconnect", "", "something_new"]) {
      for (const winnerId of [ME, OPP.id, null]) {
        const s = summarisePvpResult(room({
          result: { winnerId, loserId: null, reason, ratingDelta: null },
        }));
        expect(s.reasonText.length).toBeGreaterThan(0);
        expect(s.headline.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("rating, stated in both directions", () => {
  const delta = { aDelta: 17, bDelta: -17, aRating: 1217, bRating: 1183 };

  it("gives the WINNER side a's numbers — a is the winner, not seat a", () => {
    // server/src/lib/pvpLadder.ts: "`a` is the WINNER, `b` is the loser".
    // Reading it as a protocol seat would hand a losing side-a player +17.
    const s = summarisePvpResult(room({
      result: { winnerId: ME, loserId: OPP.id, reason: "ko", ratingDelta: delta },
    }));
    expect(s.rated).toBe(true);
    expect(s.delta).toBe(17);
    expect(s.rating).toBe(1217);
  });

  it("gives the loser side b's numbers", () => {
    const s = summarisePvpResult(room({
      result: { winnerId: OPP.id, loserId: ME, reason: "ko", ratingDelta: delta },
    }));
    expect(s.delta).toBe(-17);
    expect(s.rating).toBe(1183);
  });

  it("says a bot battle is NOT rated even if a delta somehow arrived", () => {
    // The one thing this must never do is let a player think an AI win moved
    // their ladder rating.
    const s = summarisePvpResult(room({
      format: "bot",
      result: { winnerId: ME, loserId: OPP.id, reason: "ko", ratingDelta: delta },
    }));
    expect(s.rated).toBe(false);
    expect(s.delta).toBeNull();
    expect(s.ratedNote).toContain("not rated");
    expect(s.ratedNote).toContain("AI");
  });

  it("explains a MISSING delta on a ranked match rather than just omitting it", () => {
    // endBattle's ELO update is awaited inside a try/catch and logs
    // pvp_elo_update_failed on error. A win with no number beside it reads as
    // "the rating silently broke", so it gets a sentence.
    const s = summarisePvpResult(room({
      result: { winnerId: ME, loserId: OPP.id, reason: "ko", ratingDelta: null },
    }));
    expect(s.rated).toBe(false);
    expect(s.ratedNote).toContain("no rating change was reported");
  });

  it("says an unfinished ranked battle does not move the ladder", () => {
    const s = summarisePvpResult(room({
      result: { winnerId: null, loserId: null, reason: "cancelled", ratingDelta: null },
    }));
    expect(s.ratedNote).toContain("does not move the ladder");
  });

  it("names a friendly and a tournament battle honestly", () => {
    expect(summarisePvpResult(room({ format: "anything-goes" })).ratedNote)
      .toBe("Friendly battle — not rated.");
    expect(summarisePvpResult(room({ format: "tournament" })).ratedNote)
      .toContain("Tournament");
  });

  it("never rates a voided battle", () => {
    const s = summarisePvpResult(room({
      voided: true,
      result: { winnerId: ME, loserId: OPP.id, reason: "ko", ratingDelta: delta },
    }));
    expect(s.rated).toBe(false);
    expect(s.delta).toBeNull();
    expect(s.ratedNote).toContain("unchanged");
  });

  it("never rates a draw or a cancellation", () => {
    for (const reason of ["tie", "cancelled"]) {
      const s = summarisePvpResult(room({
        result: { winnerId: null, loserId: null, reason, ratingDelta: delta },
      }));
      expect(s.rated).toBe(false);
      expect(s.delta).toBeNull();
    }
  });
});

describe("a null result — the battle is over but nothing said how", () => {
  it("does not crash and does not claim a win", () => {
    const s = summarisePvpResult(room({ result: null }));
    expect(s.outcome).toBe("cancelled");
    expect(s.rated).toBe(false);
    expect(s.reasonText.length).toBeGreaterThan(0);
  });
});
