import { Hono } from "hono";
import { prisma } from "../db.js";
import { requireUser } from "../lib/middleware.js";
import { makeRateLimiter } from "../lib/rateLimit.js";
import { enqueuePrizeGrant } from "../lib/prizeGrant.js";
import { recordError } from "../lib/errorReporting.js";
import {
  AWAY_CAP_MS,
  AWAY_MIN_MS,
  awayPeriodStart,
  computeAwayProgress,
  type AwayComputation,
} from "../lib/awayProgress.js";

// Away-time catch-up progress. See lib/awayProgress.ts for the policy and, more
// importantly, for why this is safe: the clock is entirely ours, and the reward
// is paid through the existing PendingGrant inbox rather than by writing a
// save. Nothing in this file touches saveData, saveVersion or saveAdoptSeq.
const app = new Hono();
app.use("*", requireUser);

// The claim is idempotent by construction (the conditional UPDATE below), so
// this limiter is not a correctness guard — it is there so a client bug cannot
// turn "nothing to claim" into a hot loop against the database.
const claimLimiter = makeRateLimiter({ tokens: 12, windowMs: 60_000 });

/** Badge count, read straight off the stored save. */
function badgeCount(saveData: string | null): number {
  if (!saveData) return 0;
  try {
    const parsed = JSON.parse(saveData) as { defeatedGyms?: unknown };
    return Array.isArray(parsed.defeatedGyms) ? parsed.defeatedGyms.length : 0;
  } catch {
    // An unparseable cloud save is already a recovery case elsewhere (POST
    // /api/saves treats it as "no prior"). Paying the base rate is the
    // conservative reading: it under-rewards rather than over-rewards, and it
    // cannot fail the claim.
    return 0;
  }
}

/** Shared response shape, so /status and /claim agree about what "away" means. */
function describe(c: AwayComputation, from: Date | null) {
  return {
    // Client-facing knobs, echoed so the UI can explain the rules rather than
    // hardcode a second copy of them that drifts.
    minMs: AWAY_MIN_MS,
    capMs: AWAY_CAP_MS,
    awaySince: from ? from.toISOString() : null,
    elapsedMs: c.elapsedMs,
    creditedMs: c.creditedMs,
    capped: c.capped,
    moneyPerHour: c.moneyPerHour,
    money: c.money,
    claimable: c.money > 0,
  };
}

async function readAccount(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { saveUpdatedAt: true, awayClaimedAt: true, saveData: true, saveVersion: true },
  });
}

// GET /api/away/status — what is waiting, without collecting it. Pure read, so
// the client can render the "while you were away" panel before the player
// decides, and so a failed claim can be retried against fresh numbers.
app.get("/status", async (c) => {
  const user = c.get("user");
  const row = await readAccount(user.id);
  if (!row) return c.json({ error: "user not found" }, 404);

  // An account that has never uploaded a save has no anchor to measure from.
  // Reporting zero is the honest answer; the first upload starts the clock.
  const from = awayPeriodStart(row.saveUpdatedAt, row.awayClaimedAt);
  if (!from || row.saveVersion === 0) {
    return c.json(describe(computeAwayProgress(0, 0), from));
  }
  const computed = computeAwayProgress(Date.now() - from.getTime(), badgeCount(row.saveData));
  return c.json(describe(computed, from));
});

