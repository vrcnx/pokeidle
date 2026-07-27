import { createHash, randomBytes } from "node:crypto";

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
