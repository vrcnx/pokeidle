import { prisma } from "../db.js";
import { Prisma } from "@prisma/client";
import { parsePrizesStrict, describePrizes, type Prize } from "./giveaway.js";
import { enqueuePrizeGrant } from "./prizeGrant.js";
import { recordError } from "./errorReporting.js";

// The referral programme.
//
// Share a link, and every account that signs up through it pays the referrer
// a Master Ball — up to ten, with $1,000,000 and a random shiny at the tenth.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────
// It pays on SIGNUP, with no eligibility gate. That is a decision, not an
// oversight, and it is worth writing down because the shape of the abuse is
// obvious: `requireEmailVerification` is false (auth.ts), so an account costs
// a string that looks like an email and nothing else. Ten of those is ten
// Master Balls, a million dollars and a shiny, for about a minute of
// scripting, and Master Balls are tradeable on the auction house.
//
// The compensating control is detection rather than prevention — see the
// query at the bottom of this file, and `enabled` in ReferralConfig, which is
// the stop button. If farming does turn up, the fix is an eligibility gate:
// hold the grant until the referred account reaches an accountLevel, the way
// giveaways already gate on minAccountLevel. The data model does not need to
// change for that; `Referral` already records the row at signup, so a gate is
// a condition on the PAYOUT, not a migration.

/** Audit label on the per-referral grant. */
export const REFERRAL_SOURCE = "referral";
/** Audit label on the one-off milestone grant. */
export const REFERRAL_MILESTONE_SOURCE = "referral-milestone";

/**
 * The code alphabet: no 0/O, no 1/I/L.
 *
 * A referral code's whole job is to survive being read off a screenshot, a
 * stream overlay or somebody's voice. Those six characters are where that
 * fails, and they are cheap to give up — the remaining 30 still give 30^8,
 * about 6.5e11 codes, which is not a space anyone walks into by accident.
 */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 8;

function randomCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

/**
 * Normalise a code the way both ends must agree on.
 *
 * Upper-cased and stripped of everything outside the alphabet, so a link
 * retyped by hand — with a stray space, a lowercase run, or the surrounding
 * punctuation of the sentence it was pasted into — still resolves to the same
 * row. Cheap to do; the alternative is a player insisting their code is right
 * while the server disagrees over a space.
 */
export function normaliseCode(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, CODE_LENGTH);
}

/**
 * This account's code, minting one if it has none.
 *
 * Lazy, so the table holds codes people actually asked for rather than one
 * per account forever. The collision retry is bounded: at 6.5e11 codes a
 * second attempt is already a lottery win, and looping forever on a
 * misconfigured database is worse than failing.
 */
export async function getOrCreateReferralCode(userId: string): Promise<string> {
  const existing = await prisma.referralCode.findUnique({
    where: { userId },
    select: { code: true },
  });
  if (existing) return existing.code;

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const row = await prisma.referralCode.create({
        data: { userId, code: randomCode() },
        select: { code: true },
      });
      return row.code;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        // Either the code collided or this account raced itself (two tabs
        // opening the Rewards page together). Re-read: if the account now has
        // one, that race is settled and the answer is the winner's row.
        const now = await prisma.referralCode.findUnique({
          where: { userId },
          select: { code: true },
        });
        if (now) return now.code;
        continue; // a genuine code collision — draw again
      }
      throw e;
    }
  }
  throw new Error("could not mint a referral code");
}

/** Whose code is this? `null` for an unknown or malformed one. */
export async function resolveReferralCode(raw: string): Promise<string | null> {
  const code = normaliseCode(raw);
  if (code.length !== CODE_LENGTH) return null;
  const row = await prisma.referralCode.findUnique({
    where: { code },
    select: { userId: true },
  });
  return row?.userId ?? null;
}

export interface ReferralConfigResolved {
  enabled: boolean;
  perReferral: Prize[];
  milestone: Prize[];
  shinyPool: Prize[];
  cap: number;
}

/** One Master Ball per friend — the programme as asked for, before any
 *  operator edits it. */
const DEFAULT_PER_REFERRAL: Prize[] = [{ kind: "item", itemId: "masterball", quantity: 1 }];
/** The money half of the tenth-friend bonus. The shiny half comes from the
 *  pool, because the server cannot build a Pokémon. */
const DEFAULT_MILESTONE: Prize[] = [{ kind: "money", amount: 1_000_000 }];

/**
 * The programme's configuration, with the defaults folded in.
 *
 * ── A MISSING ROW MEANS RUNNING, NOT PAUSED ────────────────────────
 * Nothing is seeded, so "never configured" is the state every deployment
 * starts in — and it now resolves to ON with the documented default prizes.
 *
 * It resolved to OFF first, which meant the feature was built, deployed,
 * correct, and invisible: the card hides itself when the programme is off, so
 * there was no way to tell "paused" from "broken" without reading the source.
 * A default an operator has to undo before the thing works is the wrong
 * default. `enabled: false` still does exactly what it says — it is just no
 * longer where everyone starts.
 */
