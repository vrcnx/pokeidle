// What a save upload is allowed to TAKE AWAY from the cloud copy.
//
// Two comparators, deliberately separate because they are enforced against
// different kinds of write:
//
//   milestoneSig / milestoneRegressed
//     Permanent progress that no legitimate play can undo: badges, Elite Four,
//     champion, Pokédex entries. Enforced against EVERY upload, versioned or
//     not, and has been since the v1 cross-device sync bug. Moved here
//     unchanged from routes/saves.ts — same fields, same comparison, same
//     `before`/`after` body — so that there is exactly one definition of
//     "regression" in the codebase.
//
//   destructiveLosses
//     SPENDABLE and DESTRUCTIBLE state: money, victory tokens, per-item
//     inventory quantities, the set of Pokémon the account owns, and the
//     append-only collection lists. All of these can legitimately go DOWN
//     during play — you spend money, you use a Potion, you release a mon — so
//     this comparator must NOT be applied to an ordinary upload.
//
//     It is for BLIND writes only: a POST that omits `expectedSaveVersion`.
//     Such a request has not proven it read the bytes it is replacing, so it
//     cannot be intending any particular subtraction from them; it is a whole
//     save landing on top of a cloud copy the sender may never have seen.
//     Refusing the subtraction is therefore never "losing a spend the player
//     meant" — it is refusing to apply an old lineage's arithmetic to bytes
//     from a newer one.
//
// NOTHING here merges, and nothing resolves a field by max(). A loss is a
// REFUSAL (409) and the caller keeps its bytes; taking the larger of two
// wallets would be a currency printer, which is the exact bug class the
// PendingGrant work exists to close.

export interface MilestoneSig {
  badges: number;
  e4: number;
  champion: boolean;
  caught: number;
}

const len = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

export function milestoneSig(s: Record<string, unknown>): MilestoneSig {
  return {
    badges: len(s.defeatedGyms),
    e4: len(s.defeatedEliteFour),
    champion: !!s.championDefeated,
    caught: len(s.pokedexCaught),
  };
}

export function milestoneRegressed(before: MilestoneSig, after: MilestoneSig): boolean {
  return after.badges < before.badges
    || after.e4 < before.e4
    || (before.champion && !after.champion)
    || after.caught < before.caught;
}

/** One dimension the incoming save would shrink. `field` is stable and
 *  machine-readable so the client (and a support ticket) can say exactly what
 *  was refused. */
export interface Loss {
  field: string;
  before: number;
  after: number;
}

/** Numeric fields that are pure spendable balance. */
const CURRENCY_FIELDS = ["money", "victoryTokens"] as const;

/** Arrays the game only ever appends to. `pokedexCaught` / `defeatedGyms` /
 *  `defeatedEliteFour` are deliberately NOT here — they belong to the
 *  milestone comparator above, which already guards them on every write. */
const APPEND_ONLY_LISTS = [
  "pokedexSeen",
  "shinyCaught",
  "shinySeen",
  "claimedRegionStarters",
] as const;

/** Every Pokémon id the save holds: active mon, party, box. Mons without a
 *  string id are untracked — validateSave permits `id` to be absent, and an
 *  untracked mon must not manufacture a phantom loss. */
function ownedIds(s: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const add = (m: unknown) => {
    if (!m || typeof m !== "object") return;
    const id = (m as { id?: unknown }).id;
    if (typeof id === "string" && id !== "") out.add(id);
  };
  add(s.playerPokemon);
  if (Array.isArray(s.party)) s.party.forEach(add);
  if (Array.isArray(s.box)) s.box.forEach(add);
  return out;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function inventoryOf(s: Record<string, unknown>): Record<string, unknown> {
  const inv = s.inventory;
  return inv && typeof inv === "object" && !Array.isArray(inv)
    ? (inv as Record<string, unknown>)
    : {};
}

/**
 * Every way `next` would destroy something `prior` holds. Empty array = the
 * incoming save is a superset in all of them and is safe to store blind.
 *
 * Comparison is one-directional on purpose: ADDING is always allowed. An old
 * tab that caught a Pokémon, earned money or bought Poké Balls during the
 * window where it cannot name a version still saves normally — which is the
 * whole reason this is a content guard and not a flat rejection of versionless
 * uploads.
 *
 * Every accessor is defensive: this runs on a blob parsed out of the database
 * and on one straight off the wire, and a throw here would 500 a save.
 */
export function destructiveLosses(
  prior: Record<string, unknown>,
  next: Record<string, unknown>,
): Loss[] {
  const losses: Loss[] = [];

  for (const f of CURRENCY_FIELDS) {
    const b = asNumber(prior[f]);
    if (b === null) continue;
    const a = asNumber(next[f]) ?? 0;
    if (a < b) losses.push({ field: f, before: b, after: a });
  }

  // Per ITEM KEY, not by total count. A fungible prize is a quantity on one
  // key: "5 Master Balls became 4" has to be visible even when the same blob
  // carries 200 more Poké Balls than the cloud copy does.
  const priorInv = inventoryOf(prior);
  const nextInv = inventoryOf(next);
  for (const [k, v] of Object.entries(priorInv)) {
    const b = asNumber(v);
    if (b === null || b <= 0) continue;
    const a = asNumber(nextInv[k]) ?? 0;
    if (a < b) losses.push({ field: `inventory.${k}`, before: b, after: a });
  }

  // Identity, not headcount: swapping a legendary for a Rattata keeps the box
  // length identical.
  const priorIds = ownedIds(prior);
  if (priorIds.size > 0) {
    const nextIds = ownedIds(next);
    let missing = 0;
    for (const id of priorIds) if (!nextIds.has(id)) missing++;
    if (missing > 0) {
      losses.push({ field: "pokemon", before: priorIds.size, after: priorIds.size - missing });
    }
  }

  for (const f of APPEND_ONLY_LISTS) {
    if (!Array.isArray(prior[f])) continue;
    const b = len(prior[f]);
    const a = len(next[f]);
    if (a < b) losses.push({ field: f, before: b, after: a });
  }

  return losses;
}
