import type { GameState, GymLeader } from "../types";
import { regions } from "../data/regions";
import type { Region } from "../data/regions";

// Endgame rematch selection for the stream director.
//
// Once a region is finished the ladder has nothing left below the raid but the
// wild-route rotation: wild battles pay NOTHING (money enters the save only
// through endTrainerBattle and endBossBattle — reducer.ts:2301 says so out
// loud), the dex stops moving once the reachable species are caught, and a
// level-100 party punching Rattatas is hours of dead air. Refighting gym
// leaders and the League is the fix: boss fights are the most watchable thing
// the account can do, and endBossBattle pays out on EVERY win, not just the
// first.
//
// Pure and stateless on purpose — the caller owns the clock, the cursor and
// the cooldowns. That is the same split as streamTeam / streamShop /
// streamMemory, and it is what lets this be simulated against the real
// reducer without standing up React.
//
// WHAT THE REDUCER ACTUALLY PAYS ON A REMATCH — measured, not assumed,
// because the loop's whole justification rests on it (reducer.ts:2451-2482):
//
//   * MONEY: yes, always. `money = state.money + moneyDelta` is computed
//     before any first-time check, and moneyDelta is
//     trainerPrize(trainerClass, trainerTeam) = 32 x the roster's ace level
//     (gym/e4/champion are not in the PRIZES table, so they take the default
//     base of 32). A rematch pays exactly what the first win paid.
//   * VICTORY TOKENS: only from the CHAMPION. The gym branch is guarded
//     `bossType === "gym" && !defeatedGyms.includes(bossId)`, so a gym
//     rematch takes the else-if chain to the floor and awards nothing; the e4
//     branch is guarded the same way and never awarded a token even on the
//     first clear. The champion branch is the odd one out — it has NO
//     `!includes` guard on the award, only on the `defeatedChampions` push,
//     so `victoryTokens += 1` fires on every champion win forever.
//
// That last point is load-bearing and it is why the League gauntlet is in
// this rotation at all rather than gyms alone: the champion is the only
// repeatable Victory Token source in the game, and tokens are what feed the
// reward shop (evolution stones, Exp Share). Gym rematches are income and
// spectacle; the gauntlet is income, spectacle AND the token faucet.

export interface RematchOptions {
  /** The party's top level. */
  best: number;
  /** Level headroom demanded over a gym / League ace before we walk on camera. */
  gymMargin: number;
  leagueMargin: number;
  /** Extra headroom demanded per recorded loss to that boss. */
  lossStep: number;
  /** Live loss strikes against a boss id, TTL already applied. */
  losses: (bossId: string) => number;
  now: number;
  /** Wall clock before which the League gauntlet may not run again. */
  leagueReadyAt: number;
}

export type RematchTarget =
  | { kind: "gym"; slot: number; bossId: string; locationId: string; name: string }
  | { kind: "league"; slot: number; locationId: string; name: string };

function aceLevel(team: { level: number }[]): number {
  return team.reduce((m, t) => Math.max(m, t.level), 0);
}

/** Everyone the League gauntlet would queue: the Elite Four in order, then
 *  the Champion. Mirrors executeStreamCommand's queue construction exactly,
 *  minus the "skip anyone already beaten" filter that makes a rematch
 *  impossible. */
export function leagueRoster(region: Region): GymLeader[] {
  return region.champion ? [...region.eliteFour, region.champion] : [...region.eliteFour];
}

/**
 * Is there genuinely nothing left to win in this region for the first time?
 *
 * This is the ladder's existing notion of "region finished", read off the same
 * three arrays rungs 12 and 13 read, rather than a new one invented here:
 * rung 12 targets `gymLeaders.find(g => !defeatedGyms.includes(g.id))` and
 * rung 13 targets `eliteFour.find(m => !defeatedEliteFour.includes(m.id))`
 * falling through to `champion && !defeatedChampions.includes(champion.id)`.
 * When all three come back empty those two rungs cannot fire, and only then
 * is there nothing better to do.
 *
 * Deliberately stricter than "no REACHABLE undefeated gym": an undefeated gym
 * we cannot currently walk to is still real progression that the frontier
 * hold and the grind are working toward, so the rematch loop stands down for
 * it too. Erring this way can only ever make the loop fire LESS, which is the
 * safe direction — it must never be the reason a badge went unearned.
 */
export function regionCleared(state: GameState, region: Region): boolean {
  if (region.gymLeaders.some((g) => !state.defeatedGyms.includes(g.id))) return false;
  if (region.eliteFour.some((m) => !state.defeatedEliteFour.includes(m.id))) return false;
  const champ = region.champion;
  if (champ && !state.defeatedChampions.includes(champ.id)) return false;
  return true;
}

