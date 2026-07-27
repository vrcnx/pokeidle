import type { GameState } from "../types";

// ─────────────────────────────────────────────────────────────────────────
// Pure save-reconciliation logic, extracted from GameContext so it can be
// unit-tested in isolation (this is the highest-blast-radius logic in the
// app — it decides, on every boot, whether to trust the browser's local
// save or the cloud copy for all 2,235 accounts).
// ─────────────────────────────────────────────────────────────────────────

interface Sig {
  badges: number;
  e4: number;
  champion: boolean;
  caught: number;
  boxParty: number;
  locations: number;
  money: number;
}

function sigOf(s: any): Sig {
  return {
    badges: Array.isArray(s?.defeatedGyms) ? s.defeatedGyms.length : 0,
    e4: Array.isArray(s?.defeatedEliteFour) ? s.defeatedEliteFour.length : 0,
    champion: !!s?.championDefeated,
    caught: Array.isArray(s?.pokedexCaught) ? s.pokedexCaught.length : 0,
    boxParty:
      (Array.isArray(s?.party) ? s.party.length : 0) +
      (Array.isArray(s?.box) ? s.box.length : 0),
    locations: Array.isArray(s?.unlockedLocations) ? s.unlockedLocations.length : 0,
    money: typeof s?.money === "number" ? s.money : 0,
  };
}

// Heuristic tie-break (the pre-existing behaviour): cloud wins if it is
// strictly ahead on any milestone, or — with all milestones equal — has a
// meaningfully bigger collection AND at least as much money. Used only when
// the version signal (below) can't decide.
export function cloudHasMoreProgress(cloudData: any, local: GameState): boolean {
  const c = sigOf(cloudData);
  const l = sigOf(local);
  if (c.e4 > l.e4) return true;
  if (c.champion && !l.champion) return true;
  if (c.badges > l.badges) return true;
  if (c.caught > l.caught) return true;
  if (c.locations > l.locations) return true;
  if (
    c.e4 === l.e4 && c.badges === l.badges && c.caught === l.caught &&
    c.locations === l.locations &&
    c.boxParty > l.boxParty + 1 && // +1 slack to swallow lock-window race
    c.money >= l.money
  ) return true;
  return false;
}

// The version signal. The server bumps `saveVersion` on every authoritative
// write it makes to an account: auction settlements, admin gifts/edits,
// giveaway grants, or another device's upload. The client stamps the cloud
// version it last synced with into localStorage; if the cloud has advanced
// PAST that, the server holds changes this browser has never seen and cloud
// must win — otherwise this browser's local copy (which predates those
// writes) would be re-uploaded and silently clobber them. This is exactly
// why an auctioned Pokémon never reached an offline winner, and why an
// offline seller's client could resurrect a mon it had already sold (a dupe).
//
// Returns false when there is no persisted sync version (a fresh browser, or
// any client that has not yet synced once under this build). In that case the
// caller falls back to the heuristic above, so legacy boots behave EXACTLY as
// before — the version path only ever ACTIVATES progress-preservation, it
// never weakens it.
export function serverAdvancedBeyondSync(
  cloudSaveVersion: number | null | undefined,
  persistedSyncVersion: number | null | undefined,
): boolean {
  if (typeof persistedSyncVersion !== "number") return false;
  if (typeof cloudSaveVersion !== "number") return false;
  return cloudSaveVersion > persistedSyncVersion;
}

// True if LOCAL is strictly ahead of cloud on any story milestone. Used to
// veto the version signal: even when the server advanced the version, we must
// NOT adopt cloud if doing so would erase a badge / E4 / champion / dex /
// location that local has and cloud doesn't. This protects the dangerous
// multi-device case (a device that's further in the story but hasn't synced
// recently must not be overwritten by another device's newer-but-behind
// cloud copy). Auction settlements and gifts never change milestones, so this
// guard never blocks them — it only blocks genuine story-progress loss.
export function localHasMoreMilestones(local: any, cloud: any): boolean {
  const l = sigOf(local);
  const c = sigOf(cloud);
  if (l.e4 > c.e4) return true;
  if (l.champion && !c.champion) return true;
  if (l.badges > c.badges) return true;
  if (l.caught > c.caught) return true;
  if (l.locations > c.locations) return true;
  return false;
}

