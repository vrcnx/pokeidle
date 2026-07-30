// CUMULATIVE gain budgets — the accumulator lib/saveGainGuard.ts does not have.
//
// ── THE HOLE THIS CLOSES (proved by execution, not argued) ───────────────
// saveGainGuard's money rule is a PER-UPLOAD step cap: the allowance is
// `MONEY_BURST + MONEY_RATE_PER_HOUR × elapsed`, and `elapsed` is measured from
// the last ACCEPTED write, so it resets on every upload. The rule is therefore
// memoryless, and "rate" in its name is wrong. routes/saves.ts's saveLimiter
// permits 30 uploads/minute, so a cheat that steps EXACTLY MONEY_BURST per
// upload is:
//
//   * never refused — a violation needs `delta > allowance`, and
//   * never even logged — a `notable` row needs `delta > MONEY_BURST`.
//
// Measured, by running the real evaluateGain in a loop at the route's own
// permitted cadence (one upload every 2s): $3,000 → $999,999,999
// (validateSave's MAX_MONEY) in 1,000 uploads = 33.3 minutes of wall clock,
// with ZERO violations and ZERO log rows of any kind. Nominal ceiling
// 30 × 60 × $1,000,000 = $1,800,000,000/hour. Total money in existence across
// all 2,309 production saves is $739,663,957, so one account could mint 1.35×
// the entire economy in half an hour without producing a single row for anyone
// to look at. The confirmed cheat (koruem2, $99,997,295 in 430 uploads) is a
// one-line change away from that shape.
//
// A step cap cannot fix this at any threshold: 30 uploads/min × C is 30C/min
// for every C, and lowering C far enough to matter starts refusing the
// offline-lineage reconcile the burst floor exists for. The missing ingredient
// is STATE — an allowance that is CHARGED and stays charged until it refills.
//
// ── WHY THE NUMBERS ARE THESE NUMBERS ────────────────────────────────────
// Both prior reviews said the corpus could not bound a real SINGLE-UPLOAD
// money delta, because SaveSnapshot is interval-gated at 30 minutes so a
// snapshot pair spans hundreds of uploads. It can: SaveSnapshot.saveVersion is
// recorded, and POST /api/saves increments saveVersion by exactly 1 per
// accepted write, so (versionB − versionA) is the EXACT number of accepted
// writes inside a pair. Measured over every consecutive pair in production:
//
//   * 8 pairs span EXACTLY ONE upload. The largest money gain among them is
//     $118,322 (mangetsu, after a 526-minute idle gap — the offline-lineage
//     reconcile shape itself). The next four are all mangetsu at $106,020,
//     $19,092, $12,672, $7,272.
//   * The two largest ≤3-upload gains, $1,176,004 (bezkerus) and $669,277
//     (mangetsu), are BOTH `user.cashfix_restore` admin writes — server
//     writes that never enter this route.
//   * 12ammurder's +$5,781,176 window, the largest unattributed gain in the
//     game after the cheat, is spread over 161 uploads ($35,908 each).
//
// So CAPACITY = $2,000,000 clears the largest measured legitimate
// single-upload gain by 17×, and REFILL = $3,000,000/h clears p99 of the
// unattributed sustained rate ($878,804/h) by 3.4× and the median ($101,492/h)
// by 30×. Simulated over all 1,269 money-rising consecutive pairs — a pair
// passes iff gain ≤ capacity + refill × duration, which is the maximum a
// bucket can absorb over that window however the uploads were spread — this
// refuses exactly ONE pair, and it is koruem2's. The other three pairs it
// touches are auction settlements, which write the row themselves.
//
// ── WHY IT IS IN MEMORY ──────────────────────────────────────────────────
// A durable bucket needs a column, and this task may not change the schema.
// The honest consequences, stated rather than buried:
//
//   * A process restart refills every bucket, so the worst case is CAPACITY
//     once per restart per account instead of once per lifetime.
//   * N replicas multiply the sustained rate by N, exactly like
//     lib/rateLimit.ts, whose header documents the same trade.
//
// Even at its weakest that is $2M + $3M/h against $1.8B/h, i.e. a ~600×
// reduction, and unlike the step cap it produces a log row the moment the
// budget is exceeded. A durable version is a column and a migration away and
// the shape of this module does not change when it lands.
//
// ── WHY CHARGING IS IDEMPOTENT ───────────────────────────────────────────
// This runs BEFORE the write, at the 2d guard site, and the write can still
// fail (the compare-and-swap in commitSave, a grant race, a 409). If a charge
// stuck for an upload that never landed, a retry of the SAME bytes would be
// charged twice and a legitimate client that lost one CAS could be refused for
// its own retry.
//
// So a bucket tracks a HIGH-WATER MARK against an ANCHOR, not a running sum.
// The anchor is the stored value the charge was computed against; `high` is the
// largest `after` already paid for at that anchor. A charge is
// `max(high, after) − high`, so:
//
//   * a retry of identical bytes charges 0;
//   * a retry that asks for MORE charges only the increment;
//   * once the write lands the stored value moves, the anchor no longer
//     matches, and the bucket re-anchors to the new stored value — which is
//     the amount already paid for, so nothing is charged twice.
//
// Falls (spending money) are free and never refund tokens: you spent it, and
// earning it back is a gain like any other.
//
// ── WHAT THIS STILL DOES NOT CLOSE, stated rather than implied ────────────
//  1. A drip UNDER the refill. $1,000 per upload at 30 uploads/minute is
//     $1,800,000/h, which is inside the $3,000,000/h a legitimate whale needs,
//     so no threshold here can refuse it without costing false-positive margin.
//     MONEY_DETECT_PER_HOUR is the answer: it cannot refuse anything, and it
//     logs. Executed: that ramp produces 0 refusals and a detection note on
//     every upload after the rolling hour crosses $1,500,000.
//  2. Cross-ACCOUNT movement. Auction settlement credits a seller up to
//     MAX_BID ($999,999,999) by writing the row itself, so minted money can be
//     moved to an account with a clean history that no per-save guard can ever
//     flag. That needs a cross-account flow check, not a rule here. Production
//     read-only at the time of writing: $47.87M of settled volume across 61
//     sales, largest single transfer $10,000,000, and koruem2 — the confirmed
//     cheat — had 10 bids placed, was the high bidder on nothing, and had won
//     and listed nothing, so none of its minted money had left before the
//     row was corrected.
//  3. N replicas and process restarts, above.

