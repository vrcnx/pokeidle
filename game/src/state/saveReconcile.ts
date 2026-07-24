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

// ─── Non-destructive cloud merge ─────────────────────────────────────────
// When the version signal fires (the SERVER wrote to this account — auction
// settlement / gift / giveaway / mass-gift) the browser may ALSO hold local
// progress the server never saw (money earned, mons caught, items bought
// since the last autosave upload). Wholesale-adopting cloud there wipes that
// unsynced progress — which is exactly the "my cash got reset" incident: a
// broad `saveVersion` bump (e.g. a mass Master Ball gift) made every
// recipient's client replace its live save with a behind-by-minutes cloud
// copy.
//
// mergeCloudAdvance keeps LOCAL as the base and folds in the server's
// ADDITIONS, never reducing a resource:
//   * money      → max(local, cloud)   never lose cash
//   * inventory  → per-item max         never lose items; delivers gifted items
//   * box        → local ∪ cloud-only   delivers gifted / auction-won Pokémon
//   * milestones → union                badges / E4 / dex / locations / champion
// The one thing it can't do without a shared baseline is apply a server
// REMOVAL (a sold/traded mon) to an OFFLINE seller — a narrow, known gap that
// auction escrow closes at the source. Resetting cash for thousands of active
// players is the far worse failure, so we err on never-lose.

function num(v: unknown): number { return typeof v === "number" && Number.isFinite(v) ? v : 0; }
function invOf(s: any): Record<string, number> {
  const inv = s?.inventory;
  return inv && typeof inv === "object" && !Array.isArray(inv) ? (inv as Record<string, number>) : {};
}
function pokeId(p: any): string | null { return p && p.id != null ? String(p.id) : null; }
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

export function mergeCloudAdvance(local: any, cloud: any): any {
  const merged: any = { ...local };

  // Money — never below the local balance.
  merged.money = Math.max(num(local?.money), num(cloud?.money));

  // Inventory — per-item max (delivers gifted items, never removes bought ones).
  const li = invOf(local), ci = invOf(cloud);
  const inv: Record<string, number> = {};
  for (const k of new Set([...Object.keys(li), ...Object.keys(ci)])) {
    const q = Math.max(num(li[k]), num(ci[k]));
    if (q > 0) inv[k] = q;
  }
  merged.inventory = inv;

  // Box — keep every local mon, add any cloud mon whose id local doesn't hold
  // (a gifted or auction-won Pokémon the server dropped into the box).
  const localParty = Array.isArray(local?.party) ? local.party : [];
  const localBox = Array.isArray(local?.box) ? local.box : [];
  const cloudBox = Array.isArray(cloud?.box) ? cloud.box : [];
  const cloudParty = Array.isArray(cloud?.party) ? cloud.party : [];
  const localIds = new Set<string>();
  for (const p of [...localParty, ...localBox]) { const id = pokeId(p); if (id) localIds.add(id); }
  const additions = [...cloudBox, ...cloudParty].filter((p) => {
    const id = pokeId(p);
    return id != null && !localIds.has(id);
  });
  merged.party = localParty;
  merged.box = [...localBox, ...additions];

  // nextPokemonId must stay ahead of every id we now hold.
  merged.nextPokemonId = Math.max(num(local?.nextPokemonId), num(cloud?.nextPokemonId));

  // Milestone unions — only when the field is actually present on a side, so
  // we never clobber a local field with [] just because cloud omitted it.
  unionInto(merged, local, cloud, "defeatedGyms");
  unionInto(merged, local, cloud, "defeatedEliteFour");
  unionInto(merged, local, cloud, "pokedexCaught");
  unionInto(merged, local, cloud, "pokedexSeen");
  unionInto(merged, local, cloud, "unlockedLocations");
  unionInto(merged, local, cloud, "claimedRegionStarters");
  merged.championDefeated = !!local?.championDefeated || !!cloud?.championDefeated;

  return merged;
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
