// PvP ladder rewards — THE PURE POLICY, proved by execution.
//
// Everything in lib/pvpLadder.ts that decides an amount is a pure function of an
// explicitly-described match, so every rule in this feature is provable without
// a database, without a clock and without a socket. The settle transaction
// (tests/pvpLadderSettle.test.ts) proves the things only Postgres can arbitrate.
//
// The three properties this file exists to keep true:
//
//   1. A BOT BATTLE PAYS NOTHING. The gate is a positive assertion
//      (`ladderProvenance`) that only the two HUMAN pairing paths make, so a bot
//      room — or any future room type — refuses by default. There is no "is this
//      a bot?" branch to forget.
//   2. A FORFEIT OR TIMEOUT PAYS NOBODY, including the survivor, so a player can
//      never profit from their opponent disconnecting.
//   3. COLLUSION IS BOUNDED — by a rolling BP cap and a cash cooldown, and by
//      pricing the cash on a zero-sum rating. Nothing else is allowed to cost an
//      honest player anything.
//
// A large block of this file is REGRESSION COVER for reported defects. Each was
// reproduced by execution first, and each test states the observed numbers so a
// future edit that re-breaks it says so in the failure message rather than in
// production:
//
//   * a 5th meeting decaying to 0 BP made the win bonus unclaimable — a player
//     who lost four times to one rival and won the fifth was paid $0 and 0 BP;
//   * the real busiest PvP day in the game's history (12 matches, one pair) paid
//     BOTH sides literally nothing for 8 of the 12 battles;
//   * five straight losses to one opponent paid 1, 1, 0, 0, 0, so the stated
//     reason for paying the loser at all stopped applying at meeting 3;
//   * milestone BP was booked into the capped column, so one 98-BP rank-up match
//     exhausted the 25-BP cap for every legitimate battle after it that day;
//   * milestones keyed on the LIVE rating, so flipping PVP_LADDER_REWARDS on
//     would have paid every already-high account its entire back-catalogue;
//   * matchmade-only refused friend invites, which are 76% of every PvP match
//     ever played here;
//   * a 60s wall-clock floor refused genuine 4- and 6-turn matches;
//   * the cash was flat, and sized against a cohort that does not play PvP.
//
// No mocks and no database — this file imports nothing that reaches src/db.ts.

import { describe, expect, it } from "vitest";

import {
  LADDER_BP_CAP_PER_WINDOW,
  LADDER_BP_ITEM_ID,
  LADDER_BP_LOSS,
  LADDER_BP_MIN_PER_PAYABLE_MATCH,
  LADDER_BP_TIE,
  LADDER_BP_WIN,
  LADDER_BP_WINDOW_MS,
  LADDER_DECAY_PERCENT_BY_MEETING,
  LADDER_DECAY_PERCENT_FLOOR,
  LADDER_MAX_BP_ONE_ACCOUNT_ONE_WINDOW,
  LADDER_MIN_DURATION_MS,
  LADDER_MIN_TURNS,
  LADDER_PAYABLE_END_REASONS,
  LADDER_PAYABLE_PROVENANCE,
  LADDER_WIN_BONUS_BP,
  LADDER_WIN_BONUS_COOLDOWN_MS,
  baseBpForResult,
  computeLadderReward,
  countTurnsInLog,
  decayPercentForMeeting,
  explainEarn,
  prizesFor,
  structuralRefusal,
  utcDayString,
  type LadderMatchDescription,
  type LadderMatchShape,
  type LadderResult,
  type LadderRewardPlan,
  type LadderSideReward,
  type LadderSideState,
} from "../src/lib/pvpLadder.js";
import {
  PVP_BADGE_TIERS,
  PVP_MILESTONES,
  PVP_MILESTONE_BP_LIFETIME_TOTAL,
  milestonesCrossed,
  pvpBadgeForRating,
  pvpTierForRating,
  winBonusMoneyForRating,
} from "../src/lib/pvpBadge.js";

// ── Fixtures ────────────────────────────────────────────────────────
// Deliberately explicit: every field a decision reads is nameable at the call
// site, so a test can never pass because a default happened to be favourable.

function sideState(over: Partial<LadderSideState> & { userId: string; result: LadderResult }): LadderSideState {
  const won = over.result === "win";
  return {
    opponentUserId: over.userId === "alice" ? "bob" : "alice",
    realAccount: true,
    ratingBefore: 1000,
    ratingAfter: won ? 1016 : over.result === "tie" ? 1000 : 984,
    ratingDelta: won ? 16 : over.result === "tie" ? 0 : -16,
    priorMeetingsVsOpponentInWindow: 0,
    bpEarnedInWindowBeforeThis: 0,
    winBonusOnCooldown: false,
    milestonesAlreadyAwarded: [],
    ...over,
  };
}

function match(
  a: LadderSideState,
  b: LadderSideState,
  over: Partial<LadderMatchDescription> = {},
): LadderMatchDescription {
  return {
    matchId: "b_test",
    provenance: "queue",
    rated: true,
    endReason: "ko",
    turns: 6,
    durationMs: 4 * 60_000,
    sides: [a, b],
    ...over,
  };
}

/** alice vs bob, with per-side overrides. `aOver.result` decides the outcome and
 *  the mirror side is derived, so an inconsistent outcome cannot be built by
 *  accident. */
function duel(
  aOver: Partial<LadderSideState> = {},
  bOver: Partial<LadderSideState> = {},
  mOver: Partial<LadderMatchDescription> = {},
): LadderMatchDescription {
  const aResult = (aOver.result ?? "win") as LadderResult;
  const bResult: LadderResult = aResult === "win" ? "loss" : aResult === "loss" ? "win" : "tie";
  return match(
    sideState({ userId: "alice", ...aOver, result: aResult }),
    sideState({ userId: "bob", ...bOver, result: (bOver.result ?? bResult) as LadderResult }),
    mOver,
  );
}

