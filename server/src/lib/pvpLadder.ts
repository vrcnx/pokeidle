// PvP ladder rewards — the policy, and the one transaction that pays it.
//
// ════════════════════════════════════════════════════════════════════════
// THE ARCHITECTURAL RULE THIS FILE EXISTS TO OBEY
// ════════════════════════════════════════════════════════════════════════
// There is no `saveData` write anywhere in this module. Not one.
//
// A PvP reward becomes ONE PendingGrant row per side, enlisted in the same
// transaction as the ledger row that decided it was earned. POST /api/saves
// folds it on top of the bytes the client just uploaded, INSIDE the CAS
// transaction that accepts that upload, and bumps `saveAdoptSeq` in the same
// UPDATE as `saveVersion` (lib/prizeGrant.ts, routes/saves.ts). That path
// already owns exactly-once payment and already survived the money-duplication
// and prize-destruction incidents; this feature reuses it wholesale rather than
// extending it — prizeGrant.ts, giveaway.ts, saveValidation.ts, saveRegression.ts
// and routes/saves.ts are byte-for-byte unmodified by this change.
// lib/awayProgress.ts + routes/away.ts are the shape being copied.
//
// So this feature adds NO new save-write path and NO new compare-and-swap. If
// the policy below is wrong, the worst it can do is owe the wrong number once.
// It cannot lose a save and it cannot double-pay, because it is not the thing
// that pays.
//
// ════════════════════════════════════════════════════════════════════════
// WHY A BOT BATTLE CANNOT PAY — five layers, every one of them fails CLOSED
// ════════════════════════════════════════════════════════════════════════
// Unrated AI opponents are being added concurrently (roughly 8 of 10 queue
// attempts never match at ~34 players/hour, so bots are the right product
// call). A bot battle that paid anything would be an infinite money printer:
// queue a bot, win, repeat, no second human and no rate limit but patience.
//
//   1. `provenance` — the reward is OPT-IN AT ROOM-CONSTRUCTION TIME, and it is
//      an ALLOWLIST OF HUMAN PAIRING PATHS, not a bot check.
//      `BattleRoom.ladderProvenance?: "queue" | "invite"` is set in exactly TWO
//      places — the matchmaking pairing path (socket.ts tryPairAndSpawnRoom) and
//      the friend-invite accept path — which are the only two pieces of code
//      that know a second HUMAN independently consented. tournamentRunner, the
//      admin force-start and every future bot room omit it and are unrewarded
//      WITH NO CODE OF THEIR OWN.
//
//      There is no "is this a bot?" check to forget — there is only a human
//      check a bot cannot accidentally satisfy. A new room type, a copy-pasted
//      room literal, or a refactor that has never heard of rewards produces
//      `undefined`, which is not in the allowlist, which pays nothing.
//
//      Contrast the two obvious alternatives, both of which fail OPEN:
//        * `if (room.format !== "bot")` is a denylist — a second bot format or
//          a rename prints money.
//        * `if (room.format === "random50")` is the predicate applyEloUpdate
//          already uses, and it is ALREADY WRONG for this purpose: socket.ts's
//          battle:invite whitelists `format: "random50"`, so it cannot tell a
//          queue pairing from an invite; and a bot task that reuses random50 for
//          the Lv50 cap — the natural thing to do — would be paid by it.
//
//   2. FOREIGN KEYS. The payout inserts BOTH sides' PvpLadderEarn rows in one
//      transaction, and both "userId" and "opponentUserId" are NOT NULL FKs to
//      User(id). Bot identities are synthetic strings (nothing stops that —
//      PvpMatch.userBId has no FK), and a synthetic id raises 23503, which
//      rolls back BOTH ledger rows and BOTH grants. The human's reward is
//      inseparable from the bot's; there is no partial success. A constraint,
//      not a branch: unforgettable, and unremovable under the additive-only
//      migration policy.
//
//   3. `saveVersion > 0`. Both ids must resolve to a User that has had at
//      least one save upload accepted. A bot has no client and never uploads,
//      so even a bot handed a real User row (likely, to make its username
//      render) fails this. Allowlist-shaped: a missing row is a refusal.
//
//   4. SYMMETRIC PAYMENT. Both grants go through enqueuePrizeGrant(..., tx),
//      which already throws "user not found" for an unresolvable id
//      (prizeGrant.ts) — an existing, tested gate this file neither wrote nor
//      modifies. If the opponent cannot be paid, the winner is not paid.
//
//   5. `rated`. An unrated result is never a ladder result. The hook sits
//      inside endBattle's existing rating block and passes `ratingDelta`;
//      null means applyEloUpdate did not run or threw, and this module treats
//      that as ineligible by arithmetic rather than by branch. Unrated AI
//      battles are the bot task's own stated contract.
//
// What still gets through: a bot given (i) a real User row, (ii) accepted save
// uploads, (iii) a rated format, and (iv) an explicit `ladderProvenance`. Four
// deliberate acts, not a forgotten `if`, and each is loudly visible — the bot
// appears in PlayerRating and on the public leaderboard, human ratings visibly
// move, and the bot's own PendingGrant rows pile up permanently owed, which
// GET /admin/pending-grants already surfaces.
//
// The bot task's entire contract is one sentence: DO NOT SET
// `ladderProvenance` ON BOT ROOMS. Nothing else about their feature has to know
// rewards exist.
//
// ════════════════════════════════════════════════════════════════════════
// WHY A FORFEIT / TIMEOUT IS NEVER A PAYDAY
// ════════════════════════════════════════════════════════════════════════
// LADDER_PAYABLE_END_REASONS is an ALLOWLIST of "ko" and "tie". forfeit,
// timeout and cancelled pay nothing to ANYBODY, including the survivor, so:
//
//   * you cannot profit from your opponent disconnecting — the reconnect-grace
//     forfeit (pvp.ts RECONNECT_GRACE_MS) and the AFK watchdog's timeout both
//     produce reasons that are not on the list;
//   * you cannot profit from your own early exit, and you cannot grief-farm by
//     flapping your socket: graceSuppressesWatchdog's MAX_TURN_CREDIT_MS budget
//     already bounds that, and its terminal states are timeout / cancelled;
//   * the both-sides-away branch ends "cancelled" — unpaid, matching its
//     existing "unrated, read as dead by the bracket" semantics;
//   * the shutdown drain ends live battles unpaid, so a deploy mints nothing.
//
// LADDER_MIN_TURNS + LADDER_MIN_DURATION_MS close the remaining hole: an
// agreed instant KO technically reports "ko".
//
// ── WHY THE DURATION FLOOR IS 20s AND NOT 60s ────────────────────────
// It was 60s. Measured at the boundary, that refused a 6-turn battle finished
// in 59,999 ms and a 4-turn battle in 55,000 ms — i.e. it refused genuine,
// decisive, briskly-played matches, which is a real cost paid by honest players.
// And it bought almost nothing: a colluder defeats a 60s floor by waiting 60
// seconds. The thing that actually bounds an abuser is the BP cap and the cash
// cooldown below, both of which are hard. So the floor is now set only high
// enough to reject scripted instant play, and the ledger records `durationMs`
// on every row precisely so this number can be RE-TUNED FROM DATA after a week:
//
//   SELECT min("durationMs"), percentile_disc(0.05) WITHIN GROUP (ORDER BY "durationMs"),
//          percentile_disc(0.5) WITHIN GROUP (ORDER BY "durationMs")
//     FROM "PvpLadderEarn" WHERE "turns" >= 3;
//
// This is honestly an untested number: PvpMatch has no usable timing (createdAt
// is stamped at insert, so finishedAt - createdAt is 0 for all 55 production
// rows), so no production measurement of real match duration exists yet. 20s is
// the value that cannot plausibly refuse two humans choosing three moves each
// through an animated client.
//
// COST TO A LEGITIMATE PLAYER, stated plainly because it is real: if your
// opponent rage-quits at turn 8 you get the rating win and no BP. Rating and
// badge tier are unaffected, so you still get the thing that ranks you.
//
// ════════════════════════════════════════════════════════════════════════
// ANTI-COLLUSION: WHAT IS LOAD-BEARING, WHAT WAS THEATRE, AND WHAT IT COSTS
// ════════════════════════════════════════════════════════════════════════
// Collusion is cheap here: accounts are free and battle:invite lets you pick
// your opponent. IP-based alt detection is IMPOSSIBLE — measured, every
// Session.ipAddress in production is a Cloudflare edge address with dozens of
// accounts behind a single one. There is no fingerprinting in this file
// because there is no signal to fingerprint.
//
// So the design principle is: ONE HARD BOUND PER FAUCET, and nothing else is
// allowed to cost an honest player anything.
//
//   LOAD-BEARING (these are the whole defence):
//     1. LADDER_BP_CAP_PER_WINDOW — 25 BP per account per ROLLING 24h, summed
//        over the ledger. Cost to an honest player: ~zero; a very good day of
//        real play lands around 20.
//     2. LADDER_WIN_BONUS_COOLDOWN_MS — the cash bonus at most once per 20h per
//        account, arbitrated by a single-row conditional upsert
//        (PvpWinBonusClaim), not by arithmetic. Cost: ~zero.
//     3. Cash amount scales with RATING (lib/pvpBadge.ts), the one PvP quantity
//        a ring cannot manufacture, because Elo is zero-sum. Cost: nothing to
//        an honest player; it PAYS them more than a flat number did.
//     4. The bot gate and the end-reason allowlist, above.
//
//   REMOVED AS THEATRE, because it cost honest players far more than it cost an
//   attacker:
//     * "matchmade only, never friend invites". Measured against production: 42
//       of 55 matches ever (76%) are between accounts that are FRIENDS, and 8 of
//       the 9 pairs that met more than once are friends — including the top pair
//       at 12 matches. Friend-invite play IS PvP in this game. Meanwhile the
//       rule bought nothing against a determined colluder: with 8 of 10 queue
//       attempts failing to match, two accounts queueing at 03:00 reliably find
//       each other anyway. So invites are now payable, and the caps do the work.
//     * decay to ZERO. The old table paid nothing from the 5th meeting. On the
//       real busiest PvP day in the game's history — 12 matches between one pair
//       — that made 8 of the 12 battles worth literally nothing to BOTH sides,
//       with no UI to explain why. Repeat pairings are the NORMAL pattern at
//       this population, not an edge case. Decay now flattens to 50% and every
//       payable match pays at least LADDER_BP_MIN_PER_PAYABLE_MATCH, because the
//       CAP is the bound — decay only shapes the curve underneath it, and a
//       shape that reaches zero teaches your only available opponent to stop
//       playing you.
//
// What this does NOT stop, said out loud: a ring of N accounts is bounded by
// N × (25 BP + one tier-priced cash bonus) per 20h, and nothing structural
// stops N. It IS detectable — the (userId, opponentUserId, createdAt) index
// makes it a one-line query:
//
//   SELECT "userId","opponentUserId",count(*),sum("bp"),sum("moneyAwarded")
//     FROM "PvpLadderEarn" GROUP BY 1,2 HAVING count(*) > 20 ORDER BY 5 DESC;
//
// and the response is an operator decision. There are no auto-bans and no
// automated clawbacks here: a clawback is a negative prize, i.e. a save write
// the player never agreed to, which is the shape awayProgress already refuses.
//
// ════════════════════════════════════════════════════════════════════════
// ECONOMY SIZING — measured read-only against production, 2026-07-30
// ════════════════════════════════════════════════════════════════════════
// 2,394 accounts; 2,305 have a parseable save (and all 2,305 have uploaded, so
// `saveVersion > 0` excludes nobody real). Money from saveData->>'money':
//
//   ALL SAVES        p25 $3,000 · p50 $3,000 · p75 $3,500 · p90 $21,519
//                    p99 $4,296,180 · max $112,116,701
//                    total in existence: $736,890,844
//   ACTIVE 24h (74)  p50 $221,525 · p75 $4,655,308 · p90 $14,396,128
//
// Starting money is $3,000, so THE MEDIAN ACCOUNT HAS NEVER EARNED A NET DOLLAR
// and sizing against it is meaningless. The active-24h cohort is bimodal (p50
// $221,525 but p75 $4,655,308), so its median is misleading too.
//
// THE COHORT THAT WILL ACTUALLY SEE THIS REWARD is the 19 accounts that have
// ever played PvP and were active in the last 7 days:
//
//   money   p25 $52,488 · p50 $3,607,030 · p75 $9,575,248 · max $106,474,958
//   badges  median 16 of 16   →  one 8-hour away claim = $54,400
//   only 5 of the 19 hold under $100,000; all have max party level 81–100
//
// That is the measurement that killed the flat $25,000: it is 0.69% of that
// cohort's median wallet. Against the ACTIVE-24h median badge count of 9 — not
// 16 — an away claim is $32,000, so a flat $25,000 was also less than one
// night's idling for a typical active player. Hence the tier-priced table in
// lib/pvpBadge.ts: $10,000 at Bronze up to $200,000 at Diamond.
//
// Existing faucets, for scale: daily login $500–$5,000 (lib/dailies.ts); away
// progress $400 × (1 + badges)/hr with an 8h cap, so $32,000 at the median
// active badge count and $54,400 at 16 (lib/awayProgress.ts); and awayProgress's
// own deliberately pessimistic ACTIVE-play floor is $72,000/hour. Prices: Poké
// Ball $200 · Ultra Ball $1,200 · Life Orb $5,000 · Link Cable $9,800 ·
// Exp. Share $20,000 · evolution stones $100,000 (sell $50,000).
//
// So the honest bottom line, stated rather than dressed up:
//   * for a mid-tier player, $10,000–$25,000 once a day is a real, noticeable
//     amount — several Ultra Balls, a fifth of a stone;
//   * for the six accounts holding $8M–$106M, NO amount of cash is a reason to
//     queue, and pretending otherwise is how you break an economy. Their reward
//     is rating, badge tier, leaderboard placement and Battle Points. That is
//     what competitive rewards are for, and it is why the badge is first in the
//     list and mints nothing.
//   * PvP is never the best money-per-hour route in the game (Diamond's
//     $200,000 once per 20h is under three hours of the documented pessimistic
//     active-play floor), which is the property that stops it distorting
//     anything.
//
// Site-wide worst case, honestly bounded: only 46 accounts have EVER played PvP.
// If every one of them claimed a Bronze bonus every 20h that is ~$460,000/day
// against a $736,890,844 float, or 0.06%/day. A 20-alt farm is 20 × $10,000 per
// 20h = $200,000/day — LESS than the old flat design's $500,000/day, which is
// the point of tiering on rating.
//
// ════════════════════════════════════════════════════════════════════════
// WHY A NEW CURRENCY AND NOT THE EXISTING VICTORY TOKEN
// ════════════════════════════════════════════════════════════════════════
// `state.victoryTokens` (game/src/state/reducer.ts: +1 per first-time gym win
// and per champion win, spent in the Reward Shop) measures 376 holders and
// 1,817 tokens in existence, max 34. Reusing it is wrong for four reasons, in
// order of force:
//
//   1. IT CANNOT BE PAID THROUGH THE INBOX WITHOUT EDITING THE PAYMENT PATH.
//      Prize is item | money | pokemon (lib/giveaway.ts) and victoryTokens is
//      a top-level save field, not an inventory key. Paying tokens means a new
//      Prize kind in giveaway.ts and a new branch in foldPrizesIntoSave — the
//      two most safety-critical functions in the codebase. An inventory-item
//      currency folds through the existing `kind: "item"` branch with ZERO
//      changes to the payment path. That alone decides it.
//   2. IT WOULD WRECK A SCARCE CURRENCY AND OPEN A CASH EXIT. The Reward Shop
//      prices 1 token = 1 evolution stone = $100,000 of mart value, and stones
//      sell back for $50,000 — so a Victory Token is convertible to cash at
//      $50,000. A 25/day cap across even 10 active players is a double-digit
//      percentage daily increase on an 1,817-token pool.
//   3. SEMANTICS. A Victory Token means "I beat a Gym Leader / the Champion",
//      and its shop hangs off the Indigo Plateau League card.
//   4. THE NEW CURRENCY INHERITS EVERY PROTECTION FOR FREE. destructiveLosses
//      already covers per-item inventory quantities (lib/saveRegression.ts),
//      so BP is blind-write-protected with no code change; validateSave bounds
//      inventory values at MAX_INVENTORY_STACK and accepts free-form keys, so
//      BP is deliverable today; and the client's SELL_ITEM refuses
//      `sellPrice <= 0`, which for an id absent from the catalog resolves via
//      `?? 0` — BP is UNSELLABLE even before its catalog entry ships.
//
// And the honest caveat to hand the owner, because players will ask for Master
// Balls and Bottle Caps in the BP shop first: in a game with a player-to-player
// auction house (179 auctions, 59 sold, max bid $10,000,000), anything
// materially useful is INDIRECTLY convertible to money. Only cosmetics are
// strictly unlaunderable. Hence the ordering: badge tier first (lib/pvpBadge.ts,
// mints nothing), a tier-priced once-per-20h cash bonus second, and a slow token
// whose shop should hold consumables only.
//
// ════════════════════════════════════════════════════════════════════════
// SHIP ORDER — READ THIS BEFORE SETTING PVP_LADDER_REWARDS=1
// ════════════════════════════════════════════════════════════════════════
// Battle Points are delivered as `inventory.battlepoint`. The client has NO
// catalog entry for that id yet, so until one ships:
//   * the Bag renders a row literally labelled "battlepoint", with no sprite
//     and no description (utils/items.ts falls back to `{name: itemId}`, and
//     data/itemsCatalog.ts's category fallback puts it under Utility);
//   * the only notification is the generic grant toast — "You received 8x
//     battlepoint + $25,000!" — which does not mention PvP;
//   * there is no BP shop, so BP is unspendable (and, for the same reason,
//     unsellable: SELL_ITEM resolves an uncatalogued sellPrice via `?? 0`).
// Rewards therefore DEFAULT OFF. The correct deploy order is: apply the
// migration, ship the client catalog entry + BP shop + the PvP rewards panel
// that reads GET /pvp/me/ladder, THEN set PVP_LADDER_REWARDS=1. Every rule below
// is echoed by that endpoint precisely so the client never needs a second,
// drifting copy of these numbers.