/** A cumulative allowance: `capacity` at rest, refilling at `refillPerHour`. */
export interface BudgetConfig {
  capacity: number;
  refillPerHour: number;
}

/** One dimension's bucket. Exported for tests and diagnostics only. */
export interface BudgetBucket {
  tokens: number;
  /** ms timestamp the tokens were last refilled to. */
  at: number;
  /** The `before` value this bucket's high-water mark is measured against. */
  anchor: number;
  /** The largest `after` already charged for at `anchor`. */
  high: number;
}

export interface ChargeResult {
  /** Did the budget cover the increment this upload asked for? */
  ok: boolean;
  /** The increment this upload asked for, above what was already paid. */
  requested: number;
  /** Tokens available BEFORE the charge — i.e. the largest increment that
   *  would have been allowed. This is the `allowance` a violation reports. */
  available: number;
  /** Tokens remaining after the charge (unchanged when `ok` is false). */
  remaining: number;
}

interface AccountBudgets {
  money: BudgetBucket;
  /** All RESTRICTED_ITEMS units summed. See saveGainGuard's list. */
  restricted: BudgetBucket;
  /** Rolling one-hour total of ACCEPTED money charges, for the sustained-rate
   *  detector below. Start of the current window, and its running total. */
  hourFrom: number;
  hourMoney: number;
  /** Last time a log row was emitted, per violation signature. */
  loggedAt: Map<string, number>;
  /** Last touch, for pruning. */
  seen: number;
}

