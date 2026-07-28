import { pokemonTable } from "../data/pokemon";
import { encounters } from "../data/encounters";
import { evolutions } from "../data/evolutions";
import { routes } from "../data/routes";
import { trainerEncounters } from "../data/trainerEncounters";
import { regions, regionForLocation } from "../data/regions";
import { regionBadgeCount } from "./unlocks";
import type { GameState, Pokemon } from "../types";

// Team selection for the autonomous stream account.
//
// Left to itself the account keeps whatever it happened to catch first, so the
// party fills with Rattatas while a Dragonair sits forgotten in the PC. This
// scores every Pokémon it owns and keeps the best six in the party, which is
// both stronger (it stops losing gyms) and far better television.
//
// Score blends four things a viewer would also judge a mon on:
//   * raw power        — base stat total, the single biggest factor
//   * investment       — its level, so we don't bench a trained mon for a
//                        freshly caught one that is merely rarer
//   * rarity           — how uncommon it is in the wild (a species that
//                        appears nowhere in any encounter table is a
//                        legendary/raid catch and scores highest)
//   * room to grow     — fully evolved mons are worth more than a stage-1
//                        that is about to be outclassed
// Shinies get a deliberate bonus: they are the moments people clip.

/** Rarest wild weight per species; absent = never appears in the wild. */
const wildRarity: Map<string, number> = (() => {
  const m = new Map<string, number>();
  for (const loc of Object.values(encounters)) {
    for (const e of loc?.encounters ?? []) {
      const prev = m.get(e.speciesKey);
      if (prev == null || e.weight < prev) m.set(e.speciesKey, e.weight);
    }
  }
  return m;
})();

function baseStatTotal(speciesKey: string): number {
  const b = pokemonTable[speciesKey]?.baseStats;
  if (!b) return 0;
  return b.hp + b.attack + b.defense + b.spAttack + b.spDefense + b.speed;
}

/** 0 when the species still evolves, 1 when it's the end of its line. */
function isFullyEvolved(speciesKey: string): number {
  return (evolutions[speciesKey]?.length ?? 0) === 0 ? 1 : 0;
}

function rarityBonus(speciesKey: string): number {
  const w = wildRarity.get(speciesKey);
  // Never found in the wild → a raid legendary or a starter. Top billing.
  if (w == null) return 220;
  // Wild weights run ~1 (very rare) to ~28 (everywhere).
  return Math.max(0, Math.round((30 - w) * 6));
}

/** False for anything that appears in no encounter table anywhere — raid
 *  legendaries, starters, region gifts. Those are irreplaceable: there is no
 *  route the account could walk back to and re-catch one. */
export function isWildObtainable(speciesKey: string): boolean {
  return wildRarity.has(speciesKey);
}

export function scoreMon(p: Pokemon): number {
  return (
    baseStatTotal(p.speciesKey) * 1.0 +
    p.level * 7 +
    rarityBonus(p.speciesKey) +
    isFullyEvolved(p.speciesKey) * 90 +
    (p.isShiny ? 260 : 0)
  );
}

export interface TeamSwap { partyIndex: number; boxIndex: number; reason: string }

/**
 * The single most valuable party↔PC swap available, or null when the party is
 * already the best six. One swap at a time keeps the change legible on stream
 * and avoids thrashing the save.
 *
 * `margin` is hysteresis: a box mon must be meaningfully better than the party
 * mon it would replace, otherwise two similar mons would trade places forever.
 */
export function bestTeamSwap(state: GameState, margin = 60): TeamSwap | null {
  if (state.party.length === 0 || state.box.length === 0) return null;

  let worstPartyIdx = -1;
  let worstPartyScore = Infinity;
  state.party.forEach((p, i) => {
    // Never bench the mon that's currently out — swapping the active fighter
    // mid-stream is jarring and can drop the battle.
    if (i === state.activePlayerPokemonIndex) return;
    const s = scoreMon(p);
    if (s < worstPartyScore) { worstPartyScore = s; worstPartyIdx = i; }
  });
  if (worstPartyIdx === -1) return null;

  let bestBoxIdx = -1;
  let bestBoxScore = -Infinity;
  state.box.forEach((p, i) => {
    const s = scoreMon(p);
    if (s > bestBoxScore) { bestBoxScore = s; bestBoxIdx = i; }
  });
  if (bestBoxIdx === -1) return null;

  if (bestBoxScore <= worstPartyScore + margin) return null;
  return {
    partyIndex: worstPartyIdx,
    boxIndex: bestBoxIdx,
    reason: `${state.box[bestBoxIdx].name} (${Math.round(bestBoxScore)}) replaces ${state.party[worstPartyIdx].name} (${Math.round(worstPartyScore)})`,
  };
}

