// Giveaway draws — the single implementation, shared by the manual
// admin endpoint (POST /admin/giveaways/:id/draw) and the automatic
// sweep below that fires when a giveaway's endsAt passes.
//
// This code pays out real prizes. Two guards in drawGiveaway() exist
// because of real incidents and must not be weakened:
//
//   1. The atomic `prisma.giveaway.updateMany` compare-and-swap on
//      { drawnAt: null, status: in [open, closed] }. Everything before
//      it is TOCTOU-vulnerable; the CAS is what makes a second
//      concurrent draw (double-click, retry, two admin sessions, a
//      sweep tick overlapping an operator's click) lose the row and
//      grant nothing. It is also exactly what makes the auto-draw loop
//      idempotent — a double tick cannot double-draw.
//   2. The `grantDelivered` flag, which keeps a failure that happens
//      AFTER a successful enqueuePrizeGrant from ever being reported as
//      ok:false — a false "UNPAID" leads an operator to re-grant a
//      prize that already landed.
//
// Note on what "granting" means here: prizes are NOT written into the
// winner's saveData by this module. They are enqueued as PendingGrant
// rows and folded into the winner's save by POST /api/saves, on top of
// whatever the client uploads. See lib/prizeGrant.ts for the incident
// that forced that design — writing the save directly here raced the
// winner's own autosave and silently destroyed prizes for anyone who
// was online at draw time.
//
// Mirrors lib/auctionSettlement.ts: the sweep is a plain interval that
// runs regardless of whether anybody is connected, because endsAt fires
// on wall-clock time, not on someone being online to press a button.
import { prisma } from "../db.js";
import { audit as auditRaw } from "./audit.js";
import { getIo, sendToUserGlobal } from "../socket.js";
import { recordError } from "./errorReporting.js";
import { newDrawSeed, pickWinners, parsePrizes, describePrizes } from "./giveaway.js";
import { enqueuePrizeGrant } from "./prizeGrant.js";
import type { Giveaway, GiveawayEntry } from "@prisma/client";

type GiveawayWithEntries = Giveaway & { entries: GiveawayEntry[] };

/**
 * Who is drawing. The admin route passes the acting admin (and how they
 * authed, so the audit row can say "via api-key" exactly as the old
 * inline makeAudit shim did). The auto-draw loop passes null, and the
 * giveaway's own ownerId stands in for the actor — nobody clicked
 * anything, so the operator who created it owns the record.
 */
export type DrawActor = { id: string; viaApiKey?: boolean };

export type GrantResult = { username: string; ok: boolean; error?: string };

export interface DrawGiveawayResult {
  ok: boolean;
  error?: string;
  /** Operator-facing explanation, mirrored into the HTTP body. */
  reason?: string;
  /** HTTP status the admin route should reply with. */
  status?: 200 | 400 | 404 | 409;
  giveaway?: GiveawayWithEntries;
  seed?: string;
  granted?: GrantResult[];
  entryCount?: number;
}

// Same shim the admin route used inline: stamp HOW the draw was
// triggered onto every audit row it writes.
function auditFor(actor: DrawActor | null, ownerId: string) {
  const adminId = actor?.id ?? ownerId;
  const via = actor ? (actor.viaApiKey ? "api-key" : null) : "auto";
  return (action: string, targetId: string | null, meta?: Record<string, unknown>) =>
    auditRaw(adminId, action, targetId, via ? { ...(meta ?? {}), via } : meta);
}

/**
 * Pick winners deterministically from a stored seed, then grant the
 * prizes straight into the winners' saves.
 *
 * Best-effort per winner: one corrupt save must not block the rest of
 * the draw, and the result is reported per winner so the operator can
 * see exactly who still needs paying out rather than guessing.
 */