/**
 * True only when there is nothing left to win ANYWHERE, not merely in the
 * region we happen to be standing in.
 *
 * This distinction is the whole guard. The progression rungs are scoped to
 * the CURRENT region, so if the account is standing in a finished Kanto while
 * Johto still has eight gyms outstanding, a region-scoped "cleared" makes the
 * gym rung, the league rung and the rematch loop all agree there is nothing
 * left — and the bot settles into refighting Brock forever while a whole
 * region goes unplayed. Rematching is strictly the LAST resort, so it has to
 * ask the global question.
 *
 * A region whose gym town we cannot reach yet still counts as unfinished:
 * that is progression waiting to happen, and the answer is to go there, not
 * to start rematching.
 */
export function allRegionsCleared(state: GameState): boolean {
  return Object.values(regions).every((r) => regionCleared(state, r));
}

/**
 * The next boss to refight, or null when nothing qualifies right now.
 *
 * The rotation is one lap of `gymLeaders.length + 1` slots: every gym leader
 * in badge order, then the League gauntlet as the lap's capstone — the same
 * shape in which the region was originally beaten, which is why it needs no
 * magic cadence number of its own. A viewer therefore sees every leader in
 * the region, and one full gauntlet, per lap, instead of the same leader on
 * repeat.
 *
 * Ineligible slots are SKIPPED, not waited on: a leader whose town is not
 * unlocked, or who has beaten us often enough that the loss margin now
 * exceeds our level, would otherwise park the cursor and stall the whole
 * rotation. The scan is bounded at exactly one lap, so "nothing qualifies"
 * costs a handful of comparisons and returns null rather than spinning.
 */
export function pickRematch(
  state: GameState,
  region: Region,
  cursor: number,
  opts: RematchOptions,
): RematchTarget | null {
  const roster = region.gymLeaders;
  const lapLength = roster.length + 1;

  for (let step = 0; step < lapLength; step++) {
    const slot = ((cursor % lapLength) + lapLength + step) % lapLength;

    if (slot < roster.length) {
      const g = roster[slot];
      if (!g) continue;
      // A REMATCH specifically. An undefeated gym belongs to rung 12, which
      // has its own margin and awards a badge and a token — routing it
      // through here instead would quietly bypass that rung's gating.
      if (!state.defeatedGyms.includes(g.id)) continue;
      if (!state.unlockedLocations.includes(g.locationKey)) continue;
      // START_BOSS_BATTLE returns the state UNCHANGED when `trainerTeam[0]`
      // is missing (reducer.ts:1920). A dispatch that no-ops leaves the phase
      // at idle, so the rung that chose it is still selected on the very next
      // tick — the exact every-tick-`return` failure that rungs 10 and 12
      // were written to document. An empty roster entry is therefore skipped
      // here rather than dispatched and hoped for.
      if (g.team.length === 0) continue;
      const need = aceLevel(g.team) + opts.gymMargin + opts.losses(g.id) * opts.lossStep;
      if (opts.best < need) continue;
      return { kind: "gym", slot, bossId: g.id, locationId: g.locationKey, name: g.name };
    }

    // The lap's capstone. Rate-limited by the caller as well as by its
    // position in the lap — see REMATCH_LEAGUE_MIN_GAP_MS.
    if (opts.now < opts.leagueReadyAt) continue;
    const league = leagueRoster(region);
    if (league.length === 0) continue;
    // Every member, not just the head. The gauntlet runs back-to-back out of
    // `bossQueue`, and endBossBattle's queue advance (reducer.ts:2484) reads
    // `nextBoss.trainerTeam[0]` with no emptiness check at all — an empty
    // member mid-queue would hand `enemyPokemon: undefined` to a battle phase
    // and hang the broadcast where the pre-guard watchdog is the only way
    // out. Rung 13 only tests the head because a first clear stops at the
    // first missing team anyway; a rematch has no such luck.
    if (league.some((m) => m.team.length === 0)) continue;
    const hall = league[0].locationKey;
    if (!state.unlockedLocations.includes(hall)) continue;
    const bar = Math.max(...league.map((m) => aceLevel(m.team)));
    const lost = Math.max(...league.map((m) => opts.losses(m.id)));
    if (opts.best < bar + opts.leagueMargin + lost * opts.lossStep) continue;
    return { kind: "league", slot, locationId: hall, name: `the ${region.name} Elite Four` };
  }

  return null;
}
