// RATE-OF-GAIN guard for save uploads — the anti-cheat layer that
// saveValidation.ts deliberately is not.
//
// ── WHY THIS EXISTS (measured, one real account) ─────────────────────
// The client owns its save and uploads the whole blob; the server validates
// SHAPE and BOUNDS only. saveValidation's MAX_MONEY (999,999,999) and
// MAX_INVENTORY_STACK (999,999) are PARSER ceilings — they stop a garbage
// blob blowing something up — and nothing in the save path has ever looked at
// how fast a number moved. So a player could edit localStorage and upload any
// value under those ceilings and the server stored it.
//
// One account did. `koruem2`, created 8 days ago, not an admin, 5 badges, 67
// dex entries: its own snapshot ring shows saveVersion 8259 at 17:07:05 with
// money $5,945 and no `expShare` key at all, then saveVersion 8689 at
// 17:37:06 with money $100,003,240 and expShare 100,000. Both values arrived
// together, in a 30-minute window across 430 uploads, on an account uploading
// every ~4 seconds. Zero AdminAudit rows, zero PendingGrants, zero auction
// sales — no server path put them there. Both values sat comfortably UNDER
// the parser ceilings, which is exactly why nothing rejected them.
//
// ── WHY IT IS NOT A FLAT CAP ─────────────────────────────────────────
// A guard that rejects a whale is a worse bug than the one it fixes, and
// there are real whales. Re-measured (2026-07-29) against all 2,309 production
// saves, 3,362 SaveSnapshot rows and every one of the 1,269 consecutive
// money-rising pairs, with each pair attributed against Auction(sold).settledAt,
// AdminAudit and PendingGrant.deliveredAt so server-side credits are excluded:
//
//   * p50 money is $3,000 — the STARTING amount, i.e. the median account has
//     never earned a net dollar — but the top wallets are tokyofuck
//     $113,046,237, phoenix $106,905,278, drwhy $67,016,484. Total money in
//     existence is $739,663,957.
//   * Legit sustained EARN RATE, unattributed windows only: p50 $101,492/h, p90
//     $411,567/h, p99 $878,804/h.
//   * THE LARGEST LEGITIMATE INCREASE IN ONE UPLOAD IS $118,322 (mangetsu),
//     and that is now measured EXACTLY rather than bounded: SaveSnapshot
//     records saveVersion, and this route increments it by exactly 1 per
//     accepted write, so a pair whose saveVersion advanced by 1 spans one
//     upload and no more. Eight such pairs exist; five are mangetsu's, and the
//     largest of them followed a 526-minute idle gap — the offline-lineage
//     reconcile shape itself, where saveReconcile.ts picks SPENDABLE state from
//     ONE lineage whole and a player who played for hours while uploads were
//     failing flushes the whole wallet in a single POST.
//   * The two largest ≤3-upload rises, bezkerus +$1,176,004 and mangetsu
//     +$669,277 (the figure this comment used to quote as a legitimate single
//     upload), are BOTH `user.cashfix_restore` admin writes. They never enter
//     this route.
//
// So: a burst floor that clears the largest single legitimate upload with
// margin, plus a CUMULATIVE budget for the account (see MONEY_BUDGET_CAPACITY)
// because a per-upload floor times 30 uploads/minute is not a rate.
//
// ── WHY IT NEVER SEES THE SERVER'S OWN PAYMENTS ──────────────────────
// evaluateGain is pure and takes (prior, next, elapsedMs);
// evaluateGainForAccount wraps it with the account's cumulative budgets. Its
// ONLY caller evaluates it at the 2b/2c guard site in routes/saves.ts,
// comparing the STORED blob against the CLIENT'S BYTES — strictly BEFORE
// commitSave, and therefore strictly before foldOwedGrants. Every
// server-issued payment is invisible to it by construction rather than by
// threshold tuning:
//
//   * PendingGrant folds (giveaway, mass-gift, away progress, PvP bonuses)
//     are applied ON TOP of the client's bytes AFTER this comparison, inside
//     commitSave. The largest money prize ever enqueued is $250,000; away
//     progress is hard-capped at AWAY_CAP_MS 8h × $16/h = $54,400. Neither
//     amount is ever part of `next` at the moment this runs.
//   * Auction settlement (lib/auctionSettlement.ts), auction escrow
//     (routes/auctions.ts) and admin patches (routes/admin.ts) write the row
//     themselves under their own saveVersion CAS. They never enter POST
//     /api/saves at all, and because they bump saveVersion, a client holding
//     a pre-write version 409s before reaching this guard. By the time it
//     uploads again the stored row — `prior` — already holds the money, so
//     the observed delta is ~0. The largest settlement in production
//     ($10,000,000, gustavokletke) and the largest admin write ($65,023,101,
//     drwhy) are both structurally out of scope.
//
// The clock is ours: elapsed comes from `User.saveUpdatedAt`, which POST
// /api/saves stamps with the server's own `new Date()` on every accepted
// write — the same rule lib/awayProgress.ts relies on. The client never
// supplies a time, a duration, or an amount.
//
// ── THE AUCTION WINNER, which is NOT a false positive ────────────────
// Both reviews flagged this and one of them called it confirmed: an auction
// winner's money is deducted by settlement, its client has not adopted, and a
// BLIND upload (no expectedSaveVersion) therefore shows an increase equal to the
// bid it just paid. Against the pure function that is exactly right — six real
// settled auctions reproduce it, up to +$10,000,000.
//
// It cannot reach this guard. lib/auctionSettlement.ts:170-184 deducts the bid
// AND appends the won Pokémon to the winner's party/box IN THE SAME WRITE, so a
// client that has not adopted the settlement is missing that mon — and step 2c
// (destructiveLosses, blind writes only) refuses a blind upload that drops an
// owned Pokémon BEFORE step 2d runs. Proved by driving all eight of the largest
// real settled auctions through the real handler with the winners' actual stored
// blobs: every one returns 400 `versionless_regression`, and the gain guard is
// never consulted. There is no money-only server debit on a player's own save —
// bidding does not escrow money (settlement checks affordability instead), so
// there is no other shape of this. See tests/saveGainGuard.test.ts, "the auction
// winner".
//
// ── PER-RULE ENFORCEMENT, NOT A GLOBAL SHADOW SWITCH ─────────────────
// This module used to ship with ENFORCE_GAIN_GUARD = false and the documented
// flip criterion "flip once `save_gain_implausible` rows have been quiet for a
// sustained window". Both halves of that were wrong:
//
//   * The criterion is satisfied BY THE CHEAT. koruem2's steady state re-uploads
//     the values it already minted, and every rule here fires only on a RAISE,
//     so a fully-cheated account at rest produces zero rows. "Quiet" meant
//     "the cheat finished", not "the guard is safe". (Closed below by the
//     STATE notes, which look at the stored value instead of the delta.)
//   * A single global switch forces one decision for rules with completely
//     different false-positive records. The rules whose refusals were measured
//     to hit 52 real accounts (the mart "Max" button, purchasable items) and
//     the rule whose refusals were measured to hit exactly one account in the
//     whole corpus (money) do not belong behind the same boolean.
//
// So every violation now carries `enforce`, set by the rule that produced it,
// and the caller refuses only when an ENFORCEABLE violation is present. A rule
// is enforceable only where the FP rate was measured at zero across all of
// production and the margin over the largest legitimate observation is stated:
//
//   ENFORCED  money:cumulative      1 refusal in 1,269 money-rising snapshot
//                                   pairs, and it is koruem2's. 17× the largest
//                                   measured legitimate single-upload gain.
//   ENFORCED  victoryTokens:*       max held in the game 34 (ceiling 500), max
//                                   rise in any window +7 (limit 25).
//   ENFORCED  restricted items      max legitimate holding 35 silverbottlecaps
//             rise/ceiling/unearned (ceiling 1,000), max rise +4 (limit 25).
//                                   This is where the confirmed abuse landed.
//   DETECTION money:rate            superseded by money:cumulative, which is
//                                   tighter in the sustained case. Kept because
//                                   its log rows are the per-upload signal.
//   DETECTION purchasable items     the class with the confirmed FP history: one
//             rise/ceiling          click of the mart's Max button refused 52 real
//                                   accounts before the purchase exemption below,
//                                   and the exemption's soundness rests on a price
//                                   floor this module cannot import. The value of a
//                                   fabricated purchasable stack is bounded by the
//                                   money rule on sell-back, so detection is the
//                                   right trade here and it is the stated residual.
//   DETECTION anything on a save    a first-ever upload has no prior to compare
//             with no stored prior  against; see FIRST_SAVE below.
//
// A false positive on an enforced rule is a 400, and the shipping client treats
// a 400 as a contract violation: it stops uploading for the session and files a
// report. That is why the bar for "enforceable" is a measured zero and not an
// argument.
const ENFORCE_GAIN_GUARD = true;