// ─── Cloud merge ─────────────────────────────────────────────────────────
// When the version signal fires (the SERVER wrote to this account, or another
// device did) the browser may ALSO hold progress that never reached the cloud
// — money earned, mons caught, items bought while offline or since the last
// autosave. Two lineages have forked from a common ancestor: whatever the
// cloud held at `persistedSyncVersion`.
//
// ── WHY THIS NO LONGER RESOLVES BY max() ────────────────────────────
// It used to keep LOCAL as the base and fold in the server's ADDITIONS by
// never reducing a resource: money = max(local, cloud), inventory = per-item
// max, box = local ∪ cloud. That reads as "never lose anything" and is
// actually a currency printer, because it takes money from one lineage and
// goods from the other:
//
//   Player pauses (no badge/dex/location change, so nothing vetoes the merge)
//   and goes offline. Spends 900,000 in the shop; writeLocalSave is
//   unconditional so the spend is durable locally, while every upload fails so
//   the persisted sync version stays at N. They reload — still offline, so
//   nothing can upload. A second device, online and booted from the pre-spend
//   cloud copy at N, ticks once and pushes. Device A comes back, boots,
//   `serverAdvancedBeyondSync` fires, and the merge sets
//   money = max(local 100k, cloud 1M) = 1M while per-item max keeps everything
//   the 900k bought. Money refunded, goods kept. No race, no failure, and it
//   repeats on every boot that satisfies it.
//
// The same mechanism refunds consumed Poké Balls and potions, and resurrects a
// mon the other lineage no longer has.
//
// ── THE RULE ────────────────────────────────────────────────────────
// SPENDABLE state — money, inventory, party, box, victory tokens, active
// consumables, raid lockouts — is taken from exactly ONE side, whole.
// Coherence is the property that matters: a balance and the goods it bought
// have to come from the same lineage, or the difference is free. Mixing is
// what creates value; picking a side can only ever LOSE it.
//
// "Whole" includes the keys the winning blob does NOT have. A blob written by
// an older build simply omits a field (pickPersistent stores `undefined` and
// JSON.stringify drops the key), and "keep local's value when the winner
// doesn't say" is mixing by another name: a cloud blob with no `inventory`
// refunds the money and keeps the goods, one with no `party` puts the same
// mon in the party and the box. So the whole set is materialised from the
// chosen side, with absence meaning empty/zero — see spendableFrom.
//
// That is also why the choice of side is allowed to be a heuristic. It decides
// what a player loses, never whether currency is duplicated.
//
// MONOTONIC state — badges, Elite Four, champion, dex, shinies, unlocked
// locations, claimed region starters, defeated trainers — is unioned from both
// sides, because it only ever grows and cannot be spent. So the rollback the
// player experiences is limited to fungible things; no story progress, no
// Pokédex entry and no unlocked route is ever taken back. (`claimedRegionStarters`
// unions in the ANTI-duplication direction: a claim recorded on either side
// stops the free starter being handed out twice.)

function num(v: unknown): number { return typeof v === "number" && Number.isFinite(v) ? v : 0; }
function unionArr(a: any, b: any): any[] {
  const out: any[] = [];
  const seen = new Set<string>();
  for (const arr of [a, b]) {
    if (!Array.isArray(arr)) continue;
    for (const x of arr) {
      const k = typeof x === "object" ? JSON.stringify(x) : String(x);
      if (!seen.has(k)) { seen.add(k); out.push(x); }
    }
  }
  return out;
}
function unionInto(merged: any, local: any, cloud: any, key: string): void {
  if (Array.isArray(local?.[key]) || Array.isArray(cloud?.[key])) {
    merged[key] = unionArr(local?.[key], cloud?.[key]);
  }
}

// Every list here only ever gets appended to by the reducer, and none of it
// can be spent, sold or consumed. Unioning them is therefore free: it cannot
// manufacture a resource, and it stops the losing lineage's story progress
// from being rolled back along with its wallet.
const MONOTONIC_KEYS = [
  "defeatedGyms",
  "defeatedEliteFour",
  "defeatedChampions",
  "pokedexCaught",
  "pokedexSeen",
  "shinyCaught",
  "shinySeen",
  "unlockedLocations",
  "claimedRegionStarters",
  "defeatedTrainers",
];

