import { Hono } from "hono";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { requireUser } from "../lib/middleware.js";
import { computeAccountLevel } from "../lib/level.js";
import { validateSave, sanitizeSave, MAX_BOX } from "../lib/saveValidation.js";
import { maybeSnapshot } from "../lib/saveHistory.js";
import { makeRateLimiter } from "../lib/rateLimit.js";
import {
  readOwedGrants, foldOwedGrants, noteDeferredGrants, countOwedGrants,
  type OwedGrant,
} from "../lib/prizeGrant.js";
import { emitSaveAdopt } from "../lib/saveAdopt.js";
import { describePrizes } from "../lib/giveaway.js";
import { recordError } from "../lib/errorReporting.js";
import { milestoneSig, milestoneRegressed, destructiveLosses } from "../lib/saveRegression.js";

const app = new Hono();

// Thrown inside the save transaction when the pending-grant compare-and-swap
// loses to a concurrent uploader. A plain early return would COMMIT the save
// write while leaving the grants unsettled.
//
// This is the load-bearing arbiter of exactly-once delivery, together with the
// `deliveredAt IS NULL` predicate it guards: whichever request updates fewer
// rows than it asked for throws, and its save write — prize included — rolls
// back with it. Nothing outside the database participates in that decision.
class GrantRace extends Error {}

// Save uploads — generous but capped. The client autosaves periodically
// (every ~10 s); 30 writes/minute is well above that and protects the
// DB from a runaway loop or malicious flood.
const saveLimiter = makeRateLimiter({ tokens: 30, windowMs: 60_000 });

// GET /api/saves — return the caller's last cloud save.
app.get("/", requireUser, async (c) => {
  const user = c.get("user");
  const [u, owed] = await Promise.all([
    prisma.user.findUnique({
      where: { id: user.id },
      select: { saveData: true, saveVersion: true, saveUpdatedAt: true, saveAdoptSeq: true },
    }),
    countOwedGrants(user.id),
  ]);
  if (!u) return c.json({ error: "user not found" }, 404);
  return c.json({
    saveData: u.saveData ? JSON.parse(u.saveData) : null,
    saveVersion: u.saveVersion,
    saveUpdatedAt: u.saveUpdatedAt,
    // Bumped by the server on an authoritative rewrite: admin edit / restore /
    // item-set, auction escrow and settlement, and the prize fold in POST
    // below. A client that last adopted a lower value adopts the cloud save
    // WHOLESALE (see game reconcile), so the server's write sticks instead of
    // being undone by a session that never saw it.
    saveAdoptSeq: u.saveAdoptSeq,
    // How many prizes this account is still owed (PendingGrant). Read-only and
    // purely informational: this endpoint does NOT deliver them.
    //
    // Delivering on READ was the obvious design and is the wrong one. A read
    // has no way to know the reader absorbed it — the client can learn a new
    // saveVersion without ever looking at the data (that is literally how the
    // prize got lost in the first place) — so a read-side delivery could be
    // clobbered by the reader's very next upload with the grant already marked
    // delivered. Delivery therefore happens ONLY on POST, where the response
    // tells the client exactly which prizes were folded in and the client
    // applies precisely those. Until then the grant stays owed and nothing can
    // destroy it.
    pendingGrants: owed,
  });
});

// POST /api/saves — upload a snapshot. Bumps saveVersion; recomputes
// derived account-level fields from the save payload. Optional
// `expectedSaveVersion` lets the client opt in to compare-and-swap
// semantics: server rejects if the cloud copy has advanced past what
// the client thought it knew (= someone else wrote in between, or the
// client is rolling back).
//
// `grantAck` is a CLIENT CAPABILITY FLAG, and it is what makes this change
// safe to roll out. A client that sends it promises two things:
//
//   1. "I apply `grantsApplied` to my in-memory state" — so its next autosave
//      carries the prize instead of overwriting it 2.5s later.
//   2. "I honour `saveAdoptSeq`" — so when the fold bumps it, every session of
//      that account adopts the cloud copy WHOLESALE instead of racing it.
//
// Promise 2 is the one that actually protects the prize; promise 1 only keeps
// the winner's own tab from taking a needless round trip through the adopt.
//
// A client that predates this deploy (a tab that has been open for hours)
// sends no flag, so nothing is folded and nothing is settled — its prizes
// simply stay owed until it reloads and gets the new bundle. That matters
// because delivery is now strictly once: an old client that cannot absorb the
// echo would overwrite the prize with its own blob, and there is no
// re-delivery to save it. Its grants must therefore never leave the inbox.
//
// It is a NUMBER rather than a boolean so the promise can grow again without
// silently delivering to a client that only made the smaller one. `2` is
// accepted as a superset for the sake of any dev build left over from the
// (removed, never-shipped) receipt design.
const UploadBody = z.object({
  saveData: z.record(z.string(), z.unknown()),
  expectedSaveVersion: z.number().int().min(0).optional(),
  grantAck: z.union([z.literal(1), z.literal(2)]).optional(),
});