import { chargeCumulativeGain, MONEY_DETECT_PER_HOUR } from "./saveGainBudget.js";

// ── Money ────────────────────────────────────────────────────────────

/**
 * Allowance at zero elapsed time. Covers the largest observed single-upload
 * legitimate jump ($669,277, mangetsu's offline-lineage reconcile) with ~1.5×
 * margin, and every grant-shaped credit ($250k mass gift, $200k Diamond-tier
 * PvP win bonus, $54,400 away cap) several times over — belt and braces,
 * since the fold happens after this comparison and none of them are in scope.
 */
export const MONEY_BURST = 1_000_000;

/**
 * Added per hour of server-measured elapsed time. 1.5× the highest observed
 * legitimate earn rate ($2.01M/h), 3.2× p99 ($947k/h), 31× p50 ($95k/h).
 */
export const MONEY_RATE_PER_HOUR = 3_000_000;

/**
 * Elapsed is clamped to this many hours. Only the DETECTION rule uses this now
 * — the cumulative budget caps at MONEY_BUDGET_CAPACITY however long an account
 * has been dormant, so it is strictly tighter than the $19M this permits.
 *
 * UNCAPPED ELAPSED IS THE MISTAKE: the
 * game does not run while the tab is closed, so a dormant account must not
 * accrue allowance for the whole dormancy. 6h × $2M/h of real earning = $12M
 * worst plausible legitimate accumulation, so the resulting $19M ceiling
 * carries ~1.6× margin over that.
 */
export const MONEY_ELAPSED_CAP_H = 6;

/**
 * THE CUMULATIVE MONEY BUDGET — the rule that actually bounds a rate.
 *
 * MONEY_BURST above is a PER-UPLOAD step cap and nothing more: `elapsedMs` is
 * measured from the last ACCEPTED write, so the allowance resets on every
 * upload and the rule is memoryless. Proved by execution — 1,000 uploads of
 * exactly MONEY_BURST at the route's own permitted cadence walk $3,000 to
 * MAX_MONEY in 33.3 minutes with zero violations and zero log rows. The full
 * reasoning, the measurements and the idempotency argument live in
 * lib/saveGainBudget.ts; these are the two numbers.
 *
 * CAPACITY is the largest single upload allowed from a full bucket. The largest
 * legitimate single-upload money gain anywhere in production is $118,322
 * (mangetsu, measured EXACTLY: SaveSnapshot.saveVersion advanced by 1 across
 * that pair, so it spans one accepted write and no more). 17× margin.
 *
 * REFILL bounds the sustained case. p99 of the unattributed sustained rate is
 * $878,804/h, p50 $101,492/h. 3.4× and 30×. Simulated over all 1,269
 * money-rising consecutive snapshot pairs, this pair refuses exactly one and it
 * is koruem2's.
 */