// ── The spendable unit ───────────────────────────────────────────────
// Everything a player can spend, consume, sell, lose or be locked out of. It
// travels as ONE unit from ONE lineage, and this function is the only place
// that decides what "the whole unit" is.
//
// Every key is materialised whether the source has it or not, because absence
// is the dangerous case: a key left off the result inherits whatever the
// consumer already had — the local blob in a merge, the LIVE session in a
// `LOAD_SAVE` dispatch (the reducer does `{...state, ...payload}`) — and that
// is precisely the money-refund-plus-goods mix. Absent therefore means the
// canonical empty, NOT "keep whatever was there".
//
// It must not fall back to initialState either: that hands out $3,000 and 20
// Poké Balls, which would make an omitted key a way to mint currency instead
// of merely losing it.
export interface SpendableState {
  money: number;
  inventory: Record<string, number>;
  party: unknown[];
  box: unknown[];
  playerPokemon: unknown;
  activePlayerPokemonIndex: number;
  victoryTokens: number;
  activeEffects: unknown[];
  raidCooldownEnd: unknown;
  raidCooldowns: Record<string, number>;
  raidLegendary: unknown;
  inRaid: boolean;
  raidLevel: number;
  preRaidLocation: unknown;
}

/** The keys spendableFrom owns, so callers can assert they are covered. */
export const SPENDABLE_KEYS: readonly (keyof SpendableState)[] = [
  "money", "inventory", "party", "box", "playerPokemon",
  "activePlayerPokemonIndex", "victoryTokens", "activeEffects",
  "raidCooldownEnd", "raidCooldowns", "raidLegendary", "inRaid", "raidLevel",
  "preRaidLocation",
];

function plainObj(v: unknown): Record<string, number> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, number>) : {};
}
function arr(v: unknown): unknown[] { return Array.isArray(v) ? v : []; }

/**
 * The complete spendable set, read out of ONE blob.
 *
 * `playerPokemon` / `activePlayerPokemonIndex` are in here because they are
 * part of the party, not state of their own: an active mon pointing into the
 * other lineage's team makes `syncPlayerToParty` a silent no-op (it bails when
 * `party[idx].id !== playerPokemon.id`), so the active mon's EXP and HP stop
 * reaching its party row for the rest of the session. Callers that filter the
 * party afterwards must re-anchor them — see the boot/adopt paths.
 *
 * The raid fields are here because a cooldown is a spent resource: taking the
 * losing lineage's cooldowns is a free extra legendary raid.
 */
export function spendableFrom(side: any): SpendableState {
  return {
    money: num(side?.money),
    inventory: plainObj(side?.inventory),
    party: arr(side?.party),
    box: arr(side?.box),
    playerPokemon: side?.playerPokemon ?? null,
    activePlayerPokemonIndex: num(side?.activePlayerPokemonIndex),
    victoryTokens: num(side?.victoryTokens),
    activeEffects: arr(side?.activeEffects),
    raidCooldownEnd: side?.raidCooldownEnd ?? null,
    raidCooldowns: plainObj(side?.raidCooldowns),
    raidLegendary: side?.raidLegendary ?? null,
    inRaid: !!side?.inRaid,
    raidLevel: num(side?.raidLevel),
    preRaidLocation: side?.preRaidLocation ?? null,
  };
}

// Player-facing preferences: not spendable, not monotonic, and worth keeping
// when the winning blob is old enough not to carry them. Explicitly listed
// because this is the ONLY exception to "the winning side decides", and an
// exception that grows by accident is how mixing comes back.
const PREFERENCE_KEYS = [
  "speed",
  "autoCatch",
  "autoProceed",
  "battleMode",
  "alwaysCatchShinies",
  "catchSettings",
  "globalCatchDefaults",
];

/**
 * How much PLAY a lineage contains. Both counters are strictly incrementing in
 * the reducer (`+ 1` on a win, never reset, never spent), so they measure the
 * one thing we actually want to compare.
 */