/**
 * Which party slot should be out front. Prefers a healthy mon that is BEHIND
 * the party's best level — that's how the team levels evenly instead of one
 * carry running away with every EXP drop while the rest stay useless.
 * Falls back to the strongest healthy mon when everything is level.
 */
export function bestLeadIndex(state: GameState, underLevelGap = 3): number {
  const healthy = state.party
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.currentHp > 0);
  if (healthy.length === 0) return -1;
  const topLevel = healthy.reduce((m, { p }) => Math.max(m, p.level), 0);

  // Anyone lagging the leader by more than the gap gets trained up first.
  const laggards = healthy.filter(({ p }) => topLevel - p.level > underLevelGap);
  if (laggards.length > 0) {
    // Train the strongest laggard — it survives longest and catches up fastest.
    return laggards.reduce((a, b) => (scoreMon(b.p) > scoreMon(a.p) ? b : a)).i;
  }
  return healthy.reduce((a, b) => (scoreMon(b.p) > scoreMon(a.p) ? b : a)).i;
}

/** The best thing in the PC. Used to rebuild a party that has somehow been
 *  emptied — at that point "best" is the only sensible pick, hysteresis and
 *  active-slot etiquette are irrelevant because there is nothing on screen. */
export function bestBoxIndex(state: GameState): number {
  let best = -1;
  let bestScore = -Infinity;
  state.box.forEach((p, i) => {
    const s = scoreMon(p);
    if (s > bestScore) { bestScore = s; best = i; }
  });
  return best;
}

/**
 * The box slots it is safe to let go of, worst first, at most `count` of them.
 *
 * Releasing is irreversible and it happens on camera, so this is deliberately
 * timid. It will only ever offer up genuinely disposable duplicates:
 *   * never a shiny — those are the clips people came for
 *   * never a species that appears in no wild encounter table (a raid
 *     legendary, a starter, a region gift): there is no route we could walk
 *     back to and re-catch one
 *   * never the last copy of a species we hold, so the collection on screen
 *     keeps one of everything. Note the Pokédex itself is never at risk
 *     either way — RELEASE_POKEMON's box branch is `{ ...state, box }` and
 *     does not touch `pokedexCaught` (reducer.ts:1572).
 *   * never anything scoring above `maxScore`. `scoreMon` is monotonic in
 *     LEVEL (+7/level) and in RARITY (+0…+174, and +220 for anything the
 *     wild tables never produce), so this one cap is simultaneously the
 *     "don't release a trained mon" and the "don't release a rare mon" rule:
 *     a level-47 Rattata or a level-1 Dratini both clear it.
 *
 * The BATCH form exists because a per-tick release of one is useless against
 * a 9,999-entry box. Two things make a batch safe that a loop of the single
 * form would not be:
 *   * the "last copy" ledger is decremented AS THE BATCH IS BUILT, so a
 *     batch can never take both of the only two Pidgeys.
 *   * the result is sorted DESCENDING. Callers dispatch one
 *     RELEASE_POKEMON per index against a shrinking array, and removing a
 *     higher index cannot move a lower one. Ascending order would release a
 *     different Pokémon on every dispatch after the first.
 */