export const MONEY_BUDGET_CAPACITY = 2_000_000;
export const MONEY_BUDGET_REFILL_PER_HOUR = 3_000_000;

// ── Victory tokens ───────────────────────────────────────────────────
// The reward-shop currency. It is already treated as spendable by
// CURRENCY_FIELDS in lib/saveRegression.ts, and validateSave places NO upper
// bound on it at all — not even a sanity ceiling. Any money guard that leaves
// this unbounded leaves the reward shop wide open, and koruem2's went 2 → 4
// in the same 30-minute window as the money and the Exp Shares.
//
// Max held in the entire game is 34 (wwwsoujiro); max rise in a 30-minute
// window is +7 (javitovar19gmailco). ~3× and ~15× those.
export const VICTORY_TOKEN_RISE_LIMIT = 25;
export const VICTORY_TOKEN_CEILING = 500;

// ── Items ────────────────────────────────────────────────────────────

/**
 * Per-upload rise for a single item key, for a rise NOTHING PAID FOR. The
 * highest legitimate rise across 236 measured ball rises in any THIRTY-MINUTE
 * window is 3,732 (dudsdiem, and it is fully accounted for — the same
 * snapshot pair shows money falling $6,645,659 → $38,435, a bulk buy at
 * $1,200 each). p99 rise is 1,683; every non-ball item is ≤ 900.
 *
 * "NOTHING PAID FOR" is load-bearing and was missing. The observed history
 * does NOT bound what one upload can legitimately carry, because the shop UI
 * collapses any quantity into a single dispatch: the mart's quantity stepper
 * has a "Max" button — game/src/components/BottomTabs.tsx:258, whose tooltip
 * reads "Buy as many as you can afford" — and the quantity behind it is
 *     Math.max(1, Math.floor(state.money / price))            (line 163)
 * with no cap, feeding a BUY_ITEM that adds it to the stack with no clamp
 * (game/src/state/reducer.ts:1262-1268). Cheapest mart item is honey at $100,
 * so ONE CLICK turns a $10M wallet into 100,000 Honey inside one autosave.
 * Measured by replaying THIS function over all 2,309 production saves: 52
 * accounts already hold enough money to blow past both this limit and the
 * ceiling below on a single legitimate purchase. See ACCOUNTED-FOR below.
 */
export const ITEM_RISE_LIMIT = 10_000;

/**
 * Absolute stack ceiling for an item the marts sell — again only for a stack
 * NOTHING PAID FOR. Highest legitimate holding in the game is 5,803 Ultra
 * Balls, but that is a fact about how much players have chosen to buy, not a
 * bound: any wallet ≥ $2.5M can exceed this in one click, and 32 production
 * accounts can. A flat stack bound on a purchasable item is unsound on its own
 * — MAX_MONEY ($999,999,999) buys 9,999,999 units of the cheapest shop item,
 * more than MAX_INVENTORY_STACK itself — so the bound has to be on the
 * PAYMENT, not on the pile.
 */
export const ITEM_STACK_PURCHASABLE = 25_000;

/**
 * The cheapest unit price anywhere a shop sells anything: honey, $100
 * (game/src/data/itemsCatalog.ts:152). Checked against every table BUY_ITEM
 * consults in the order it consults them — itemsCatalog.buyPrice, then
 * data/pokeballs.ts (min 200), then data/consumables.ts (min 500), then the
 * evolution-stone fallback (2,100) — so no purchase of N units can move money
 * by less than 100 × N. That makes it a sound LOWER BOUND on what a
 * legitimate purchase costs, without this module needing the price table (it
 * cannot reach the client's catalog; see RESTRICTED_ITEMS).
 */
export const MIN_SHOP_UNIT_PRICE = 100;

/**
 * Absolute stack ceiling for reward-only items — a BACKSTOP, not the rate rule.
 *
 * This was 100, which was measured to be a false positive waiting to happen: the
 * largest real holding of an accumulating raid drop is 35 silverbottlecaps
 * (koruem), so the margin was 2.9× and the drop that crossed 100 would have been
 * a 400 that stops the session's uploads. The ceiling only fires on a RAISE, so
 * an account already above it is not bricked, but the crossing itself was.
 *
 * The accumulation bound moved to where it belongs — RESTRICTED_ITEM_RISE_LIMIT
 * per upload plus a CUMULATIVE budget across uploads (lib/saveGainBudget.ts) — so
 * this can be set where it never refuses a real player: 28× the largest holding
 * in the game, roughly nine months of headroom at koruem's measured accumulation
 * rate. It still catches a fabricated pile outright (koruem2's 100,000 Exp Shares
 * are 100× it) and it is the only thing bounding the TOTAL a patient drip can
 * reach.
 *
 * Restricted present-state maxima across all 2,309 production saves: expShare
 * 100,000 (the cheat), silverbottlecap 35, goldbottlecap 10, masterball 9,
 * nugget 3, bignugget 3, shinycharm 1.
 */
export const ITEM_STACK_RESTRICTED = 1_000;

/**
 * Per-upload rise for a reward-only item. There was NO restricted-specific rise
 * limit before this: restricted keys shared ITEM_RISE_LIMIT (10,000), so the
 * whole restricted class rested on the absolute ceiling alone and a rise of
 * 0 → 100 passed every rule.
 *
 * The largest legitimate rise of any restricted key in ANY 30-minute window
 * across every consecutive snapshot pair in production is +4 (silverbottlecap,
 * nicolaswalter555); then nugget +3, goldbottlecap +2, masterball +1. koruem2's
 * fabrications in one window were expShare +100,000 and shinycharm +10. 6×
 * margin over the largest legitimate observation, and it catches the +10.
 */