/** The `grantAck` value that promises echo-application + saveAdoptSeq
 *  handling. Anything below it is parsed but never delivered to. */
const GRANT_ACK_ADOPT = 1;

/**
 * THE COMPATIBILITY WINDOW for `expectedSaveVersion`.
 *
 * A POST that omits the field is a BLIND WRITE: the sender has not proven it
 * read the bytes it is replacing. The shipping client never makes one (both
 * upload paths bail while their base version is < 0), so the only legitimate
 * source is a tab loaded from the PREVIOUS bundle that is still inside its
 * pre-boot-reconcile window — the two places the old client passed
 * `undefined`. Those go away on their own, one session at a time.
 *
 * Until they do, a blind write is heavily constrained rather than rejected
 * (step 2c below) so an old tab keeps saving its real progress. Once telemetry
 * shows the versionless rate at zero, set `SAVES_REQUIRE_VERSION=1` and the
 * branch becomes a 400 with no code change and no deploy-order risk; unset it
 * to roll straight back. Read per request so the flip does not need a restart
 * beyond the env change itself.
 */
function blindWritesAllowed(): boolean {
  return process.env.SAVES_REQUIRE_VERSION !== "1";
}

// Hard upper bound on serialized save size. Guards the JSON parser against
// an OOM attempt. We check the Content-Length header where available, then
// again on the parsed body.
//
// Must stay consistent with saveValidation's MAX_BOX: a save the validator
// accepts must be one this transport can carry. These were picked
// independently and disagreed — MAX_BOX allowed 9999 mons while this capped
// the body at 1MB, so a save could be simultaneously valid and unsendable,
// 413ing forever with no client recovery. A save is ~600 bytes/mon, so 9999
// mons is ~6MB: the two constants contradicted each other by ~6x.
//
// Nobody has hit this yet — the largest of 1679 real boxes is 212 mons
// (~130KB), so there is ~8x headroom. Sizing the transport to the declared
// limit is the cheap half of the fix. The real fix is architectural: the
// whole collection ships in every save, so payload grows without bound and
// ANY constant here is a future outage. Delta saves are the answer; this
// buys the room to build them.
const MAX_SAVE_BYTES = 8_000_000;

// Measured against the real createPokemon shape, including the statStages
// the reducer spreads in wholesale: ~635 bytes per boxed mon.
const BYTES_PER_MON = 635;

// Fail at boot, not at 3am in a player's save. The two constants have no
// compile-time link, so this is the link: if someone raises MAX_BOX or
// lowers this cap such that a validator-approved save can no longer be
// SENT, the server refuses to start rather than silently 413ing veterans
// forever. That is exactly the failure mode this pair already shipped.
if (MAX_SAVE_BYTES < MAX_BOX * BYTES_PER_MON) {
  throw new Error(
    `Save limits contradict: MAX_BOX=${MAX_BOX} needs ~${MAX_BOX * BYTES_PER_MON} bytes `
    + `but MAX_SAVE_BYTES=${MAX_SAVE_BYTES}. A save could be valid yet unsendable.`
  );
}

