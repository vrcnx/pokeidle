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