/**
 * THE DETECTION THRESHOLD, well below the refusal threshold.
 *
 * The refill rate has to clear a legitimate whale with margin, so it is
 * $3,000,000/h — which means a patient drip that stays under it is ACCEPTED and
 * produces no violation. That is the honest residual of a token bucket, and the
 * answer to it is not a lower refill (that costs false-positive margin) but a
 * second, lower line that only ever writes a row.
 *
 * $1,500,000/h is 1.7× p99 of the unattributed sustained rate ($878,804/h) and
 * 2.5× the highest sustained rate any real account reached over a multi-hour
 * window (12ammurder, $588,000/h). So the expected legitimate row count is zero,
 * and any drip fast enough to matter is visible long before the budget runs dry.
 */
export const MONEY_DETECT_PER_HOUR = 1_500_000;
const HOUR_MS = 3_600_000;

/**
 * Per-account state, keyed by User.id.
 *
 * Bounded two ways so a registration flood cannot grow it without limit:
 * entries untouched for STALE_MS are dropped on the next sweep, and the sweep
 * runs whenever the map exceeds SWEEP_AT. An evicted account starts full
 * again, which is the same tolerance the restart case already has.
 */
const budgets = new Map<string, AccountBudgets>();
const STALE_MS = 12 * 3_600_000;
const SWEEP_AT = 20_000;

function sweep(nowMs: number): void {
  if (budgets.size <= SWEEP_AT) return;
  for (const [k, v] of budgets) {
    if (nowMs - v.seen > STALE_MS) budgets.delete(k);
  }
  // Still oversized (every account active inside the window): drop the
  // least-recently-seen half rather than growing without bound.
  if (budgets.size > SWEEP_AT) {
    const byAge = [...budgets].sort((a, b) => a[1].seen - b[1].seen);
    for (let i = 0; i < Math.floor(byAge.length / 2); i++) budgets.delete(byAge[i][0]);
  }
}

function newBucket(cfg: BudgetConfig, nowMs: number): BudgetBucket {
  // Starts FULL. A first sighting cannot be distinguished from a restart, and
  // starting empty would refuse an account's first upload after every deploy.
  return { tokens: cfg.capacity, at: nowMs, anchor: Number.NaN, high: Number.NaN };
}

function accountOf(key: string, money: BudgetConfig, restricted: BudgetConfig, nowMs: number): AccountBudgets {
  let a = budgets.get(key);
  if (!a) {
    sweep(nowMs);
    a = {
      money: newBucket(money, nowMs),
      restricted: newBucket(restricted, nowMs),
      hourFrom: nowMs,
      hourMoney: 0,
      loggedAt: new Map(),
      seen: nowMs,
    };
    budgets.set(key, a);
  }
  a.seen = nowMs;
  return a;
}

/**
 * Refill, then charge the rise from `before` to `after`.
 *
 * Every hostile input collapses to a finite number: a non-finite `nowMs` or a
 * clock that went backwards yields no refill rather than an infinite one, and
 * a non-finite before/after is read as 0 — the same rule balance() uses in
 * saveGainGuard. There is no division and no throw anywhere in here, because a
 * throw at this call site would 500 a save.
 */
function charge(
  b: BudgetBucket,
  cfg: BudgetConfig,
  before: number,
  after: number,
  nowMs: number,
): ChargeResult {
  const now = Number.isFinite(nowMs) ? nowMs : b.at;
  const elapsed = now > b.at ? now - b.at : 0;
  b.tokens = Math.min(cfg.capacity, b.tokens + (cfg.refillPerHour * elapsed) / 3_600_000);
  b.at = now > b.at ? now : b.at;

  const from = Number.isFinite(before) && before > 0 ? before : 0;
  const to = Number.isFinite(after) && after > 0 ? after : 0;

  // Re-anchor whenever the stored value this bucket was tracking has moved —
  // the write landed, or a server-side credit changed the row. Whatever is in
  // the row is, by definition, already paid for.
  if (b.anchor !== from) {
    b.anchor = from;
    b.high = from;
  }

  const target = to > b.high ? to : b.high;
  const requested = target - b.high;
  const available = b.tokens;
  if (requested <= 0) return { ok: true, requested: 0, available, remaining: b.tokens };
  if (requested > available) return { ok: false, requested, available, remaining: b.tokens };
  b.tokens -= requested;
  b.high = target;
  return { ok: true, requested, available, remaining: b.tokens };
}