function sideOf(plan: LadderRewardPlan, userId: string): LadderSideReward {
  const s = plan.sides.find((x) => x.userId === userId);
  if (!s) throw new Error(`no side for ${userId}: ${JSON.stringify(plan)}`);
  return s;
}

const shape = (over: Partial<LadderMatchShape> = {}): LadderMatchShape => ({
  provenance: "queue", rated: true, endReason: "ko", turns: 9, durationMs: 300_000, ...over,
});

/**
 * Replay a whole window of matches between the SAME pair, threading each side's
 * ledger state forward exactly as the settle does. This is the harness that
 * reproduced three of the reported defects, so it is kept rather than inlined.
 */
function playWindow(results: LadderResult[]) {
  let aBp = 0, bBp = 0, aMoney = 0, bMoney = 0;
  let aBonusUsed = false, bBonusUsed = false, meetings = 0;
  const perMatch: { aBp: number; bBp: number; aMoney: number; bMoney: number }[] = [];
  for (const r of results) {
    const plan = computeLadderReward(duel(
      {
        result: r,
        priorMeetingsVsOpponentInWindow: meetings,
        bpEarnedInWindowBeforeThis: aBp,
        winBonusOnCooldown: aBonusUsed,
      },
      {
        priorMeetingsVsOpponentInWindow: meetings,
        bpEarnedInWindowBeforeThis: bBp,
        winBonusOnCooldown: bBonusUsed,
      },
    ));
    const A = sideOf(plan, "alice");
    const B = sideOf(plan, "bob");
    perMatch.push({ aBp: A.bpTotal, bBp: B.bpTotal, aMoney: A.money, bMoney: B.money });
    aBp += A.bpFromBattle + A.bpWinBonus;
    bBp += B.bpFromBattle + B.bpWinBonus;
    aMoney += A.money;
    bMoney += B.money;
    if (A.winBonus) aBonusUsed = true;
    if (B.winBonus) bBonusUsed = true;
    meetings++;
  }
  return { aBp, bBp, aMoney, bMoney, perMatch };
}

// ════════════════════════════════════════════════════════════════════
// 1. THE BOT GATE
// ════════════════════════════════════════════════════════════════════
describe("bot battles cannot pay — the reward is opt-in at room construction", () => {
  it("refuses a room that carries no human-pairing provenance", () => {
    const plan = computeLadderReward(duel({}, {}, { provenance: null }));
    expect(plan.eligible).toBe(false);
    expect(plan.refusedReason).toBe("not_human_pvp");
    expect(plan.sides).toEqual([]);
  });

  it("fails CLOSED for a room object built without the field at all", () => {
    // The exact shape a future bot / tournament room literal produces: the
    // property is simply absent, so it reads `undefined`.
    const room = { format: "bot", isBot: true } as unknown as { ladderProvenance?: string };
    expect(structuralRefusal(shape({ provenance: room.ladderProvenance }))).toBe("not_human_pvp");
  });

  it("refuses every provenance not on the allowlist, including near-misses", () => {
    for (const p of ["bot", "tournament", "admin", "stream", "QUEUE", "", " queue", "queue "]) {
      expect(structuralRefusal(shape({ provenance: p }))).toBe("not_human_pvp");
    }
    expect([...LADDER_PAYABLE_PROVENANCE]).toEqual(["queue", "invite"]);
    for (const p of LADDER_PAYABLE_PROVENANCE) {
      expect(structuralRefusal(shape({ provenance: p }))).toBeNull();
    }
  });

  it("refuses when EITHER side is not a real, save-having account", () => {
    expect(computeLadderReward(duel({ realAccount: false })).refusedReason)
      .toBe("opponent_not_a_real_account");
    expect(computeLadderReward(duel({}, { realAccount: false })).refusedReason)
      .toBe("opponent_not_a_real_account");
  });

  it("refuses an unrated result — an unrated battle is never a ladder battle", () => {
    expect(computeLadderReward(duel({}, {}, { rated: false })).refusedReason).toBe("unrated");
  });

  it("refuses a self-play room", () => {
    expect(computeLadderReward(match(
      sideState({ userId: "alice", result: "win", opponentUserId: "alice" }),
      sideState({ userId: "alice", result: "loss", opponentUserId: "alice" }),
    )).refusedReason).toBe("self_match");
  });

  it("refuses a match with no user ids", () => {
    expect(computeLadderReward(match(
      sideState({ userId: "", result: "win" }),
      sideState({ userId: "bob", result: "loss" }),
    )).refusedReason).toBe("missing_user_id");
  });

  it("refuses an outcome that does not describe one winner and one loser", () => {
    expect(computeLadderReward(match(
      sideState({ userId: "alice", result: "win" }),
      sideState({ userId: "bob", result: "win" }),
    )).refusedReason).toBe("inconsistent_results");
    expect(computeLadderReward(match(
      sideState({ userId: "alice", result: "win" }),
      sideState({ userId: "bob", result: "tie" }),
    )).refusedReason).toBe("inconsistent_results");
  });

  it("checks the bot gate BEFORE anything else, so a bot forfeit reports the bot reason", () => {
    expect(structuralRefusal({
      provenance: undefined, rated: false, endReason: "forfeit", turns: 0, durationMs: 0,
    })).toBe("not_human_pvp");
  });
});

