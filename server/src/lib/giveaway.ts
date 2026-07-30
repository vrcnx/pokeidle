import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

// Provably-fair winner selection.
//
// A draw players do not trust is worse than no draw at all — the first
// time someone says "it's rigged, your mate won again" you need to be
// able to answer with something better than "trust me". So the pick is
// a pure, deterministic function of (seed, entry ids):
//
//   1. The operator draws. We generate a random seed and STORE it.
//   2. Winners are derived by hashing `seed:entryId` for every entry,
//      sorting by that hash, and taking the first N.
//   3. Afterwards, anyone holding the seed and the entry list can
//      recompute the exact same winners and check for themselves.
//
// Properties that matter:
//   * Deterministic — same inputs always give the same winners, so the
//     result is checkable after the fact.
//   * Unbiased — SHA-256 output is uniform, so sorting by it is a
//     uniformly random permutation of the entries.
//   * Not gameable by entrants — the seed does not exist until the
//     operator draws, so no entrant can pick an id that wins.
//   * Not gameable by the operator either, as long as the seed is
//     published: they would have to re-draw to change the outcome, and
//     a re-draw is blocked once drawnAt is set and is audited anyway.
//
// Entry ids are cuids we generate, so an entrant cannot grind a
// favourable id even if they somehow learned the seed early.

export function newDrawSeed(): string {
  return randomBytes(16).toString("hex");
}

/** Deterministic per-entry ticket. Uniform over the hash space. */
function ticket(seed: string, entryId: string): string {
  return createHash("sha256").update(`${seed}:${entryId}`).digest("hex");
}

/**
 * Pick `count` winners from `entryIds`, deterministically from `seed`.
 * Returns ids in winning order (1st, 2nd, ...).
 *
 * Exported so both the draw endpoint and any future verification tool
 * (or a curious player, via a published seed) run the exact same code.
 */
export function pickWinners(
  seed: string,
  entryIds: readonly string[],
  count: number,
): string[] {
  if (count <= 0 || entryIds.length === 0) return [];
  // Sort the input first so the result cannot depend on the order the
  // database happened to return rows in — that would make the draw
  // unverifiable even though it looked deterministic.
  const sorted = [...entryIds].sort();
  return sorted
    .map((id) => ({ id, t: ticket(seed, id) }))
    .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.id < b.id ? -1 : 1))
    .slice(0, Math.min(count, sorted.length))
    .map((x) => x.id);
}

// ── Prizes ──────────────────────────────────────────────────────────
// Kept deliberately small and explicit. Each variant maps to a
// well-understood mutation of the winner's save; anything we cannot
// apply safely simply is not offered.
export type Prize =
  | { kind: "item"; itemId: string; quantity: number }
  | { kind: "money"; amount: number }
  // The FULL serialised mon, built by the admin client at creation time
  // rather than described here and reconstructed on the server.
  //
  // The server has no Pokemon table and no stat formula — it could only
  // fabricate stats, and a mon with wrong stats is exactly the bug that
  // made the save editor hand players a Lv50 Charizard with 24 HP.
  // admin/src/data/gameCatalog.ts already owns createPokemon with the
  // real formula, so the correct mon is built there, stored whole, and
  // the server just appends it — then validateSave gates it like any
  // other write. `label` is carried for display so listing a prize does
  // not require parsing the mon.
  | { kind: "pokemon"; label: string; mon: Record<string, unknown> };

/**
 * A prize as ACTUALLY APPLIED to a save, echoed back to the client so its
 * live state can match the bytes the server just stored.
 *
 * Two things differ from the stored descriptor, and both exist because the
 * client must be able to reproduce the server's write EXACTLY rather than
 * approximate it:
 *
 *   * `assignedId` — the id the fold stamped on a `pokemon` prize. Without it
 *     the client mints its own (`gift<n>`) and the same physical mon then
 *     exists under two ids: the box union in saveReconcile keys on id, so any
 *     merge sees two mons and the one-off prize is duplicated.
 *   * `quantity` / `amount` are the DELTA that landed, not the nominal prize.
 *     A recipient at the inventory/money ceiling absorbs less than the grant
 *     promised; echoing the nominal figure would tell them (and the toast) a
 *     number the save never moved by.
 *
 * `assignedId` is a separate field rather than an overwrite of `mon.id` on
 * purpose: the legacy `gift:received` socket path carries the admin client's
 * template id in `mon.id`, which is identical for every recipient, so the
 * client must keep re-iding on that path.
 */
export type AppliedPrize = Prize & { assignedId?: string };

