// Paying a Prize out to a player — the pending-grant inbox.
//
// ── WHY THIS IS NOT A SAVE WRITE ────────────────────────────────────
// This module used to read User.saveData, add the prize, and write the
// whole blob back with `prisma.user.update({ where: { id: userId } })`.
// No compare-and-swap, no coordination with the player's own client.
//
// The game client is save-AUTHORITATIVE: it holds the save in memory and
// re-uploads the entire blob every ~2.5s. So for any winner who happened
// to be PLAYING when the draw fired, the sequence was:
//
//     server: read save@N → add masterball → write save@N+1   (prize in DB)
//     client: PUT save (its own blob, no masterball, expected=N) → 409
//     client: re-reads only the VERSION, keeps its stale blob
//     client: PUT save (same stale blob, expected=N+1) → ACCEPTED
//             → masterball destroyed, and the client persists N+2 as its
//               sync point so no later boot reconcile can ever recover it.
//
// The draw reported success. The player got nothing. Offline winners were
// unaffected (their next boot merged the cloud copy), which is exactly why
// it looked random — it only ever hit the people a giveaway attracts.
//
// The fix is to stop racing the blob. A grant now writes ONE row into
// PendingGrant and nothing else; there is no save write here at all, so
// there is nothing for a client push to clobber. The prize is folded into
// the player's save by POST /api/saves, ON TOP OF the bytes the client just
// uploaded, in the same transaction that accepts the upload — see
// readOwedGrants / foldOwedGrants below and routes/saves.ts. Until that
// happens the row stays owed, and every subsequent upload tries again.
//
// Living in a lib rather than a route file is what lets the timer-driven
// draw reuse it without importing the admin Hono app (which would be a
// cycle).
import { prisma } from "../db.js";
import { sendToUserGlobal } from "../socket.js";
import { describePrizes, parsePrizes } from "./giveaway.js";
import type { AppliedPrize, Prize } from "./giveaway.js";
import { sanitizeSave, validateSave } from "./saveValidation.js";

export interface GrantMeta {
  /** Audit label: "giveaway" | "mass-gift" | "backfill" | … */
  source: string;
  /** The giveaway/auction/whatever id this grant came from, if any. */
  sourceId?: string | null;
}

/** How many owed grants one save upload will try to settle. Bounds the work
 *  a single request can do; the remainder is picked up by the next upload
 *  (which an idle game produces within ~2.5s). */
export const MAX_GRANTS_PER_DRAIN = 25;

// ── WHY DELIVERY STATE LIVES ONLY IN THE DATABASE ───────────────────
//
// `PendingGrant.deliveredAt` is the ONE gate. Nothing the client sends
// participates in the decision to pay a grant.
//
// The obvious-looking alternative — a receipt stamped into the save blob, so
// the fold can ask "does the copy in front of me already hold this prize?" —
// was built, and it is an exploit. The gate becomes a field the CLIENT
// supplies: delete it in localStorage, reload, and every grant inside the
// re-check window is paid again on every upload. Measured on the real modules:
// $1.5M in 30 uploads, 51 Master Balls from one grant, 25 grants re-paid in a
// single request.
//
// It cannot be repaired by validating the receipt harder, because the server
// has no way to tell "never received it" from "received it and spent it" — a
// fungible prize leaves no trace once it is spent. So a lost fungible prize
// CANNOT be safely healed, and the answer is to make it impossible to lose:
//
//   * the fold applies the prize on top of the bytes the client just uploaded,
//     inside the transaction that accepts that upload (below, + routes/saves.ts);
//   * that same UPDATE bumps `User.saveAdoptSeq`, which is the pre-existing
//     signal meaning "the server authoritatively rewrote this save — adopt the
//     cloud copy WHOLESALE". Every other session of that account therefore
//     adopts the copy that HOLDS the prize instead of racing it with a stale
//     blob (see lib/saveAdopt.ts and GameContext's adopt paths).
//
// That closes the tab-B hole — B loses the version CAS, 409s, and can only
// learn the new saveVersion from a response that also carries the new
// saveAdoptSeq, so it adopts rather than re-pushing — with no client-supplied
// delivery state and no merge anywhere.
//
// Pokémon prizes are the one exception to "cannot be healed", and only because
// `prizeMonId` makes absence provable: the id is derived from the grant, so a
// box that lacks it provably never received it. That is what
// foldPrizesIntoSave's held-id check uses, and it is a de-duplicator, never a
// gate.

