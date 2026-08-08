import type { Prize } from "./giveaway.js";

// Level rewards: the ladder a player climbs just by playing.
//
// ── THE TWO NUMBERS THAT SHAPED THIS ────────────────────────────────
//
// 1. THE CEILING IS 100,050, not a few thousand. `accountLevel` is
//    `floor(totalCaughtLevels / 10)` over party + box (lib/level.ts), and the
//    box holds 9,999 Pokemon at level 100. Live accounts are at 800-1200
//    today, so the tail has to stay sane across four orders of magnitude —
//    which is why nothing in this file loops over tiers. Both directions are
//    O(1) arithmetic; a `for (let l = 0; l < level; l++)` here would be a
//    100,000-iteration loop on every save upload, and every save upload is
//    every 2.5 seconds, per player.
//
// 2. LEVEL CAN GO DOWN. It is derived from the Pokemon you currently HOLD, so
//    releasing a boxful lowers it. That makes "reached level N" unusable as a
//    payment trigger on its own: release, re-level, collect again, forever.
//    The claim ledger keys off a high-water mark instead — see
//    lib/progression.ts, and PvpLadderBaseline, which learned the same lesson.
//
// ── THE SHAPE ───────────────────────────────────────────────────────
// Hand-authored early, arithmetic forever after. The first few levels arrive
// quickly and are where a new player learns the game has rewards at all, so
// they are close together and deliberately chosen. Past EARLY_END the spacing
// is constant and the VALUE scales instead — a fixed prize on an infinite
// ladder is worthless by level 1,000, and an escalating interval means a
// veteran can play for a week and cross nothing.

/** Hand-picked opening tiers. Close together, because the first reward has to
 *  arrive before a new player concludes there are none. */
const EARLY_TIERS = [5, 10, 15, 20, 30, 40, 50, 75, 100] as const;

/** Past the last hand-authored tier, one every this many levels, forever. */
export const TAIL_STEP = 25;

/** The last hand-authored tier. */
const EARLY_END = EARLY_TIERS[EARLY_TIERS.length - 1];

/** A Master Ball rides along on tiers at multiples of this.
 *
 *  250, not 100. Master Balls are auction-tradeable, so an infinite ladder
 *  minting them is an infinite supply — the interval is what bounds the rate.
 *  At 250 a player crossing level 1,200 has earned four across their whole
 *  history, which reads as rare; at 100 the same player has twelve and they
 *  are a currency. */
export const MASTERBALL_EVERY = 250;

/**
 * How many tiers a player at `level` has reached.
 *
 * This is the count, not an index — level 0 is 0 tiers, level 5 is 1. O(1):
 * the early tiers are a short scan of a fixed 9-element list, and the tail is
 * a division.
 */
export function tiersReachedAt(level: number): number {
  if (!Number.isFinite(level) || level < EARLY_TIERS[0]) return 0;
  if (level < EARLY_END) {
    let n = 0;
    for (const t of EARLY_TIERS) if (level >= t) n++;
    return n;
  }
  return EARLY_TIERS.length + Math.floor((level - EARLY_END) / TAIL_STEP);
}

/**
 * The level tier `n` requires. `n` is 1-based, matching `tiersReachedAt`.
 *
 * The inverse of the above, and tested as one — a ladder whose two directions
 * disagree pays the wrong tier or pays it twice.
 */
export function levelForTier(n: number): number {
  if (n <= 0) return 0;
  if (n <= EARLY_TIERS.length) return EARLY_TIERS[n - 1];
  return EARLY_END + (n - EARLY_TIERS.length) * TAIL_STEP;
}

/** The next level that pays, from where the player stands now. */
export function nextTierLevel(level: number): number {
  return levelForTier(tiersReachedAt(level) + 1);
}

/**
 * What tier `n` pays.
 *
 * ── WHY THE VALUE SCALES AND THE INTERVAL DOES NOT ──────────────────
 * The alternative — a fixed prize with a widening gap — fails at both ends: it
 * is stingy early, when the gaps are small, and by level 1,000 the player is
 * crossing a tier every few hours for a reward worth less than one battle.
 * Scaling the value keeps a tier meaningful at 50 and at 5,000, and a constant
 * interval keeps the feedback regular.
 *
 * Money is the backbone because it is the one reward that never becomes junk
 * and never needs a catalog lookup. Consumables ride along in bands, because a
 * stack of Poke Balls means something at level 20 and nothing at level 900 —
 * so the BALL changes rather than the count climbing forever.
 */