import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { recordError } from "./errorReporting.js";
import { enqueuePrizeGrant } from "./prizeGrant.js";
import type { Prize } from "./giveaway.js";
import {
  PVP_MILESTONE_BP_LIFETIME_TOTAL,
  milestonesCrossed,
  pvpTierForRating,
  winBonusMoneyForRating,
} from "./pvpBadge.js";

// ─── Policy constants ────────────────────────────────────────────────

/**
 * The inventory key BP is stored under, in `save.inventory`.
 *
 * NOT a new top-level save field and NOT a server-side balance. The spendable
 * balance lives in the save; the PvpLadderEarn ledger is an append-only audit
 * of what was MINTED, never a second authoritative balance. Two stores for one
 * spendable currency is precisely the reconciliation bug class the save-CAS
 * work removed.
 */
export const LADDER_BP_ITEM_ID = "battlepoint";

/** Battle Points for a rated win against a human. */
export const LADDER_BP_WIN = 3;
/**
 * Battle Points for a rated LOSS that was actually fought.
 *
 * Paying the loser at all is deliberate: with ~34 players an hour the scarce
 * resource is opponents, not wins, and a ladder where losing pays zero teaches
 * the better player's victims to stop queueing — which starves the feature of
 * the very thing it needs. It is also the mechanism that makes gate 4 above
 * work: the loser's grant is the winner's proof of a real, payable opponent.
 */