/**
 * Would these prizes fold into a legal save AT ALL?
 *
 * PRIZE-INTRINSIC ONLY — it folds them onto an empty skeleton, never onto the
 * recipient's current save. That distinction is the whole point:
 *
 *   * Checking against the recipient's save would make a TRANSIENT condition
 *     (a full box the player is about to clear) report the grant as failed.
 *     The operator then re-grants, a SECOND PendingGrant row is created, and
 *     the player is paid twice once the condition clears. A grant must never
 *     be refused for something the player can fix.
 *   * Checking the prize itself catches what is permanently undeliverable —
 *     a level-105 mon, a malformed moves array — which the admin API's
 *     `mon: z.record(...)` deliberately does not bound. Before the inbox
 *     existed, the old grant path validated at grant time and an operator saw
 *     a real failure; without this check the draw reports ok for every winner
 *     and the row is refused silently on every upload, forever.
 *
 * Returns null when the prizes are deliverable, or the reason they are not.
 */
export function checkPrizesDeliverable(prizes: readonly Prize[]): string | null {
  if (!Array.isArray(prizes) || prizes.length === 0) return "no prizes to grant";
  const { save } = foldPrizesIntoSave(
    { box: [], inventory: {}, money: 0, nextPokemonId: 1 },
    prizes,
    "check",
  );
  // Sanitize first, exactly as the real fold path does (POST /api/saves
  // sanitizes the incoming blob before validating), so this check accepts
  // precisely what the fold will accept — no more, no less.
  sanitizeSave(save);
  const v = validateSave(save);
  return v.ok ? null : v.reason;
}

/**
 * Owe a player some prizes, durably.
 *
 * Returns once the row is COMMITTED — that, and not a save write, is the
 * point of no return. A caller that sees this resolve may report the prize
 * as paid: the only way it does not reach the player is if they never load
 * the game again.
 *
 * Throws if the account does not exist, so an operator still gets a real
 * error for a genuinely impossible grant rather than a silently orphaned row.
 */
export async function enqueuePrizeGrant(
  userId: string,
  prizes: Prize[],
  meta: GrantMeta,
): Promise<{ id: string }> {
  if (!Array.isArray(prizes) || prizes.length === 0) throw new Error("no prizes to grant");
  // Refuse a prize that can never be folded, BEFORE it becomes a durable row
  // the caller will report as paid. A grant that the fold refuses is retried
  // on every upload for the rest of that account's life and is invisible to
  // the operator, who was told `ok`. Prize-intrinsic — see
  // checkPrizesDeliverable for why this must never consult the target's save.
  const badPrize = checkPrizesDeliverable(prizes);
  if (badPrize) throw new Error(`prize would corrupt save: ${badPrize}`);
  // Cheap existence check. The FK would catch this too, but as an opaque
  // P2003 — an operator staring at a failed draw deserves the real reason.
  const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!target) throw new Error("user not found");

  const row = await prisma.pendingGrant.create({
    data: {
      userId,
      prizes: JSON.stringify(prizes),
      source: meta.source,
      sourceId: meta.sourceId ?? null,
      summary: describePrizes(prizes),
    },
    select: { id: true },
  });

  // Nudge an online player to sync NOW so the prize lands in a second rather
  // than on their next autosave tick. Purely an optimisation: this emit is
  // fire-and-forget (socket.ts drops it on the floor if the user has no live
  // socket) and NOTHING depends on it — the grant is already durable, and the
  // client's normal save loop settles it regardless. That dependency is what
  // the old code got wrong.
  //
  // Deliberately NOT the legacy "gift:received" event: that one tells the
  // client to add the prizes to its own state, which under the inbox would
  // double-count (client adds them, then the server folds the still-owed row
  // in on top). New clients apply only what a save response confirms.
  try {
    sendToUserGlobal(userId, "gift:pending", {
      grantId: row.id,
      summary: describePrizes(prizes),
    });
  } catch { /* socket layer optional — the inbox is the guarantee */ }

  return row;
}

