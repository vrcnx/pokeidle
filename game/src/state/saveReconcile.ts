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
  /**
   * ── THE TWO THINGS THAT WENT MISSING ──────────────────────────────
   *
   * This signature is how the boot decides whether the cloud copy or the
   * local one survives, and for a long time it measured seven things —
   * none of which was a Pokemon's LEVEL or whether it was SHINY.
   *
   * Three players reported the same shape within a week, and one of them
   * described it exactly: "only the Pokemon (Pokedex/shiny) and levels were
   * reset; everything else (League, auctions, money) seemed the same."
   *
   * That is this signature, inverted. Everything it could see survived.
   * Everything it could not see was thrown away — because a save that is
   * hours behind on levels and shinies, but level with the other on badges,
   * dex COUNT and money, looked identical to it. The older copy won, and
   * then uploaded over the newer one with a version the server accepted.
   */
  shinies: number;
  /** Total levels across party and box. */
  levels: number;
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
    shinies: Array.isArray(s?.shinyCaught) ? s.shinyCaught.length : 0,
    levels: sumLevels(s),
  };
}

/** Total levels held, party and box. Not a milestone — a Pokemon can be
 *  released, traded or auctioned — so this only ever breaks a TIE, never
 *  vetoes. See the note in localHasMoreMilestones. */
function sumLevels(s: any): number {
  let n = 0;
  for (const list of [s?.party, s?.box]) {
    if (!Array.isArray(list)) continue;
    for (const m of list) if (m && typeof m.level === "number") n += m.level;
  }
  return n;
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
  // A shiny is registered append-only, exactly like the dex, so cloud holding
  // one local has never seen means cloud is genuinely ahead. This is the
  // check whose absence let a save with two fewer shinies win.
  if (c.shinies > l.shinies) return true;
  if (
    c.boxParty > l.boxParty + 1 && // +1 slack to swallow lock-window race
    c.money >= l.money
  ) return true;
  // EVERY MILESTONE LEVEL, AND THE SAME COLLECTION. This is the case the
  // reports describe: an hour of levelling adds no dex entry, no badge and no
  // box slot, so the two copies were indistinguishable and the older one could
  // win on a coin flip. Levels are the only thing left that differs, so they
  // decide it.
  //
  // A margin, not `>`, because levels move for innocent reasons — an
  // evolution, a released runt — and a one-level difference is not evidence of
  // a fresher save. Fifteen is about a quarter of an hour of play.
  if (
    c.money >= l.money &&
    c.levels > l.levels + 15
  ) return true;
  return false;
}

// ── WHY THE MILESTONE-EQUALITY GATE IS GONE ───────────────────────────────
// Both tie-breaks above used to additionally require
//     c.e4 === l.e4 && c.badges === l.badges && c.caught === l.caught &&
//     c.locations === l.locations && c.shinies === l.shinies
// which is the exact logical NEGATION of localHasMoreMilestones below. So
// whenever the veto could fire, the tie-breaks were structurally unreachable
// and this function could only return false. A local copy ahead by a SINGLE
// dex entry beat a cloud copy holding an arbitrary amount of play, and boot
// took the wholesale "local extends cloud" branch and uploaded over it. That
// is the "played all evening on my phone, opened the laptop, lost the
// evening" report — and it is why the levels/shinies signal added earlier
// never actually fired for the case it was written for.
//
// Dropping the gate is safe precisely BECAUSE of what the caller does with a
// true. When cloud wins and local is usable, GameContext does NOT overwrite —
// it runs mergeCloudAdvance, which unions the monotonic milestones from both
// lineages (so local's extra dex entry survives) and takes the spendable set
// whole from whichever side holds more play. A fork where each side has
// something the other lacks is exactly what a merge is for; answering it by
// picking one side wholesale is what lost data in both directions.
//
// The two substantive guards are kept and are doing the real work:
//   * `c.money >= l.money` — a copy with less money is not unambiguously
//     fresher, it may be the one that has not seen a purchase.
//   * the +15 level / +1 box margins — levels and box counts move for
//     innocent reasons (an evolution, a release, a trade), and a one-unit
//     difference is not evidence of a fresher save.

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
  // Shinies veto too — append-only, so local holding one cloud lacks is local
  // being genuinely ahead, and adopting cloud would delete it. This is the
  // half that protects the player whose device is the fresher one.
  //
  // LEVELS DELIBERATELY DO NOT VETO. They fall when a Pokemon is released,
  // traded or auctioned, and a veto on them would let a stale device refuse
  // every authoritative server write — including the settlement that took the
  // Pokemon whose levels are missing. They break ties above; they do not block.
  if (l.shinies > c.shinies) return true;
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
  // Route-mastery tiers already paid out. Unioned in the ANTI-duplication
  // direction, exactly like claimedRegionStarters: a claim recorded on
  // EITHER lineage has to survive the merge, or a tier taken on the copy
  // that loses becomes claimable again and pays a second time.
  "claimedMastery",
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
  "autoEvolve",
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