export const LADDER_BP_LOSS = 1;
/**
 * Battle Points each for a genuine draw.
 *
 * Currently UNREACHABLE in production and that is not an oversight: pvp.ts
 * leaves winnerId/loserId unset on a tie, so endBattle's rating block never
 * runs and a tie is never rated — and an unrated result is never a ladder
 * result (gate 5). The policy carries the value so that if ties are ever
 * rated, the table is already complete and already tested.
 */
export const LADDER_BP_TIE = 1;

/**
 * The floor under decay: any match that passes every structural gate pays at
 * least this much BP, however many times these two have already met.
 *
 * ── WHY THERE IS A FLOOR AT ALL ──────────────────────────────────────
 * The previous table decayed to 0% from the 5th meeting. Executed against the
 * real busiest PvP day in the game's history (12 matches between one pair, wins
 * split 6/6), that paid BOTH sides exactly nothing for 8 of the 12 battles — and
 * five straight losses to one rival paid 1, 1, 0, 0, 0, so the reason the loser
 * is paid at all stopped applying from the third meeting.
 *
 * The floor costs the economy nothing, because the CAP is the bound: a pair
 * playing 100 matches in a window still stops at LADDER_BP_CAP_PER_WINDOW.
 * Decay's only remaining job is to make the FIRST meetings of a window worth
 * more than the twentieth, which is a shaping decision, not a defence.
 */
export const LADDER_BP_MIN_PER_PAYABLE_MATCH = 1;

/** One-off Battle Points on top of the win bonus, once per cooldown. */
export const LADDER_WIN_BONUS_BP = 5;

/**
 * The rolling window the BP cap and the per-opponent decay are both measured
 * over — 24 hours, from `PvpLadderEarn.createdAt`.
 *
 * ── WHY ROLLING AND NOT A UTC CALENDAR DAY ───────────────────────────
 * A UTC-day cap is STRADDLEABLE and it was measured: two matches at
 * 23:59:30Z and 00:00:30Z paid one account $50,000 and 16 BP inside 61 seconds,
 * i.e. double the advertised daily maximum, in a burst, with no waiting. Every
 * calendar-boundary cap has this property; a rolling window has it by
 * construction never, because there is no boundary to sit on.
 *
 * The `day` column is kept for ops reporting only. Nothing gates on it.
 *
 * Cost to an honest player: the cap refills gradually instead of all at once at
 * midnight, which is strictly friendlier — there is no "wait three hours for
 * reset" incentive to stop playing.
 */
export const LADDER_BP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Battle Points per account per rolling window from BATTLES (including the
 * once-per-cooldown BP bonus). This is the hard bound on the repeatable BP
 * faucet.
 *
 * Milestones do NOT count against it and do NOT consume it — see
 * PvpLadderEarn."milestoneBp", which is a separate column precisely so that
 * `SUM("bp")` (the cap read) cannot see them. An earlier version booked
 * milestone BP into the capped column, which meant a 98-BP milestone match
 * exhausted the cap for every legitimate battle for the rest of the day: the
 * comment promised the exemption and the SQL took it away.
 *
 * Sized to be INVISIBLE to a legitimate player and to be the only hard bound on
 * an abuser: a realistic very good window is ~8 matches / ~5 wins spread over 3
 * opponents, which after decay is about 19–20 BP. The cap binds at ~1.3x that.
 */
export const LADDER_BP_CAP_PER_WINDOW = 25;

/**
 * THE HONEST HEADLINE NUMBER: the most BP one account can ever hold after one
 * window, inclusive of milestones.
 *
 * `LADDER_BP_CAP_PER_WINDOW` alone reads like the hard bound and it is not —
 * milestones are exempt, by design and now also in the arithmetic. The
 * exemption is safe because milestone BP is (a) once-ever per threshold,
 * arbitrated by a primary key, (b) payable only on the match that CROSSES the
 * threshold, and (c) gated on rating, which Elo makes zero-sum across any
 * collusion ring. So the 90 below is a LIFETIME total per account, not a daily
 * one: the steady state is 25 per window, and 115 can happen exactly once in
 * the life of an account that climbs from Bronze to Diamond in a single day.
 */
export const LADDER_MAX_BP_ONE_ACCOUNT_ONE_WINDOW =
  LADDER_BP_CAP_PER_WINDOW + PVP_MILESTONE_BP_LIFETIME_TOTAL;

/**
 * The cash bonus is claimable at most once per this interval, per account.
 *
 * ── WHY A ROLLING COOLDOWN AND NOT "FIRST WIN OF THE UTC DAY" ─────────
 * Same measurement as LADDER_BP_WINDOW_MS: the calendar-day version paid
 * $50,000 in 61 seconds across midnight. A cooldown cannot be straddled, so the
 * per-account per-HOUR ceiling is exactly one bonus, which is the number that
 * matters for burst extraction.
 *
 * 20h rather than 24h so the claim time does not drift later every day and
 * eventually become unreachable for a player with a fixed routine — the standard
 * reason competitive games use a sub-24h cooldown. The honest arithmetic that
 * follows: at most 1 bonus per hour, and at most 2 in the worst-aligned 24h
 * window (two claims exactly 20h apart). It is not a burst and it cannot be
 * compressed.
 *
 * Arbitrated by PvpWinBonusClaim — ONE ROW PER ACCOUNT, claimed with
 * `INSERT … ON CONFLICT ("userId") DO UPDATE … WHERE "claimedAt" <= cutoff`,
 * which takes a row lock on the conflicting row and so serialises concurrent
 * claims. Strictly stronger than the (userId, day) primary key it replaces:
 * that key could be satisfied twice by two different day values.
 */