export interface CumulativeCharge {
  money: ChargeResult;
  restricted: ChargeResult;
  /** Accepted money charged inside the current rolling hour, and whether that
   *  total has crossed MONEY_DETECT_PER_HOUR. Detection only. */
  moneyPerHour: number;
  sustained: boolean;
}

/**
 * Charge both cumulative budgets for one upload.
 *
 * `accountKey` is User.id. Values are the STORED blob's and the CLIENT'S
 * BYTES' — the same two sides saveGainGuard compares, at the same point in the
 * route, so server-issued payments are invisible to this for exactly the same
 * structural reason (see the placement note in routes/saves.ts step 2d).
 */
export function chargeCumulativeGain(
  accountKey: string,
  dims: {
    moneyBefore: number; moneyAfter: number;
    restrictedBefore: number; restrictedAfter: number;
  },
  cfg: { money: BudgetConfig; restricted: BudgetConfig },
  nowMs: number,
): CumulativeCharge {
  const a = accountOf(accountKey, cfg.money, cfg.restricted, nowMs);
  const money = charge(a.money, cfg.money, dims.moneyBefore, dims.moneyAfter, nowMs);
  const restricted = charge(a.restricted, cfg.restricted, dims.restrictedBefore, dims.restrictedAfter, nowMs);

  // Rolling hour, reset rather than slid: a sliding window needs the whole
  // history and this only has to answer "did this account take more than
  // MONEY_DETECT_PER_HOUR in an hour", where being a fraction of a window late
  // costs nothing because the row is advisory.
  const now = Number.isFinite(nowMs) ? nowMs : a.hourFrom;
  if (now - a.hourFrom >= HOUR_MS || now < a.hourFrom) {
    a.hourFrom = now;
    a.hourMoney = 0;
  }
  if (money.ok) a.hourMoney += money.requested;

  return { money, restricted, moneyPerHour: a.hourMoney, sustained: a.hourMoney > MONEY_DETECT_PER_HOUR };
}

/**
 * Should this violation shape be logged for this account right now?
 *
 * A refused upload is refused every time — this throttles the LOG, not the
 * decision. It has to: koruem2 made 430 uploads in 30 minutes, and once a
 * cumulative budget is exhausted every one of them violates, which would bury
 * ErrorLog under 430 identical rows per half-hour and drown the alerting
 * fingerprint in lib/alerting.ts. Keyed on the violation SIGNATURE so a NEW
 * shape from the same account is never suppressed, and the first row of any
 * shape is always written.
 */
export const GAIN_LOG_COOLDOWN_MS = 5 * 60_000;

export function shouldLogGain(accountKey: string, signature: string, nowMs: number): boolean {
  const a = budgets.get(accountKey);
  if (!a) return true;
  const last = a.loggedAt.get(signature);
  if (last !== undefined && nowMs - last < GAIN_LOG_COOLDOWN_MS) return false;
  // Bounded: an account cannot accumulate signatures without limit.
  if (a.loggedAt.size > 32) a.loggedAt.clear();
  a.loggedAt.set(signature, nowMs);
  return true;
}

/** Test seam. Never called by production code. */
export function resetGainBudgets(): void {
  budgets.clear();
}

/** Test/diagnostic seam. Returns a copy; mutating it changes nothing. */
export function peekGainBudget(accountKey: string): {
  money: BudgetBucket; restricted: BudgetBucket; hourMoney: number;
} | null {
  const a = budgets.get(accountKey);
  return a ? { money: { ...a.money }, restricted: { ...a.restricted }, hourMoney: a.hourMoney } : null;
}

/** Test/diagnostic seam: how many accounts are being tracked. */
export function gainBudgetSize(): number {
  return budgets.size;
}
