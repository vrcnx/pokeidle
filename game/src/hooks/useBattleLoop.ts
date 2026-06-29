import { useEffect, useRef } from "react";
import { useGame } from "../state/GameContext";
import { rollEncounter, routeHasEncounters } from "../utils/encounters";
import { createPokemon } from "../utils/pokemon";
import { rollShiny, hasShinyCharm } from "../utils/pokemon";
import { ballForAutoCatch, shouldAutoCatch } from "../utils/catching";
import { routes } from "../data/routes";
import { getRouteTrainers, buildTeam, trainerSprite } from "../utils/trainerFactory";
import type { GameState } from "../types";

// The simulation tick. While the phase is "idle" the loop kicks off encounters
// on the current route. While the phase is "battle" it ticks turns until one
// side faints. Speed setting controls how fast (1=1000ms, 2=500ms, 5=200ms).

function tickIntervalFor(speed: number): number {
  if (speed >= 5) return 200;
  if (speed >= 2) return 500;
  return 1000;
}

// In manual mode, the loop should NOT auto-execute turns. The MovesPanel will
// dispatch EXECUTE_TURN with a chosen move when the player clicks. Bypass the
// wait when (a) the player is forced into a recharge turn, (b) they're locked
// into a multi-turn move (Outrage / Petal Dance), or (c) every move has 0 PP
// — those have no choice to make, so the simulation should advance itself.
function manualWaiting(s: GameState): boolean {
  if (s.battleMode !== "manual") return false;
  if (!s.playerPokemon) return false;
  const v = s.playerVolatile;
  if (v?.mustRecharge) return false;
  if (v?.lockedMove) return false;
  const allOutOfPP = s.playerPokemon.moves.every((m) => m.pp <= 0);
  if (allOutOfPP) return false;
  return true;
}