export const LADDER_WIN_BONUS_COOLDOWN_MS = 20 * 60 * 60 * 1000;

/** A battle shorter than this pays nothing even when it reports "ko". */
export const LADDER_MIN_TURNS = 3;
/** …and neither does one that finished faster than this. See the header for why
 *  this is 20s and not 60s, and for the query that re-tunes it from data. */
export const LADDER_MIN_DURATION_MS = 20_000;

/**
 * The ALLOWLIST of end reasons that can pay. Allowlist, not denylist: a new
 * end reason added to pvp.ts in future pays nothing until someone deliberately
 * adds it here, which is the direction a mistake should fail in.
 */
export const LADDER_PAYABLE_END_REASONS = ["ko", "tie"] as const;

/**
 * The ALLOWLIST of room-construction paths that can pay — the bot gate.
 *
 * "queue"  = socket.ts tryPairAndSpawnRoom, i.e. two humans independently
 *            joined the matchmaking queue.
 * "invite" = a friend invite that the other human explicitly accepted.
 *
 * Both are positive assertions of human consent made at room-construction time.
 * Anything else — a bot room, a tournament room, an admin force-start, a room
 * type that does not exist yet — carries no provenance and is refused with no
 * code of its own.
 */
export const LADDER_PAYABLE_PROVENANCE = ["queue", "invite"] as const;

/**
 * Per-opponent diminishing returns, indexed by (meeting number - 1) within the
 * rolling window. Past the end of the table the value is
 * LADDER_DECAY_PERCENT_FLOOR — it does NOT fall to zero; see
 * LADDER_BP_MIN_PER_PAYABLE_MATCH for why.
 */
export const LADDER_DECAY_PERCENT_BY_MEETING = [100, 100, 75, 75, 50] as const;
/** The percentage every meeting past the table pays. Never 0. */
export const LADDER_DECAY_PERCENT_FLOOR = 50;

/**
 * Master switch, read per call so it can be flipped without a redeploy.
 *
 * DEFAULT OFF, on purpose. The server can ship first (tables, ledger,
 * endpoints) and the faucet only opens once the client can render a Battle
 * Point — see the SHIP ORDER block in the header — and the rollback is one
 * environment variable rather than a revert. A deploy that forgets it mints
 * nothing, which is the correct direction.
 */
export function ladderRewardsEnabled(): boolean {
  return process.env.PVP_LADDER_REWARDS === "1";
}

// ─── The pure policy ─────────────────────────────────────────────────

export type LadderEndReason = "ko" | "tie" | "forfeit" | "timeout" | "cancelled";
export type LadderResult = "win" | "loss" | "tie";
export type LadderProvenance = (typeof LADDER_PAYABLE_PROVENANCE)[number];

/** Everything about a match that can be judged WITHOUT touching the database. */
export interface LadderMatchShape {
  /**
   * `room.ladderProvenance` — positively asserted by the two human pairing
   * paths and by nothing else. Required (not optional) on purpose: a caller
   * that forgets it is a COMPILE error, which is a strictly stronger
   * fail-closed than a missing property being `undefined`. Typed as
   * `string | null` rather than `LadderProvenance | null` so that an
   * unrecognised value from a future room type is a runtime REFUSAL rather than
   * a type error that tempts someone into a cast.
   */
  provenance: string | null | undefined;
  /** applyEloUpdate produced a delta, i.e. this was a rated result. */
  rated: boolean;
  endReason: LadderEndReason;
  turns: number;
  durationMs: number;
}

/** Per-side ledger state, as observed. All of it is server-owned; nothing here
 *  can be influenced by anything a client sends. */
export interface LadderSideState {
  userId: string;
  opponentUserId: string;
  /**
   * Positively asserted: this id belongs to a real User row that has had at
   * least one save upload accepted (`saveVersion > 0`). Required, and refusing
   * is the default — see gate 3 in the header.
   */
  realAccount: boolean;
  result: LadderResult;
  /** Rating BEFORE the match. Milestones pay only on a crossing, so this is
   *  load-bearing, not decoration — see milestonesCrossed. */
  ratingBefore: number | null;
  /** Rating AFTER the match. Also prices the cash bonus (pvpBadge tier). */
  ratingAfter: number | null;
  /** This side's Elo delta, stored for audit. */
  ratingDelta: number;
  /** Meetings against THIS opponent already recorded inside the window. */
  priorMeetingsVsOpponentInWindow: number;
  /** Capped BP already earned inside the window, before this match. Excludes
   *  milestone BP by construction — it is a different column. */
  bpEarnedInWindowBeforeThis: number;
  /** Is the cash bonus still on cooldown for this account? */
  winBonusOnCooldown: boolean;
  /** Rating thresholds already awarded to this account, ever. */
  milestonesAlreadyAwarded: readonly number[];
}

export interface LadderMatchDescription extends LadderMatchShape {
  matchId: string;
  sides: readonly [LadderSideState, LadderSideState];
}

export interface LadderMilestoneAward {
  threshold: number;
  bp: number;
  ratingBefore: number;
  ratingAtAward: number;
}

export interface LadderSideReward {
  userId: string;
  opponentUserId: string;
  result: LadderResult;
  /** 1-based: this is the Nth time these two met inside the window. */
  meetingIndex: number;
  decayPercent: number;
  /** BP the result is worth before decay and before the cap. */
  bpBeforeDecay: number;
  /** BP from the battle itself, after decay and after the cap. */
  bpFromBattle: number;
  /** Did this match claim the once-per-cooldown bonus? */
  winBonus: boolean;
  bpWinBonus: number;
  money: number;
  /** The tier that priced `money`, for the audit row and the UI. */
  tier: string;
  milestones: LadderMilestoneAward[];
  /** Milestone BP only. Deliberately separate from the capped total. */
  milestoneBp: number;
  /** Everything, for the grant. */
  bpTotal: number;
  /** Ready to hand straight to enqueuePrizeGrant. Empty = nothing to pay. */
  prizes: Prize[];
  ratingDelta: number;
  /** Carried through so the audit row and the bonus claim record the rating
   *  that priced them, rather than recomputing it from a different source. */
  ratingBefore: number;
  ratingAfter: number;
}

export interface LadderRewardPlan {
  eligible: boolean;
  /** Non-null exactly when `eligible` is false. A stable machine-readable slug
   *  so the refusal can be asserted by a test and counted in the logs. */
  refusedReason: string | null;
  sides: readonly LadderSideReward[];
}

/**
 * The gates that need no database. Exported so `settleLadderEarn` can refuse
 * before spending a single query, and so the bot / forfeit / short-battle rules
 * are provable in isolation.
 *
 * Ordered cheapest-and-most-structural first, and every branch is a REFUSAL —
 * there is no path through this function that returns null by accident.
 */
export function structuralRefusal(m: LadderMatchShape): string | null {
  // Gate 1. The bot gate. Not a bot CHECK: an allowlist of human pairing paths
  // that a bot room cannot accidentally carry.
  if (typeof m.provenance !== "string"
    || !(LADDER_PAYABLE_PROVENANCE as readonly string[]).includes(m.provenance)) {
    return "not_human_pvp";
  }
  // Gate 5. An unrated result is never a ladder result.
  if (m.rated !== true) return "unrated";
  // A forfeit / timeout / cancellation is never a payday, for EITHER side.
  if (!(LADDER_PAYABLE_END_REASONS as readonly string[]).includes(m.endReason)) {
    return `end_reason_${m.endReason}`;
  }
  // An agreed instant KO reports "ko". These two stop it.
  if (!Number.isFinite(m.turns) || m.turns < LADDER_MIN_TURNS) return "too_few_turns";
  if (!Number.isFinite(m.durationMs) || m.durationMs < LADDER_MIN_DURATION_MS) return "too_short";
  return null;
}

/** Decay multiplier as a percentage for the Nth meeting (1-based) in the
 *  window. Never returns 0 for a real meeting — the floor is deliberate. */
export function decayPercentForMeeting(meetingIndex: number): number {
  if (!Number.isFinite(meetingIndex) || meetingIndex < 1) return 0;
  const i = Math.floor(meetingIndex) - 1;
  return i < LADDER_DECAY_PERCENT_BY_MEETING.length
    ? LADDER_DECAY_PERCENT_BY_MEETING[i]
    : LADDER_DECAY_PERCENT_FLOOR;
}

