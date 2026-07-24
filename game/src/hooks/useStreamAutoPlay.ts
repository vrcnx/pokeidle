import { useEffect, useRef } from "react";
import { useGame } from "../state/GameContext";
import { isStreamMode } from "../state/streamMode";
import { executeStreamCommand } from "../utils/streamCommands";
import { regions, regionForLocation, DEFAULT_REGION } from "../data/regions";
import { regionBadgeCount } from "../utils/unlocks";
import { encounters } from "../data/encounters";
import type { GameState } from "../types";

// Autonomous progression for the 24/7 stream account.
//
// The generic idle loop only ever grinds whatever route you're standing on —
// it never decides to challenge a gym, run the Elite Four, or move somewhere
// more useful. Left alone a stream account therefore farms its starting route
// forever. This hook is the missing director: on a stream session it
// periodically looks at the game state and takes the single most sensible next
// action.
//
// It also LEARNS. A purely static "is my level high enough" rule keeps walking
// back into a fight it can't win — the stream then loops death → heal → death
// on the same route. So whiteouts are recorded per location and per boss: a
// place that keeps killing us is avoided and we drop to an easier route to
// level, and a gym that beat us has to be cleared by a wider margin next time.
// Both fade after a while so the account retries once it has actually grown.
//
// Deliberately conservative — it only acts while idle and out of battle, one
// action per tick, so it can never fight the normal loop or the admin's manual
// remote commands.

const TICK_MS = 6000;
/** Only challenge a boss when the party's best mon clears the boss's ace by
 *  this much — losing on stream repeatedly is worse than grinding. */
const GYM_LEVEL_MARGIN = 2;
const E4_LEVEL_MARGIN = 3;
/** Each recorded loss to a boss adds this to the margin it must clear. */
const LOSS_MARGIN_STEP = 3;
/** Whiteouts at a location before we treat it as too dangerous. */
const DANGER_LIMIT = 2;
/** Recorded losses fade after this, so nowhere is written off forever. */
const DANGER_TTL_MS = 15 * 60_000;

interface Strike { count: number; at: number }

function topLevel(state: GameState): number {
  return state.party.reduce((m, p) => Math.max(m, p.level), 0);
}
function healthyCount(state: GameState): number {
  return state.party.filter((p) => p.currentHp > 0).length;
}
function aceLevel(team: { level: number }[]): number {
  return team.reduce((m, t) => Math.max(m, t.level), 0);
}
/** Live strike count, ignoring anything that has aged out. */
function strikes(map: Map<string, Strike>, key: string): number {
  const s = map.get(key);
  if (!s) return 0;
  if (Date.now() - s.at > DANGER_TTL_MS) { map.delete(key); return 0; }
  return s.count;
}
function addStrike(map: Map<string, Strike>, key: string): void {
  const prev = strikes(map, key);
  map.set(key, { count: prev + 1, at: Date.now() });
}

