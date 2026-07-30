// PvP badge tiers — the reward that costs nothing and cannot be inflated,
// and the table that sizes the one cash reward this feature mints.
//
// ── WHY A DERIVED BADGE IS THE PRIMARY PvP REWARD ────────────────────
// Every other reward in this feature is a faucet: it mints something, and
// therefore has to be capped, decayed and audited (see lib/pvpLadder.ts, which
// exists almost entirely to bound two small faucets). A badge tier mints
// nothing. It is a PURE FUNCTION of PlayerRating.rating, so:
//
//   * it has no supply, so it cannot inflate;
//   * it cannot be laundered into money — the auction house lists Pokémon
//     (Auction.pokemonId / pokemonSnapshot), and a tier is not an object at
//     all, so there is nothing to sell;
//   * two colluding accounts trading wins 1:1 end where they started, because
//     applyEloUpdate is zero-sum (K=32, winnerDelta = -loserDelta), so a
//     collusion ring cannot manufacture a tier between themselves;
//   * it needs no schema, no migration and no reconciliation, so it cannot
//     disagree with a save.
//
// ════════════════════════════════════════════════════════════════════════
// THE BANDS ARE THE CLIENT'S BANDS. THIS FILE IS NOT ALLOWED TO INVENT ANY.
// ════════════════════════════════════════════════════════════════════════
// game/src/state/pvpTiers.ts already exists, already declares itself the
// "single source of truth so client/server don't drift", and is already
// rendered in the PvP hub (components/PvpHubModal.tsx calls tierFor(rating)).
// An earlier version of this file shipped a SECOND, different table — bronze 0 /
// silver 1100 / gold 1200 / platinum 1350 / master 1500, plus a "rookie" tier
// for accounts with no matches. Measured over 15 ratings, 8 of 15 disagreed
// with the hub: at 1200 the server would have announced "Gold" while the
// player's own hub showed Silver, at 1500 "Master" while the hub showed
// Platinum, "Master" did not exist client-side at all, "Diamond" did not exist
// server-side, and a 0-match account was "Rookie" here and "Bronze" there.
//
// Paying a bonus under a tier name that contradicts what the player is looking
// at is worse than paying nothing, so the bands below are EXACTLY the client's:
//
//   Bronze 0 · Silver 1100 · Gold 1300 · Platinum 1500 · Diamond 1700
//
// tests/pvpBadgeTierDrift.test.ts parses game/src/state/pvpTiers.ts as text and
// fails if the two ever diverge again — including if a tier is added, removed,
// renamed or re-floored on either side. That is the mechanism; this comment is
// only the reason.
//
// Measured against the real ladder (production, read-only, 2026-07-30): FOUR
// PlayerRating rows exist, ratings 984–1016, peak 1016, max matchesPlayed 1,
// across 55 matches ever. So every honest account starts at Bronze and Silver
// is genuinely unclaimed today.

/** Ids are the client's ids (game/src/state/pvpTiers.ts). No extras. */
export type PvpBadgeTierId = "bronze" | "silver" | "gold" | "platinum" | "diamond";