/** Base BP a result is worth, before decay and before the cap. */
export function baseBpForResult(result: LadderResult): number {
  return result === "win" ? LADDER_BP_WIN : result === "tie" ? LADDER_BP_TIE : LADDER_BP_LOSS;
}

/** UTC calendar day as `YYYY-MM-DD`. Reporting only — no gate reads it, which
 *  is exactly why the straddle described on LADDER_BP_WINDOW_MS is gone. */
export function utcDayString(when: Date = new Date()): string {
  return when.toISOString().slice(0, 10);
}

/** Turn count from the omniscient protocol log. `|turn|N` is emitted once per
 *  turn by @pkmn/sim. Pure, and it is the ONLY place turns are derived — the
 *  count exists nowhere else once the room is dropped, which is why the ledger
 *  stores it rather than deriving it later. */
export function countTurnsInLog(lines: readonly string[]): number {
  let n = 0;
  for (const line of lines) if (typeof line === "string" && line.startsWith("|turn|")) n++;
  return n;
}

/**
 * Turn a described match into the exact rewards to pay. PURE — no clock, no
 * I/O, no database, no randomness — so every rule above is provable by
 * execution rather than by argument.
 *
 * Refuses by default: the function is a cascade of refusals followed by
 * arithmetic, and an ineligible match returns zero sides rather than zero
 * amounts, so a caller that ignores `eligible` still writes nothing.
 */
export function computeLadderReward(m: LadderMatchDescription): LadderRewardPlan {
  const refuse = (reason: string): LadderRewardPlan =>
    ({ eligible: false, refusedReason: reason, sides: [] });

  const structural = structuralRefusal(m);
  if (structural) return refuse(structural);

  const [x, y] = m.sides;
  if (!x?.userId || !y?.userId) return refuse("missing_user_id");
  // Mirrors the PvpLadderEarn CHECK constraint. A self-play room cannot be
  // recorded at all, so it must not be computed either.
  if (x.userId === y.userId) return refuse("self_match");
  // Gate 2/3/4's policy half: the winner is only payable because the OPPONENT
  // is payable. One synthetic id refuses the whole match, which is what makes
  // a bot battle worth nothing to the human in it.
  if (!x.realAccount || !y.realAccount) return refuse("opponent_not_a_real_account");

  // A decisive match must be exactly one win and one loss; a draw must be two
  // ties. Anything else means the caller mis-described the outcome, and a
  // mis-described outcome must not be paid on a guess.
  const results = [x.result, y.result].sort().join("/");
  if (results !== "loss/win" && results !== "tie/tie") return refuse("inconsistent_results");

  return {
    eligible: true,
    refusedReason: null,
    sides: [computeSide(x), computeSide(y)],
  };
}

function computeSide(s: LadderSideState): LadderSideReward {
  const ratingBefore = typeof s.ratingBefore === "number" && Number.isFinite(s.ratingBefore)
    ? Math.floor(s.ratingBefore) : 0;
  const ratingAfter = typeof s.ratingAfter === "number" && Number.isFinite(s.ratingAfter)
    ? Math.floor(s.ratingAfter) : 0;

  const meetingIndex = Math.max(0, Math.floor(s.priorMeetingsVsOpponentInWindow)) + 1;
  const decayPercent = decayPercentForMeeting(meetingIndex);
  const bpBeforeDecay = baseBpForResult(s.result);
  // floor, not round: the decay must never round a half-value UP into more
  // than the undecayed reward. Then the FLOOR: a match that passed every
  // structural gate is a real match and pays something. Clamped to
  // bpBeforeDecay so the floor can never pay MORE than an undecayed result.
  const decayed = Math.min(
    bpBeforeDecay,
    Math.max(LADDER_BP_MIN_PER_PAYABLE_MATCH, Math.floor((bpBeforeDecay * decayPercent) / 100)),
  );

  const alreadyInWindow = Math.max(0, Math.floor(s.bpEarnedInWindowBeforeThis));
  let remaining = Math.max(0, LADDER_BP_CAP_PER_WINDOW - alreadyInWindow);
  const bpFromBattle = Math.min(decayed, remaining);
  remaining -= bpFromBattle;

  // ── The once-per-cooldown bonus ────────────────────────────────────
  // Requires a WIN and an off-cooldown account, and NOTHING ELSE.
  //
  // It deliberately does NOT require the battle's own BP to have survived
  // decay. That extra condition was measured and it broke the single strongest
  // reason to come back: a player who loses four times to the same rival and
  // finally wins the fifth was paid $0 and 0 BP for that win, because the 5th
  // meeting had decayed to zero. With only ~8 people playing PvP, that is the
  // weaker half of every rivalry, permanently. The condition was also
  // unnecessary — the cash faucet is bounded by the cooldown arbiter, not by
  // the BP arithmetic, so letting a decayed win claim it mints nothing extra.
  const winBonus = s.result === "win" && !s.winBonusOnCooldown;
  const bpWinBonus = winBonus ? Math.min(LADDER_WIN_BONUS_BP, remaining) : 0;
  // Priced by RATING, the one PvP quantity a ring cannot manufacture.
  const money = winBonus ? winBonusMoneyForRating(ratingAfter) : 0;
  const tier = pvpTierForRating(ratingAfter).id;

  // ── Milestones ─────────────────────────────────────────────────────
  // Exempt from the window cap (they are a separate ledger column, so the cap
  // read cannot even see them), and paid ONLY on the match that crosses the
  // threshold — never for merely standing above it, which is what made the
  // switch-flip day pay every high account its whole back-catalogue.
  const awarded = new Set(s.milestonesAlreadyAwarded);
  const milestones: LadderMilestoneAward[] = milestonesCrossed(s.ratingBefore, s.ratingAfter)
    .filter((ms) => !awarded.has(ms.threshold))
    .map((ms) => ({ threshold: ms.threshold, bp: ms.bp, ratingBefore, ratingAtAward: ratingAfter }));
  const milestoneBp = milestones.reduce((a, b) => a + b.bp, 0);

  const bpTotal = bpFromBattle + bpWinBonus + milestoneBp;

  return {
    userId: s.userId,
    opponentUserId: s.opponentUserId,
    result: s.result,
    meetingIndex,
    decayPercent,
    bpBeforeDecay,
    bpFromBattle,
    winBonus,
    bpWinBonus,
    money,
    tier,
    milestones,
    milestoneBp,
    bpTotal,
    prizes: prizesFor(bpTotal, money),
    ratingDelta: Math.trunc(s.ratingDelta) || 0,
    ratingBefore,
    ratingAfter,
  };
}

/** BP + money as inbox Prizes. Both go through the EXISTING `item` / `money`
 *  branches of foldPrizesIntoSave — no new Prize kind, so giveaway.ts,
 *  prizeGrant.ts and saveValidation.ts are untouched by this feature. */
export function prizesFor(bp: number, money: number): Prize[] {
  const out: Prize[] = [];
  if (bp > 0) out.push({ kind: "item", itemId: LADDER_BP_ITEM_ID, quantity: bp });
  if (money > 0) out.push({ kind: "money", amount: money });
  return out;
}

// ─── The settle transaction ──────────────────────────────────────────
//
// ── WHY RAW SQL FOR THE THREE NEW TABLES ─────────────────────────────
// `prisma generate` cannot be run on the Windows dev box while a dev server
// holds a lock on the query-engine DLL (EPERM renaming
// query_engine-windows.dll.node), so the generated client has no typed
// delegates for tables added in this change and `tsc --noEmit` would fail on
// `prisma.pvpLadderEarn`. lib/errorReporting.ts and lib/audit.ts already solve
// this the same way and document the same reason. The Railway build runs
// `npx prisma generate && npm run build`, so the models ARE typed in
// production; raw SQL works identically either way and keeps the local
// typecheck honest.
//
// Every statement below is a Prisma TAGGED TEMPLATE, so every value is a bound
// parameter — there is no string interpolation of user data anywhere in this
// file.