function playCount(s: any): number {
  return num(s?.wildBattlesWon) + num(s?.trainerBattlesWon);
}

/**
 * Which lineage keeps its spendable state.
 *
 * Both sides descend from the same fork point — the cloud as it stood at
 * `persistedSyncVersion`. So the play a lineage has accumulated since the fork
 * is `playCount(side) − playCount(fork)`, and since the fork term is shared,
 * comparing the two totals compares the two amounts of work directly. Picking
 * the larger one discards the smaller body of play. We cannot keep both
 * without mixing lineages, and mixing lineages is what printed the money.
 *
 * Ties go to CLOUD, and the tie is the common case that matters. Server-side
 * writes — an auction settlement, a trade, an admin action — add no battles at
 * all, so an account whose cloud advanced for one of those reasons resolves to
 * "cloud, at zero cost to local". Same for a browser that was fully synced and
 * merely came back to find another device had played: local has nothing to
 * lose, so cloud simply wins.
 *
 * Cloud also wins whenever local looks unusable or empty, so a blank or
 * corrupt local blob can never claim authority over a real cloud save.
 */
export function spendableSide(local: any, cloud: any): "local" | "cloud" {
  if (!local || typeof local !== "object" || !local.playerPokemon) return "cloud";
  if (!cloud || typeof cloud !== "object" || !cloud.playerPokemon) return "local";
  return playCount(local) > playCount(cloud) ? "local" : "cloud";
}

export function mergeCloudAdvance(local: any, cloud: any): any {
  const side = spendableSide(local, cloud);
  const base = side === "cloud" ? cloud : local;
  const other = side === "cloud" ? local : cloud;

  // Start from the WINNING side, not from local. Starting from local and
  // overwriting with "everything base defines" is what produced the bug this
  // structure replaced: a key base simply omits keeps the LOSING lineage's
  // value, so cloud-wins-without-`inventory` refunds the money and keeps the
  // goods, and cloud-wins-without-`party` leaves the same mon in the party and
  // the box. Absence has to mean "the winner has none", not "ask the loser".
  const merged: any = { ...base };

  // …with two explicit, narrow exceptions, both of which can only ever move
  // NON-spendable state.
  //
  // 1. Preferences. A blob written before a setting existed omits it, and
  //    resetting someone's battle speed because the other device is a version
  //    behind is gratuitous. Cannot carry value: none of these is spendable.
  for (const k of PREFERENCE_KEYS) {
    if (merged[k] === undefined && other?.[k] !== undefined) merged[k] = other[k];
  }
  // 2. Monotonic milestones, unioned from BOTH sides — only when the field is
  //    actually present on a side, so we never clobber with [] just because
  //    one side omitted it. These only ever grow and cannot be spent, so a
  //    union cannot manufacture anything, and it stops the losing lineage's
  //    story progress being rolled back along with its wallet.
  for (const k of MONOTONIC_KEYS) unionInto(merged, local, cloud, k);
  merged.championDefeated = !!local?.championDefeated || !!cloud?.championDefeated;

  // THE SPENDABLE UNIT — every key materialised from `base`, including the
  // ones `base` does not have (they become empty/zero, never local's). This
  // assignment is last so nothing above can leave a spendable key mixed.
  Object.assign(merged, spendableFrom(base));

  // A counter, not a resource: it hands out the next id and only moves up.
  // Taking the max costs nothing and stops the losing lineage's ids from being
  // minted a second time, which would collide with rows (trades, auctions,
  // battle history) that key on them.
  merged.nextPokemonId = Math.max(num(local?.nextPokemonId), num(cloud?.nextPokemonId));

  // A prize grant is unaffected by which side wins, and that is by design:
  // delivery is recorded in PendingGrant.deliveredAt, in the database. This
  // function cannot un-deliver a grant, and there is deliberately nothing in
  // the blob for it to carry that could. If the losing lineage was the one
  // holding a just-delivered prize, that prize is lost with the rest of that
  // lineage's spendable state — which is why the fold bumps saveAdoptSeq, so
  // a delivered prize is adopted wholesale and never reaches this decision.

  return merged;
}