export interface PvpBadgeTier {
  id: PvpBadgeTierId;
  label: string;
  /** Inclusive rating floor. Never null — every rating has a tier, exactly as
   *  the client's tierFor() has always behaved. */
  minRating: number;
  /**
   * One-time Battle Point bonus for reaching this tier for the first time
   * EVER, or null for the entry tier, which pays nothing because everyone
   * starts there.
   *
   * ── WHY THE MILESTONE BONUS KEYS ON RATING AND NOT ON WINS ───────────
   * This is the largest single BP payment in the feature, and rating is the one
   * PvP quantity a collusion ring cannot manufacture: Elo is zero-sum, so N
   * accounts trading wins have a constant rating SUM no matter how many matches
   * they play. Paying per win instead would make the same ring's income linear
   * in match count, which is exactly the ladder-reward attack.
   *
   * It is once-ever per account per threshold (PvpBadgeMilestone's composite
   * primary key is the gate) AND it is only paid on the match that actually
   * CROSSES the threshold (lib/pvpLadder.ts: ratingBefore < threshold <=
   * ratingAfter). Both are needed: the primary key stops an oscillating rating
   * being pumped across a boundary repeatedly, and the crossing rule stops the
   * day PVP_LADDER_REWARDS is switched on from paying every already-high
   * account its entire back-catalogue.
   */
  milestoneBp: number | null;
  /**
   * The once-per-cooldown cash bonus for a win at this tier.
   *
   * ── WHY THE CASH SCALES WITH RATING RATHER THAN BEING FLAT ───────────
   * A flat $25,000 was measured against the wrong cohort. The accounts that
   * actually play PvP (19 accounts that have ever played and were active in the
   * last 7 days) have a MEDIAN wallet of $3,607,030 and a median of 16 badges,
   * i.e. $54,400 for a single 8-hour away claim. $25,000 is 0.7% of that median
   * wallet and 46% of one away claim — it is not a reason for that cohort to
   * queue. Meanwhile the median of ALL 2,305 saves is $3,000 (the starting
   * grant), so no single flat number can be meaningful to both ends.
   *
   * Tiering it on rating fixes both ends at once AND strictly improves the
   * anti-collusion story, because rating is the quantity a ring cannot
   * manufacture:
   *
   *   * a legitimate strong player, who is also the wealthy one, gets an amount
   *     that is worth queueing for;
   *   * a farm of fresh alts sits at Bronze forever — Elo is zero-sum, so alts
   *     trading wins among themselves cannot all climb — and therefore earns
   *     LESS per account than the old flat number did. A 20-alt ring's ceiling
   *     drops from 20 × $25,000 = $500,000/day to 20 × $10,000 = $200,000/day.
   *   * feeding one main to Diamond costs the ring ~22 net thrown wins and
   *     leaves the feeders on Bronze: 1 × $200,000 + 22 × $10,000 = $420,000
   *     for 23 accounts, which is still less than the old flat design paid the
   *     same ring.
   *
   * Sized against measured production (2026-07-30): total money in existence
   * $736,890,844; top wallet $112,116,701; median active-24h wallet $221,525;
   * one 8-hour away claim is $32,000 at the median active badge count of 9 and
   * $54,400 at 16; the documented pessimistic active-play floor is $72,000/hour
   * (lib/awayProgress.ts). So even Diamond's $200,000 is under three hours of
   * ordinary honest play, and PvP is never the best money-per-hour route in the
   * game — the property that stops it distorting anything.
   */
  winBonusMoney: number;
}

/**
 * Tiers, ascending. The single server-side source of truth for the cosmetic
 * tier, the milestone thresholds AND the cash bonus, so the three can never
 * drift apart from each other — and pinned to the client's table by
 * tests/pvpBadgeTierDrift.test.ts so they cannot drift from the hub either.
 */
export const PVP_BADGE_TIERS: readonly PvpBadgeTier[] = [
  { id: "bronze",   label: "Bronze",   minRating: 0,    milestoneBp: null, winBonusMoney:  10_000 },
  { id: "silver",   label: "Silver",   minRating: 1100, milestoneBp: 10,   winBonusMoney:  25_000 },
  { id: "gold",     label: "Gold",     minRating: 1300, milestoneBp: 15,   winBonusMoney:  60_000 },
  { id: "platinum", label: "Platinum", minRating: 1500, milestoneBp: 25,   winBonusMoney: 120_000 },
  { id: "diamond",  label: "Diamond",  minRating: 1700, milestoneBp: 40,   winBonusMoney: 200_000 },
];

/**
 * Rating thresholds that pay a one-time bonus, ascending, derived from the tier
 * table above so there is exactly one place to change them.
 *
 * Lifetime total is 90 BP per account, and that is the ENTIRE uncapped portion
 * of the BP faucet: everything else is bounded by LADDER_BP_CAP_PER_WINDOW, and
 * this is bounded by "there are only four payable tiers, you can only reach each
 * once, and you are only paid on the match that crosses it".
 */
export const PVP_MILESTONES: readonly { threshold: number; bp: number }[] =
  PVP_BADGE_TIERS
    .filter((t): t is PvpBadgeTier & { milestoneBp: number } => t.milestoneBp !== null)
    .map((t) => ({ threshold: t.minRating, bp: t.milestoneBp }));

/** The lifetime ceiling on milestone BP for one account: 90. Exported because
 *  it is half of the honest answer to "what is the most BP one account can hold
 *  after one day?" — see LADDER_MAX_BP_ONE_ACCOUNT_ONE_WINDOW. */
export const PVP_MILESTONE_BP_LIFETIME_TOTAL =
  PVP_MILESTONES.reduce((a, m) => a + m.bp, 0);

/** Rating → tier. Identical in behaviour to the client's tierFor(). */
export function pvpTierForRating(rating: number): PvpBadgeTier {
  const r = Number.isFinite(rating) ? Math.floor(rating) : 0;
  for (let i = PVP_BADGE_TIERS.length - 1; i >= 0; i--) {
    if (r >= PVP_BADGE_TIERS[i].minRating) return PVP_BADGE_TIERS[i];
  }
  return PVP_BADGE_TIERS[0];
}