/**
 * The id a prize Pokémon is stored under. Derived from the GRANT, never from
 * the recipient's `nextPokemonId` sequence, for two independent reasons:
 *
 *   1. Uniqueness. `nextPokemonId` lives in a blob the client owns and can
 *      re-send stale, so two folds against two stale blobs can pick the SAME
 *      number — and the box union in the client's reconcile keys on id, so one
 *      of the two prizes silently disappears. A grant id is a cuid: unique by
 *      construction, and it cannot collide with the player's own ids
 *      (plain numerals, `t<n>`, `a<n>`, `gift<n>`).
 *   2. Idempotency. A fold replayed onto a blob that already holds the mon
 *      produces the same id, so the union collapses it instead of duplicating.
 *
 * Stays inside saveValidation's id charset/length bound (`[A-Za-z0-9_-]{1,40}`):
 * "pg" + a 25-char cuid + "_" + a one- or two-digit index.
 */
function prizeMonId(grantId: string, index: number): string {
  return `pg${grantId.replace(/[^a-zA-Z0-9_-]/g, "")}_${index}`.slice(0, 40);
}

/**
 * Apply prizes to a save object, returning a NEW object. Pure: no I/O, no
 * mutation of `base`. This is the one place that knows how a Prize turns
 * into save fields, shared by every delivery path.
 *
 * Returns the prizes AS APPLIED alongside the save. The caller echoes those
 * (not the nominal descriptors) to the client, which is what lets the client
 * reproduce this write byte-for-byte instead of guessing at it — see
 * AppliedPrize in ./giveaway.ts for exactly what differs and why.
 */
export function foldPrizesIntoSave(
  base: Record<string, unknown>,
  prizes: readonly Prize[],
  grantId: string,
): { save: Record<string, unknown>; applied: AppliedPrize[] } {
  const save: Record<string, unknown> = { ...base };
  const applied: AppliedPrize[] = [];

  for (let i = 0; i < prizes.length; i++) {
    const p = prizes[i];
    if (p.kind === "item") {
      const inv: Record<string, number> = {
        ...((save.inventory && typeof save.inventory === "object" && !Array.isArray(save.inventory))
          ? (save.inventory as Record<string, number>) : {}),
      };
      const before = inv[p.itemId] ?? 0;
      const after = Math.min(999_999, before + p.quantity);
      inv[p.itemId] = after;
      save.inventory = inv;
      // Report the delta, not the nominal quantity: at the stack ceiling the
      // save moves by less than the grant promised, and the client applies
      // exactly what we report.
      if (after > before) applied.push({ ...p, quantity: after - before });
    } else if (p.kind === "money") {
      const cur = typeof save.money === "number" ? save.money : 0;
      const next = Math.min(999_999_999, cur + p.amount);
      save.money = next;
      if (next > cur) applied.push({ ...p, amount: next - cur });
    } else if (p.kind === "pokemon") {
      // Into the BOX, never the party: overwriting a party slot would be
      // a hostile way to receive a gift.
      const box = Array.isArray(save.box) ? [...(save.box as unknown[])] : [];
      // Re-id so the prize cannot collide with a mon the winner already
      // owns — an id clash would confuse trade ownership lookups, which
      // match by id. See prizeMonId for why it comes from the grant.
      const assignedId = prizeMonId(grantId, i);
      const held = new Set<string>();
      for (const m of [...box, ...(Array.isArray(save.party) ? (save.party as unknown[]) : [])]) {
        const id = (m as { id?: unknown } | null)?.id;
        if (typeof id === "string") held.add(id);
      }
      // Already present — this exact grant's mon is in the blob the client
      // just uploaded. Re-adding it would hand out a one-off prize twice.
      if (!held.has(assignedId)) {
        box.push({ ...p.mon, id: assignedId });
        save.box = box;
      }
      applied.push({ ...p, assignedId });
    }
  }

  return { save, applied };
}

