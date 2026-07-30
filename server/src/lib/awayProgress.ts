// Catch-up progress for time the player spent away — the "idle game that only
// runs while you watch it" complaint (br_876bae56ef21c9021c, and the loudest
// thing in chat: "its annoying to always have to keep the game open… if the PC
// shuts down nothing is counted in the background, same when the tab is
// minimized, by the browser itself, switching tabs, or opening a fullscreen
// game").
//
// ── WHY THE GAME STALLS IN THE BACKGROUND ────────────────────────────
// The simulation is a setTimeout chain (game/src/hooks/useBattleLoop.ts).
// Browsers clamp background-tab timers to roughly 1/second and freeze them
// outright once a tab is discarded or the device sleeps, so at ×5 — a 200ms
// tick — a backgrounded tab runs at under a twentieth of its normal rate, and
// a closed tab or a powered-off PC runs at zero. No amount of client work
// fixes that, because for most of the away time there IS no client.
//
// So progress cannot be *simulated* while away; it has to be *computed on
// return* from elapsed time. That is what this module does.
//
// ── WHY IT IS SAFE ───────────────────────────────────────────────────
// Two rules, and everything here follows from them.
//
// 1. THE CLOCK IS OURS. Every timestamp in the computation is written by this
//    server: `saveUpdatedAt` (stamped by POST /api/saves on every accepted
//    upload) and `awayClaimedAt` (stamped by the claim below). The client
//    never sends a time, a duration, or an amount, so moving the system clock,
//    replaying a request or hand-rolling one buys nothing.
//
// 2. PAYMENT GOES THROUGH THE PENDING-GRANT INBOX, which already solved this
//    exact problem for giveaway prizes. The reward becomes one PendingGrant
//    row; POST /api/saves folds it on top of whatever blob the client uploads,
//    inside the transaction that accepts that upload, and settles it under a
//    `deliveredAt IS NULL` compare-and-swap.
//
//    That means this feature adds NO new save-write path and NO new
//    compare-and-swap. It does not read saveData, it does not write saveData,
//    and it cannot race a client push — the delivery discipline that the
//    currency-printing and prize-destroying incidents produced is reused
//    wholesale rather than extended. If this file is wrong, the worst it can
//    do is owe the wrong number once; it cannot lose a save or double-pay,
//    because it is not the thing that pays.
//
// ── WHY MONEY AND NOTHING ELSE (yet) ─────────────────────────────────
// EXP, catches and dex entries are what players ultimately want from idle
// progress, and all three are far riskier: they mutate the Pokémon
// collection, and the server owns no species table, no stat formula and no
// encounter table (see the Prize `pokemon` comment in lib/giveaway.ts for why
// that is deliberate). Fabricating levelled-up mons here is how the save
// editor once handed out a Lv50 Charizard with 24 HP. Money is the one reward
// this layer can compute correctly on its own, and the inbox already knows how
// to deliver it. The rest is a follow-up, on top of this.

/** Nothing accrues below this. A page reload, a deploy or a five-minute
 *  coffee break should not produce a "welcome back" payout — the feature is
 *  for real absences, and a reward that fires constantly is noise. */
export const AWAY_MIN_MS = 10 * 60_000;

/** Away time stops accruing here. Eight hours ≈ one night's sleep, which is
 *  the absence players actually described. Uncapped accrual would mean a
 *  dormant account returning after a month collects a month of stipend in one
 *  request, which is both a balance cliff and a number nobody can sanity-check. */
export const AWAY_CAP_MS = 8 * 60 * 60_000;

/**
 * Money per away-hour, before the badge multiplier.
 *
 * ── WHY THIS NUMBER IS SO SMALL, AND HOW IT WAS PICKED ───────────────
 * Idling must never beat playing, and "never" has to hold against a
 * PESSIMISTIC estimate of active play, not an average one — otherwise the
 * margin evaporates for exactly the players who are worst off.
 *
 * Active income is trainer prize money (game/src/state/reducer.ts trainerPrize
 * = a class base of 12–100 times the opponent's top level) and in a town the
 * loop starts a trainer battle on EVERY idle tick. The conservative floor:
 * the CHEAPEST trainer class (bugCatcher, 12), a level-50 opponent, and a
 * deliberately slow 30s per fight — about $72,000/hour. Real late-game play
 * is several times that (ace/gentleman bases, level-100 teams, ×5 speed).
 *
 * The away ceiling is 17× this base (16 badges), so it must stay an order of
 * magnitude under that floor:
 *
 *     400 × 17 = $6,800/hour  →  ~10.6× worse than the conservative floor
 *
 * An earlier 1,000 gave $17,000/hour, only 4.2× under the floor — close
 * enough that a player with a slow route could rationally leave the game shut.
 * That is the exact failure this constant exists to prevent, so it is 400.
 */
