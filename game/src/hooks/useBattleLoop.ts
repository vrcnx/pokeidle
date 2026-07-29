import { useEffect, useRef } from "react";
import { useGame } from "../state/GameContext";
import { rollEncounter, routeHasEncounters } from "../utils/encounters";
import { createPokemon } from "../utils/pokemon";
import { rollShiny } from "../utils/pokemon";
import { hasShinyCharm } from "../utils/shinyCharm";
import { pushToast } from "../components/Toast";
import { ballForAutoCatch, shouldAutoCatch } from "../utils/catching";
import { resolveCatchSettings } from "../utils/catchSettings";
import { pokeballs } from "../data/pokeballs";
import { getStreamConfig, isStreamMode } from "../state/streamMode";
import { routes } from "../data/routes";
import { getRouteTrainers, buildTeam, trainerSprite } from "../utils/trainerFactory";
import type { GameState } from "../types";

// Weaken-before-catch: keep attacking until the wild Pokémon is at or below
// this fraction of max HP, then throw. 0.30 leaves a comfortable buffer above
// fainting while still deep enough into the HP window to earn most of the
// low-HP catch bonus.
const WEAKEN_HP_THRESHOLD = 0.30;

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
// wait only when (a) the player is forced into a recharge turn or (b) they're
// locked into a multi-turn move (Outrage / Petal Dance) — those have no choice
// to make, so the simulation should advance itself.
//
// A spent moveset used to bypass the wait too, which is why a Pokémon that ran
// out of PP silently started auto-battling and stayed that way until it was
// healed: manual mode had no way back in. It is a choice like any other now —
// the panel offers Struggle and the loop waits for it.
function manualWaiting(s: GameState): boolean {
  if (s.battleMode !== "manual") return false;
  if (!s.playerPokemon) return false;
  const v = s.playerVolatile;
  if (v?.mustRecharge) return false;
  if (v?.lockedMove) return false;
  return true;
}

export function useBattleLoop(): void {
  // True while we have wanted a ball and had none. Reset as soon as a
  // ball is available again, so each dry spell warns exactly once.
  const outOfBallsRef = useRef(false);
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
      if (cur.paused || cur.phase === "starterSelect" || cur.phase === "regionStarterSelect" || cur.phase === "evolution") return;
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
      // A ball is mid-flight. The outcome is already rolled, so letting turns
      // keep running underneath the animation meant the enemy attacked (and
      // could faint your mon, or itself) while the ball was still arcing —
      // the throw read as a cosmetic overlay rather than an action. Hold the
      // loop until the throw resolves.
      if (cur.catchAnim) { repoll(); return; }

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

      // Deadlock breaker: idle with a FAINTED active Pokémon but healthy
      // bench members. Nothing moves in that state — the idle branch below
      // requires a healthy active mon to spawn an encounter, the battle
      // branch needs phase "battle", and the auto-heal above only fires when
      // the WHOLE party is down. Players saw this as the game freezing right
      // after a faint ("Pidgey fainted!" and then nothing forever). Send out
      // the first healthy mon and carry on.
      if (
        cur.phase === "idle" &&
        cur.playerPokemon &&
        cur.playerPokemon.currentHp <= 0
      ) {
        const healthy = cur.party.findIndex((p) => p.currentHp > 0);
        if (healthy >= 0) {
          dispatch({ type: "SWITCH_PLAYER_POKEMON", payload: { partyIndex: healthy } });
          repoll(200);
          return;
        }
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
              rollShiny(hasShinyCharm(cur))
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
          // Weaken-before-catch: if the rule for this encounter has it on,
          // keep attacking until the wild Pokémon is at/below the low-HP
          // window, so the HP catch bonus kicks in — then throw. Shinies are
          // exempt: they're caught immediately so a weakening hit can never
          // faint one.
          const rule = resolveCatchSettings(cur, cur.currentRoute, enemy.speciesKey);
          const hpFrac = enemy.maxHp > 0 ? enemy.currentHp / enemy.maxHp : 1;
          const wantWeaken =
            !!rule.weakenFirst && !enemy.isShiny &&
            !(enemy.isShiny && cur.alwaysCatchShinies) &&
            hpFrac > WEAKEN_HP_THRESHOLD;
          if (wantWeaken) {
            // Not weak enough yet — attack this turn instead of catching.
            if (manualWaiting(cur)) { repoll(); return; }
            dispatch({ type: "EXECUTE_TURN" });
            schedule();
            return;
          }
          const ball = ballForAutoCatch(cur, cur.currentRoute, enemy.speciesKey, enemy.isShiny);
          if (ball) {
            outOfBallsRef.current = false;
            dispatch({ type: "TRY_CATCH", payload: { ballId: ball } });
            schedule();
            return;
          }
          // Stream auto-buy: an unattended 24/7 stream restocks balls instead
          // of silently pausing. Only fires for a stream session with the
          // feature configured, and only for a ball that's actually enabled
          // for auto-catch on this encounter (otherwise buying wouldn't let
          // ballForAutoCatch pick it and we'd loop-buy forever). Money-gated.
          const sc = getStreamConfig();
          const ab = isStreamMode() && sc?.autoBuyBalls?.enabled ? sc.autoBuyBalls : null;
          if (ab) {
            const rule = resolveCatchSettings(cur, cur.currentRoute, enemy.speciesKey);
            const usable = rule.enabledBalls.includes(ab.ballId) || (enemy.isShiny && cur.alwaysCatchShinies);
            const price = pokeballs[ab.ballId]?.buyPrice ?? null;
            if (usable && price != null && cur.money >= price) {
              const qty = Math.max(1, Math.min(ab.restockTo, Math.floor(cur.money / price)));
              dispatch({ type: "BUY_ITEM", payload: { itemId: ab.ballId, quantity: qty } });
              outOfBallsRef.current = false;
              schedule();
              return;
            }
          }
          // We WANTED to catch this and had no ball for it. Previously
          // this just fell through to EXECUTE_TURN, so the game quietly
          // stopped catching anything — forever — and never said why.
          // An idle game going silently dead is the worst failure mode
          // there is: the player leaves it running for an hour and
          // comes back to nothing.
          //
          // Warn once per dry spell (the ref resets the moment a ball
          // is available again) so it is impossible to miss but never
          // spams the log every encounter.
          if (!outOfBallsRef.current) {
            outOfBallsRef.current = true;
            pushToast({
              kind: "warn",
              icon: "🎣",
              text: "Out of Poké Balls — auto-catch is paused. Restock at any Mart.",
            });
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