export function useBattleLoop(): void {
  const { state, dispatch } = useGame();
  const stateRef = useRef(state);
  stateRef.current = state;

  // When a new opponent enters the field, wait for the pokeball-pop (and any
  // trainer slide-in) animation to finish before firing the first EXECUTE_TURN.
  const lastEnemyIdRef = useRef<string | null>(null);
  const enemySettleAtRef = useRef<number>(0);

  useEffect(() => {
    let cancelled = false;
    let timeout: number | null = null;
    const schedule = () => {
      if (cancelled) return;
      const cur = stateRef.current;
      if (cur.paused || cur.phase === "starterSelect" || cur.phase === "evolution") return;
      timeout = window.setTimeout(tick, tickIntervalFor(cur.speed));
    };

    const tick = () => {
      if (cancelled) return;
      const cur = stateRef.current;
      // Reschedule a follow-up poll so the loop never dies on an early return.
      // (awaitingSwitch / pendingEvents.length will also wake the loop via
      // the useEffect deps, but the settle-window is a pure timer.)
      const repoll = (ms = 150) => {
        if (cancelled) return;
        timeout = window.setTimeout(tick, ms);
      };

      if (cur.awaitingSwitch) { repoll(); return; }
      if (cur.pendingEvents.length > 0) { repoll(); return; }

      // Defensive: if every party member is fainted while idle (ie. the
      // game ended up in a stuck state somehow), auto-heal so the loop
      // doesn't deadlock.
      if (
        cur.phase === "idle" &&
        cur.party.length > 0 &&
        cur.party.every((p) => p.currentHp <= 0)
      ) {
        dispatch({ type: "HEAL_PARTY" });
        repoll(400);
        return;
      }

      // New opponent? Hold off until the appear animation finishes.
      // Wild: ~700ms (pokeball-pop is 600ms + a little settle)
      // Trainer/boss: ~1800ms (trainer slide-in 0–1100ms + pokeball-pop 1100–1700ms)
      if (cur.enemyPokemon && cur.enemyPokemon.id !== lastEnemyIdRef.current) {
        lastEnemyIdRef.current = cur.enemyPokemon.id;
        const fromTrainer = !!(cur.trainerBattle || cur.bossBattle);
        enemySettleAtRef.current = Date.now() + (fromTrainer ? 1800 : 700);
      }
      if (cur.enemyPokemon && Date.now() < enemySettleAtRef.current) {
        // Schedule the next poll just past the settle deadline (or ~150ms,
        // whichever is sooner) so we don't burn cycles spinning.
        repoll(Math.max(50, Math.min(300, enemySettleAtRef.current - Date.now() + 20)));
        return;
      }

      if (cur.phase === "idle" && cur.playerPokemon && cur.playerPokemon.currentHp > 0) {
        const here = cur.currentLocation;
        const route = routes[here];
        const isTown = route?.type === "town";

        if (isTown) {
          // Cities auto-trigger trainer battles using the shared encounter
          // table. Indigo Plateau is included now (the player can also kick
          // off the E4 gauntlet manually from the league card alongside).
          const trainers = getRouteTrainers(here);
          if (trainers.length > 0) {
            const undefeated = trainers.filter(
              (t) => !cur.defeatedTrainers.includes(t.id)
            );
            const pool = undefeated.length > 0 ? undefeated : trainers;
            const t = pool[Math.floor(Math.random() * pool.length)];
            const isRematch = cur.defeatedTrainers.includes(t.id);
            // Rematch teams scale toward the player's average level.
            let teamDef = t.team;
            if (isRematch && cur.party.length > 0) {
              const avg = Math.round(
                cur.party.reduce((s, p) => s + p.level, 0) / cur.party.length
              );
              const max = Math.max(...t.team.map((p) => p.level));
              const target = Math.min(avg + 2, max + 10, 100);
              teamDef = t.team.map((p) => ({
                ...p,
                level: Math.max(p.level, target - (max - p.level)),
              }));
            }
            const { team } = buildTeam(teamDef, `trainer_${t.id}_${Date.now()}`);
            dispatch({
              type: "START_TRAINER_BATTLE",
              payload: {
                trainerId: t.id,
                trainerName: t.name,
                trainerClass: t.trainerClass,
                trainerTeam: team,
                spriteKey: trainerSprite(t.trainerClass),
              },
            });
          }
        } else if (routeHasEncounters(cur.currentRoute)) {
          // Routes auto-trigger wild encounters
          const roll = rollEncounter(cur.currentRoute, cur.activeEffects);
          if (roll) {
            const enemy = createPokemon(
              roll.speciesKey,
              roll.level,
              cur.nextPokemonId,
              rollShiny(hasShinyCharm(cur.pokedexCaught))
            );
            dispatch({ type: "START_ENCOUNTER", payload: { pokemon: enemy } });
          }
        }
      } else if (cur.phase === "battle" && cur.enemyPokemon && cur.playerPokemon) {
        // Wild battle — auto-catch first if rules say so. Route auto
        // catches through TRY_CATCH so they share the same animation,
        // log line, and 3-shake sequence as manual ball throws (the
        // earlier silent CATCH_POKEMON shortcut just teleported the
        // mon into the party).
        const enemy = cur.enemyPokemon;
        if (
          cur.autoCatch &&
          shouldAutoCatch(cur, cur.currentRoute, enemy.speciesKey, enemy.level, enemy.isShiny)
        ) {
          const ball = ballForAutoCatch(cur, cur.currentRoute, enemy.speciesKey, enemy.isShiny);
          if (ball) {
            dispatch({ type: "TRY_CATCH", payload: { ballId: ball } });
            schedule();
            return;
          }
        }
        if (manualWaiting(cur)) { repoll(); return; }
        dispatch({ type: "EXECUTE_TURN" });
      } else if (
        (cur.phase === "trainerBattle" || cur.phase === "bossBattle") &&
        cur.enemyPokemon &&
        cur.playerPokemon
      ) {
        // Trainer / boss — fight only, no catching
        if (manualWaiting(cur)) { repoll(); return; }
        dispatch({ type: "EXECUTE_TURN" });
      }

      schedule();
    };

    schedule();
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [
    state.phase,
    state.paused,
    state.speed,
    state.playerPokemon?.id,
    state.enemyPokemon?.id,
    state.awaitingSwitch,
    state.pendingEvents.length,
    state.currentLocation,
    state.battleMode,
    dispatch,
  ]);
}