export interface OwedGrant {
  id: string;
  prizes: Prize[];
  summary: string;
  /** How many previous folds refused this grant. Used only to stop a
   *  permanently-unfoldable grant from writing diagnostics on every single
   *  save upload — see noteDeferredGrants. */
  attempts: number;
}

/**
 * What this ACCOUNT is still owed. Takes any Prisma client — the plain one or
 * a transaction client.
 *
 * `deliveredAt IS NULL` is the whole query, and it is the whole delivery
 * gate. Nothing about the incoming blob is consulted, so this function has no
 * way to be influenced by anything a client sends: it is not passed the save
 * at all. That is deliberate and it is the property to preserve — the moment
 * a caller starts filtering these rows by something out of the request body,
 * the exploit is back.
 *
 * Ordered never-refused-first, then oldest-first: with a pure createdAt
 * ordering, rows the fold keeps refusing (a Pokémon prize into a full box)
 * fill the take() window permanently and every grant created afterwards
 * starves. Sorting refusals to the back makes a stuck grant cost one slot's
 * worth of retry, not the whole queue.
 *
 * The overwhelmingly common result is `[]` — an account is owed nothing — so
 * POST /api/saves stays a single UPDATE with no transaction on the hottest
 * write path in the app.
 *
 * This read is a HINT and does not need to be atomic: a grant it misses is
 * collected by the next upload ~2.5s later, and a grant it returns that a
 * concurrent upload folds first loses the `deliveredAt IS NULL` CAS and rolls
 * back whole.
 */
export async function readOwedGrants(
  tx: { pendingGrant: { findMany: (args: any) => Promise<any[]> } },
  userId: string,
): Promise<OwedGrant[]> {
  const rows = await tx.pendingGrant.findMany({
    where: { userId, deliveredAt: null },
    orderBy: [
      { attempts: "asc" },
      { createdAt: "asc" },
    ],
    take: MAX_GRANTS_PER_DRAIN,
    select: { id: true, prizes: true, summary: true, attempts: true },
  });

  return (rows as any[]).map((r) => ({
    id: r.id as string,
    prizes: parsePrizes(r.prizes as string),
    summary: r.summary as string,
    attempts: typeof r.attempts === "number" ? r.attempts : 0,
  }));
}

export interface FoldOutcome {
  /** The save with every applicable grant folded in (or the input untouched). */
  save: Record<string, unknown>;
  /** Grants folded in. These take the `deliveredAt: null` compare-and-swap in
   *  the same transaction that persists `save`, and that CAS is what makes
   *  delivery exactly-once. */
  claimIds: string[];
  /** Prizes actually folded in, flattened — echoed to the client so its live
   *  state can match the bytes the server just stored. Carries the applied
   *  DELTA and the assigned mon id, not the nominal descriptor; see
   *  AppliedPrize. */
  appliedPrizes: AppliedPrize[];
  /** Grants left owed because folding them produced a save the game would
   *  reject (e.g. a Pokémon prize into a full box). Not an error: they stay
   *  in the inbox and are retried on the next upload. */
  deferred: DeferredGrant[];
}

export interface DeferredGrant {
  id: string;
  reason: string;
  /** attempts BEFORE this one. 0 = this is the first refusal. */
  attempts: number;
}