/**
 * Turn a cloud blob into the state to LOAD, WHOLESALE. The single builder for
 * every adopt path — boot forced-adopt, the `save:adopt` socket event, the
 * 409 re-read, and the no-usable-local boot branch — because all four have the
 * same two ways to go wrong.
 *
 * 1. SPENDABLE STATE MUST NOT LEAK FROM LOCAL. The reducer's `LOAD_SAVE` is a
 *    merge (`{...state, ...payload}`), so any key this payload omits keeps the
 *    LIVE session's value. A cloud blob written by an older build omits keys
 *    it never had (pickPersistent stores `undefined`; JSON.stringify drops
 *    it), and a cloud blob with no `inventory` would then mean "cloud's money,
 *    local's items" — the same refund-plus-goods mix mergeCloudAdvance was
 *    rewritten to eliminate. `spendableFrom` materialises the whole set from
 *    the cloud copy, absent keys included, so an adopt is genuinely wholesale.
 *
 * 2. THE ACTIVE MON MUST BE RE-ANCHORED. `syncPlayerToParty` bails silently
 *    when `party[activePlayerPokemonIndex].id !== playerPokemon.id`, and from
 *    then on the active mon's EXP and HP never reach its party row — visible
 *    in battle, gone at the next save. The cloud's index can be stale, and the
 *    `speciesKey` filter below can drop entries and shift it, so the index is
 *    re-derived from the party we actually ended up with, by id, exactly as
 *    loadSaved does for a local blob.
 *
 * This can only ever DISCARD local state, never combine two lineages, so it
 * cannot duplicate or mint anything: the result is the cloud copy plus the
 * transients a fresh load always resets.
 *
 * `normalizeMon` is injected rather than imported so this module stays pure
 * and dependency-free (it is the highest-blast-radius logic in the app and is
 * meant to be executable in isolation). GameContext passes its own
 * normalizePokemon.
 */
export function adoptCloudWholesale(
  cloud: any,
  normalizeMon: (p: any) => any,
): any {
  const spendable = spendableFrom(cloud);
  const normParty = spendable.party
    .filter((p: any) => p && typeof p.speciesKey === "string")
    .map(normalizeMon);
  const normBox = spendable.box
    .filter((p: any) => p && typeof p.speciesKey === "string")
    .map(normalizeMon);
  const activeId = (spendable.playerPokemon as { id?: string } | null)?.id;
  let activeIdx = normParty.findIndex((p: any) => p.id === activeId);
  if (activeIdx < 0) activeIdx = 0;
  return {
    ...cloud,
    ...spendable,
    party: normParty,
    box: normBox,
    playerPokemon: normParty[activeIdx] ?? null,
    activePlayerPokemonIndex: activeIdx,
    // Transients, reset exactly as loadSaved resets them. Without this an
    // adopt taken mid-battle keeps `awaitingSwitch` or a trainer battle
    // pointing at a party that no longer exists.
    phase: "idle",
    enemyPokemon: null,
    battleEvents: [],
    pendingEvents: [],
    currentEventIndex: 0,
    trainerBattle: null,
    bossBattle: null,
    bossQueue: [],
    pendingBossBattle: null,
    healingState: null,
    playerVolatile: null,
    evolutionState: null,
    awaitingSwitch: false,
  };
}

// The combined "should the cloud copy replace local?" decision, given both
// the version signal and the heuristic. Kept tiny and pure so the test suite
// can pin every branch. `localUsable` is false when there is no valid local
// save (fresh tab / cleared storage / foreign blob) — in which case cloud
// always wins so we never overwrite a real cloud row with initialState.
export function cloudShouldWin(args: {
  localUsable: boolean;
  cloudData: any;
  cloudSaveVersion: number | null | undefined;
  local: GameState;
  persistedSyncVersion: number | null | undefined;
}): boolean {
  if (!args.localUsable) return true;
  // Version signal — but never at the cost of a story milestone local holds.
  if (
    serverAdvancedBeyondSync(args.cloudSaveVersion, args.persistedSyncVersion) &&
    !localHasMoreMilestones(args.local, args.cloudData)
  ) return true;
  return cloudHasMoreProgress(args.cloudData, args.local);
}