export async function getReferralConfig(): Promise<ReferralConfigResolved> {
  const row = await prisma.referralConfig.findUnique({ where: { id: "singleton" } });
  const parse = (json: string | null | undefined, fallback: Prize[]): Prize[] => {
    if (!json) return fallback;
    // A stored list that no longer parses is a configuration error, not a
    // reason to pay nothing silently — fall back to the documented default
    // and let the admin panel show what is actually stored.
    const parsed = parsePrizesStrict(json);
    if (!parsed.ok) return fallback;
    return parsed.prizes.length > 0 ? parsed.prizes : fallback;
  };
  return {
    enabled: row?.enabled ?? true,
    perReferral: parse(row?.perReferral, DEFAULT_PER_REFERRAL),
    milestone: parse(row?.milestone, DEFAULT_MILESTONE),
    shinyPool: parse(row?.shinyPool, []),
    cap: row?.perReferralCap ?? 10,
  };
}

export type AttributeResult =
  | { ok: true; ordinal: number; paid: boolean; milestone: boolean }
  | { ok: false; reason: "unknown_code" | "self_referral" | "already_referred" | "failed" };

/**
 * Record that `referredUserId` arrived through `code`, and pay for it.
 *
 * ── THE ROW IS WRITTEN EVEN WHEN THE PROGRAMME IS OFF ───────────────
 * Where an account came from is a fact about that account, and it is only
 * knowable at this moment; the payout is a promotion that happens to be
 * running. Recording regardless means turning the programme on later does not
 * lose the history, and the analytics stay honest either way.
 *
 * It also means turning it on does NOT back-pay the referrals collected while
 * it was off. That is the deliberate half: retroactive payment across an
 * unknown window is how an operator discovers they owe ten thousand Master
 * Balls.
 */