export const AWAY_MONEY_PER_HOUR_BASE = 400;

/**
 * Badges scale the stipend so it stays worth collecting deep into the game
 * without ever approaching active income.
 *
 * Badge count is the right dial precisely because it CANNOT be inflated to
 * farm this: `defeatedGyms` is guarded by milestoneRegressed on every single
 * upload (versioned or blind), and growing it means actually beating a gym.
 * Contrast `accountLevel`, which is the summed levels of everything in the PC
 * — that would pay for hoarding, and a box is easy to fill.
 */
export function awayMoneyPerHour(badges: number): number {
  const b = Math.max(0, Math.min(16, Math.floor(badges)));
  return AWAY_MONEY_PER_HOUR_BASE * (1 + b);
}

export interface AwayComputation {
  /** Raw elapsed time since this account last proved it was playing. */
  elapsedMs: number;
  /** Elapsed time after the cap — what was actually paid for. */
  creditedMs: number;
  /** True when `elapsedMs` ran past AWAY_CAP_MS, so the UI can say so rather
   *  than quietly paying for less time than the player was gone. */
  capped: boolean;
  /** Badge-scaled hourly rate used for this computation. */
  moneyPerHour: number;
  /** The payout. 0 means "nothing to claim". */
  money: number;
}

/**
 * Turn an away duration into a reward. Pure — no clock, no I/O, no database —
 * so the policy is testable on its own and the route is left holding nothing
 * but the atomic gate.
 */
export function computeAwayProgress(elapsedMs: number, badges: number): AwayComputation {
  const moneyPerHour = awayMoneyPerHour(badges);
  // Negative elapsed is not a hypothetical: `saveUpdatedAt` is set from the
  // server's own `new Date()`, so an NTP correction between an upload and this
  // call can put "last seen" in the future. Clamp rather than trust the
  // subtraction — a negative duration would otherwise become a negative
  // prize, and a negative money prize is a currency SINK the player never
  // agreed to.
  const elapsed = Math.max(0, Math.floor(elapsedMs));
  if (elapsed < AWAY_MIN_MS) {
    return { elapsedMs: elapsed, creditedMs: 0, capped: false, moneyPerHour, money: 0 };
  }
  const creditedMs = Math.min(elapsed, AWAY_CAP_MS);
  const money = Math.floor((creditedMs / 3_600_000) * moneyPerHour);
  return {
    elapsedMs: elapsed,
    creditedMs,
    capped: elapsed > AWAY_CAP_MS,
    moneyPerHour,
    money,
  };
}

/**
 * When the away period started: the later of "last accepted save upload" and
 * "last away claim".
 *
 * Both terms are load-bearing. `saveUpdatedAt` alone would pay a player who is
 * actively playing but has not uploaded for a while, and — worse — would let
 * two claims in a row both measure from the same upload and both get paid.
 * `awayClaimedAt` alone would pay for time the player spent playing since
 * their last claim. Taking the max means away time is only ever the gap since
 * the account last did *something* the server witnessed.
 */
export function awayPeriodStart(
  saveUpdatedAt: Date | null | undefined,
  awayClaimedAt: Date | null | undefined,
): Date | null {
  const a = saveUpdatedAt?.getTime();
  const b = awayClaimedAt?.getTime();
  // No upload and no claim = an account that has never saved. There is no
  // anchor to measure from, and inventing one (account creation, "now") would
  // either pay a brand-new account for time it did not exist or pay nothing
  // while pretending otherwise. Report "no away period" and let the first
  // upload establish the anchor honestly.
  if (a === undefined && b === undefined) return null;
  return new Date(Math.max(a ?? 0, b ?? 0));
}