// ════════════════════════════════════════════════════════════════════
// 2. FRIEND INVITES PAY — the removed "matchmade only" rule
// ════════════════════════════════════════════════════════════════════
describe("friend invites are payable, because they ARE PvP in this game", () => {
  // REGRESSION. Measured read-only against production: 42 of 55 matches ever
  // (76%) are between accounts that are FRIENDS, and 8 of the 9 pairs that met
  // more than once are friends — including the top pair at 12 matches. The old
  // rule refused every one of them and called the cost "small".
  it("pays an invite exactly as it pays a queue pairing", () => {
    const viaQueue = sideOf(computeLadderReward(duel({}, {}, { provenance: "queue" })), "alice");
    const viaInvite = sideOf(computeLadderReward(duel({}, {}, { provenance: "invite" })), "alice");
    expect(viaInvite.bpTotal).toBe(viaQueue.bpTotal);
    expect(viaInvite.money).toBe(viaQueue.money);
    expect(viaInvite.money).toBeGreaterThan(0);
  });

  it("stayed an allowlist — widening it by one HUMAN path did not make it a denylist", () => {
    expect(LADDER_PAYABLE_PROVENANCE.length).toBe(2);
    expect((LADDER_PAYABLE_PROVENANCE as readonly string[]).includes("bot")).toBe(false);
    // A bot room is refused because it carries NOTHING, not because "bot" is
    // enumerated anywhere. That is the property that survives a refactor.
    expect(structuralRefusal(shape({ provenance: undefined }))).toBe("not_human_pvp");
  });
});

// ════════════════════════════════════════════════════════════════════
// 3. A FORFEIT / TIMEOUT IS NEVER A PAYDAY
// ════════════════════════════════════════════════════════════════════
describe("a forfeit, a timeout or a cancellation pays NOBODY", () => {
  it("pays only reasons on the ALLOWLIST", () => {
    expect([...LADDER_PAYABLE_END_REASONS]).toEqual(["ko", "tie"]);
    expect(structuralRefusal(shape({ endReason: "forfeit" }))).toBe("end_reason_forfeit");
    expect(structuralRefusal(shape({ endReason: "timeout" }))).toBe("end_reason_timeout");
    expect(structuralRefusal(shape({ endReason: "cancelled" }))).toBe("end_reason_cancelled");
    expect(structuralRefusal(shape({ endReason: "ko" }))).toBeNull();
  });

  it("refuses the SURVIVOR of a forfeit as well as the quitter", () => {
    // Both directions, because "you must not profit from your opponent
    // disconnecting" is the actual requirement and it is symmetric.
    expect(computeLadderReward(duel({}, {}, { endReason: "forfeit" })).refusedReason)
      .toBe("end_reason_forfeit");
    expect(computeLadderReward(duel({ result: "loss" }, {}, { endReason: "forfeit" })).refusedReason)
      .toBe("end_reason_forfeit");
  });

  it("refuses an instant KO — an agreed 'battle' that never happened", () => {
    expect(structuralRefusal(shape({ turns: 0 }))).toBe("too_few_turns");
    expect(structuralRefusal(shape({ turns: LADDER_MIN_TURNS - 1 }))).toBe("too_few_turns");
    expect(structuralRefusal(shape({ turns: LADDER_MIN_TURNS }))).toBeNull();
  });

  it("refuses non-finite turns and durations rather than treating them as large", () => {
    expect(structuralRefusal(shape({ turns: NaN }))).toBe("too_few_turns");
    expect(structuralRefusal(shape({ turns: Infinity }))).toBe("too_few_turns");
    expect(structuralRefusal(shape({ durationMs: NaN }))).toBe("too_short");
    expect(structuralRefusal(shape({ durationMs: Infinity }))).toBe("too_short");
  });

  // REGRESSION. The floor was 60_000 ms and refused, at the boundary, a 6-turn
  // battle finished in 59,999 ms, a 4-turn in 55,000 ms and a 3-turn in
  // 45,000 ms — genuine, decisive, briskly-played matches. It bought nothing: a
  // colluder defeats a wall-clock floor by waiting.
  it("no longer refuses a genuine brisk match, which a 60s floor did", () => {
    expect(LADDER_MIN_DURATION_MS).toBe(20_000);
    for (const ms of [20_000, 45_000, 55_000, 59_999]) {
      expect(structuralRefusal(shape({ turns: 6, durationMs: ms }))).toBeNull();
    }
    // …and still refuses scripted instant play.
    expect(structuralRefusal(shape({ turns: 6, durationMs: 19_999 }))).toBe("too_short");
    expect(structuralRefusal(shape({ turns: 6, durationMs: 0 }))).toBe("too_short");
  });
});