export function rewardForTier(n: number): Prize[] {
  const level = levelForTier(n);
  const prizes: Prize[] = [];

  // Linear in level, so a tier is always worth roughly the same share of what
  // a player at that level is earning. Rounded to something readable: a
  // reward that reads $47,318 looks computed, and $47,000 looks decided.
  const money = roundish(400 * level + 2_000);
  prizes.push({ kind: "money", amount: Math.min(10_000_000, money) });

  // Bands, not a climbing count. The best ball a tier can carry says more
  // about progress than "60x Poke Ball" ever does, and the quantity stays
  // small enough to read at a glance.
  if (level < 50) prizes.push({ kind: "item", itemId: "pokeball", quantity: 5 });
  else if (level < 150) prizes.push({ kind: "item", itemId: "greatball", quantity: 5 });
  else prizes.push({ kind: "item", itemId: "ultraball", quantity: 5 });

  // Rare on purpose — see MASTERBALL_EVERY.
  if (level > 0 && level % MASTERBALL_EVERY === 0) {
    prizes.push({ kind: "item", itemId: "masterball", quantity: 1 });
  }

  return prizes;
}

/**
 * Everything owed between two high-water marks, MERGED into one prize list.
 *
 * Merging is the point. A player arriving at level 1,200 has crossed 53 tiers,
 * and paying them as 53 PendingGrant rows would be 53 toasts, 53 rows in the
 * inbox and 53 deliveries folded into one save. It is the same value either
 * way; one grant is the only version a person would recognise as a reward.
 *
 * Money sums. Items sum per id. Nothing is capped here beyond the per-prize
 * ceilings the schema already enforces — the caller decides how far back to
 * pay, and this only describes what that span is worth.
 */
export function rewardsBetween(fromTier: number, toTier: number): Prize[] {
  if (toTier <= fromTier) return [];
  let money = 0;
  const items = new Map<string, number>();

  for (let n = fromTier + 1; n <= toTier; n++) {
    for (const p of rewardForTier(n)) {
      if (p.kind === "money") money += p.amount;
      else if (p.kind === "item") items.set(p.itemId, (items.get(p.itemId) ?? 0) + p.quantity);
    }
  }

  const out: Prize[] = [];
  // ── SPLIT, DO NOT CLAMP ──────────────────────────────────────────
  // PrizeSchema caps money at 10,000,000 PER PRIZE, and a long back-pay
  // exceeds that easily: 53 tiers at level 1,200 is ~$11.9M and 205 tiers at
  // level 5,000 is over $50M.
  //
  // The first version clamped to the cap, which made every veteran past
  // ~level 1,150 receive exactly $10,000,000 — a level 5,000 account and a
  // level 1,200 account paid identically, with roughly $40M quietly deleted
  // and nothing anywhere saying so. The cap is a limit on how large one prize
  // may be, not a statement about what a span is worth, so the span is
  // carried as as many prizes as it takes.
  //
  // Bounded by construction rather than by a guard: the ceiling is level
  // 100,050, which is ~4,007 tiers and around $80 BILLION, so the worst case
  // is ~8,000 money prizes. That is absurd as a payout and would be absurd as
  // a row, so the SPAN is what the caller limits — see progression.ts, where
  // back-pay is what it is and ongoing awards are one tier at a time.
  const MONEY_PRIZE_CAP = 10_000_000;
  let remaining = money;
  while (remaining > 0) {
    const chunk = Math.min(MONEY_PRIZE_CAP, remaining);
    out.push({ kind: "money", amount: chunk });
    remaining -= chunk;
  }
  for (const [itemId, quantity] of items) {
    out.push({ kind: "item", itemId, quantity: Math.min(9_999, quantity) });
  }
  return out;
}

/** 3 significant figures, so the number reads as chosen rather than computed. */
function roundish(n: number): number {
  if (n < 1000) return Math.round(n / 100) * 100;
  const mag = 10 ** (Math.floor(Math.log10(n)) - 2);
  return Math.round(n / mag) * mag;
}