// ── The bounds on a prize, in ONE place ─────────────────────────────
//
// WHY THIS MOVED HERE, and it is not tidying. These bounds used to live as a
// private `PrizeSchema` const inside routes/admin.ts, and two of the three
// operator paths that mint a prize used it while the third did not:
//
//   giveaway create  POST /admin/giveaways      z.array(PrizeSchema).min(1).max(10)
//   mass gift        POST /admin/mass-gift      z.array(PrizeSchema).min(1).max(10)
//   TOURNAMENT       POST/PATCH /admin/tournaments   z.string().max(20_000)
//
// The tournament routes took the prize list as an opaque JSON STRING and ran
// only `checkPrizesDeliverable(parsePrizes(...))` on it. `parsePrizes` below is
// deliberately lenient — it is the reader for rows that were validated on the
// way IN — so it JSON.parses and casts with no per-element checking at all, and
// checkPrizesDeliverable folds onto an empty save and asks validateSave, whose
// only item rule is MAX_INVENTORY_STACK. Net effect, measured by executing both
// checks over the same payloads:
//
//   999,999x expShare      giveaway REFUSED   tournament ACCEPTED
//   999,999x masterball    giveaway REFUSED   tournament ACCEPTED
//   999,999x shinycharm    giveaway REFUSED   tournament ACCEPTED
//   $999,999,999           giveaway REFUSED   tournament ACCEPTED
//   itemId "../../etc; DROP TABLE"
//                          giveaway REFUSED   tournament ACCEPTED
//   300 distinct items at 999,999 each (14,891 chars, inside the 20,000 cap)
//                          giveaway REFUSED   tournament ACCEPTED
//
// A tournament prize is paid through enqueuePrizeGrant, so it lands via the
// PendingGrant fold — which is applied ON TOP of the client's bytes INSIDE
// commitSave, i.e. strictly after lib/saveGainGuard.ts has already run. The
// gain guard is blind to it by construction (that blindness is deliberate and
// correct: it is what stops the guard flagging the server's own payments). So
// the item ceiling that catches a fabricated pile on the upload path —
// ITEM_STACK_RESTRICTED, 1,000 — cannot see a prize at all, and the tournament
// route was the one prize path with nothing else in its place.
//
// Nothing exploited it: production holds ZERO Tournament rows, and every
// PendingGrant ever written is 1-50 units of an ordinary item. It is a latent
// hole, closed here by construction rather than by remembering to repeat the
// schema at a fourth call site.
export const PrizeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("item"),
    itemId: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
    quantity: z.number().int().min(1).max(999),
  }),
  z.object({ kind: z.literal("money"), amount: z.number().int().min(1).max(10_000_000) }),
  // The admin client builds the real mon (it owns the stat formula); we bound
  // the shape here and validateSave gates the final write.
  z.object({ kind: z.literal("pokemon"), label: z.string().max(80), mon: z.record(z.string(), z.unknown()) }),
]);

/** A whole prize list, as every operator-facing route accepts it. */
export const PrizeListSchema = z.array(PrizeSchema).min(1).max(10);

/**
 * Validate a prize list that arrives as a JSON STRING rather than as parsed
 * JSON — the shape the tournament routes use, because Tournament.prizes is a
 * string column mirroring Giveaway.prizes.
 *
 * Returns the prizes RE-NORMALISED through the schema, so the caller stores
 * exactly what was validated and no unchecked field can round-trip into the
 * row. Deliberately does NOT call checkPrizesDeliverable: that lives in
 * prizeGrant.ts, which imports this module, and the callers already run it
 * afterwards. This function answers "is it in bounds", that one answers "will
 * it fold" — both are needed and they are separate questions.
 */
export function parsePrizesStrict(
  json: string,
): { ok: true; prizes: Prize[] } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, reason: "prizes must be valid JSON" };
  }
  const parsed = PrizeListSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? `prizes[${first.path.join(".")}]: ` : "";
    return { ok: false, reason: `${where}${first?.message ?? "invalid prize list"}` };
  }
  return { ok: true, prizes: parsed.data as Prize[] };
}

/**
 * LENIENT reader for a prize list that was already validated on the way in.
 * Every caller of this reads a STORED row (Giveaway.prizes, Tournament.prizes,
 * PendingGrant.prizes). Do not reach for it on an inbound request body —
 * PrizeListSchema / parsePrizesStrict are the inbound gate, and routing a
 * request through this one is exactly the hole documented above.
 */
export function parsePrizes(json: string): Prize[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as Prize[]) : [];
  } catch {
    return [];
  }
}

/** Human summary for lists/toasts, e.g. "1x Master Ball + $50,000". */
export function describePrizes(prizes: readonly Prize[]): string {
  if (prizes.length === 0) return "No prize set";
  return prizes
    .map((p) =>
      p.kind === "item"    ? `${p.quantity}x ${p.itemId}`
      : p.kind === "money" ? `$${p.amount.toLocaleString()}`
      :                      p.label
    )
    .join(" + ");
}

// ── The PLAYER-FACING projection ────────────────────────────────────
//
// One function, used by every player-facing giveaway route, because the
// privacy rules here are the kind that rot if they are re-stated per route:
//
//   * an entrant who LOST must never appear anywhere in the output. Who
//     entered and did not win is nobody's business and publishing it invites
//     harassment;
//   * no user id ever leaves — not a winner's, not the viewer's. `winners` is
//     a list of strings, never objects;
//   * the draw seed and the winner list appear only AFTER `drawnAt`. Before
//     the draw the seed would let an entrant compute the outcome; after it, it
//     is the whole fairness proof;
//   * `draft` and `cancelled` giveaways are operator state and are not
//     public at all — production is holding an unpublished draft right now.
//
// Enforced by server/tests/giveawayPublicView.test.ts, which asserts over the
// object this returns rather than over route source: a grep for a `where`
// clause rots the moment someone refactors the query, a projection test does
// not.