/** The cash a first win at this rating is worth. Pure, and the ONLY place the
 *  amount is decided — lib/pvpLadder.ts asks this rather than carrying a second
 *  copy of the numbers. */
export function winBonusMoneyForRating(rating: number | null | undefined): number {
  if (typeof rating !== "number" || !Number.isFinite(rating)) {
    // No rating means no rated result, which is already refused upstream. If it
    // ever gets here, pay the floor tier and nothing more.
    return PVP_BADGE_TIERS[0].winBonusMoney;
  }
  return pvpTierForRating(rating).winBonusMoney;
}

export interface PvpBadge {
  tier: PvpBadgeTierId;
  label: string;
  rating: number;
  /** The best tier this account has EVER held, from peakRating. Shown beside
   *  the live tier so a bad week does not erase the achievement — which is the
   *  whole point of a cosmetic, and is also why the milestone bonus is
   *  once-ever rather than re-earned on every crossing. */
  peakTier: PvpBadgeTierId;
  peakLabel: string;
  peakRating: number;
  /** The next tier up, or null at the top. Lets the UI render "38 to Gold"
   *  without a second copy of this table. */
  nextTier: { tier: PvpBadgeTierId; label: string; minRating: number; ratingToGo: number } | null;
  /** Has this account played a rated match at all? Reported SEPARATELY rather
   *  than folded into the tier: an earlier version returned a synthetic
   *  "Rookie" tier for 0-match accounts, which contradicted the hub (whose
   *  tierFor() has always said Bronze at 1000). The UI can render "unranked"
   *  from this flag; the tier stays a pure function of rating. */
  ranked: boolean;
  /** What a first win right now would pay, so the hub can show it. */
  winBonusMoney: number;
}

/**
 * Rating → badge. Pure, and a strict mirror of the client's tierFor().
 */
export function pvpBadgeForRating(
  rating: number | null | undefined,
  peakRating: number | null | undefined,
  matchesPlayed: number | null | undefined,
): PvpBadge {
  const r = typeof rating === "number" && Number.isFinite(rating) ? Math.floor(rating) : 1000;
  const p = typeof peakRating === "number" && Number.isFinite(peakRating) ? Math.floor(peakRating) : r;
  const played = typeof matchesPlayed === "number" && Number.isFinite(matchesPlayed) ? matchesPlayed : 0;

  const live = pvpTierForRating(r);
  const peak = pvpTierForRating(Math.max(p, r));
  const next = PVP_BADGE_TIERS.find((t) => t.minRating > r);

  return {
    tier: live.id,
    label: live.label,
    rating: r,
    peakTier: peak.id,
    peakLabel: peak.label,
    peakRating: Math.max(p, r),
    nextTier: next
      ? { tier: next.id, label: next.label, minRating: next.minRating, ratingToGo: next.minRating - r }
      : null,
    ranked: played >= 1,
    winBonusMoney: live.winBonusMoney,
  };
}

/**
 * The milestones this match CROSSED, ignoring anything already paid.
 *
 * ── WHY CROSSING AND NOT "ratingAfter >= threshold" ──────────────────
 * Rewards default OFF (PVP_LADDER_REWARDS). The version of this that keyed on
 * `ratingAfter` alone meant the day the switch is flipped, every account already
 * above 1100 would collect its entire milestone back-catalogue on its next win
 * — precisely what the migration's own comment says PvpBadgeMilestone exists to
 * prevent. Production exposure is 0 BP today (top rating 1016), which is exactly
 * why the switch should be flipped now rather than after a ladder has formed;
 * but the rule belongs in the code, not in the timing.
 *
 * A crossing also cannot happen on a loss (rating falls), so a milestone can
 * never be paid for going backwards.
 */
export function milestonesCrossed(
  ratingBefore: number | null | undefined,
  ratingAfter: number | null | undefined,
): { threshold: number; bp: number }[] {
  if (typeof ratingBefore !== "number" || !Number.isFinite(ratingBefore)) return [];
  if (typeof ratingAfter !== "number" || !Number.isFinite(ratingAfter)) return [];
  const before = Math.floor(ratingBefore);
  const after = Math.floor(ratingAfter);
  if (after <= before) return [];
  return PVP_MILESTONES.filter((m) => before < m.threshold && m.threshold <= after)
    .map((m) => ({ threshold: m.threshold, bp: m.bp }));
}