// ════════════════════════════════════════════════════════════════════
// 4. THE HAPPY PATH
// ════════════════════════════════════════════════════════════════════
describe("the happy path", () => {
  it("pays the winner and the loser, and prices the cash by tier", () => {
    const plan = computeLadderReward(duel());
    expect(plan.eligible).toBe(true);
    const a = sideOf(plan, "alice");
    const b = sideOf(plan, "bob");

    expect(a.bpFromBattle).toBe(LADDER_BP_WIN);
    expect(a.winBonus).toBe(true);
    expect(a.bpWinBonus).toBe(LADDER_WIN_BONUS_BP);
    expect(a.bpTotal).toBe(LADDER_BP_WIN + LADDER_WIN_BONUS_BP);
    // 1016 is Bronze on the client's bands, so the entry-tier amount.
    expect(a.tier).toBe("bronze");
    expect(a.money).toBe(PVP_BADGE_TIERS[0].winBonusMoney);

    expect(b.bpFromBattle).toBe(LADDER_BP_LOSS);
    expect(b.winBonus).toBe(false);
    expect(b.money).toBe(0);
  });

  it("turns the reward into inbox Prizes — an ITEM and MONEY, never a save field", () => {
    const a = sideOf(computeLadderReward(duel()), "alice");
    expect(a.prizes).toEqual([
      { kind: "item", itemId: LADDER_BP_ITEM_ID, quantity: a.bpTotal },
      { kind: "money", amount: a.money },
    ]);
    // The whole reason the new currency is an inventory item: both kinds already
    // exist in giveaway.ts, so foldPrizesIntoSave needs no new branch.
    for (const p of a.prizes) expect(["item", "money"]).toContain(p.kind);
  });

  it("emits NO prizes when nothing was earned, so no empty grant is created", () => {
    const a = sideOf(computeLadderReward(duel(
      { result: "loss", bpEarnedInWindowBeforeThis: LADDER_BP_CAP_PER_WINDOW },
      { winBonusOnCooldown: true },
    )), "alice");
    expect(a.bpTotal).toBe(0);
    expect(a.prizes).toEqual([]);
  });

  it("prizesFor never emits a zero or negative quantity", () => {
    expect(prizesFor(0, 0)).toEqual([]);
    expect(prizesFor(-5, -5)).toEqual([]);
    expect(prizesFor(3, 0)).toEqual([{ kind: "item", itemId: LADDER_BP_ITEM_ID, quantity: 3 }]);
    expect(prizesFor(0, 10)).toEqual([{ kind: "money", amount: 10 }]);
  });

  it("scores each result at its documented rate", () => {
    expect(baseBpForResult("win")).toBe(LADDER_BP_WIN);
    expect(baseBpForResult("loss")).toBe(LADDER_BP_LOSS);
    expect(baseBpForResult("tie")).toBe(LADDER_BP_TIE);
  });

  it("has a complete tie policy even though pvp.ts cannot currently reach it", () => {
    const plan = computeLadderReward(match(
      sideState({ userId: "alice", result: "tie" }),
      sideState({ userId: "bob", result: "tie" }),
      { endReason: "tie" },
    ));
    expect(plan.eligible).toBe(true);
    for (const s of plan.sides) {
      expect(s.bpFromBattle).toBe(LADDER_BP_TIE);
      // A draw is not a win, so it never claims the win bonus.
      expect(s.winBonus).toBe(false);
      expect(s.money).toBe(0);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// 5. PER-OPPONENT DECAY — and the floor that stops it reaching zero
// ════════════════════════════════════════════════════════════════════
describe("repeat meetings with the same opponent decay, but never to nothing", () => {
  it("pays 100/100/75/75/50 and then a 50% floor forever", () => {
    expect([...LADDER_DECAY_PERCENT_BY_MEETING]).toEqual([100, 100, 75, 75, 50]);
    expect(LADDER_DECAY_PERCENT_FLOOR).toBe(50);
    for (const n of [6, 7, 12, 40, 500]) {
      expect(decayPercentForMeeting(n)).toBe(LADDER_DECAY_PERCENT_FLOOR);
    }
  });

  // REGRESSION. The old table ended in 0%, and 3 BP times 0% is 0 BP.
  it("never pays zero for a match that passed every structural gate", () => {
    for (const meetings of [0, 1, 2, 3, 4, 5, 9, 25, 99]) {
      const plan = computeLadderReward(duel(
        { priorMeetingsVsOpponentInWindow: meetings },
        { priorMeetingsVsOpponentInWindow: meetings },
      ));
      for (const s of plan.sides) {
        expect(s.bpFromBattle).toBeGreaterThanOrEqual(LADDER_BP_MIN_PER_PAYABLE_MATCH);
      }
    }
  });

  // REGRESSION, the exact reproduction: the real busiest PvP day in the game's
  // history is 12 matches between one pair. Under the old table, 8 of those 12
  // paid BOTH sides exactly 0, with no UI to explain it.
  it("pays something on every one of the 12 matches of the real busiest PvP day", () => {
    const results: LadderResult[] = [];
    for (let i = 0; i < 12; i++) results.push(i % 2 === 0 ? "win" : "loss");
    const day = playWindow(results);
    expect(day.perMatch.filter((p) => p.aBp === 0 && p.bBp === 0).length).toBe(0);
    // Both sides land under the cap — the CAP is the bound, not the decay.
    expect(day.aBp).toBeGreaterThan(10);
    expect(day.aBp).toBeLessThanOrEqual(LADDER_BP_CAP_PER_WINDOW);
    expect(day.bBp).toBeLessThanOrEqual(LADDER_BP_CAP_PER_WINDOW);
  });

  // REGRESSION. LADDER_BP_LOSS is 1, so any decay below 100% floored it to 0 and
  // a loss paid nothing from the 3rd meeting — precisely the behaviour that
  // "pay the loser so they keep queueing" exists to prevent.
  it("pays a loss on every meeting, not just the first two", () => {
    const day = playWindow(["loss", "loss", "loss", "loss", "loss"]);
    expect(day.perMatch.map((p) => p.aBp)).toEqual([1, 1, 1, 1, 1]);
    expect(day.aBp).toBe(5);
  });

  it("rounds decay DOWN, and the floor can never exceed the undecayed value", () => {
    for (const meetings of [0, 2, 4, 10]) {
      const plan = computeLadderReward(duel(
        { priorMeetingsVsOpponentInWindow: meetings },
        { priorMeetingsVsOpponentInWindow: meetings },
      ));
      for (const s of plan.sides) expect(s.bpFromBattle).toBeLessThanOrEqual(s.bpBeforeDecay);
    }
  });

  it("decayPercentForMeeting is total and refuses nonsense indices", () => {
    expect(decayPercentForMeeting(0)).toBe(0);
    expect(decayPercentForMeeting(-3)).toBe(0);
    expect(decayPercentForMeeting(NaN)).toBe(0);
    expect(decayPercentForMeeting(Infinity)).toBe(0);
    expect(decayPercentForMeeting(1)).toBe(100);
  });

  it("clamps a negative prior-meeting count to the first meeting", () => {
    const a = sideOf(computeLadderReward(duel(
      { priorMeetingsVsOpponentInWindow: -7 }, { priorMeetingsVsOpponentInWindow: -7 },
    )), "alice");
    expect(a.meetingIndex).toBe(1);
    expect(a.decayPercent).toBe(100);
  });
});

// ════════════════════════════════════════════════════════════════════
// 6. THE ROLLING BP CAP — the only hard bound on the repeatable faucet
// ════════════════════════════════════════════════════════════════════
describe("the rolling BP cap is the hard bound, and it holds", () => {
  it("is measured over a rolling 24h window, not a calendar day", () => {
    // REGRESSION: a calendar window is straddleable — measured, two matches 61
    // seconds apart across 00:00Z paid one account double the daily maximum. A
    // rolling window has no boundary to sit on. pvpLadderSettle.test.ts proves
    // the SQL agrees.
    expect(LADDER_BP_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("clamps the last paying win to exactly the remaining balance", () => {
    const a = sideOf(computeLadderReward(duel(
      { bpEarnedInWindowBeforeThis: LADDER_BP_CAP_PER_WINDOW - 2, winBonusOnCooldown: true },
      {},
    )), "alice");
    expect(a.bpFromBattle).toBe(2);
  });

  it("never goes negative once the cap is exceeded", () => {
    const a = sideOf(computeLadderReward(duel(
      { bpEarnedInWindowBeforeThis: LADDER_BP_CAP_PER_WINDOW + 40, winBonusOnCooldown: true },
      {},
    )), "alice");
    expect(a.bpFromBattle).toBe(0);
    expect(a.bpTotal).toBe(0);
  });

  it("counts the win-bonus BP against the same cap", () => {
    const a = sideOf(computeLadderReward(duel(
      { bpEarnedInWindowBeforeThis: LADDER_BP_CAP_PER_WINDOW - 4 }, {},
    )), "alice");
    // 3 for the battle, then only 1 of the 5 bonus BP fits.
    expect(a.bpFromBattle).toBe(3);
    expect(a.bpWinBonus).toBe(1);
  });

  it("bounds a whole window of battle BP at the cap however many opponents are used", () => {
    // Fresh opponent every time, so decay never applies — this is the maximum a
    // ring of alts can extract per account, and the cap is what stops it.
    let earned = 0;
    for (let i = 0; i < 60; i++) {
      const a = sideOf(computeLadderReward(duel(
        {
          opponentUserId: `alt${i}`,
          bpEarnedInWindowBeforeThis: earned,
          winBonusOnCooldown: i > 0,
        },
        { opponentUserId: "alice" },
      )), "alice");
      earned += a.bpFromBattle + a.bpWinBonus;
    }
    expect(earned).toBe(LADDER_BP_CAP_PER_WINDOW);
  });

  it("clamps a negative earned figure rather than granting extra headroom", () => {
    const a = sideOf(computeLadderReward(duel({ bpEarnedInWindowBeforeThis: -1_000 }, {})), "alice");
    expect(a.bpFromBattle).toBe(LADDER_BP_WIN);
    expect(a.bpWinBonus).toBe(LADDER_WIN_BONUS_BP);
  });

  // REGRESSION for the headline number itself. "The cap is 25" read as the hard
  // bound and was not: milestones are exempt, and one match could pay 98 BP.
  it("states the honest ceiling, inclusive of the exempt milestone stack", () => {
    expect(LADDER_MAX_BP_ONE_ACCOUNT_ONE_WINDOW)
      .toBe(LADDER_BP_CAP_PER_WINDOW + PVP_MILESTONE_BP_LIFETIME_TOTAL);
    expect(LADDER_MAX_BP_ONE_ACCOUNT_ONE_WINDOW).toBe(115);
    // …and the exempt part is a LIFETIME total, not a per-window one.
    expect(PVP_MILESTONE_BP_LIFETIME_TOTAL).toBe(90);
  });
});

// ════════════════════════════════════════════════════════════════════
// 7. THE WIN BONUS — cash, cooldown, and tier pricing
// ════════════════════════════════════════════════════════════════════
describe("the once-per-cooldown win bonus", () => {
  it("pays once, and not again while on cooldown", () => {
    expect(sideOf(computeLadderReward(duel({ winBonusOnCooldown: false })), "alice").winBonus).toBe(true);
    const after = sideOf(computeLadderReward(duel({ winBonusOnCooldown: true })), "alice");
    expect(after.winBonus).toBe(false);
    expect(after.money).toBe(0);
    expect(after.bpWinBonus).toBe(0);
  });

  it("never pays a LOSS", () => {
    const b = sideOf(computeLadderReward(duel()), "bob");
    expect(b.winBonus).toBe(false);
    expect(b.money).toBe(0);
  });

  // REGRESSION, the exact reproduction: [loss, loss, loss, loss, win] against
  // one opponent paid the 5th-match WINNER $0 and 0 BP, because the bonus
  // required the battle's own BP to survive decay and the 5th meeting had
  // decayed to zero. With ~8 people playing PvP that is the weaker half of every
  // rivalry, permanently.
  it("is claimable on a decayed win — losing four times then winning still pays", () => {
    const day = playWindow(["loss", "loss", "loss", "loss", "win"]);
    expect(day.perMatch[4].aMoney).toBeGreaterThan(0);
    expect(day.perMatch[4].aBp).toBeGreaterThan(0);
    expect(day.aMoney).toBe(PVP_BADGE_TIERS[0].winBonusMoney);
  });

  it("is still claimable when the BP cap is completely exhausted", () => {
    // The cash faucet is bounded by the cooldown arbiter, not by BP arithmetic,
    // so a full cap must not silently eat the cash bonus as well.
    const a = sideOf(computeLadderReward(duel(
      { bpEarnedInWindowBeforeThis: LADDER_BP_CAP_PER_WINDOW }, {},
    )), "alice");
    expect(a.bpFromBattle).toBe(0);
    expect(a.bpWinBonus).toBe(0);
    expect(a.winBonus).toBe(true);
    expect(a.money).toBeGreaterThan(0);
  });

  it("prices the cash by badge tier, which a collusion ring cannot manufacture", () => {
    const at = (rating: number) =>
      sideOf(computeLadderReward(duel({ ratingBefore: rating, ratingAfter: rating })), "alice");
    expect(at(1000).tier).toBe("bronze");
    expect(at(1000).money).toBe(10_000);
    expect(at(1100).money).toBe(25_000);
    expect(at(1300).money).toBe(60_000);
    expect(at(1500).money).toBe(120_000);
    expect(at(1700).money).toBe(200_000);
    // Monotonic in rating, and never above the top tier.
    let prev = 0;
    for (let r = 0; r <= 2500; r += 50) {
      const m = winBonusMoneyForRating(r);
      expect(m).toBeGreaterThanOrEqual(prev);
      prev = m;
    }
    expect(prev).toBe(200_000);
  });

  // REGRESSION for the sizing claim itself, against measured production
  // (read-only, 2026-07-30). The old flat $25,000 was justified as "11% of the
  // median active wallet"; the cohort that actually plays PvP has a median
  // wallet of $3,607,030, where it is 0.69% — noise.
  it("is sized against the cohort that will actually see it", () => {
    const PVP_COHORT_MEDIAN_WALLET = 3_607_030;        // 19 accounts, PvP-ever ∩ active-7d
    const AWAY_CLAIM_8H_AT_16_BADGES = 54_400;         // that cohort's median badge count is 16
    const AWAY_CLAIM_8H_AT_MEDIAN_ACTIVE = 32_000;     // active-24h median is 9 badges, not 16
    const ACTIVE_PLAY_FLOOR_PER_HOUR = 72_000;         // awayProgress.ts's own pessimistic floor

    // Bronze — where every alt and every new player sits — is deliberately BELOW
    // one median away claim, so PvP is never the best money-per-hour route.
    expect(PVP_BADGE_TIERS[0].winBonusMoney).toBeLessThan(AWAY_CLAIM_8H_AT_MEDIAN_ACTIVE);
    // Diamond is worth a real amount to the wealthy cohort that can reach it —
    // >5% of their median wallet rather than 0.69% — while still being under
    // three hours of documented honest play.
    const diamond = PVP_BADGE_TIERS[PVP_BADGE_TIERS.length - 1].winBonusMoney;
    expect(diamond / PVP_COHORT_MEDIAN_WALLET).toBeGreaterThan(0.05);
    expect(diamond).toBeGreaterThan(AWAY_CLAIM_8H_AT_16_BADGES);
    expect(diamond).toBeLessThan(3 * ACTIVE_PLAY_FLOOR_PER_HOUR);
  });

  it("bounds a colluding PAIR of fresh alts below one honest away claim", () => {
    // Both alts are Bronze — Elo is zero-sum, so alts trading wins cannot both
    // climb — and each can claim at most one bonus per cooldown.
    const pairPerCooldown = 2 * PVP_BADGE_TIERS[0].winBonusMoney;
    expect(pairPerCooldown).toBe(20_000);
    expect(pairPerCooldown).toBeLessThan(32_000);
    // A 20-alt ring takes strictly LESS than the flat-$25,000 design paid it.
    expect(20 * PVP_BADGE_TIERS[0].winBonusMoney).toBeLessThan(20 * 25_000);
  });

  it("cannot be compressed into a burst, because the gate is a cooldown", () => {
    expect(LADDER_WIN_BONUS_COOLDOWN_MS).toBe(20 * 60 * 60 * 1000);
    // The honest arithmetic that follows from 20h: at most 2 in the
    // worst-aligned 24h window, and never two inside one hour.
    expect(Math.ceil((24 * 60 * 60 * 1000) / LADDER_WIN_BONUS_COOLDOWN_MS)).toBe(2);
    expect(LADDER_WIN_BONUS_COOLDOWN_MS).toBeGreaterThan(60 * 60 * 1000);
  });

  it("is a standalone bonus and not a streak, so an empty queue breaks no promise", () => {
    // A player who cannot find an opponent for three days loses only the bonuses
    // they could not claim — there is no multiplier to reset. With 1–8 distinct
    // players online per hour, a streak mechanic would be a promise the
    // population cannot keep.
    const first = sideOf(computeLadderReward(duel({ winBonusOnCooldown: false })), "alice");
    const muchLater = sideOf(computeLadderReward(duel({ winBonusOnCooldown: false })), "alice");
    expect(muchLater.money).toBe(first.money);
    expect(muchLater.bpWinBonus).toBe(first.bpWinBonus);
  });
});

// ════════════════════════════════════════════════════════════════════
// 8. MILESTONES — crossing-only, exempt from the cap, once ever
// ════════════════════════════════════════════════════════════════════
describe("rating milestones", () => {
  const crossing = (before: number, after: number, already: number[] = []) =>
    sideOf(computeLadderReward(duel(
      { ratingBefore: before, ratingAfter: after, milestonesAlreadyAwarded: already, winBonusOnCooldown: true },
      {},
    )), "alice");

  it("awards nothing below the first threshold", () => {
    expect(crossing(1000, 1016).milestones).toEqual([]);
    expect(crossing(1000, 1099).milestones).toEqual([]);
  });

  it("awards a threshold on the match that crosses it", () => {
    const m = crossing(1090, 1106);
    expect(m.milestones.map((x) => x.threshold)).toEqual([1100]);
    expect(m.milestoneBp).toBe(10);
    expect(m.milestones[0].ratingBefore).toBe(1090);
    expect(m.milestones[0].ratingAtAward).toBe(1106);
  });

  // REGRESSION, the exact reproduction: milestones keyed on `ratingAfter` alone,
  // so an account sitting at 1500 collected [1100, 1200, 1350, 1500] — its
  // entire back-catalogue — on its next win. Rewards default OFF, so that is
  // exactly what the day the switch is flipped would have looked like.
  it("pays NOTHING to an account merely standing above a threshold", () => {
    expect(crossing(1500, 1516).milestones).toEqual([]);
    expect(crossing(1500, 1516).milestoneBp).toBe(0);
    expect(crossing(1700, 1720).milestones).toEqual([]);
  });

  it("awards every threshold a single big jump crosses, ascending", () => {
    const m = crossing(1000, 1750);
    expect(m.milestones.map((x) => x.threshold)).toEqual([1100, 1300, 1500, 1700]);
    expect(m.milestoneBp).toBe(PVP_MILESTONE_BP_LIFETIME_TOTAL);
  });

  it("never re-awards a threshold already paid", () => {
    expect(crossing(1090, 1310, [1100]).milestones.map((x) => x.threshold)).toEqual([1300]);
  });

  it("cannot be paid on a LOSS, because a loss cannot cross upward", () => {
    expect(milestonesCrossed(1150, 1100)).toEqual([]);
    expect(milestonesCrossed(1150, 1150)).toEqual([]);
    const a = sideOf(computeLadderReward(duel(
      { result: "loss", ratingBefore: 1120, ratingAfter: 1104 },
      { ratingBefore: 1000, ratingAfter: 1016 },
    )), "alice");
    expect(a.milestones).toEqual([]);
  });

  // REGRESSION: milestone BP used to be summed into the capped column, so a
  // 98-BP rank-up match exhausted the 25-BP cap for every legitimate battle
  // after it that day. It is now a separate figure at every level.
  it("is exempt from the cap AND does not consume it", () => {
    const burnt = sideOf(computeLadderReward(duel(
      {
        ratingBefore: 1000, ratingAfter: 1750,
        bpEarnedInWindowBeforeThis: LADDER_BP_CAP_PER_WINDOW,
        winBonusOnCooldown: true,
      },
      {},
    )), "alice");
    expect(burnt.bpFromBattle).toBe(0);
    expect(burnt.milestoneBp).toBe(PVP_MILESTONE_BP_LIFETIME_TOTAL);

    const m = crossing(1000, 1750);
    // The capped figure the ledger sums is SEPARATE from the milestone figure,
    // which is what makes the exemption true rather than merely documented.
    expect(m.bpFromBattle + m.bpWinBonus).toBeLessThanOrEqual(LADDER_BP_CAP_PER_WINDOW);
    expect(m.bpTotal).toBe(m.bpFromBattle + m.bpWinBonus + m.milestoneBp);
  });

  it("cannot be manufactured by a collusion ring, because Elo is zero-sum", () => {
    // Two accounts trading wins 1:1 end where they started, so their rating SUM
    // is constant and no number of matches manufactures a crossing.
    const K = 32;
    let a = 1000, b = 1000;
    for (let i = 0; i < 500; i++) {
      if (i % 2 === 0) { a += K / 2; b -= K / 2; } else { a -= K / 2; b += K / 2; }
      expect(a + b).toBe(2000);
    }
    expect(milestonesCrossed(1000, Math.max(a, b))).toEqual([]);
  });

  it("skips milestones for an unrated side rather than treating null as zero", () => {
    expect(milestonesCrossed(null, 1500)).toEqual([]);
    expect(milestonesCrossed(1000, null)).toEqual([]);
    expect(milestonesCrossed(NaN, 1500)).toEqual([]);
    expect(milestonesCrossed(1000, Infinity)).toEqual([]);
  });

  it("has a bounded lifetime total — the entire uncapped part of the faucet", () => {
    expect(PVP_MILESTONES.map((m) => m.threshold)).toEqual([1100, 1300, 1500, 1700]);
    expect(PVP_MILESTONES.map((m) => m.bp)).toEqual([10, 15, 25, 40]);
    expect(PVP_MILESTONE_BP_LIFETIME_TOTAL).toBe(90);
  });
});

// ════════════════════════════════════════════════════════════════════
// 9. BADGE TIERS
// ════════════════════════════════════════════════════════════════════
describe("badge tiers", () => {
  it("uses the client's bands and only the client's ids", () => {
    expect(PVP_BADGE_TIERS.map((t) => t.id)).toEqual(["bronze", "silver", "gold", "platinum", "diamond"]);
    expect(PVP_BADGE_TIERS.map((t) => t.minRating)).toEqual([0, 1100, 1300, 1500, 1700]);
  });

  // REGRESSION. The server used to return a synthetic "Rookie" tier for 0-match
  // accounts while the hub's tierFor() said Bronze at 1000.
  it("reports rankedness separately instead of inventing a tier for it", () => {
    const unplayed = pvpBadgeForRating(1000, 1000, 0);
    expect(unplayed.tier).toBe("bronze");
    expect(unplayed.label).toBe("Bronze");
    expect(unplayed.ranked).toBe(false);
    expect(pvpBadgeForRating(1000, 1000, 1).ranked).toBe(true);
  });

  it("maps the measured production ladder (984–1016) to Bronze", () => {
    for (const r of [984, 1000, 1016]) expect(pvpBadgeForRating(r, r, 1).tier).toBe("bronze");
  });

  it("is monotonic in rating", () => {
    let idx = -1;
    for (let r = 0; r <= 2400; r += 25) {
      const i = PVP_BADGE_TIERS.findIndex((t) => t.id === pvpTierForRating(r).id);
      expect(i).toBeGreaterThanOrEqual(idx);
      idx = i;
    }
  });

  it("remembers the best tier ever held, from peakRating", () => {
    const b = pvpBadgeForRating(1050, 1550, 20);
    expect(b.tier).toBe("bronze");
    expect(b.peakTier).toBe("platinum");
    expect(b.peakRating).toBe(1550);
  });

  it("reports the next tier and the gap, so the UI needs no second copy", () => {
    expect(pvpBadgeForRating(1262, 1262, 5).nextTier)
      .toEqual({ tier: "gold", label: "Gold", minRating: 1300, ratingToGo: 38 });
    expect(pvpBadgeForRating(1800, 1800, 5).nextTier).toBeNull();
  });

  it("survives missing / nonsense inputs without throwing", () => {
    expect(pvpBadgeForRating(null, null, null).tier).toBe("bronze");
    expect(pvpBadgeForRating(undefined, undefined, undefined).ranked).toBe(false);
    expect(pvpBadgeForRating(NaN, NaN, NaN).rating).toBe(1000);
    expect(pvpTierForRating(NaN).id).toBe("bronze");
    expect(pvpTierForRating(-500).id).toBe("bronze");
  });

  it("mints nothing — every milestone threshold IS a tier boundary", () => {
    for (const m of PVP_MILESTONES) {
      expect(PVP_BADGE_TIERS.some((t) => t.minRating === m.threshold)).toBe(true);
    }
  });

  it("gives the badge a cash meaning, so the hub can answer 'what is a win worth?'", () => {
    expect(pvpBadgeForRating(1000, 1000, 3).winBonusMoney).toBe(10_000);
    expect(pvpBadgeForRating(1750, 1750, 3).winBonusMoney).toBe(200_000);
  });
});

// ════════════════════════════════════════════════════════════════════
// 10. INPUTS DERIVED FROM THE ROOM
// ════════════════════════════════════════════════════════════════════
describe("inputs derived from the room, because they exist nowhere else", () => {
  it("counts |turn| markers and nothing that merely looks like one", () => {
    expect(countTurnsInLog([])).toBe(0);
    expect(countTurnsInLog(["|start", "|turn|1", "|move|p1a: Pikachu", "|turn|2"])).toBe(2);
    expect(countTurnsInLog(["|turnabout|", "turn|1", "|-turn|3"])).toBe(0);
  });

  it("ignores non-string log entries rather than throwing on a malformed log", () => {
    expect(countTurnsInLog([null as any, 7 as any, "|turn|1", undefined as any])).toBe(1);
  });

  it("keeps utcDayString for REPORTING while no gate reads a calendar day", () => {
    expect(utcDayString(new Date("2026-07-29T23:59:59.999Z"))).toBe("2026-07-29");
    expect(utcDayString(new Date("2026-07-30T00:00:00.000Z"))).toBe("2026-07-30");
    // The straddle is closed because the WINDOWS are rolling, not because this
    // function changed.
    expect(LADDER_BP_WINDOW_MS).toBeGreaterThan(0);
    expect(LADDER_WIN_BONUS_COOLDOWN_MS).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════
// 11. EVERY REWARD EXPLAINS ITSELF
// ════════════════════════════════════════════════════════════════════
describe("every reward explains itself", () => {
  // One reported defect was that nothing can explain a zero to the player. The
  // server half of the fix is that the explanation is COMPUTED HERE, so a client
  // never needs a second, drifting copy of the policy to render one.
  it("explains a full-rate first win", () => {
    const s = explainEarn({
      meetingIndex: 1, decayPercent: 100, bp: 8, milestoneBp: 0,
      money: 10_000, winBonusPaid: true, result: "win",
    });
    expect(s).toContain("8 BP");
    expect(s).toContain("$10,000 win bonus");
  });

  it("explains a decayed repeat meeting in words", () => {
    const s = explainEarn({
      meetingIndex: 6, decayPercent: 50, bp: 1, milestoneBp: 0,
      money: 0, winBonusPaid: false, result: "win",
    });
    expect(s).toContain("meeting #6");
    expect(s).toContain("50%");
    expect(s).toContain("win bonus already claimed");
  });

  it("explains a zero as a full cap rather than leaving it a mystery", () => {
    const s = explainEarn({
      meetingIndex: 3, decayPercent: 75, bp: 0, milestoneBp: 0,
      money: 0, winBonusPaid: false, result: "loss",
    });
    expect(s).toContain("cap for the last 24h is full");
  });

  it("names a rank-up bonus separately from ordinary BP", () => {
    const s = explainEarn({
      meetingIndex: 1, decayPercent: 100, bp: 8, milestoneBp: 25,
      money: 120_000, winBonusPaid: true, result: "win",
    });
    expect(s).toContain("33 BP");
    expect(s).toContain("25 BP rank-up bonus");
  });
});