export interface SettleLadderInput {
  /** The battle room id. Doubles as the ledger's idempotency key. */
  matchId: string;
  /** `room.ladderProvenance` — "queue" | "invite", or absent. See gate 1. */
  provenance: string | null | undefined;
  winnerId: string;
  loserId: string;
  endReason: LadderEndReason;
  /** `room.log` — the omniscient protocol lines. Turns are counted from it
   *  here because the count exists NOWHERE ELSE once the room is dropped. */
  logLines: readonly string[];
  /** `Date.now() - room.createdAt`. Also unrecoverable later: PvpMatch.createdAt
   *  is stamped at row-insert time INSIDE endBattle, so finishedAt - createdAt
   *  is 0 seconds for all 55 production rows. */
  durationMs: number;
  /** applyEloUpdate's return value. `a` is the WINNER, `b` is the loser. */
  ratingDelta: { aDelta: number; bDelta: number; aRating: number; bRating: number } | null;
  /** Injectable clock, for tests only. */
  now?: Date;
}

export interface SettleLadderSideOutcome {
  userId: string;
  /** Capped BP: battle + the once-per-cooldown bonus. */
  bp: number;
  /** Uncapped, once-ever milestone BP. Reported separately so the honest total
   *  is visible and the cap is not misread. */
  milestoneBp: number;
  money: number;
  winBonus: boolean;
  tier: string;
  milestones: number[];
  grantId: string | null;
}

export interface SettleLadderOutcome {
  paid: boolean;
  /** Machine-readable refusal slug, or null when paid. */
  reason: string | null;
  sides: SettleLadderSideOutcome[];
}

const NOT_PAID = (reason: string): SettleLadderOutcome => ({ paid: false, reason, sides: [] });

/**
 * A refusal raised from INSIDE the settle transaction.
 *
 * It is thrown rather than returned because returning a value COMMITS the
 * transaction, and one refusal ("already_settled") is only discovered after the
 * first ledger insert has already happened. Committing there would leave a
 * zero-value orphan row that still counts as a meeting for the decay window.
 * Throwing makes every refusal path — structural, ineligible, or a replay —
 * roll back to nothing written, uniformly.
 *
 * Caught by name outside the transaction so it never reaches recordError: these
 * are the NORMAL answers (a bot battle, a tournament room, a forfeit, a replay),
 * not failures, and logging them would bury the real ones.
 */
class LadderRefusal extends Error {
  constructor(readonly slug: string) {
    super(`ladder_refused:${slug}`);
    this.name = "LadderRefusal";
  }
}

function newLadderRowId(): string {
  return "ple_" + randomBytes(9).toString("hex");
}

interface SideLedgerRead {
  bpInWindow: number;
  meetings: number;
  winBonusOnCooldown: boolean;
}

async function readSideLedger(
  tx: Prisma.TransactionClient,
  userId: string,
  opponentUserId: string,
  windowStart: Date,
  bonusCutoff: Date,
): Promise<SideLedgerRead> {
  // One round trip for all three per-side facts. The aggregate has no GROUP BY,
  // so it returns exactly one row even when the account has earned nothing in
  // the window — which is the overwhelmingly common case and must not be a
  // special path.
  //
  // NOTE `SUM(e."bp")` and not `SUM(e."bp" + e."milestoneBp")`. That is the
  // milestone exemption, expressed where it actually binds.
  const rows = await tx.$queryRaw<{ bp_window: number; meetings: number; bonus_on_cooldown: number }[]>`
    SELECT
      COALESCE(SUM(e."bp"), 0)::int AS bp_window,
      COUNT(*) FILTER (WHERE e."opponentUserId" = ${opponentUserId})::int AS meetings,
      (SELECT COUNT(*) FROM "PvpWinBonusClaim" w
        WHERE w."userId" = ${userId} AND w."claimedAt" > ${bonusCutoff})::int AS bonus_on_cooldown
    FROM "PvpLadderEarn" e
    WHERE e."userId" = ${userId} AND e."createdAt" > ${windowStart}
  `;
  const r = rows[0];
  return {
    bpInWindow: Number(r?.bp_window ?? 0),
    meetings: Number(r?.meetings ?? 0),
    winBonusOnCooldown: Number(r?.bonus_on_cooldown ?? 0) > 0,
  };
}

async function readMilestones(tx: Prisma.TransactionClient, userId: string): Promise<number[]> {
  const rows = await tx.$queryRaw<{ threshold: number }[]>`
    SELECT "threshold"::int AS threshold FROM "PvpBadgeMilestone" WHERE "userId" = ${userId}
  `;
  return rows.map((r) => Number(r.threshold));
}

/**
 * Settle a finished rated human battle: decide the reward, record it, and owe
 * it through the PendingGrant inbox.
 *
 * Never throws and never rejects — endBattle calls it fire-and-forget, exactly
 * like the PvpMatch insert beside it, because a reward must not be able to
 * delay or fail a battle that has already ended. Every failure path records an
 * error: a reward that silently fails to pay is a support ticket nobody can
 * answer.
 *
 * ── WHAT MAKES THIS EXACTLY-ONCE ─────────────────────────────────────
 * Three separate unique constraints arbitrate, and none of them is a
 * check-then-act:
 *
 *   * `PvpLadderEarn (matchId, userId)` — a replayed settle (endBattle invoked
 *     twice, a retry, a duplicated event) inserts zero rows, and zero rows
 *     rolls the whole transaction back before a single grant exists.
 *   * `PvpWinBonusClaim ("userId")` primary key with a CONDITIONAL upsert — the
 *     cash bonus. `ON CONFLICT DO UPDATE … WHERE "claimedAt" <= cutoff` takes a
 *     row lock on the existing row, so two battles finishing in the same instant
 *     serialise: the second sees the first's timestamp and affects zero rows,
 *     and that side simply does not get the bonus. Exception-free, so it needs
 *     no savepoint and cannot poison the transaction. Unlike a (userId, day)
 *     key, it also cannot be satisfied twice by straddling midnight.
 *   * `PvpBadgeMilestone (userId, threshold)` primary key — same shape, once
 *     ever rather than once per cooldown.
 *
 * The rolling BP cap and the per-opponent decay are READS, and they are the only
 * check-then-act in here. That is deliberate and it is safe: socket.ts enforces
 * one live battle per account, so two settles for the same user cannot overlap;
 * and a cap is a soft economic bound where a one-match overshoot costs 3 BP,
 * unlike the cash bonus, which is hard-gated above.
 */