/** Enough of a lost Pokémon to name it to the player. */
export interface LostMon {
  id: string;
  speciesKey: string;
  name: string;
  isShiny: boolean;
  level: number;
}

/**
 * The Pokémon the LOSING lineage held and the winning one does not.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 * A player reported a shiny Scyther that was in their Pokédex but in neither
 * their party nor their PC, and read it — reasonably — as the game having
 * eaten it. It is not corruption. It is this merge, working exactly as
 * designed: `pokedexCaught` and `shinyCaught` are MONOTONIC and unioned from
 * both lineages, while party and box are SPENDABLE and taken whole from one.
 * So a Pokémon caught on the lineage that loses leaves its dex entry behind
 * and takes the Pokémon with it. Every alternative is worse — unioning the box
 * resurrects mons the other lineage sold, which is the duplication exploit the
 * comments above spend two screens explaining.
 *
 * What was genuinely wrong is that it happened SILENTLY. A designed rollback
 * nobody is told about is indistinguishable from a bug, and the player's next
 * move is a report we cannot act on. So the merge now says what it cost.
 *
 * Matched on id AND species: `nextPokemonId` is a shared counter, so two
 * lineages that both kept playing can mint the same id for different Pokémon.
 * Treating that as "still present" would hide the one case most worth naming.
 */
export function lineageCasualties(local: any, cloud: any): LostMon[] {
  const side = spendableSide(local, cloud);
  const winner = side === "cloud" ? cloud : local;
  const loser = side === "cloud" ? local : cloud;

  const key = (m: any) => `${m?.id}|${m?.speciesKey}`;
  const kept = new Set<string>();
  for (const m of [...arr(winner?.party), ...arr(winner?.box)]) kept.add(key(m));

  const out: LostMon[] = [];
  const seen = new Set<string>();
  for (const m of [...arr(loser?.party), ...arr(loser?.box)] as any[]) {
    if (!m || typeof m.speciesKey !== "string") continue;
    const k = key(m);
    if (kept.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push({
      id: String(m.id),
      speciesKey: m.speciesKey,
      name: m.nickname || m.name || m.speciesKey,
      isShiny: !!m.isShiny,
      level: num(m.level),
    });
  }
  // Shinies first, then the highest level. If the list has to be truncated for
  // a message, the entries a player would actually miss are the ones kept.
  return out.sort((a, b) =>
    (Number(b.isShiny) - Number(a.isShiny)) || (b.level - a.level));
}

/**
 * What to tell the player, or null if the merge cost them nothing.
 *
 * Pure and here rather than at the call site so the wording is testable and so
 * it stays one sentence in one place. It has to do three things: say a
 * rollback happened, NAME what went (a count alone is worse than silence —
 * the player still has to go hunting), and say what was kept, because the dex
 * entry they can still see is the thing that makes this look like corruption.
 */
export function lostMonsMessage(lost: LostMon[]): string | null {
  if (lost.length === 0) return null;
  const SHOWN = 3;
  const named = lost
    .slice(0, SHOWN)
    .map((m) => `${m.isShiny ? "✨ " : ""}${m.name} Lv${m.level}`)
    .join(", ");
  const rest = lost.length - SHOWN;
  return (
    `Another session's save was further ahead, so this browser's copy was rolled back. ` +
    `${lost.length === 1 ? "This Pokémon was" : "These Pokémon were"} only on the copy that lost: ` +
    `${named}${rest > 0 ? ` and ${rest} more` : ""}. Their Pokédex entries were kept.`
  );
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