export const RESTRICTED_ITEM_RISE_LIMIT = 25;

/**
 * Cumulative budget for restricted-item units, summed across every restricted
 * key. Same mechanism and same reason as the money budget: a per-upload limit
 * times 30 uploads/minute is not a rate. Capacity 25 (6× the largest observed
 * single-window rise), refill 25/h (~12× the observed hourly accumulation), so a
 * drip is bounded at 25/h and hits ITEM_STACK_RESTRICTED after ~40 hours instead
 * of reaching 100,000 in half an hour.
 */
export const RESTRICTED_BUDGET_CAPACITY = 25;
export const RESTRICTED_BUDGET_REFILL_PER_HOUR = 25;

/**
 * A restricted-item rise above this gets a DETECTION note even when the budget
 * covers it. One above the largest legitimate rise ever observed (+4), so the
 * expected legitimate row count is zero and any drip that steps faster than real
 * drops is visible without waiting for the budget to run dry.
 */
export const RESTRICTED_RISE_NOTABLE = 5;

/**
 * The Shiny Charm is not a quantity cheat — one of it is the whole prize, and it
 * DOUBLES the account-wide shiny rate. A purely quantity-based item rule can
 * never see it: `shinycharm: 1` is under every limit here.
 *
 * game/src/utils/shinyCharm.ts grants it from exactly one place, and only when
 * `isDexComplete(pokedexCaught)`. It cannot be bought (`buyPrice: null`), cannot
 * be sold (`sellPrice: 0`), and is never taken away once earned.
 *
 * THE FLOOR IS 100 AND NOT 245, AND THAT NUMBER WAS FOUND BY BEING WRONG FIRST.
 * The obvious reading — 23 accounts hold the charm, 22 of them have 246–288 dex
 * entries and only koruem2 has 67, so put the floor at 200 — produces a REAL
 * false positive, and replaying every consecutive snapshot pair in production
 * against this rule found it: willielucio2016's charm ARRIVED at
 * 2026-07-24T18:35 with `pokedexCaught.length === 167`, and it only climbed to
 * 247 over the following days. That is legitimate, because completion is not a
 * count: game/src/utils/obtainable.ts derives the obtainable set from the
 * encounter/raid/starter data (a chunk of the Johto entries exist for dex
 * numbering and can never be caught), and 167 was the whole obtainable set at
 * that moment. `LEGACY_SHINY_CHARM_THRESHOLD = 245` is the OLD flat-length rule
 * and is not the bar any more.
 *
 * So the floor has to sit below the obtainable-set SIZE, which this module
 * cannot compute — it has no access to the client's data tables. 100 leaves 67
 * entries of margin below the one measured legitimate arrival and 33 above the
 * one measured fabrication, and the obtainable set is designed to GROW as
 * content ships ("the moment an unreleased species is given encounters the dex
 * total grows on its own"), so the margin below only widens. Shrinking it under
 * 100 would mean deleting ~40% of the game's encounter tables.
 *
 * Honest about what it catches: a fabricator who also fabricates 100 Pokédex
 * entries walks past this. It catches the one who did not — and a save claiming
 * 100 registrations it cannot show the Pokémon for is a much louder cheat.
 *
 * Checked only when the charm ARRIVES (0 → ≥1), so no existing holder can ever
 * be refused, whatever its blob claims about its Pokédex.
 */
export const SHINY_CHARM_ITEM = "shinycharm";
export const SHINY_CHARM_DEX_FLOOR = 100;

/**
 * Items no shop sells, so a large stack cannot have been bought.
 *
 * Mirrors `buyPrice: null` in game/src/data/itemsCatalog.ts (masterball,
 * shinycharm, bottlecaps, treasure, HMs, key items) — PLUS `expShare`, which
 * the catalog prices at 20,000 but which is UNREACHABLE from any purchase
 * path: both BUY_ITEM and BUY_REWARD_ITEM in game/src/state/reducer.ts
 * special-case it and stack an `activeEffects` entry instead of writing
 * inventory ("Exp. Share is a buff, not a stockpile-able held item"), and
 * USE_EXP_SHARE only ever DECREMENTS the key. It is not in the daily-reward
 * cycle either (lib/dailies.ts pays money + balls). So a nonzero
 * `inventory.expShare` can only have come from a server grant, and the game
 * can only spend it down — which is why a heavy legitimate player holds 0 and
 * koruem2's 100,000 is 16,667× the next-highest holder in the game.
 *
 * An item id absent from this set gets the PURCHASABLE ceiling, not the
 * restricted one. That is the false-positive-avoiding default: new game
 * content ships in the client's catalog, not here, and an id this list has
 * never heard of is far more likely to be a new purchasable than a new
 * reward. An invented id that the game does not know is inert anyway.
 */
const RESTRICTED_ITEMS: ReadonlySet<string> = new Set([
  // buyPrice: null in itemsCatalog.ts
  "masterball",
  "shinycharm",
  "goldbottlecap",
  "silverbottlecap",
  "nugget",
  "bignugget",
  "pearl",
  "bigpearl",
  "stardust",
  "starpiece",
  "hm01", "hm02", "hm03", "hm04", "hm05",
  "bicycle",
  "oldrod",
  "goodrod",
  "superrod",
  "itemfinder",
  "pokeflute",
  // Priced but structurally unpurchasable-into-inventory — see above.
  "expShare",
]);

/** Which ceiling applies to an item key. */
export function itemStackCeiling(itemId: string): number {
  return RESTRICTED_ITEMS.has(itemId) ? ITEM_STACK_RESTRICTED : ITEM_STACK_PURCHASABLE;
}

// ── Verdict types ────────────────────────────────────────────────────