export async function settleLadderEarn(input: SettleLadderInput): Promise<SettleLadderOutcome> {
  // Master switch first, before any work at all. Default off (see
  // ladderRewardsEnabled) — a server that ships ahead of the client mints
  // nothing, and the rollback is one env var.
  if (!ladderRewardsEnabled()) return NOT_PAID("disabled");

  const shape: LadderMatchShape = {
    provenance: input.provenance,
    rated: input.ratingDelta !== null && input.ratingDelta !== undefined,
    endReason: input.endReason,
    turns: countTurnsInLog(input.logLines ?? []),
    durationMs: Math.max(0, Math.floor(input.durationMs)),
  };

  // Refuse before touching the database. This is the hot path for every bot
  // battle, every tournament room and every forfeit, and none of them should
  // cost a query. It is also NOT an error — these are the normal answers — so
  // nothing is recorded here.
  const structural = structuralRefusal(shape);
  if (structural) return NOT_PAID(structural);

  if (!input.winnerId || !input.loserId || input.winnerId === input.loserId) {
    // Reachable only from a caller that mis-describes the outcome. That IS
    // worth an error: it means endBattle handed us a match it should not have.
    void recordError({
      kind: "server",
      message: "pvp_ladder_bad_outcome",
      source: "lib/pvpLadder.settleLadderEarn",
      meta: { matchId: input.matchId, winnerId: input.winnerId, loserId: input.loserId },
    });
    return NOT_PAID("bad_outcome");
  }

  const now = input.now ?? new Date();
  const day = utcDayString(now);
  const windowStart = new Date(now.getTime() - LADDER_BP_WINDOW_MS);
  const bonusCutoff = new Date(now.getTime() - LADDER_WIN_BONUS_COOLDOWN_MS);
  const delta = input.ratingDelta!;
  // Elo is applied by applyEloUpdate before the hook runs, so the pre-match
  // rating is recovered by subtracting the delta rather than by a second read —
  // which also means it cannot disagree with the delta that was actually paid.
  const winnerBefore = delta.aRating - delta.aDelta;
  const loserBefore = delta.bRating - delta.bDelta;

  try {
    const settled = await prisma.$transaction(async (tx) => {
      // Gate 3. Both ids must be accounts that have had a save upload accepted.
      // A bot has no client and never uploads one, so this refuses even a bot
      // that was handed a real User row to make its username render. Allowlist
      // shaped: a missing row is simply absent from the map.
      const accounts = await tx.user.findMany({
        where: { id: { in: [input.winnerId, input.loserId] } },
        select: { id: true, saveVersion: true },
      });
      const real = new Set(
        accounts.filter((a) => (a.saveVersion ?? 0) > 0).map((a) => a.id),
      );

      const [winnerLedger, loserLedger, winnerMilestones, loserMilestones] = await Promise.all([
        readSideLedger(tx, input.winnerId, input.loserId, windowStart, bonusCutoff),
        readSideLedger(tx, input.loserId, input.winnerId, windowStart, bonusCutoff),
        readMilestones(tx, input.winnerId),
        readMilestones(tx, input.loserId),
      ]);

      const description: LadderMatchDescription = {
        ...shape,
        matchId: input.matchId,
        sides: [
          {
            userId: input.winnerId,
            opponentUserId: input.loserId,
            realAccount: real.has(input.winnerId),
            result: "win",
            ratingBefore: winnerBefore,
            ratingAfter: delta.aRating,
            ratingDelta: delta.aDelta,
            priorMeetingsVsOpponentInWindow: winnerLedger.meetings,
            bpEarnedInWindowBeforeThis: winnerLedger.bpInWindow,
            winBonusOnCooldown: winnerLedger.winBonusOnCooldown,
            milestonesAlreadyAwarded: winnerMilestones,
          },
          {
            userId: input.loserId,
            opponentUserId: input.winnerId,
            realAccount: real.has(input.loserId),
            result: "loss",
            ratingBefore: loserBefore,
            ratingAfter: delta.bRating,
            ratingDelta: delta.bDelta,
            priorMeetingsVsOpponentInWindow: loserLedger.meetings,
            bpEarnedInWindowBeforeThis: loserLedger.bpInWindow,
            winBonusOnCooldown: loserLedger.winBonusOnCooldown,
            milestonesAlreadyAwarded: loserMilestones,
          },
        ],
      };

      const plan = computeLadderReward(description);
      // Throwing rolls this transaction back with nothing written. See
      // LadderRefusal for why this is a throw and not a return.
      if (!plan.eligible) throw new LadderRefusal(plan.refusedReason ?? "ineligible");

      // ── Exactly-once, claimed FIRST ──────────────────────────────
      // Both ledger rows go in before any grant exists, with zeroed amounts.
      // If either insert is a no-op this match has already been settled, and
      // rolling back here means a replay cannot create a second grant.
      //
      // This is also where a BOT DIES: "userId" and "opponentUserId" are FKs to
      // User(id), so a synthetic bot id raises 23503 and takes both rows and
      // both grants down together.
      const rowIds: string[] = [];
      for (const side of plan.sides) {
        const id = newLadderRowId();
        rowIds.push(id);
        const affected = await tx.$executeRaw`
          INSERT INTO "PvpLadderEarn" (
            "id","matchId","userId","opponentUserId","day","provenance","result","endReason",
            "turns","durationMs","ratingBefore","ratingAfter","ratingDelta","meetingIndex",
            "bpBeforeDecay","tier","bp","milestoneBp","moneyAwarded","winBonusPaid","createdAt"
          ) VALUES (
            ${id}, ${input.matchId}, ${side.userId}, ${side.opponentUserId}, ${day}::date,
            ${shape.provenance as string}, ${side.result}, ${input.endReason},
            ${shape.turns}, ${shape.durationMs},
            ${side.ratingBefore}, ${side.ratingAfter},
            ${side.ratingDelta}, ${side.meetingIndex},
            ${side.bpBeforeDecay}, ${side.tier},
            0, 0, 0, false, ${now}
          )
          ON CONFLICT ("matchId","userId") DO NOTHING
        `;
        // Zero affected rows means this (match, side) is already in the ledger:
        // endBattle was invoked twice, or a retry replayed the settle. Throwing
        // rolls back the row(s) this attempt already inserted, so a replay
        // cannot leave a second grant OR a phantom meeting behind.
        if (affected !== 1) throw new LadderRefusal("already_settled");
      }

      const outcomes: SettleLadderSideOutcome[] = [];
      for (let i = 0; i < plan.sides.length; i++) {
        const side = plan.sides[i];
        const rowId = rowIds[i];

        // ── The once-per-cooldown gate ─────────────────────────────
        // The read above is only a hint; THIS is the arbiter. One row per
        // account, and the WHERE on the DO UPDATE takes that row's lock, so
        // concurrent claims serialise and the loser affects zero rows rather
        // than raising a 23505 that would poison the transaction.
        //
        // There is no calendar day in this predicate, which is the whole point:
        // a cooldown cannot be straddled.
        let winBonus = false;
        if (side.winBonus) {
          const claimed = await tx.$executeRaw`
            INSERT INTO "PvpWinBonusClaim" ("userId","claimedAt","day","matchId","rating","tier","money")
            VALUES (${side.userId}, ${now}, ${day}::date, ${input.matchId},
                    ${side.ratingAfter}, ${side.tier}, ${side.money})
            ON CONFLICT ("userId") DO UPDATE
              SET "claimedAt" = EXCLUDED."claimedAt",
                  "day"       = EXCLUDED."day",
                  "matchId"   = EXCLUDED."matchId",
                  "rating"    = EXCLUDED."rating",
                  "tier"      = EXCLUDED."tier",
                  "money"     = EXCLUDED."money"
              WHERE "PvpWinBonusClaim"."claimedAt" <= ${bonusCutoff}
          `;
          winBonus = claimed === 1;
        }

        // ── The once-ever milestone gate, same shape ───────────────
        const wonMilestones: LadderMilestoneAward[] = [];
        for (const ms of side.milestones) {
          const claimed = await tx.$executeRaw`
            INSERT INTO "PvpBadgeMilestone" ("userId","threshold","ratingBefore","ratingAtAward","bp")
            VALUES (${side.userId}, ${ms.threshold}, ${ms.ratingBefore}, ${ms.ratingAtAward}, ${ms.bp})
            ON CONFLICT ("userId","threshold") DO NOTHING
          `;
          if (claimed === 1) wonMilestones.push(ms);
        }

        // Downgrade to what was ACTUALLY claimed. A lost gate removes its own
        // component and nothing else, so a race costs the bonus rather than
        // the match.
        const bp = side.bpFromBattle + (winBonus ? side.bpWinBonus : 0);
        const milestoneBp = wonMilestones.reduce((a, b) => a + b.bp, 0);
        const money = winBonus ? side.money : 0;
        const prizes = prizesFor(bp + milestoneBp, money);

        // ── Payment ────────────────────────────────────────────────
        // The inbox, and nothing else. Enlisted in THIS transaction so the
        // ledger row and the grant are one atomic fact: it is impossible to
        // record an earn without owing it, or to owe without recording it.
        //
        // Gate 4 lives here: enqueuePrizeGrant throws "user not found" for an
        // unresolvable id, and because both sides are paid in this same
        // transaction, an unpayable opponent takes the winner's reward with it.
        let grantId: string | null = null;
        if (prizes.length > 0) {
          const granted = await enqueuePrizeGrant(
            side.userId,
            prizes,
            { source: "pvp-ladder", sourceId: input.matchId },
            tx,
          );
          grantId = granted.id;
        }

        // Finalise the audit row with what was paid. The immutable descriptive
        // columns (meetingIndex, bpBeforeDecay, turns, durationMs, provenance,
        // ratingBefore/After) were written at insert time and are never revised
        // — recomputing them later under a changed policy would yield a number
        // nobody was paid, which makes an audit worthless.
        await tx.$executeRaw`
          UPDATE "PvpLadderEarn"
          SET "bp" = ${bp}, "milestoneBp" = ${milestoneBp}, "moneyAwarded" = ${money},
              "winBonusPaid" = ${winBonus}, "grantId" = ${grantId}
          WHERE "id" = ${rowId}
        `;

        outcomes.push({
          userId: side.userId,
          bp,
          milestoneBp,
          money,
          winBonus,
          tier: side.tier,
          milestones: wonMilestones.map((w) => w.threshold),
          grantId,
        });
      }

      return outcomes;
    });

    return { paid: true, reason: null, sides: settled };
  } catch (e) {
    // A refusal is a normal answer, and the transaction has already rolled
    // back. Report it; do not log it.
    if (e instanceof LadderRefusal) return NOT_PAID(e.slug);
    // The transaction guarantees nothing was written; this only reports it.
    //
    // Recorded rather than swallowed because the two most likely causes are
    // both things an operator must see: a missing migration (the tables do not
    // exist yet, so every rated battle logs this and pays nothing — loud, and
    // fail-closed), and an FK violation from a synthetic opponent id, which is
    // the bot gate firing and worth knowing about.
    void recordError({
      kind: "server",
      message: "pvp_ladder_settle_failed",
      source: "lib/pvpLadder.settleLadderEarn",
      meta: {
        matchId: input.matchId,
        winnerId: input.winnerId,
        loserId: input.loserId,
        provenance: String(input.provenance),
        endReason: input.endReason,
        turns: shape.turns,
        durationMs: shape.durationMs,
        day,
        error: String(e),
      },
    });
    return NOT_PAID("error");
  }
}

