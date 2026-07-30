import type { Pokemon } from "../types";

/**
 * Release confirmation policy — br_ff6112fc5180462b81 asked for a toggle that
 * skips the prompt, alongside bulk release.
 *
 * A pure predicate, and shared by all four release call sites (the PC cell menu,
 * the party row menu, the detail modal, and the bulk bar), because "the toggle
 * is on" is NOT the whole answer and a copy of that thought at each call site is
 * how one of them ends up wrong. Releasing is the only irreversible action in
 * the game, so the two exceptions below are structural rather than advisory.
 */

/** Should this SINGLE release ask before it happens? */
export function needsReleaseConfirm(mon: Pokemon, skipReleaseConfirm: boolean): boolean {
  // A shiny ALWAYS asks. The whole reason the toggle exists is bulk chaff —
  // 500 Magikarp — and the setting is enabled once and then forgotten, months
  // before the shiny shows up. Letting it cover a 1/8192 encounter would turn a
  // convenience into the most expensive misclick in the game.
  if (mon.isShiny) return true;
  return !skipReleaseConfirm;
}

/**
 * The wording for a SINGLE release, shared by every surface that asks.
 *
 * `needsReleaseConfirm` decides WHETHER to ask; this decides how loudly. The
 * two context menus only ever ask when the predicate says yes, so they always
 * get the full sentence. The detail modal asks unconditionally (its Release
 * button sits next to Close, and one stray tap must never be enough), so with
 * "skip confirmation" on it gets the short form — the toggle still buys the
 * player something, it just cannot buy them a one-tap deletion.
 */
export function releaseConfirmMessage(mon: Pokemon, skipReleaseConfirm: boolean): string {
  const name = mon.nickname?.trim() || mon.name;
  return needsReleaseConfirm(mon, skipReleaseConfirm)
    ? `Release ${name}? This cannot be undone.`
    : `Release ${name}?`;
}

/** Where a single release is being asked from. */
export type ReleaseSource = "party" | "box";

/**
 * The ids that appear MORE THAN ONCE in a list.
 *
 * RELEASE_POKEMON re-anchors on `pokemonId` with `list.findIndex(p => p.id ===
 * pokemonId)`, which resolves to the FIRST match. That is exactly right while
 * ids are unique and catastrophically wrong when they are not: releasing the
 * later of two Pokémon sharing an id destroys the earlier one, while every
 * surface — the cell, the modal header, the confirmation sentence — names the
 * later one. RELEASE_MANY has the mirror-image problem: it releases by a Set of
 * ids, so ticking one of the pair destroys BOTH.
 *
 * Ids are not guaranteed unique. `nextPokemonId` is a per-save counter that
 * RESTARTS at 1, so an admin reset or a cloud-lineage adopt can hand a
 * brand-new Pokémon an id an older one already holds — dexRepair's
 * `pokemonIdFloor` exists for precisely this, and its own comment names
 * "RELEASE_POKEMON's re-anchor releases a bystander" as the hazard. That repair
 * stops the counter MINTING a fresh collision; it cannot de-duplicate a
 * collision that arrives already inside an incoming save blob.
 *
 * So the UI refuses. The reducer is not ours to change and there is no payload
 * that reaches the second of two identical ids — an index would, but a bare
 * index is the stale-index hazard the id anchor was added to kill. Refusing is
 * the only answer that cannot delete the wrong Pokémon, and a release the
 * player has to retry after a reload is infinitely cheaper than one that
 * silently takes a different Pokémon.
 */
export function duplicateIdSet(list: readonly Pokemon[]): Set<string> {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const p of list) {
    if (seen.has(p.id)) dup.add(p.id);
    else seen.add(p.id);
  }
  return dup;
}

/** Said on the greyed row / disabled button, so it reads as a reason rather
 *  than a bug. Deliberately about the Pokémon, not about ids as a concept. */
export const AMBIGUOUS_ID_REASON =
  "Shares an ID with another Pokémon — releasing could delete the wrong one.";

/**
 * Why the reducer would REFUSE this release, or null if it would go through.
 *
 * A mirror of the three hard guards in RELEASE_POKEMON, and it exists because
 * the UI was promising an irreversible action and then silently doing nothing:
 * the detail modal offered Release on an auction-listed Pokémon, asked "this
 * cannot be undone", took the confirmation, and dispatched into a reducer that
 * correctly refused it. Nothing was destroyed — which is the only reason that
 * was a papercut rather than a disaster — but "confirm a permanent deletion
 * and watch nothing happen" is indistinguishable from a lost save.
 *
 * The reducer keeps its own copy on purpose. This one is about not showing the
 * player a lie; that one is about not losing a Pokémon if this one is wrong.
 */
export function releaseBlockedReason(
  mon: Pokemon,
  source: ReleaseSource,
  ctx: {
    listedPokemonIds: string[];
    party: Pokemon[];
    /** From duplicateIdSet() over the list this Pokémon lives in. Optional so
     *  a caller that cannot cheaply compute it keeps the old behaviour. */
    duplicateIds?: ReadonlySet<string>;
  },
): string | null {
  // First, because it is the only one of these whose failure mode is
  // destroying a DIFFERENT Pokémon rather than doing nothing.
  if (ctx.duplicateIds?.has(mon.id)) return AMBIGUOUS_ID_REASON;
  if (ctx.listedPokemonIds.includes(mon.id)) {
    return "Listed at the auction house — cancel the listing first.";
  }
  if (source !== "party") return null;
  const party = ctx.party;
  if (party.length <= 1) return "This is your last Pokémon.";
  // Anchored by id, exactly as the reducer anchors it — an index frozen when a
  // menu opened can point at a different party member by the time it is read.
  const index = party.findIndex((p) => p.id === mon.id);
  // Already gone from the party. The reducer drops the action; nothing to warn
  // about, and claiming a reason here would be inventing one.
  if (index < 0) return null;
  if (
    mon.currentHp > 0 &&
    !party.some((p, i) => i !== index && p.currentHp > 0)
  ) {
    return "This is your last healthy Pokémon.";
  }
  return null;
}

/**
 * The BULK confirmation is never skippable and always states the exact count.
 * `skipReleaseConfirm` is deliberately not a parameter — there is no argument
 * that could turn this off, which is the point.
 */
export function bulkReleaseConfirmMessage(count: number): string {
  return count === 1
    ? "Release 1 Pokémon? This cannot be undone."
    : `Release ${count} Pokémon? This cannot be undone.`;
}

/** Can this Pokémon be picked up by a multi-select bulk release?
 *
 *  Mirrors the reducer's RELEASE_MANY guards so the UI cannot even offer what
 *  the reducer would refuse. The reducer keeps its own copy on purpose — this
 *  one is about not showing the player a lie, that one is about not losing a
 *  Pokémon if this one is ever wrong. */
export function isBulkReleasable(
  mon: Pokemon,
  listedPokemonIds: string[],
  duplicateIds?: ReadonlySet<string>,
): boolean {
  if (mon.isShiny) return false;
  // RELEASE_MANY releases by a Set of ids, so a duplicated id takes BOTH
  // Pokémon out for one tick. See duplicateIdSet.
  if (duplicateIds?.has(mon.id)) return false;
  return !listedPokemonIds.includes(mon.id);
}