export function useStreamAutoPlay(): void {
  const { state, dispatch } = useGame();
  const stateRef = useRef(state);
  stateRef.current = state;

  // Learned danger, kept in refs: this is scratch heuristics, not player
  // progress, so it deliberately doesn't touch the save. A reload just makes
  // the director re-learn, which is cheap.
  const routeDanger = useRef(new Map<string, Strike>());
  const bossLosses = useRef(new Map<string, Strike>());
  const lastWhiteoutKey = useRef<number | null>(state.whiteoutAnim?.key ?? null);
  // Remember what we were fighting/where, so a whiteout can be attributed
  // after the fact (by then the battle state is already cleared).
  const lastBossId = useRef<string | null>(null);
  const lastLocation = useRef<string>(state.currentLocation);

  if (state.bossBattle) lastBossId.current = state.bossBattle.bossId;
  if (!state.enemyPokemon && state.phase === "idle") lastLocation.current = state.currentLocation;

  // Record a loss whenever the party gets wiped.
  useEffect(() => {
    if (!isStreamMode()) return;
    const key = state.whiteoutAnim?.key ?? null;
    if (key == null || key === lastWhiteoutKey.current) return;
    lastWhiteoutKey.current = key;
    addStrike(routeDanger.current, lastLocation.current);
    if (lastBossId.current) {
      addStrike(bossLosses.current, lastBossId.current);
      lastBossId.current = null;
    }
  }, [state.whiteoutAnim?.key]);

  useEffect(() => {
    if (!isStreamMode()) return;
    const id = setInterval(() => {
      const s = stateRef.current;
      // Never interfere mid-battle, mid-animation, or while paused.
      if (s.phase !== "idle" || s.paused) return;
      if (s.enemyPokemon || s.awaitingSwitch || s.pendingEvents.length > 0) return;
      if (s.party.length === 0) return;

      // 1. Patch up. A half-fainted party loses gyms and stalls the grind.
      if (healthyCount(s) < s.party.length) {
        dispatch({ type: "HEAL_PARTY" });
        return;
      }

      const region = regions[regionForLocation(s.currentLocation) ?? DEFAULT_REGION] ?? regions[DEFAULT_REGION];
      const best = topLevel(s);

      // 2. Beat the next gym once the party can plausibly win — and if this
      //    gym has already beaten us, demand a wider margin each time.
      const nextGym = region.gymLeaders.find((g) => !s.defeatedGyms.includes(g.id));
      if (nextGym && s.unlockedLocations.includes(nextGym.locationKey)) {
        const need = aceLevel(nextGym.team)
          + GYM_LEVEL_MARGIN
          + strikes(bossLosses.current, nextGym.id) * LOSS_MARGIN_STEP;
        if (best >= need) {
          if (s.currentLocation !== nextGym.locationKey) {
            executeStreamCommand({ kind: "travel", locationId: nextGym.locationKey }, s, dispatch);
          } else {
            executeStreamCommand({ kind: "gym", gymId: nextGym.id }, s, dispatch);
          }
          return;
        }
      }

      // 3. All badges in hand → run the league gauntlet once strong enough.
      if (regionBadgeCount(s, region) >= region.gymLeaders.length) {
        const champ = region.champion;
        const e4Left = region.eliteFour.some((m) => !s.defeatedEliteFour.includes(m.id));
        const champLeft = champ && !s.defeatedChampions.includes(champ.id);
        if (e4Left || champLeft) {
          const bar = Math.max(
            ...region.eliteFour.map((m) => aceLevel(m.team)),
            champ ? aceLevel(champ.team) : 0,
          );
          const lost = Math.max(
            ...region.eliteFour.map((m) => strikes(bossLosses.current, m.id)),
            champ ? strikes(bossLosses.current, champ.id) : 0,
          );
          if (best >= bar + E4_LEVEL_MARGIN + lost * LOSS_MARGIN_STEP) {
            executeStreamCommand({ kind: "eliteFour" }, s, dispatch);
            return;
          }
        }
      }

      // 4. Otherwise grind somewhere useful. Normally that's the toughest
      //    route we can handle (fastest EXP), but every whiteout here pulls
      //    the ceiling DOWN, so a run of deaths makes the account retreat to
      //    easier ground and level up instead of feeding the same route.
      const hereDanger = strikes(routeDanger.current, s.currentLocation);
      const ceiling = best + 3 - hereDanger * 4;
      const candidates = s.unlockedLocations
        .filter((id) => (encounters[id]?.encounters?.length ?? 0) > 0)
        // Somewhere that has wiped us repeatedly is off the table until the
        // strike ages out.
        .filter((id) => strikes(routeDanger.current, id) < DANGER_LIMIT)
        .map((id) => {
          const list = encounters[id]!.encounters;
          return { id, top: list.reduce((m, e) => Math.max(m, e.maxLevel), 0) };
        })
        .filter((c) => c.top <= ceiling)
        .sort((a, b) => b.top - a.top);

      // If everything unlocked is now considered too hard, fall back to the
      // single easiest route rather than standing still doing nothing.
      const easiest = s.unlockedLocations
        .filter((id) => (encounters[id]?.encounters?.length ?? 0) > 0)
        .map((id) => ({ id, top: encounters[id]!.encounters.reduce((m, e) => Math.max(m, e.maxLevel), 0) }))
        .sort((a, b) => a.top - b.top)[0];

      const target = candidates[0] ?? easiest;
      if (target && target.id !== s.currentLocation) {
        executeStreamCommand({ kind: "travel", locationId: target.id }, s, dispatch);
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [dispatch]);
}