// ─── Read-side helpers for routes/pvp.ts ─────────────────────────────

export interface LadderStatus {
  /** UTC day, for display only. The windows below are rolling. */
  day: string;
  windowMs: number;
  bpEarnedInWindow: number;
  bpCap: number;
  bpRemainingInWindow: number;
  /** Milestone BP minted, ever. Never counted against the cap. */
  milestoneBpLifetime: number;
  bpMintedLifetime: number;
  matchesRewardedInWindow: number;
  winBonusOnCooldown: boolean;
  /** ISO timestamp the cash bonus becomes claimable again, or null if it is
   *  claimable now. The single most-asked question a rewards panel has to
   *  answer, and it is unanswerable from a calendar-day design. */
  winBonusAvailableAt: string | null;
  winBonusCooldownMs: number;
  winBonusBp: number;
  /** What a win right now would pay in cash, at this account's rating. */
  winBonusMoney: number;
  rewardsEnabled: boolean;
}

/**
 * The caller's ladder position. Read-only, and it deliberately does NOT report a
 * BP BALANCE: the balance lives in `save.inventory.battlepoint`, which the
 * client already holds. This reports what was MINTED, which is the only thing
 * the server is authoritative about.
 */
export async function readLadderStatus(
  userId: string,
  now: Date = new Date(),
  rating: number | null = null,
): Promise<LadderStatus> {
  const windowStart = new Date(now.getTime() - LADDER_BP_WINDOW_MS);
  const rows = await prisma.$queryRaw<{
    bp_window: number; matches_window: number; bp_lifetime: number;
    milestone_lifetime: number; bonus_at: Date | null;
  }[]>`
    SELECT
      COALESCE(SUM(e."bp") FILTER (WHERE e."createdAt" > ${windowStart}), 0)::int AS bp_window,
      COUNT(*) FILTER (WHERE e."createdAt" > ${windowStart})::int AS matches_window,
      COALESCE(SUM(e."bp"), 0)::int AS bp_lifetime,
      COALESCE(SUM(e."milestoneBp"), 0)::int AS milestone_lifetime,
      (SELECT w."claimedAt" FROM "PvpWinBonusClaim" w WHERE w."userId" = ${userId}) AS bonus_at
    FROM "PvpLadderEarn" e
    WHERE e."userId" = ${userId}
  `;
  const r = rows[0];
  const bpEarnedInWindow = Number(r?.bp_window ?? 0);
  const claimedAt = r?.bonus_at ? new Date(r.bonus_at as unknown as string) : null;
  const availableAt = claimedAt
    ? new Date(claimedAt.getTime() + LADDER_WIN_BONUS_COOLDOWN_MS)
    : null;
  const onCooldown = !!availableAt && availableAt.getTime() > now.getTime();
  return {
    day: utcDayString(now),
    windowMs: LADDER_BP_WINDOW_MS,
    bpEarnedInWindow,
    bpCap: LADDER_BP_CAP_PER_WINDOW,
    bpRemainingInWindow: Math.max(0, LADDER_BP_CAP_PER_WINDOW - bpEarnedInWindow),
    milestoneBpLifetime: Number(r?.milestone_lifetime ?? 0),
    bpMintedLifetime: Number(r?.bp_lifetime ?? 0) + Number(r?.milestone_lifetime ?? 0),
    matchesRewardedInWindow: Number(r?.matches_window ?? 0),
    winBonusOnCooldown: onCooldown,
    winBonusAvailableAt: onCooldown ? availableAt!.toISOString() : null,
    winBonusCooldownMs: LADDER_WIN_BONUS_COOLDOWN_MS,
    winBonusBp: LADDER_WIN_BONUS_BP,
    winBonusMoney: winBonusMoneyForRating(rating ?? 1000),
    rewardsEnabled: ladderRewardsEnabled(),
  };
}

export interface LadderHistoryRow {
  matchId: string;
  opponentUserId: string;
  day: string;
  provenance: string;
  result: string;
  bp: number;
  milestoneBp: number;
  moneyAwarded: number;
  winBonusPaid: boolean;
  tier: string;
  meetingIndex: number;
  decayPercent: number;
  decayApplied: boolean;
  /** Why this row paid what it paid, in words, so a smaller-than-expected
   *  reward is explainable rather than a guess. */
  explanation: string;
  turns: number;
  ratingDelta: number;
  createdAt: Date;
}

/** Recent ladder earnings for one account, newest first. */
export async function readLadderHistory(userId: string, limit = 25): Promise<LadderHistoryRow[]> {
  const take = Math.min(100, Math.max(1, Math.floor(limit)));
  const rows = await prisma.$queryRaw<any[]>`
    SELECT "matchId","opponentUserId","day","provenance","result","bp","milestoneBp",
           "moneyAwarded","winBonusPaid","tier","meetingIndex","bpBeforeDecay","turns",
           "ratingDelta","createdAt"
    FROM "PvpLadderEarn"
    WHERE "userId" = ${userId}
    ORDER BY "createdAt" DESC
    LIMIT ${take}
  `;
  return rows.map((r) => {
    const meetingIndex = Number(r.meetingIndex);
    const decayPercent = decayPercentForMeeting(meetingIndex);
    return {
      matchId: String(r.matchId),
      opponentUserId: String(r.opponentUserId),
      day: r.day instanceof Date ? utcDayString(r.day) : String(r.day).slice(0, 10),
      provenance: String(r.provenance ?? ""),
      result: String(r.result),
      bp: Number(r.bp),
      milestoneBp: Number(r.milestoneBp ?? 0),
      moneyAwarded: Number(r.moneyAwarded),
      winBonusPaid: Boolean(r.winBonusPaid),
      tier: String(r.tier ?? ""),
      meetingIndex,
      decayPercent,
      decayApplied: decayPercent < 100,
      explanation: explainEarn({
        meetingIndex,
        decayPercent,
        bp: Number(r.bp),
        milestoneBp: Number(r.milestoneBp ?? 0),
        money: Number(r.moneyAwarded),
        winBonusPaid: Boolean(r.winBonusPaid),
        result: String(r.result),
      }),
      turns: Number(r.turns),
      ratingDelta: Number(r.ratingDelta),
      createdAt: r.createdAt instanceof Date ? r.createdAt : new Date(String(r.createdAt)),
    };
  });
}

/**
 * One sentence explaining a single earn. Server-side because the rules are
 * server-side: a client that reconstructed this would be a second copy of the
 * policy, drifting from the day it shipped.
 */
export function explainEarn(e: {
  meetingIndex: number; decayPercent: number; bp: number; milestoneBp: number;
  money: number; winBonusPaid: boolean; result: string;
}): string {
  const parts: string[] = [];
  if (e.bp > 0 || e.milestoneBp > 0) {
    parts.push(`${e.bp + e.milestoneBp} BP`);
  } else {
    parts.push("0 BP — your Battle Point cap for the last 24h is full");
  }
  if (e.money > 0) parts.push(`$${e.money.toLocaleString("en-US")} win bonus`);
  if (e.milestoneBp > 0) parts.push(`${e.milestoneBp} BP rank-up bonus`);
  if (e.meetingIndex > 1) {
    parts.push(`meeting #${e.meetingIndex} with this opponent in 24h, so BP paid at ${e.decayPercent}%`);
  }
  if (e.result === "win" && !e.winBonusPaid && e.money === 0) {
    parts.push("win bonus already claimed — it returns 20h after your last one");
  }
  return parts.join("; ");
}