export function worstBoxReleases(
  state: GameState,
  count: number,
  maxScore = 520,
): number[] {
  if (count <= 0 || state.box.length === 0) return [];

  const copies = new Map<string, number>();
  for (const p of [...state.party, ...state.box]) {
    copies.set(p.speciesKey, (copies.get(p.speciesKey) ?? 0) + 1);
  }

  const candidates: { index: number; score: number; key: string }[] = [];
  state.box.forEach((p, index) => {
    if (p.isShiny) return;
    if (!isWildObtainable(p.speciesKey)) return;
    const score = scoreMon(p);
    if (score > maxScore) return;
    candidates.push({ index, score, key: p.speciesKey });
  });
  // Worst first; ties broken by slot so the choice is deterministic and the
  // box still drains from the bottom.
  candidates.sort((a, b) => a.score - b.score || a.index - b.index);

  const picked: number[] = [];
  for (const c of candidates) {
    if (picked.length >= count) break;
    const left = copies.get(c.key) ?? 0;
    if (left <= 1) continue;
    copies.set(c.key, left - 1);
    picked.push(c.index);
  }
  return picked.sort((a, b) => b - a);
}

/** The single worst releasable slot, or null. Same rules as
 *  `worstBoxReleases`, which it is now a thin wrapper over. */
export function worstBoxRelease(state: GameState, maxScore = 520): number | null {
  return worstBoxReleases(state, 1, maxScore)[0] ?? null;
}

export interface FrontierHold {
  /** Where the account has to stand and fight. */
  locationId: string;
  /** The still-locked location this opens. */
  unlocks: string;
  /** Battles won there so far, and how many the gate wants. */
  have: number;
  need: number;
}

/**
 * The next progression gate the account can actually move, expressed as
 * "stand HERE until the counter reaches N".
 *
 * This exists because progression in both regions is bought with
 * `battlesAtLocation` counters (utils/unlocks.ts), and most of those counters
 * sit on TOWNS — which have no wild encounters at all, so the grind rule's
 * "pick the toughest route with encounters" filter can never target one. The
 * result was an account that could not finish Kanto, let alone reach Johto:
 * New Bark Town has no gym and no grass, so nothing in the old ladder had any
 * reason to send the bot there, and any tick it spent there the grind rule
 * dragged it straight back to Victory Road.
 *
 * Only gates we can close by standing somewhere are considered — a badge or
 * champion requirement is someone else's rung. `skip` lets the caller retire
 * a frontier that stubbornly refuses to move.
 */
export function frontierTarget(
  state: GameState,
  skip: (locationId: string) => boolean = () => false,
): FrontierHold | null {
  const unlocked = new Set(state.unlockedLocations);
  let best: (FrontierHold & { order: number }) | null = null;

  for (const [id, route] of Object.entries(routes)) {
    if (unlocked.has(id)) continue;
    // Raid islands have their own entry flow and no unlock chain.
    if (route.type === "raid") continue;

    const u = route.unlock;
    const reqs = u.battlesAtLocation ?? [];
    if (reqs.length === 0) continue;

    // Badge / champion gates can't be fixed by standing anywhere, so a route
    // still waiting on one isn't the frontier yet.
    const region = regions[regionForLocation(id) ?? ""];
    const badges = region ? regionBadgeCount(state, region) : state.defeatedGyms.length;
    if (u.badgesRequired && badges < u.badgesRequired) continue;
    if (u.championDefeated && !state.championDefeated) continue;

    // Every deficit has to be somewhere we can legally travel to AND somewhere
    // that can actually produce a battle — a location with neither trainers
    // nor wild encounters would park the stream forever on a counter that can
    // never tick.
    let pick: { locationId: string; have: number; need: number } | null = null;
    let reachable = true;
    for (const req of reqs) {
      const have = state.battlesWonByLocation[req.locationId] ?? 0;
      if (have >= req.count) continue;
      const farmable =
        (trainerEncounters[req.locationId]?.length ?? 0) > 0 ||
        (encounters[req.locationId]?.encounters?.length ?? 0) > 0;
      if (!unlocked.has(req.locationId) || !farmable || skip(req.locationId)) {
        reachable = false;
        break;
      }
      // Take the binding constraint — the deficit with the most left to do.
      if (!pick || req.count - have > pick.need - pick.have) {
        pick = { locationId: req.locationId, have, need: req.count };
      }
    }
    if (!reachable || !pick) continue;

    const order = route.unlockOrder ?? 0;
    if (!best || order < best.order) {
      best = { locationId: pick.locationId, unlocks: id, have: pick.have, need: pick.need, order };
    }
  }

  if (!best) return null;
  return { locationId: best.locationId, unlocks: best.unlocks, have: best.have, need: best.need };
}