/** The only statuses a player may ever be shown. */
export const PUBLIC_GIVEAWAY_STATUSES = ["open", "closed", "drawn"] as const;

/**
 * The entry columns the projection needs. Routes are expected to have ALREADY
 * narrowed the rows to `viewer OR winner` — that is what makes a losing
 * entrant's row something this process never loads — but the filtering below
 * is repeated anyway so a caller that forgets cannot leak.
 */
export interface GiveawayEntryRowForView {
  userId: string;
  username: string;
  isWinner: boolean;
}

export interface GiveawayRowForView {
  id: string;
  title: string;
  description: string;
  status: string;
  createdAt: Date;
  startsAt: Date | null;
  endsAt: Date | null;
  drawnAt: Date | null;
  winnerCount: number;
  minAccountLevel: number | null;
  prizes: string;
  drawSeed: string | null;
  entries: GiveawayEntryRowForView[];
  /** Prisma `_count: { select: { entries: true } }` — the TRUE entrant total. */
  _count?: { entries: number };
}

export interface PublicGiveawayView {
  id: string;
  title: string;
  description: string;
  status: string;
  createdAt: Date;
  startsAt: Date | null;
  endsAt: Date | null;
  drawnAt: Date | null;
  winnerCount: number;
  minAccountLevel: number | null;
  prizes: Prize[];
  prizeSummary: string;
  entryCount: number;
  hasEntered: boolean;
  youWon: boolean;
  /**
   * Whether the viewer's OWN prize has physically landed in their save.
   * `null` means "not applicable or not knowable" — they did not win, or the
   * win predates the PendingGrant queue (production holds 68 wins against 33
   * grant rows, so this is the common case on older giveaways). Never says
   * anything about anybody else: it is read from a single row scoped to the
   * viewer's user id.
   */
  youWonDelivered: boolean | null;
  /** Usernames only, and only once drawn. Losers are never listed. */
  winners: string[];
  /** Published after the draw so the result can be independently recomputed. */
  drawSeed: string | null;
}

export interface ShapeViewerContext {
  viewerId: string;
  /** giveawayId → delivered?, built from the VIEWER's own PendingGrant rows. */
  delivered?: ReadonlyMap<string, boolean>;
}

/**
 * Project one Giveaway row into what a player may see, or `null` if the row
 * is not public at all.
 */
export function shapePublicGiveaway(
  row: GiveawayRowForView,
  ctx: ShapeViewerContext,
): PublicGiveawayView | null {
  if (!(PUBLIC_GIVEAWAY_STATUSES as readonly string[]).includes(row.status)) return null;

  const entries = row.entries ?? [];
  const prizes = parsePrizes(row.prizes);
  const drawn = row.drawnAt != null;
  const youWon = entries.some((e) => e.userId === ctx.viewerId && e.isWinner);

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    // History with no date is not history. `createdAt` is the only date every
    // row is guaranteed to have — endsAt and drawnAt are both nullable, and
    // production holds drawn giveaways with endsAt === null.
    createdAt: row.createdAt,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    drawnAt: row.drawnAt,
    winnerCount: row.winnerCount,
    minAccountLevel: row.minAccountLevel,
    prizes,
    prizeSummary: describePrizes(prizes),
    // An aggregate, never a list. Prefer the DB's own count: the entry rows
    // above are deliberately narrowed, so counting them would under-report.
    entryCount: row._count?.entries ?? entries.length,
    hasEntered: entries.some((e) => e.userId === ctx.viewerId),
    youWon,
    youWonDelivered: youWon ? ctx.delivered?.get(row.id) ?? null : null,
    winners: drawn ? entries.filter((e) => e.isWinner).map((e) => e.username) : [],
    drawSeed: drawn ? row.drawSeed : null,
  };
}

/**
 * Lifetime, aggregate-only giveaway numbers. This exists for one reason: a
 * returning player needs to be able to SEE that giveaways happen regularly,
 * and one line ("13 giveaways · 68 prizes to 39 trainers · since 17 July")
 * does that better than any amount of copy.
 *
 * Deliberately NOT a top-winners leaderboard. The data supports one — 68 wins
 * are spread over 39 names and the repeats are visible — and it should not be
 * built: it aggregates a handful of named individuals into a target and hands
 * the "it's rigged" argument a headline. Per-giveaway winner lists are already
 * public and are enough.
 */
export interface GiveawayStats {
  /** Public giveaways ever held (draft/cancelled excluded). */
  total: number;
  /** Winner entries across all of them — i.e. prizes handed out. */
  prizesAwarded: number;
  /** How many DIFFERENT trainers have won at least once. */
  distinctWinners: number;
  /** When the first public giveaway was created. */
  firstAt: Date | null;
  /** The viewer's own record. Own data only. */
  you: { entered: number; won: number };
}
