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
// forever (players watching it saw "perma catching Pokémon"). This hook is the
// missing director: on a stream session it periodically looks at the game state
// and takes the single most sensible next action.
//
// Deliberately conservative — it only acts while idle and out of battle, one
// action per tick, so it can never fight the normal loop or the admin's manual
// remote commands.

const TICK_MS = 6000;
/** Only challenge a boss when the party's best mon is at least this far above
 *  the boss's ace — losing on stream repeatedly is worse than grinding. */
const GYM_LEVEL_MARGIN = 2;
const E4_LEVEL_MARGIN = 3;

function topLevel(state: GameState): number {
  return state.party.reduce((m, p) => Math.max(m, p.level), 0);
}
function healthyCount(state: GameState): number {
  return state.party.filter((p) => p.currentHp > 0).length;
}
function aceLevel(team: { level: number }[]): number {
  return team.reduce((m, t) => Math.max(m, t.level), 0);
}

export function useStreamAutoPlay(): void {
  const { state, dispatch } = useGame();
  const stateRef = useRef(state);
  stateRef.current = state;

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

      // 2. Beat the next gym as soon as the party can plausibly win it.
      const nextGym = region.gymLeaders.find((g) => !s.defeatedGyms.includes(g.id));
      if (nextGym && s.unlockedLocations.includes(nextGym.locationKey)) {
        if (best >= aceLevel(nextGym.team) + GYM_LEVEL_MARGIN) {
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
          if (best >= bar + E4_LEVEL_MARGIN) {
            executeStreamCommand({ kind: "eliteFour" }, s, dispatch);
            return;
          }
        }
      }

      // 4. Otherwise grind somewhere useful: the highest-level unlocked route
      //    the party can still safely handle. Standing in a town (no wild
      //    encounters) or on a starter route at Lv60 both waste stream time.
      const candidates = s.unlockedLocations
        .filter((id) => (encounters[id]?.encounters?.length ?? 0) > 0)
        .map((id) => {
          const list = encounters[id]!.encounters;
          return { id, top: list.reduce((m, e) => Math.max(m, e.maxLevel), 0) };
        })
        // Anything more than a few levels above our best mon is a losing fight.
        .filter((c) => c.top <= best + 3)
        .sort((a, b) => b.top - a.top);
      const target = candidates[0];
      if (target && target.id !== s.currentLocation) {
        executeStreamCommand({ kind: "travel", locationId: target.id }, s, dispatch);
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [dispatch]);
}