export async function drawGiveaway(
  giveawayId: string,
  actor: DrawActor | null = null,
): Promise<DrawGiveawayResult> {
  const id = giveawayId;
  const g = await prisma.giveaway.findUnique({ where: { id }, include: { entries: true } });
  if (!g) return { ok: false, error: "giveaway not found", status: 404 };
  if (g.drawnAt) {
    return {
      ok: false,
      error: "already drawn",
      reason: "This giveaway has already been drawn. Re-drawing would change who won after the fact.",
      status: 409,
    };
  }
  if (g.status !== "open" && g.status !== "closed") {
    return { ok: false, error: "giveaway must be open or closed to draw", status: 409 };
  }
  if (g.entries.length === 0) return { ok: false, error: "no entries to draw from", status: 400 };

  const makeAudit = auditFor(actor, g.ownerId);
  // Chat announcements are posted as the acting admin, or — for an
  // automatic draw, where there is no acting admin — as the operator
  // who owns the giveaway.
  const posterId = actor?.id ?? g.ownerId;

  const seed = newDrawSeed();
  const drawnAt = new Date();
  // Atomic claim BEFORE picking winners or granting anything. The two
  // checks above (drawnAt/status) are TOCTOU-vulnerable on their own —
  // two overlapping requests (a double-click before the button
  // disables, a client retry, two admin sessions) can both pass them
  // before either has written anything, each draw with a different
  // seed, and each grant prizes — more winners than winnerCount, and a
  // winner picked by both runs getting paid twice. This updateMany is
  // the actual guard: only one concurrent call can match
  // `drawnAt: null` and win the row.
  const claimed = await prisma.giveaway.updateMany({
    where: { id, drawnAt: null, status: { in: ["open", "closed"] } },
    data: { status: "drawn", drawnAt, drawSeed: seed },
  });
  if (claimed.count === 0) {
    return {
      ok: false,
      error: "already drawn",
      reason: "This giveaway has already been drawn. Re-drawing would change who won after the fact.",
      status: 409,
    };
  }

  const winnerEntryIds = pickWinners(seed, g.entries.map((e) => e.id), g.winnerCount);
  const winners = g.entries.filter((e) => winnerEntryIds.includes(e.id));
  const prizes = parsePrizes(g.prizes);

  // Grant prizes. Per-winner and best-effort: one corrupt save must not
  // block the rest of the draw, and the result is reported per winner so
  // the operator can see exactly who still needs paying out rather than
  // guessing.
  //
  // The two writes below (owe the prize, then record the claim) are
  // NOT atomic — enqueuePrizeGrant can succeed and the much smaller,
  // much less likely to fail claimedAt update can still throw right
  // after (a transient DB blip). Getting that ordering wrong here once
  // meant a real prize grant got reported as ok:false / claimedAt:null
  // ("UNPAID" in the dashboard), which steers an operator toward
  // manually re-granting a prize that was already delivered — a real
  // double-payout. So a failure AFTER the grant already succeeded is
  // handled separately from a failure IN the grant itself: retry the
  // small tracking write once, and if it still fails, never report
  // ok:false for a prize that did land.
  const granted: GrantResult[] = [];
  for (const w of winners) {
    let grantDelivered = false;
    try {
      // Durable: the row is committed before this resolves. From here the
      // prize is guaranteed — it is folded into the winner's save by the save
      // endpoint, on top of their own upload, and cannot be raced away.
      // enqueuePrizeGrant also emits `gift:pending`, which nudges an online
      // winner to sync immediately instead of waiting for the next autosave
      // tick; that emit is an optimisation and nothing depends on it.
      await enqueuePrizeGrant(w.userId, prizes, { source: "giveaway", sourceId: g.id });
      grantDelivered = true;
      await prisma.giveawayEntry.update({
        where: { id: w.id },
        data: { isWinner: true, claimedAt: new Date() },
      });
      granted.push({ username: w.username, ok: true });
      // Tell them right now if they are online — a prize you only find
      // out about days later is a much smaller moment.
      try {
        sendToUserGlobal(w.userId, "giveaway:won", {
          giveawayId: g.id,
          title: g.title,
          prizeSummary: describePrizes(prizes),
        });
      } catch { /* socket layer optional */ }
    } catch (e) {
      if (grantDelivered) {
        // The prize already landed — only the bookkeeping write failed.
        // One retry, since this is a tiny two-column update far less
        // likely to fail twice than the transient blip that just hit it.
        try {
          await prisma.giveawayEntry.update({
            where: { id: w.id },
            data: { isWinner: true, claimedAt: new Date() },
          });
          granted.push({ username: w.username, ok: true });
        } catch (e2) {
          // Still couldn't record it. isWinner is set so the win itself
          // isn't lost, but claimedAt stays null on a PAID entry — the
          // dashboard's "UNPAID" badge would be actively wrong here, so
          // this is audited loudly instead of silently reported as a
          // normal failure an operator would react to by re-granting.
          await prisma.giveawayEntry.update({ where: { id: w.id }, data: { isWinner: true } })
            .catch(() => undefined);
          void makeAudit("giveaway.claim_record_failed", id, {
            entryId: w.id, userId: w.userId, username: w.username,
            error: String((e2 as Error).message ?? e2),
          });
          granted.push({
            username: w.username, ok: true,
            error: "Prize WAS granted — only recording the claim failed twice. Do not re-grant; fix claimedAt on this entry manually.",
          });
        }
        continue;
      }
      // The grant itself failed — genuinely unpaid, safe to re-grant.
      await prisma.giveawayEntry.update({ where: { id: w.id }, data: { isWinner: true } });
      granted.push({ username: w.username, ok: false, error: String((e as Error).message ?? e) });
    }
  }

  // The claim above already wrote status/drawnAt/drawSeed atomically —
  // build the response from what we already know rather than a second
  // round trip.
  const updated = { ...g, status: "drawn" as const, drawnAt, drawSeed: seed };

  void makeAudit("giveaway.draw", id, {
    seed,                              // the proof — must be in the ledger
    entryCount: g.entries.length,
    winners: granted.map((x) => x.username),
    failedGrants: granted.filter((x) => !x.ok).map((x) => x.username),
  });

  // Announce in global chat. A giveaway nobody sees the result of might
  // as well not have happened.
  try {
    const io = getIo();
    if (io && granted.length > 0) {
      const names = granted.map((x) => `@${x.username}`).join(", ");
      // kind: "giveaway" — rendered as a system card, so content drops
      // the emoji prefix that used to be the only way to recognize it.
      const stored = await prisma.chatMessage.create({
        data: {
          channelId: "global",
          userId: posterId,
          content: `"${g.title}" has been drawn! Congratulations ${names} — you won ${describePrizes(prizes)}!`,
          kind: "giveaway",
        },
        include: { user: { select: { id: true, username: true, name: true, accountLevel: true } } },
      });
      io.to("global").emit("chat:message", {
        id: stored.id, channelId: stored.channelId, content: stored.content,
        kind: stored.kind, createdAt: stored.createdAt, user: stored.user,
      });
    }
  } catch { /* announcement is a nice-to-have, never fail the draw for it */ }

  return {
    ok: true,
    status: 200,
    giveaway: updated,
    seed,
    granted,
    entryCount: g.entries.length,
  };
}