export type GainRule =
  /** A gain larger than burst + rate × elapsed. PER-UPLOAD; detection only. */
  | "rate"
  /** A gain larger than what this ACCOUNT'S cumulative budget still holds. */
  | "cumulative"
  /** A rise larger than a flat per-upload limit (items, victory tokens). */
  | "rise"
  /** An upload that RAISES a value above an absolute ceiling. */
  | "ceiling"
  /** A reward the account has not met the in-game condition for. */
  | "unearned";

/** One dimension the incoming save moves further than play can explain.
 *  `field` is stable and machine-readable so triage can group on it. */
export interface GainViolation {
  field: string;
  rule: GainRule;
  before: number;
  after: number;
  delta: number;
  /** The largest value of this dimension the guard would have accepted. */
  allowance: number;
  /**
   * May the caller REFUSE the upload for this violation?
   *
   * Set by the rule, not by the caller, so the decision lives next to the
   * measurement that justifies it — see the PER-RULE ENFORCEMENT table at the
   * top of this file. A violation with `enforce: false` is a log row and
   * nothing else, no matter what ENFORCE_GAIN_GUARD says.
   */
  enforce: boolean;
}

/** An ACCEPTED gain worth a human glance — see the alerting note below. */
export interface GainNote {
  field: string;
  before: number;
  after: number;
  delta: number;
  allowance: number;
}