export async function attributeSignup(
  referredUserId: string,
  rawCode: string,
): Promise<AttributeResult> {
  try {
    const referrerUserId = await resolveReferralCode(rawCode);
    if (!referrerUserId) return { ok: false, reason: "unknown_code" };
    // Your own link pays you nothing. Cheap to check and the first thing
    // anybody tries.
    if (referrerUserId === referredUserId) return { ok: false, reason: "self_referral" };

    const cfg = await getReferralConfig();

    // ── The ordinal, and why this loops ──────────────────────────────
    // `MAX(ordinal) + 1` read and then written is a time-of-check/
    // time-of-use bug: two signups landing together both read 9, both write
    // 10, and the milestone pays twice. The unique index on
    // (referrerUserId, ordinal) makes the second writer lose, and this loop
    // is what turns that loss into a correct retry rather than a 500.
    // ── Why the bound is this high ───────────────────────────────────
    // Each pass guarantees at least ONE writer wins its ordinal, so N writers
    // racing need up to N passes to all get through. A small bound therefore
    // does not just slow a burst down, it DROPS the tail of it: at 6 attempts
    // a batch of twelve simultaneous signups credits six friends and silently
    // loses the other six.
    //
    // 25 covers any burst a human-paced signup flow can produce. Past that it
    // gives up rather than looping, and a referrer taking 25 signups inside
    // one contention window is the farm this programme is watching for
    // anyway — better dropped than spun on.
    for (let attempt = 0; attempt < 25; attempt++) {
      const last = await prisma.referral.findFirst({
        where: { referrerUserId },
        orderBy: { ordinal: "desc" },
        select: { ordinal: true },
      });
      const ordinal = (last?.ordinal ?? 0) + 1;

      try {
        await prisma.referral.create({
          data: { referredUserId, referrerUserId, ordinal },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          const target = (e.meta?.target as string[] | undefined)?.join(",") ?? "";
          // The REFERRED account already has a referrer. Primary key, so this
          // is the database refusing a second attribution for one account —
          // exactly what it is there for. Not retryable.
          if (target.includes("referredUserId") || target.includes("pkey")) {
            return { ok: false, reason: "already_referred" };
          }
          continue; // somebody else took this ordinal; recount and retry
        }
        throw e;
      }

      // ── Paying for it ────────────────────────────────────────────
      // Past the cap the referral is still recorded — the friend is real and
      // the count should say so — it simply stops paying.
      if (!cfg.enabled || ordinal > cfg.cap) {
        return { ok: true, ordinal, paid: false, milestone: false };
      }

      // sourceId is the REFERRED account, which is unique per referral, so
      // the (source, sourceId) index is the receipt: a retry of this whole
      // function cannot pay for the same friend twice.
      await enqueuePrizeGrant(referrerUserId, cfg.perReferral, {
        source: REFERRAL_SOURCE,
        sourceId: referredUserId,
      });

      let milestone = false;
      if (ordinal === cfg.cap) {
        milestone = await payMilestone(referrerUserId, cfg);
      }
      return { ok: true, ordinal, paid: true, milestone };
    }

    return { ok: false, reason: "failed" };
  } catch (e) {
    // Never fatal to the signup. Somebody creating an account must not be
    // turned away because a promotion failed to pay somebody else.
    void recordError({
      kind: "server",
      message: "referral_attribution_failed",
      source: "attributeSignup",
      userId: referredUserId,
      meta: { error: String((e as Error)?.message ?? e) },
    });
    return { ok: false, reason: "failed" };
  }
}

/**
 * The tenth-friend bonus: the money, plus one shiny drawn from the pool.
 *
 * ── WHY THE SHINY IS DRAWN AND NOT BUILT ────────────────────────────
 * The server has no species table and no stat formula (see lib/giveaway.ts),
 * so a Pokémon it invented would have invented stats — the bug that once
 * handed out a Lv50 Charizard with 24 HP. The admin builds real mons with the
 * real formula in the existing PrizeBuilder and they sit in `shinyPool`; this
 * only picks an index.
 *
 * An empty pool pays the money half and records the misconfiguration. The
 * alternatives are worse: paying nothing loses a milestone the player
 * genuinely earned and cannot earn again, and inventing a mon is the bug
 * above.
 */
async function payMilestone(
  referrerUserId: string,
  cfg: ReferralConfigResolved,
): Promise<boolean> {
  const prizes: Prize[] = [...cfg.milestone];

  if (cfg.shinyPool.length > 0) {
    prizes.push(cfg.shinyPool[Math.floor(Math.random() * cfg.shinyPool.length)]);
  } else {
    void recordError({
      kind: "server",
      message: "referral_shiny_pool_empty",
      source: "payMilestone",
      userId: referrerUserId,
      meta: { note: "milestone paid its money half only; configure the pool in admin → Referrals" },
    });
  }

  // sourceId is the REFERRER: the milestone is once per account for the life
  // of the programme, so this is the receipt that survives even if referrals
  // are later deleted and re-earned.
  const already = await prisma.pendingGrant.count({
    where: { source: REFERRAL_MILESTONE_SOURCE, sourceId: referrerUserId },
  });
  if (already > 0) return false;

  await enqueuePrizeGrant(referrerUserId, prizes, {
    source: REFERRAL_MILESTONE_SOURCE,
    sourceId: referrerUserId,
  });
  return true;
}

export interface ReferralSummary {
  code: string;
  /** Referrals recorded, whether or not they paid. */
  total: number;
  /** How many of those were paid for. */
  paid: number;
  cap: number;
  enabled: boolean;
  milestoneReached: boolean;
  /**
   * The actual prize descriptors, not a sentence about them.
   *
   * The card first shipped with only `describePrizes` strings and rendered
   * "1x masterball" as text, beside a Discord card showing a Master Ball
   * chip with its sprite. Same page, same kind of information, two different
   * treatments, and the worse one was ours. Sending the Prize[] lets the card
   * use the same PrizeChips component everything else does — which also
   * resolves the item NAME, so no player has to read a catalog id.
   */
  perReferral: Prize[];
  milestone: Prize[];
  /** Whether the milestone will also draw a shiny. The pool holds many mons
   *  and the draw has not happened, so the card can promise the fact of one
   *  without naming a species it might not hand over. */
  milestoneHasShiny: boolean;
  /** Kept for anything that wants one line rather than chips. */
  perReferralSummary: string;
  milestoneSummary: string;
}

/** Everything the Rewards card needs, in one round trip. */
export async function getReferralSummary(userId: string): Promise<ReferralSummary> {
  const [code, cfg, total, paid, milestone] = await Promise.all([
    getOrCreateReferralCode(userId),
    getReferralConfig(),
    prisma.referral.count({ where: { referrerUserId: userId } }),
    prisma.pendingGrant.count({ where: { userId, source: REFERRAL_SOURCE } }),
    prisma.pendingGrant.count({
      where: { source: REFERRAL_MILESTONE_SOURCE, sourceId: userId },
    }),
  ]);

  return {
    code,
    total,
    paid,
    cap: cfg.cap,
    enabled: cfg.enabled,
    milestoneReached: milestone > 0,
    perReferral: cfg.perReferral,
    milestone: cfg.milestone,
    milestoneHasShiny: cfg.shinyPool.length > 0,
    perReferralSummary: describePrizes(cfg.perReferral),
    // Describes the money half plus the fact of a shiny. The pool holds many
    // mons and the draw has not happened, so naming one would be a lie.
    milestoneSummary:
      describePrizes(cfg.milestone) + (cfg.shinyPool.length > 0 ? " + a random shiny" : ""),
  };
}

// ── IS IT BEING FARMED? ─────────────────────────────────────────────
// Pay-on-signup was chosen with the risk understood, so detection is the
// control. Referrals per referrer per day — a real player's line is flat and
// low, a farm's is a spike:
//
//   SELECT date_trunc('day', "createdAt") AS day, "referrerUserId", count(*)
//   FROM "Referral" GROUP BY 1, 2 HAVING count(*) > 3 ORDER BY 1 DESC, 3 DESC;
//
// And what it has cost so far:
//
//   SELECT source, count(*), min("createdAt"), max("createdAt")
//   FROM "PendingGrant" WHERE source LIKE 'referral%' GROUP BY 1;
//
// The stop button is ReferralConfig.enabled — admin → Referrals. Turning it
// off stops payment immediately and keeps recording where accounts came from.