// ── Automatic draw sweep ────────────────────────────────────────────
// A giveaway's endsAt used to be decoration: nothing acted on it, so a
// draw only happened when an operator remembered to click. This is the
// timer that closes that gap.
const DRAW_INTERVAL_MS = 15_000;

export async function drawDueGiveaways(): Promise<void> {
  const due = await prisma.giveaway.findMany({
    where: {
      status: "open",
      drawnAt: null,
      // A null endsAt means "open until the operator draws" and never
      // matches an lte comparison, so it is left alone by design.
      endsAt: { lte: new Date() },
      // Zero-entry giveaways are SKIPPED, not failed: nobody entered,
      // there is nothing to pay out, and the operator may still want to
      // extend or cancel it by hand. Filtering here keeps the sweep
      // from logging the same "no entries to draw from" every tick.
      entries: { some: {} },
    },
    select: { id: true },
    take: 50,
  });
  // Serial, not Promise.all — same reason as the auction sweep: this
  // codebase has previously hit a real Postgres connection-ceiling
  // incident from concurrent fan-out, and each draw issues several
  // sequential queries (one per winner, plus the grant writes).
  for (const row of due) {
    try {
      const res = await drawGiveaway(row.id, null);
      // "already drawn" here is not a failure: an operator's manual draw
      // (or an overlapping tick) won the compare-and-swap first, which
      // is precisely the guard working. Same for a giveaway whose last
      // entry vanished between the query and the draw.
      if (!res.ok && res.error !== "already drawn" && res.error !== "no entries to draw from") {
        void recordError({
          kind: "server",
          message: "giveaway_auto_draw_failed",
          source: "giveawayDraw.drawDueGiveaways",
          meta: { giveawayId: row.id, error: res.error ?? null },
        });
        continue;
      }
      // The draw itself succeeded; individual grants can still fail
      // (corrupt save, deleted account). Surface those — they are the
      // rows an operator has to pay out by hand.
      const failed = (res.granted ?? []).filter((x) => !x.ok);
      if (failed.length > 0) {
        void recordError({
          kind: "server",
          message: "giveaway_auto_draw_grant_failed",
          source: "giveawayDraw.drawDueGiveaways",
          meta: {
            giveawayId: row.id,
            failed: failed.map((x) => ({ username: x.username, error: x.error ?? null })),
          },
        });
      }
    } catch (e) {
      void recordError({
        kind: "server",
        message: "giveaway_auto_draw_threw",
        source: "giveawayDraw.drawDueGiveaways",
        meta: { giveawayId: row.id, error: String((e as Error)?.message ?? e) },
      });
    }
  }
}

let started = false;
export function startGiveawayDrawLoop(): void {
  if (started) return;
  started = true;
  const tick = () => {
    drawDueGiveaways().catch((e) => {
      void recordError({
        kind: "server",
        message: "giveaway_auto_draw_sweep_failed",
        source: "giveawayDraw.tick",
        meta: { error: String((e as Error)?.message ?? e) },
      });
    });
  };
  tick();
  setInterval(tick, DRAW_INTERVAL_MS);
}