export interface GainVerdict {
  /** No violations. Note that `notable` may still be non-empty. */
  ok: boolean;
  violations: GainViolation[];
  /**
   * Part C: DETECTION, NOT REJECTION. Any accepted money gain above
   * MONEY_BURST only passed because of the elapsed term, which is the
   * residual "wait six hours, then jump" bypass. Measured base rate is
   * essentially zero legitimate uploads except the handful of
   * offline-lineage reconciles, so this is a few rows a week and reviewable
   * by hand — and it can never refuse anything.
   */
  notable: GainNote[];
  /**
   * ABSOLUTE bounds the STORED row already exceeds, whether or not this upload
   * moved them. Detection only, and it can never refuse anything.
   *
   * This closes the hole in the old flip criterion. Every other rule here fires
   * only on a RAISE — deliberately, because refusing a value already in the row
   * bricks the account permanently — so an account that has ALREADY minted its
   * cheat and is quietly re-uploading it produces no rows at all. Measured:
   * evaluateGain(koruem2's stored blob, the same blob, 10s) returned zero
   * violations and zero notes with $100,028,732 and 100,000 Exp Shares on both
   * sides. "The log has been quiet" therefore meant "the cheat finished", which
   * is the worst possible thing for a flip criterion to mean.
   *
   * Throttled at the call site (lib/saveGainBudget.ts's shouldLogGain), because
   * an account uploading every 4 seconds must not write 430 identical rows per
   * half-hour.
   */
  stateNotes: GainNote[];
  /** Elapsed hours AS USED: clamped to [0, MONEY_ELAPSED_CAP_H]. */
  elapsedHours: number;
  /** The money allowance this verdict was computed against. */
  moneyAllowance: number;
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * A save field read as a balance.
 *
 * ABSENT OR NON-NUMERIC IN `prior` READS AS 0, which is the opposite of what
 * destructiveLosses does (it skips) and the difference is load-bearing.
 * Skipping would be a two-step bypass: upload once with `money` deleted, then
 * upload $500M against a prior the guard declined to read. It is also the
 * exact shape of the real abuse on the item side — koruem2 had no `expShare`
 * KEY at all in the 17:07 snapshot and 100,000 at 17:37, and a diff that only
 * compares keys present in both silently drops that event.
 */
function balance(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

function inventoryOf(s: Record<string, unknown>): Record<string, unknown> {
  const inv = s.inventory;
  return inv && typeof inv === "object" && !Array.isArray(inv)
    ? (inv as Record<string, unknown>)
    : {};
}

/**
 * Is a field of the STORED blob readable as the thing this module thinks it is?
 *
 * balance() reads absent-or-broken as 0, which is exactly right for an ABSENT
 * key (deleting `money` and then uploading $500M must not be a two-step bypass)
 * and exactly wrong for a PRESENT-BUT-DEGENERATE one: a stored `money` of the
 * string "5000" would read as 0 and flag the account's next perfectly ordinary
 * upload for a $5,000,000 gain it did not make.
 *
 * The surrounding 2b/2c guards skip shapes they cannot read; this makes the gain
 * guard's tolerance match theirs, on the PRIOR side only. It opens no bypass,
 * because validateSave already refuses to store a `money` that is not a number
 * or an `inventory` that is not a plain object — so the only way to get one into
 * the row is an admin write, and production has zero of them (all 2,309 saves
 * parse, all have numeric `money` and object `inventory`).
 */
function readable(v: unknown, kind: "number" | "object"): boolean {
  if (v === undefined || v === null) return true; // absent → balance() reads 0
  return kind === "number"
    ? typeof v === "number" && Number.isFinite(v)
    : typeof v === "object" && !Array.isArray(v);
}

/** Total units held across every reward-only key. The unit the restricted
 *  cumulative budget is charged in. */
export function restrictedUnits(s: Record<string, unknown> | null): number {
  if (!s || typeof s !== "object" || Array.isArray(s)) return 0;
  const inv = inventoryOf(s);
  let total = 0;
  for (const k of RESTRICTED_ITEMS) total += balance(inv[k]);
  return total;
}

/** Pokédex registrations, as the shiny-charm floor reads them. */
function dexCount(s: Record<string, unknown>): number {
  return Array.isArray(s.pokedexCaught) ? s.pokedexCaught.length : 0;
}

/**
 * Elapsed milliseconds → hours, clamped into [0, MONEY_ELAPSED_CAP_H].
 *
 * Every hostile and broken input collapses to a NUMBER in that range, so the
 * allowance is always finite and there is no division anywhere in this module
 * — a zero or negative elapsed simply yields the burst floor. Negative
 * elapsed is not hypothetical: `saveUpdatedAt` is stamped by whichever server
 * process accepted the last write, so an NTP correction or two instances with
 * skewed clocks can legitimately produce one.
 *
 * NaN reads as 0 (no elapsed can be proved, so grant none). ±Infinity reads
 * as its own end of the range, so that an absurdly large elapsed clamps to
 * the cap exactly like 1e15 does rather than falling off a cliff to 0 — a
 * discontinuity in a guard is the kind of thing that gets rediscovered as a
 * bug years later.
 */
export function elapsedHoursFor(elapsedMs: number): number {
  if (Number.isNaN(elapsedMs) || elapsedMs <= 0) return 0;
  const h = elapsedMs / 3_600_000;
  return h > MONEY_ELAPSED_CAP_H ? MONEY_ELAPSED_CAP_H : h;
}

/** burst + rate × clamped elapsed. Monotonic in elapsed, never NaN. */
export function moneyAllowanceFor(elapsedMs: number): number {
  return MONEY_BURST + MONEY_RATE_PER_HOUR * elapsedHoursFor(elapsedMs);
}

// ── The decision ─────────────────────────────────────────────────────

/**
 * Is the move from `prior` to `next` explainable by `elapsedMs` of play?
 *
 * PURE: no I/O, no clock, no database, no mutation of either argument. Every
 * threshold is therefore provably testable without a database, which is the
 * whole reason the decision lives here instead of inline in the route.
 *
 * `prior === null` (first-ever save, or a stored blob that would not parse)
 * returns a clean verdict. There is nothing to compare against, and the
 * migration/corruption path must not start refusing saves — same tolerance
 * the surrounding 2b/2c guards already have.
 *
 * Only INCREASES are examined. Decreases are legitimate play (you spend
 * money, you throw a ball, you release a mon); on a blind write they already
 * go through destructiveLosses, and on a versioned one they must stay
 * unrestricted.
 *
 * Every accessor is defensive: this runs on a blob parsed out of the database
 * and on one straight off the wire, and a throw here would 500 a save.
 */
export function evaluateGain(
  prior: Record<string, unknown> | null,
  next: Record<string, unknown>,
  elapsedMs: number,
): GainVerdict {
  const elapsedHours = elapsedHoursFor(elapsedMs);
  const moneyAllowance = MONEY_BURST + MONEY_RATE_PER_HOUR * elapsedHours;
  const violations: GainViolation[] = [];
  const notable: GainNote[] = [];
  const stateNotes: GainNote[] = [];

  if (
    !prior || typeof prior !== "object" || Array.isArray(prior)
    || !next || typeof next !== "object" || Array.isArray(next)
  ) {
    return { ok: true, violations, notable, stateNotes, elapsedHours, moneyAllowance };
  }

  // 1) Money — the one that matters. $100M is enough to buy out the auction
  //    house and distort prices for every other player, which is why it
  //    outranks the items even though the items are the cheaper catch.
  //
  //    PER-UPLOAD, THEREFORE DETECTION ONLY. `elapsedMs` restarts at every
  //    accepted write, so this bounds one step and not a rate; the rate is
  //    bounded by the cumulative budget in evaluateGainForAccount below. Kept
  //    because a single oversized step is still the clearest thing to put in
  //    front of a human, and because it needs no state to compute.
  const moneyBefore = balance(prior.money);
  const moneyAfter = balance(next.money);
  const moneyDelta = readable(prior.money, "number") ? moneyAfter - moneyBefore : 0;
  if (moneyDelta > moneyAllowance) {
    violations.push({
      field: "money",
      rule: "rate",
      before: moneyBefore,
      after: moneyAfter,
      delta: moneyDelta,
      allowance: moneyAllowance,
      enforce: false,
    });
  } else if (moneyDelta > MONEY_BURST) {
    // Accepted, but only thanks to the elapsed term.
    notable.push({
      field: "money",
      before: moneyBefore,
      after: moneyAfter,
      delta: moneyDelta,
      allowance: moneyAllowance,
    });
  }

  // 2) Victory tokens — flat, because they are earned per PvP/tournament
  //    result and no elapsed time makes 500 of them plausible.
  const vtBefore = balance(prior.victoryTokens);
  const vtAfter = balance(next.victoryTokens);
  const vtDelta = readable(prior.victoryTokens, "number") ? vtAfter - vtBefore : 0;
  if (vtDelta > VICTORY_TOKEN_RISE_LIMIT) {
    violations.push({
      field: "victoryTokens",
      rule: "rise",
      before: vtBefore,
      after: vtAfter,
      delta: vtDelta,
      allowance: VICTORY_TOKEN_RISE_LIMIT,
      enforce: true,
    });
  }
  // Absolute ceiling, and only when THIS upload pushes it higher. An account
  // already above a ceiling must still be able to save — enforcing an
  // absolute bound against a value already in the row would brick it
  // permanently (every upload refused, forever), which is exactly the
  // MAX_BOX=600 outage that saveValidation's comment documents. Freezing it
  // at its current amount so it can only go DOWN gets the anti-accumulation
  // property without the brick, and it also keeps a single compromised
  // account from writing a log row on all 430 of its uploads per half-hour.
  if (vtAfter > VICTORY_TOKEN_CEILING && vtAfter > vtBefore) {
    violations.push({
      field: "victoryTokens",
      rule: "ceiling",
      before: vtBefore,
      after: vtAfter,
      delta: vtDelta,
      allowance: VICTORY_TOKEN_CEILING,
      enforce: true,
    });
  } else if (vtAfter > VICTORY_TOKEN_CEILING) {
    // Already over it and not climbing: not refusable (see the anti-brick rule
    // above), but it must not be silent either.
    stateNotes.push({
      field: "victoryTokens", before: vtBefore, after: vtAfter,
      delta: vtDelta, allowance: VICTORY_TOKEN_CEILING,
    });
  }

  // 3) Inventory, PER ITEM KEY. Iterating `next` (not `prior`) is what makes
  //    a brand-new key visible: a key absent from `prior` reads as 0, so
  //    "no expShare at all" → 100,000 is a 100,000 rise, not a skipped
  //    comparison.
  //
  // ── ACCOUNTED-FOR: A PURCHASE IS NOT A GAIN ──────────────────────────
  // Money the same upload SPENT is the receipt for the items it bought, and a
  // shop item is the only thing in the game a player can convert money into at
  // will. Without this, the item rules fire on the mart's own "Max" button:
  // measured against all 2,309 production saves, ONE legitimate click refuses
  // 52 real accounts — the $112.6M and $106.9M holders, drwhy, every auction
  // whale — on both the rise and the ceiling rule at once. In enforce mode that
  // is a 400, which makes the shipping client stop uploading for the rest of
  // the session (see the WHY 400 note in routes/saves.ts), so the fix cannot be
  // "log it and hope": it has to not fire.
  //
  // The test is deliberately price-FREE, so it cannot drift out of sync with a
  // catalog this module cannot import: a rise of `d` units is explained when
  // the wallet fell by at least MIN_SHOP_UNIT_PRICE × d. `moneyAllowance` is
  // added as slack because one upload can hold a purchase AND the battle
  // winnings that arrived beside it — netting the two would otherwise refuse a
  // buy that spent a dollar less than the floor price. That slack is also
  // exactly what keeps the free case bounded: with no money spent at all the
  // condition degenerates to d ≤ allowance / 100 ≈ 10,000 at an ordinary
  // upload interval, i.e. ITEM_RISE_LIMIT, which is the bound this replaces.
  //
  // RESTRICTED ITEMS ARE EXEMPT FROM THE EXEMPTION. No shop sells them, so no
  // amount of spent money can explain one appearing — which is the whole point
  // of that list, and it is where the real abuse landed (expShare). koruem2's
  // upload is caught twice over regardless: its money ROSE $99,997,295 in the
  // same window, so `moneyDrop` is 0 and nothing is accounted for at all.
  //
  // KNOWN LOOSENING, stated rather than hidden: the budget is checked per key,
  // not consumed, so an upload that raises N different purchasable keys gets to
  // spend the same receipt N times. Splitting the budget would be the strict
  // reading and it is wrong here — one upload legitimately covers several
  // separate purchases, and there is no way to attribute a net wallet movement
  // to them. The exposure is a factor of N on an item class whose only route to
  // value is selling it back, which is a money RISE and lands on rule 1.
  const priorInv = inventoryOf(prior);
  const nextInv = inventoryOf(next);
  const invReadable = readable(prior.inventory, "object");
  const moneyDrop = moneyBefore > moneyAfter ? moneyBefore - moneyAfter : 0;
  const purchaseBudget = moneyDrop + moneyAllowance;
  for (const [k, v] of Object.entries(nextInv)) {
    const after = balance(v);
    if (after <= 0) continue;
    const before = balance(priorInv[k]);
    const restricted = RESTRICTED_ITEMS.has(k);
    const delta = invReadable ? after - before : 0;
    const ceiling = itemStackCeiling(k);

    // THE SHINY CHARM, which no quantity rule can see: one of it is the entire
    // prize and it doubles the account-wide shiny rate. Gated on the in-game
    // condition instead of on an amount, and only when it ARRIVES.
    if (
      restricted && k === SHINY_CHARM_ITEM && delta > 0 && before <= 0
      && dexCount(next) < SHINY_CHARM_DEX_FLOOR
    ) {
      violations.push({
        field: `inventory.${k}`,
        rule: "unearned",
        before,
        after,
        delta,
        allowance: 0,
        enforce: true,
      });
    }

    // Paid for at the cheapest price any shop charges → not a gain.
    // RESTRICTED items are exempt from the exemption: no shop sells them, so no
    // amount of spent money can explain one appearing.
    const paidFor = delta > 0 && !restricted && MIN_SHOP_UNIT_PRICE * delta <= purchaseBudget;

    if (!paidFor) {
      const riseLimit = restricted ? RESTRICTED_ITEM_RISE_LIMIT : ITEM_RISE_LIMIT;
      if (delta > riseLimit) {
        violations.push({
          field: `inventory.${k}`,
          rule: "rise",
          before,
          after,
          delta,
          allowance: riseLimit,
          enforce: restricted,
        });
      }
      if (after > ceiling && after > before) {
        violations.push({
          field: `inventory.${k}`,
          rule: "ceiling",
          before,
          after,
          delta,
          allowance: ceiling,
          enforce: restricted,
        });
      }
      if (restricted && delta > RESTRICTED_RISE_NOTABLE && delta <= riseLimit) {
        notable.push({ field: `inventory.${k}`, before, after, delta, allowance: riseLimit });
      }
    }

    // The stored row is already over an absolute bound. Not refusable — see the
    // anti-brick rule — but this is the ONLY rule that can see an account which
    // has already minted its cheat and is quietly re-uploading it.
    if (after > ceiling && after <= before) {
      stateNotes.push({ field: `inventory.${k}`, before, after, delta, allowance: ceiling });
    }
  }

  return { ok: violations.length === 0, violations, notable, stateNotes, elapsedHours, moneyAllowance };
}

// ── The decision, WITH the account's cumulative budget ───────────────
// The pure rules above bound ONE UPLOAD. This bounds the ACCOUNT, which is the
// half that was missing: 30 uploads/minute × any per-upload cap C is 30C/minute,
// so no threshold in a stateless rule can stop a drip. See
// lib/saveGainBudget.ts for the measurements, the chosen numbers and why the
// charge is idempotent against a retry whose write never landed.

/**
 * Evaluate a save upload for one ACCOUNT, charging its cumulative budgets.
 *
 * NOT PURE, deliberately and only here: it reads and writes the per-account
 * budget state keyed by `accountKey` (User.id). Everything else about the
 * placement contract is identical to evaluateGain — `prior` is the STORED blob
 * and `next` is the CLIENT'S BYTES, evaluated before commitSave and therefore
 * before foldOwedGrants, so no server-issued payment is ever in `next`.
 *
 * `firstSave` is the no-prior case (a brand-new account's first-ever upload, or
 * a stored blob that would not parse). It used to skip the guard ENTIRELY —
 * routes/saves.ts gated steps 2b/2c/2d together on `existing?.saveData` — which
 * made "register an alt, POST once" the cheapest possible path to MAX_MONEY,
 * with neither a refusal nor a log row. Measured through the real handler:
 * saveData=null + `{money: 999_999_999, …}` returned 200 and stored every value
 * verbatim.
 *
 * It is DETECTION on that path and never a refusal, because a large first upload
 * has a legitimate shape: a player who has been playing against localStorage
 * (guest, or a browser that never synced) and uploads an established save the
 * first time they sign in. There is nothing to compare that against, so refusing
 * it would be guessing. A row is not.
 */
export function evaluateGainForAccount(
  accountKey: string,
  prior: Record<string, unknown> | null,
  next: Record<string, unknown>,
  elapsedMs: number,
  opts: { firstSave?: boolean; nowMs?: number } = {},
): GainVerdict {
  // No prior is ALWAYS detection-only, whether the caller flagged it or not:
  // an unparseable stored blob is the migration/corruption path and must not
  // start refusing saves.
  const firstSave = opts.firstSave === true || prior === null;
  const nowMs = opts.nowMs ?? Date.now();
  // On the no-prior path the comparison is against an EMPTY save, so every
  // value in the upload reads as a rise from zero. That is the only comparison
  // available, and it is the right one: a first upload carrying MAX_MONEY is
  // exactly what it looks like.
  const base: Record<string, unknown> = prior ?? {};
  const verdict = evaluateGain(base, next, elapsedMs);

  // Same PRIOR-side tolerance the pure rules have: a stored field this module
  // cannot read is not charged for, because the delta would be a fiction. See
  // readable(). Charging `after` against `after` makes the increment zero
  // without disturbing the bucket's anchor bookkeeping.
  const moneyAfter = balance(next.money);
  const moneyBefore = readable(base.money, "number") ? balance(base.money) : moneyAfter;
  const restrictedAfter = restrictedUnits(next);
  const restrictedBefore = readable(base.inventory, "object")
    ? restrictedUnits(base)
    : restrictedAfter;

  const charge = chargeCumulativeGain(
    accountKey,
    { moneyBefore, moneyAfter, restrictedBefore, restrictedAfter },
    {
      money: { capacity: MONEY_BUDGET_CAPACITY, refillPerHour: MONEY_BUDGET_REFILL_PER_HOUR },
      restricted: { capacity: RESTRICTED_BUDGET_CAPACITY, refillPerHour: RESTRICTED_BUDGET_REFILL_PER_HOUR },
    },
    nowMs,
  );

  if (!charge.money.ok) {
    verdict.violations.push({
      field: "money",
      rule: "cumulative",
      before: moneyBefore,
      after: moneyAfter,
      delta: charge.money.requested,
      allowance: charge.money.available,
      enforce: !firstSave,
    });
  }
  if (!charge.restricted.ok) {
    verdict.violations.push({
      field: "inventory.restricted",
      rule: "cumulative",
      before: restrictedBefore,
      after: restrictedAfter,
      delta: charge.restricted.requested,
      allowance: charge.restricted.available,
      enforce: !firstSave,
    });
  }

  // DETECTION, well under the refusal line. The refill has to clear a legitimate
  // whale with margin, so a drip that stays under $3,000,000/h is accepted and
  // silent — the honest residual of any token bucket. This is the second, lower
  // line that catches it without costing any false-positive margin, because it
  // can only ever write a row. Threshold and its measured margins:
  // MONEY_DETECT_PER_HOUR in lib/saveGainBudget.ts.
  if (charge.sustained) {
    verdict.notable.push({
      field: "money.hourly",
      before: moneyBefore,
      after: moneyAfter,
      delta: charge.moneyPerHour,
      allowance: MONEY_DETECT_PER_HOUR,
    });
  }

  // A first-ever save is detection on EVERY rule, not just the cumulative ones.
  if (firstSave) for (const v of verdict.violations) v.enforce = false;

  verdict.ok = verdict.violations.length === 0;
  return verdict;
}

/** Does this verdict authorise a refusal? See the PER-RULE ENFORCEMENT table. */
export function shouldRefuse(v: GainVerdict): boolean {
  return ENFORCE_GAIN_GUARD && v.violations.some((x) => x.enforce);
}

/**
 * A stable grouping key for the log throttle: which rules fired, on which
 * fields. Amounts are deliberately absent — a drip's amounts change on every
 * upload and its shape does not, and it is the shape a human triages.
 */
export function gainSignature(v: GainVerdict): string {
  const parts = new Set<string>();
  for (const x of v.violations) parts.add(`${x.field}:${x.rule}`);
  for (const x of v.notable) parts.add(`${x.field}:notable`);
  for (const x of v.stateNotes) parts.add(`${x.field}:state`);
  return [...parts].sort().join(",");
}

export { ENFORCE_GAIN_GUARD };