// POST /api/away/claim — collect it.
//
// ── THE GATE ─────────────────────────────────────────────────────────
// `awayClaimedAt` is advanced by a conditional UPDATE that matches only if the
// column still holds the value THIS request measured from. Two concurrent
// claims therefore cannot both be paid: the first moves the column, the
// second's WHERE no longer matches and it is refused. Same shape as
// POST /api/dailies/claim, and the same reason — the alternative is
// check-then-act, where both requests read "8 hours away" and both pay.
//
// The stamp and the grant row share one transaction, so it is impossible to
// consume the away period without owing the reward, or to owe a reward for an
// away period that was not consumed.
//
// Note what this endpoint does NOT do: it does not read, write or version the
// save. Payment is one PendingGrant row, folded into the player's next upload
// by POST /api/saves under its own `deliveredAt IS NULL` compare-and-swap. The
// save-CAS discipline is untouched — this feature cannot lose a save or
// double-pay, because it is not what pays.
app.post("/claim", async (c) => {
  const user = c.get("user");
  if (!claimLimiter.consume(user.id)) {
    return c.json({ error: "rate_limited", retryAfter: 60 }, 429);
  }

  const row = await readAccount(user.id);
  if (!row) return c.json({ error: "user not found" }, 404);

  const from = awayPeriodStart(row.saveUpdatedAt, row.awayClaimedAt);
  if (!from || row.saveVersion === 0) {
    return c.json({ ok: true, claimed: false, ...describe(computeAwayProgress(0, 0), from) });
  }

  const now = new Date();
  const computed = computeAwayProgress(now.getTime() - from.getTime(), badgeCount(row.saveData));
  if (computed.money <= 0) {
    // Below the minimum, or nothing accrued. Not an error — the client asks on
    // every boot and "you were only gone two minutes" is the normal answer.
    return c.json({ ok: true, claimed: false, ...describe(computed, from) });
  }

  let granted: { id: string } | null = null;
  try {
    granted = await prisma.$transaction(async (tx) => {
      // Advance the anchor FIRST, conditionally. `awayClaimedAt` must equal
      // what we measured from — including the NULL case, which is a distinct
      // predicate rather than an equality against null.
      const gate = await tx.user.updateMany({
        where: {
          id: user.id,
          ...(row.awayClaimedAt === null
            ? { awayClaimedAt: null }
            : { awayClaimedAt: row.awayClaimedAt }),
        },
        data: { awayClaimedAt: now },
      });
      // Lost the race to a concurrent claim from another tab or device. Nothing
      // has been written; returning null rolls this transaction back without
      // owing anything.
      if (gate.count !== 1) return null;

      // Enlisted in this transaction, so the stamp above and this row are one
      // atomic fact. From here the reward is durable and the inbox owns
      // delivery — exactly-once, on top of whatever the client uploads next.
      return enqueuePrizeGrant(
        user.id,
        [{ kind: "money", amount: computed.money }],
        { source: "away-progress" },
        tx,
      );
    });
  } catch (e) {
    // A failed claim must leave the away period UNCONSUMED so the next attempt
    // can pay it. The transaction guarantees that; this only reports it.
    void recordError({
      kind: "server",
      message: "away_claim_failed",
      source: "POST /api/away/claim",
      userId: user.id,
      meta: { elapsedMs: computed.elapsedMs, money: computed.money, error: String(e) },
    });
    return c.json({ error: "claim_failed", reason: "could not collect away progress — try again" }, 500);
  }

  if (!granted) {
    // Concurrent claim won. Report the fresh (now near-zero) state rather than
    // the amount we computed but did not pay, so the UI cannot show a number
    // the player will never receive.
    const fresh = await readAccount(user.id);
    const freshFrom = fresh ? awayPeriodStart(fresh.saveUpdatedAt, fresh.awayClaimedAt) : null;
    const freshComputed = computeAwayProgress(
      freshFrom ? Date.now() - freshFrom.getTime() : 0,
      badgeCount(fresh?.saveData ?? null),
    );
    return c.json({ ok: true, claimed: false, ...describe(freshComputed, freshFrom) });
  }

  return c.json({
    ok: true,
    claimed: true,
    grantId: granted.id,
    // The money is OWED, not yet in the save: it lands when the client's next
    // upload is folded. The client shows the summary now and sees the actual
    // credit arrive as `grantsApplied` on that upload, which is the same
    // two-step every giveaway prize already goes through.
    ...describe(computed, from),
  });
});

export default app;