/**
 * Fold owed grants into a save, one grant at a time, skipping any single
 * grant that would make the result invalid.
 *
 * Per-grant validation matters: a prize that cannot be applied (full box)
 * must never block the player's own save from being accepted, and must never
 * take the OTHER owed grants down with it.
 *
 * ── WHY THIS IS EXACTLY-ONCE ────────────────────────────────────────
 * Nothing here decides whether a grant has already been paid. `owed` comes
 * from `deliveredAt IS NULL` and from nowhere else, and the caller settles
 * every id in `claimIds` under a `deliveredAt: null` compare-and-swap in the
 * same transaction that persists `save` — so:
 *
 *   * two concurrent uploads cannot both pay: one wins the CAS, the other
 *     rolls its save write back with it;
 *   * a save that is rejected pays nothing: the CAS is in the same
 *     transaction as the write;
 *   * a paid grant never comes back: the row leaves the `deliveredAt IS NULL`
 *     set permanently, and no request body can put it back.
 *
 * `incoming` is READ but never trusted: the only thing taken from it is the
 * set of Pokémon ids already present, which de-duplicates a prize mon within
 * a single fold (see foldPrizesIntoSave). Forging that can only make an
 * attacker MISS a mon they were owed — it can never pay one twice, and it
 * cannot touch money or items at all.
 */
export function foldOwedGrants(
  incoming: Record<string, unknown>,
  owed: readonly OwedGrant[],
  validate: (s: Record<string, unknown>) => { ok: true } | { ok: false; reason: string },
): FoldOutcome {
  let working = incoming;
  const claimIds: string[] = [];
  const appliedPrizes: AppliedPrize[] = [];
  const deferred: DeferredGrant[] = [];

  for (const g of owed) {
    // An empty/corrupt prize list can never be delivered and would otherwise
    // be retried on every single upload forever. Claim it and move on — the
    // row leaves the owed set and stops costing anything.
    if (g.prizes.length === 0) {
      claimIds.push(g.id);
      continue;
    }
    const { save: candidate, applied } = foldPrizesIntoSave(working, g.prizes, g.id);
    const v = validate(candidate);
    if (!v.ok) { deferred.push({ id: g.id, reason: v.reason, attempts: g.attempts }); continue; }
    working = candidate;
    claimIds.push(g.id);
    // `applied`, never `g.prizes`: the client applies precisely what we
    // stored, so a ceiling-clamped amount and the assigned mon id both reach
    // it. Echoing the nominal prizes is how the same mon ended up with two
    // different ids on the two sides.
    appliedPrizes.push(...applied);
  }

  return { save: working, claimIds, appliedPrizes, deferred };
}

/**
 * How many refusals get recorded before we stop writing about a grant. A save
 * upload happens ~24×/minute per active player, so an unfoldable grant (a
 * Pokémon prize into a permanently full box) would otherwise write a row and
 * log an error on every single one of them — thousands an hour, for a
 * condition that is fully described by the first few. The grant keeps being
 * RETRIED forever regardless; only the bookkeeping stops.
 */
export const MAX_DEFERRAL_NOTES = 20;

/**
 * Record that a grant could not be folded yet. Best-effort and OUTSIDE the
 * save transaction on purpose — this is diagnostics, and it must never be
 * able to roll back or delay a save that already committed.
 */
export function noteDeferredGrants(deferred: readonly DeferredGrant[]): void {
  for (const d of deferred) {
    if (d.attempts >= MAX_DEFERRAL_NOTES) continue;
    // updateMany, not update: the `attempts` bound is re-checked by the
    // database, so concurrent uploads can't push the counter past the cap.
    void prisma.pendingGrant
      .updateMany({
        where: { id: d.id, attempts: { lt: MAX_DEFERRAL_NOTES } },
        data: { attempts: { increment: 1 }, lastError: d.reason.slice(0, 300) },
      })
      .catch(() => undefined);
  }
}

/** How many prizes an account is still owed. Read-only; used by GET /api/saves
 *  and by ops tooling. */
export async function countOwedGrants(userId: string): Promise<number> {
  return prisma.pendingGrant.count({ where: { userId, deliveredAt: null } });
}