app.post("/", requireUser, async (c) => {
  const user = c.get("user");
  if (!saveLimiter.consume(user.id)) {
    return c.json({ error: "rate_limited", retryAfter: 60 }, 429);
  }
  const lenHeader = c.req.header("content-length");
  if (lenHeader && parseInt(lenHeader, 10) > MAX_SAVE_BYTES) {
    return c.json({ error: "save too large" }, 413);
  }
  const raw = await c.req.text();
  if (raw.length > MAX_SAVE_BYTES) {
    return c.json({ error: "save too large" }, 413);
  }
  let parsedJson: unknown;
  try { parsedJson = JSON.parse(raw); } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  const parsed = UploadBody.safeParse(parsedJson);
  if (!parsed.success) return c.json({ error: "invalid body", details: parsed.error.flatten() }, 400);

  const save = parsed.data.saveData;

  // 0) Clamp recoverable inconsistencies (e.g. currentHp > maxHp after an
  // evolution / over-heal) so a legit save isn't rejected — and thus never
  // backed up — over something harmless.
  sanitizeSave(save);

  // 1) Anti-cheat: bounds-check the payload before persisting. Rejects
  // obviously bogus saves (level > 100, negative money, party > 6, ...).
  const v = validateSave(save);
  if (!v.ok) {
    return c.json({ error: "save rejected", reason: v.reason }, 400);
  }

  // 2) Monotonic guard. The server-stored `saveVersion` is the source
  // of truth — we increment it on every accepted write. If the client
  // sends `expectedSaveVersion`, we reject when the cloud copy has
  // advanced past it (someone else wrote between this client's last
  // pull and now, or the client is rolling back). The client `__savedAt`
  // is still echoed for diagnostics but no longer the gate.
  const existing = await prisma.user.findUnique({
    where: { id: user.id },
    select: { saveVersion: true, saveData: true, saveAdoptSeq: true },
  });
  const expected = parsed.data.expectedSaveVersion;
  if (existing && expected !== undefined && expected < existing.saveVersion) {
    return c.json({
      error: "stale save",
      reason: "the cloud copy has advanced past your client's last known version",
      serverSaveVersion: existing.saveVersion,
      // THE INVARIANT, IN THE WIRE FORMAT. The design rests on "a client
      // cannot learn the new saveVersion — the thing that would let its stale
      // bytes pass the CAS — without seeing the new saveAdoptSeq in the same
      // response". Both 409 bodies used to report `serverSaveVersion` and OMIT
      // this, which made that sentence false in code: two POSTs and zero GETs
      // were enough to learn a fresh version with no adopt signal attached.
      //
      // A client still needs a GET to obtain the cloud BYTES, but with this
      // field it can decide, from the 409 alone, whether the conflict is
      // "another device wrote" (report it) or "the server authoritatively
      // rewrote this save" (adopt; do not report). It also means a client
      // whose GET fails knows it must keep 409ing rather than advance.
      serverSaveAdoptSeq: existing.saveAdoptSeq,
      clientExpectedVersion: expected,
    }, 409);
  }

  // A BLIND WRITE: no `expectedSaveVersion`, so nothing in this request
  // demonstrates that its sender ever read the bytes it is about to replace.
  // Used by steps 2a / 2c and by the compare-and-swap in commitSave.
  const blind = expected === undefined;

  // 2a) The end state, behind an env flag. See blindWritesAllowed().
  if (blind && !blindWritesAllowed()) {
    return c.json({
      error: "version_required",
      reason: "expectedSaveVersion is required — reload the page to get the current client",
      serverSaveVersion: existing?.saveVersion ?? null,
      serverSaveAdoptSeq: existing?.saveAdoptSeq ?? null,
    }, 400);
  }

  // 2b) Anti-regression guard. Even with no expectedSaveVersion, refuse
  // writes from older clients that would erase major milestone progress
  // (Elite Four cleared, Champion defeated, badges earned, Pokédex
  // entries). Cross-device save-sync bugs in v1 of the client caused
  // a stale device to silently overwrite the canonical save and bury
  // weeks of progress. This guard catches every save-clobber path on
  // the server regardless of which client version sent the write.
  //
  // 2c) …and for a BLIND write, the same idea extended to everything a
  // milestone signature cannot see. Badges/E4/champion/dex were the fields the
  // v1 incident happened to be about; they are not the fields a prize lands
  // in. A versionless POST of a pre-prize blob left every one of them
  // identical while it erased a delivered Master Ball, took a wallet from
  // 900,000 to 1, and emptied a three-Pokémon box — measured, through this
  // route. destructiveLosses covers money, victory tokens, PER-ITEM inventory
  // quantities, the set of owned Pokémon and the append-only lists.
  //
  // Why blind-only: all of those legitimately shrink during play. You spend
  // money, you throw a Poké Ball, you release a mon. An upload that named a
  // version proved it read the bytes it is subtracting from, so its
  // subtraction is intentional and must go through. An upload that named none
  // proved nothing, and "old lineage's arithmetic applied to a newer
  // lineage's bytes" is not a subtraction anyone intended.
  //
  // Why refuse rather than merge: a merge that kept the larger of two wallets
  // is a currency printer. Refusing costs the sender nothing it can't recover
  // — its bytes are still in its own localStorage, and its next upload after
  // the boot reconcile lands normally with a version attached.
  //
  // WHY 400 AND NOT 409 — this one is load-bearing and not a style choice.
  // The only sender that can reach 2c is a PRE-DEPLOY tab, and the deployed
  // client's 409 handler re-reads the cloud's VERSION ONLY and keeps its own
  // bytes (`cloudVersionRef.current = fresh.saveVersion`). Answer this request
  // with a 409 and that tab learns a version it can pass the CAS with, and its
  // very next upload — versioned, therefore not subject to 2c — destroys the
  // prize anyway, one round trip later. The refusal would be theatre.
  //
  // 400 is the status that same client treats as a contract violation: it sets
  // permanentlyRejectedRef, stops uploading for the session on BOTH paths
  // (autosave and the pagehide beacon), and files a `save-rejected` report
  // carrying `reason`. So the tab stops writing to a cloud copy it cannot
  // represent, keeps playing against localStorage — which is written
  // unconditionally and loses nothing — and recovers completely on reload.
  // The report is also the telemetry that says when SAVES_REQUIRE_VERSION can
  // be flipped.
  if (existing?.saveData) {
    let prior: Record<string, unknown> | null = null;
    try {
      prior = JSON.parse(existing.saveData) as Record<string, unknown>;
    } catch {
      // Existing save unparseable; treat as if there's no prior — let
      // the new write through. This is the migration / corruption
      // recovery path.
      prior = null;
    }
    if (prior) {
      const before = milestoneSig(prior);
      const after  = milestoneSig(save as Record<string, unknown>);
      if (milestoneRegressed(before, after)) {
        return c.json({
          error: "regression_blocked",
          reason: "incoming save erases milestone progress — refusing to clobber the cloud copy",
          before,
          after,
        }, 409);
      }
      if (blind) {
        const losses = destructiveLosses(prior, save as Record<string, unknown>);
        if (losses.length > 0) {
          return c.json({
            error: "versionless_regression",
            reason:
              "a save sent without expectedSaveVersion may not reduce money, items or Pokémon — "
              + "reload the page so this client can sync properly",
            // Capped: a blob that disagrees about a thousand item keys should
            // not turn a 409 body into a payload of its own.
            losses: losses.slice(0, 20),
            lossCount: losses.length,
            // Same rule as every other rejection here: the version never
            // travels without the adopt seq that goes with it.
            serverSaveVersion: existing.saveVersion,
            serverSaveAdoptSeq: existing.saveAdoptSeq,
          }, 400);
        }
      }
    }
  }

  // 3) THE DELIVERY POINT for server-owed prizes.
  //
  // Everything this ACCOUNT is still owed — a PendingGrant with
  // `deliveredAt IS NULL`, and nothing else — is folded in ON TOP OF the bytes
  // the client just sent, in the transaction that accepts the upload. That
  // ordering is half the fix: the client's blob can be arbitrarily stale and
  // it does not matter, because the grant is applied AFTER it.
  //
  // Contrast with what this replaced — a separate un-CAS'd write from the
  // giveaway draw that the client's next push simply overwrote.
  //
  // The OTHER half is the `saveAdoptSeq` bump in the same UPDATE (see
  // commitSave). Folding alone still loses to a second session: that session
  // 409s, keeps its stale blob, and its next upload carries the version it
  // learned and passes. Bumping saveAdoptSeq means the only response that can
  // teach a session the new saveVersion also tells it to adopt the cloud copy
  // — the copy that holds the prize — so the stale bytes are never pushed.
  //
  // Exactly-once is the `deliveredAt: null` compare-and-swap below and nothing
  // else. There is deliberately no re-delivery: the server cannot distinguish
  // "never received it" from "received it and spent it", so any mechanism that
  // re-pays a fungible prize is an exploit no matter what it keys on.
  //
  // Delivery still REQUIRES a version guard: without `expectedSaveVersion` the
  // UPDATE below degrades to `{ id }`, which cannot miss, so an upload built
  // before this client knew what the cloud held could overwrite a save it has
  // never seen while collecting a prize into it. This is not a client-trust
  // question: any build, or a hand-rolled request, can send `grantAck` without
  // a version, so the server refuses the combination rather than the client
  // avoiding it. A pre-reconcile upload simply collects nothing; the grants
  // stay owed and land on the next upload once the client knows a real
  // version. Same reasoning that keeps `grantAck` off the pagehide beacon.
  const wantsGrants =
    (parsed.data.grantAck ?? 0) >= GRANT_ACK_ADOPT && expected !== undefined;

  interface Committed {
    updated: {
      saveVersion: number; saveUpdatedAt: Date; saveAdoptSeq: number;
      accountLevel: number; totalCaughtLevels: number; pokedexCaughtCount: number;
    };
    stored: Record<string, unknown>;
    appliedPrizes: ReturnType<typeof foldOwedGrants>["appliedPrizes"];
    deferred: ReturnType<typeof foldOwedGrants>["deferred"];
    /** This request bumped saveAdoptSeq, i.e. it stored bytes the client did
     *  not send. Drives the save:adopt notification below. */
    bumpedAdoptSeq: boolean;
  }

  // The write itself. `runner` is either the plain client (nothing missing —
  // the overwhelmingly common case, one statement, exactly as before this
  // change) or a transaction client (something to fold — save write and
  // delivery bookkeeping commit or roll back together).
  const commitSave = async (
    runner: Prisma.TransactionClient,
    owed: OwedGrant[],
  ): Promise<Committed> => {
    // Fold per grant, skipping any single one that would produce a save
    // the game rejects (a Pokémon prize into a full box). A prize that
    // cannot be applied must never block the PLAYER'S OWN save — it stays
    // owed and is retried on the next upload.
    //
    // Sanitize before validating, exactly as step 0 did for the client's own
    // bytes. Without it a prize mon carrying a recoverable inconsistency
    // (currentHp above maxHp) is refused on every upload forever rather than
    // clamped once — and the sanitize is idempotent, so re-running it over
    // the player's already-sanitized mons is a no-op.
    const fold = foldOwedGrants(
      save,
      owed,
      (s) => { sanitizeSave(s); return validateSave(s); },
    );
    const finalSave = fold.save;
    // Did the bytes we are about to store differ from the bytes the client
    // sent? foldOwedGrants returns the input object by identity when it
    // changed nothing, so this is exact — and it is the precise condition for
    // needing an adopt. A grant with an empty prize list is still CLAIMED (so
    // it leaves the owed set) but writes no prize, and must not make every
    // session of this account throw away its unsynced play for nothing.
    const serverWroteBytes = finalSave !== save;
    const derived = computeAccountLevel(finalSave);

    // ATOMIC compare-and-swap.
    //
    // The version check ~50 lines above is a read; this is the write.
    // Between them another request from the same account can land, and
    // both writers pass a check neither of them still holds — classic
    // check-then-act. Both got `ok: true` and one save was silently
    // destroyed.
    //
    // Putting saveVersion in the WHERE makes the database arbitrate:
    // exactly one of two concurrent writers matches a given version, the
    // loser matches no row and Prisma raises P2025, which is precisely a
    // 409. The read above stays as a fast path that returns a friendlier
    // body.
    //
    // ── EVERY write is a compare-and-swap; only the version differs ──────
    // A versioned upload swaps on the version the CLIENT claims to have read.
    // A blind one has no claim to make, so it swaps on the version THIS
    // REQUEST observed in step 2 — the same read the 2b/2c guards compared
    // against.
    //
    // That is not decoration. Without it the guards are check-then-act: step 2
    // reads a prize-less row, the fold from another device commits, and the
    // blind write lands on bytes the guard never saw and erases the prize it
    // was written to protect. Binding the update to the observed version makes
    // the database arbitrate — the guard's verdict and the write it authorises
    // now refer to the same row state, or the write misses and P2025s into the
    // 409 below. It is also the last hole through which anything could reach a
    // row concurrently, which matters because the blind branch NEVER retries:
    // `wantsGrants` requires a version, so `owed` is empty here and there is
    // exactly one attempt.
    //
    // `existing` is only null if the row vanished between requireUser and the
    // step-2 read, in which case the update misses on `{ id }` anyway.
    //
    // Grants remain unreachable from the blind branch (`wantsGrants` requires
    // `expected !== undefined`), so nothing here can collect or re-collect a
    // prize; the remaining exposure is bounded by 2c, and disappears entirely
    // when SAVES_REQUIRE_VERSION turns the branch into a 400.
    const updated = await runner.user.update({
      where: expected !== undefined
        ? { id: user.id, saveVersion: expected }
        : existing
          ? { id: user.id, saveVersion: existing.saveVersion }
          : { id: user.id },
      data: {
        saveData: JSON.stringify(finalSave),
        saveVersion: { increment: 1 },
        // THE OVERWRITE PREVENTION. This upload's bytes are no longer purely
        // the client's — the server added a prize on top — so this is an
        // authoritative rewrite and gets the same treatment as an admin edit
        // or an auction escrow: every session of this account adopts the cloud
        // copy WHOLESALE rather than racing it with its own blob.
        //
        // Bumped in the SAME update as saveVersion, which is the invariant
        // every other bump site keeps (auctions, admin, escrow restore): a
        // client can never learn the new saveVersion — the thing that would
        // let its stale write pass the CAS — without seeing the new
        // saveAdoptSeq in the same response. That is what closes the two-tab
        // hole, and it needs nothing from the request body to do it.
        //
        // Only when the server actually added bytes. An ordinary upload must
        // not bump it, or every client would wholesale-adopt every 2.5s.
        ...(serverWroteBytes ? { saveAdoptSeq: { increment: 1 } } : {}),
        saveUpdatedAt: new Date(),
        accountLevel: derived.accountLevel,
        totalCaughtLevels: derived.totalCaughtLevels,
        pokedexCaughtCount: derived.pokedexCaughtCount,
      },
      select: {
        saveVersion: true,
        saveUpdatedAt: true,
        saveAdoptSeq: true,
        accountLevel: true,
        totalCaughtLevels: true,
        pokedexCaughtCount: true,
      },
    });

    // Delivery, under a `deliveredAt: null` compare-and-swap. This is THE
    // gate: it lives entirely in the database, and a row that passes through
    // it never returns to the owed set. A concurrent transaction that already
    // settled these rows leaves us matching fewer than we asked for, and we
    // then throw, rolling the save write above back with us rather than
    // reporting a delivery that did not happen. Always ordered
    // User-then-PendingGrant so concurrent uploads take the same locks in the
    // same order.
    if (fold.claimIds.length > 0) {
      const claim = await runner.pendingGrant.updateMany({
        where: { id: { in: fold.claimIds }, deliveredAt: null },
        data: { deliveredAt: new Date(), deliveredSaveVersion: updated.saveVersion },
      });
      if (claim.count !== fold.claimIds.length) throw new GrantRace();
    }

    return {
      updated,
      stored: finalSave,
      appliedPrizes: fold.appliedPrizes,
      deferred: fold.deferred,
      bumpedAdoptSeq: serverWroteBytes,
    };
  };

  // One retry, and ONLY for a lost grant CAS. That means another upload from
  // this same account delivered the grants a millisecond ago; re-reading picks
  // up whatever is STILL owed and folds that in. A version conflict is NOT
  // retried — that is a real conflict the client must hear about.
  //
  // The retry must never degrade into "write the client's bytes with nothing
  // folded in": the request that lost CAS #2 lost it to a transaction that
  // committed a prize, so an un-folded write here would erase a prize the row
  // already records as delivered, and nothing retries a delivered grant. See
  // the guard below.
  let committed: Committed | null = null;
  let lostGrantCas = false;
  for (let attempt = 0; attempt < 2 && committed === null; attempt++) {
    // Read what is owed OUTSIDE the transaction, on the
    // (userId, deliveredAt) index. This is a hint, not the guarantee: the
    // guarantee is the `deliveredAt: null` CAS inside commitSave, which
    // arbitrates under lock. Reading here is what keeps the 99.99% case —
    // nothing owed — a single UPDATE instead of an interactive transaction on
    // the hottest write path in the app. A grant enqueued a microsecond after
    // this read is simply collected by the next upload, ~2.5s later.
    const owed = wantsGrants ? await readOwedGrants(prisma, user.id) : [];
    // We lost the delivery CAS and now nothing is owed: another upload folded
    // these prizes into ITS blob a moment ago. Writing ours here would be a
    // plain save that silently drops a prize this account was just told it
    // received. Refuse and let the client pull the new version — which now
    // also carries a bumped saveAdoptSeq, so it adopts the copy holding the
    // prize. Nothing has been written, so nothing is lost. (With the version
    // guard above this is unreachable: the loser of the delivery CAS must
    // first have lost the version CAS and 409'd.)
    if (lostGrantCas && owed.length === 0) break;
    try {
      committed = owed.length === 0
        ? await commitSave(prisma, owed)
        : await prisma.$transaction((tx) => commitSave(tx, owed));
    } catch (e: any) {
      // Someone else delivered mid-flight; nothing was written. Re-read and
      // retry once — with whatever is STILL owed folded in.
      if (e instanceof GrantRace) { lostGrantCas = true; continue; }
      // P2025 = "record to update not found". The id is real (requireUser
      // resolved it), so the only way the WHERE misses is the saveVersion
      // guard: another write beat us. That is a conflict, not an error.
      if (e?.code === "P2025") {
        const now = await prisma.user.findUnique({
          where: { id: user.id },
          select: { saveVersion: true, saveAdoptSeq: true },
        });
        return c.json({
          error: "stale save",
          reason: "another device wrote while this save was in flight",
          serverSaveVersion: now?.saveVersion ?? null,
          // Same reason as the fast-path 409 above: the version never travels
          // without the adopt seq that goes with it.
          serverSaveAdoptSeq: now?.saveAdoptSeq ?? null,
          clientExpectedVersion: expected ?? null,
        }, 409);
      }
      throw e;
    }
  }
  if (!committed) {
    // Lost the grant CAS and could not safely retry. Nothing was written, so
    // nothing is lost — report it as the conflict it is and let the client
    // push again.
    return c.json({
      error: "stale save",
      reason: "a concurrent upload delivered pending grants while this save was in flight",
      clientExpectedVersion: expected ?? null,
    }, 409);
  }

  // Diagnostics only, and deliberately after the commit: a grant we could not
  // apply must not be able to roll back a save that already succeeded.
  //
  // Logged ONLY on a grant's first refusal. Uploads run ~24×/minute per active
  // player, so logging every refusal of a permanently-unfoldable grant (a
  // Pokémon prize into a box that stays full) would bury the ErrorLog under
  // thousands of identical rows an hour. The grant is still retried on every
  // upload; only the noise is capped.
  if (committed.deferred.length > 0) {
    noteDeferredGrants(committed.deferred);
    const firstTime = committed.deferred.filter((d) => d.attempts === 0);
    if (firstTime.length > 0) {
      void recordError({
        kind: "server", level: "warn", message: "pending_grant_deferred",
        source: "POST /api/saves", userId: user.id,
        meta: { grants: firstTime },
      });
    }
  }

  // Append-only history: an interval-gated checkpoint of this accepted save,
  // so a later bad write is recoverable. Fire-and-forget — it must never
  // delay or fail the response for a save that already committed.
  void maybeSnapshot(user.id, committed.updated.saveVersion, JSON.stringify(committed.stored));

  // The prize is durable and the account's saveAdoptSeq has moved, so EVERY
  // session of this account must now adopt the cloud copy. Online sessions get
  // told immediately; an offline or socket-less one sees it on its next
  // getSave (boot) or on the getSave its next 409 forces. Fire-and-forget by
  // construction — the seq in the database is the guarantee, this is only the
  // latency.
  //
  // Deliberately AFTER the commit: a notification for a transaction that then
  // rolled back would send every tab to re-read a save that never changed.
  if (committed.bumpedAdoptSeq) emitSaveAdopt(user.id);

  // Tell the client EXACTLY what we added on top of its bytes. It applies
  // precisely these to its in-memory state, so its next upload carries them
  // instead of overwriting them.
  //
  // `saveAdoptSeq` is echoed alongside so the uploader can recognise the bump
  // as ITS OWN and skip the wholesale adopt it would otherwise do a moment
  // later — the cloud copy is its own bytes plus the prize it just absorbed,
  // so re-fetching it would only cost the player the play since this upload.
  // Every OTHER session sees a seq it cannot account for and adopts, which is
  // exactly the intent. The client re-anchors on `seq === adopted + 1` and
  // adopts otherwise, so an admin bump racing this one is never skipped.
  //
  // A response that never arrives costs the player nothing: the grant is
  // settled and the prize is in the cloud copy, the client's known version is
  // unchanged so its next upload 409s, and the 409 re-read carries the bumped
  // seq — it adopts, and finds the prize.
  return c.json({
    ok: true,
    ...committed.updated,
    ...(committed.appliedPrizes.length > 0
      ? {
          grantsApplied: committed.appliedPrizes,
          grantsSummary: describePrizes(committed.appliedPrizes),
        }
      : {}),
  });
});

export default app;
