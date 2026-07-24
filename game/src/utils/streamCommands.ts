import type { GameState, Dispatch, BossBattle } from "../types";
import { regions, regionForLocation, DEFAULT_REGION } from "../data/regions";
import { buildTeam } from "./trainerFactory";
import { regionBadgeCount } from "./unlocks";

// Remote control for a stream (OBS/24-7) account. The admin issues a command
// from the dashboard → server relays it over the `stream:command` socket event
// → the stream client runs it here. Every command drives the SAME game flow the
// normal UI uses (TRAVEL / START_BOSS_BATTLE / START_RAID / the setting
// toggles), so a remotely-driven stream behaves exactly like a player clicking.
//
// Only ever executed on a stream session (GameContext gates it on isStream).

export type StreamCommand =
  | { kind: "travel"; locationId: string }
  | { kind: "speed"; value: number }
  | { kind: "autoProceed"; value: boolean }
  | { kind: "autoCatch"; value: boolean }
  | { kind: "raid"; tier?: string }
  | { kind: "gym"; gymId: string }
  | { kind: "eliteFour" }
  | { kind: "champion" };

export interface StreamCommandResult { ok: boolean; message: string }

function regionOf(state: GameState) {
  return regions[regionForLocation(state.currentLocation) ?? DEFAULT_REGION] ?? regions[DEFAULT_REGION];
}
function isInBattle(state: GameState): boolean {
  return state.phase === "battle" || state.phase === "trainerBattle" || state.phase === "bossBattle";
}
function seed(prefix: string): string {
  // Match the UI's team-id seeding; randomness only needs to vary per call.
  return `${prefix}_${state_seq++}`;
}
let state_seq = 1;

export function executeStreamCommand(
  cmd: StreamCommand,
  state: GameState,
  dispatch: Dispatch,
): StreamCommandResult {
  switch (cmd.kind) {
    case "travel": {
      if (!state.unlockedLocations.includes(cmd.locationId)) {
        return { ok: false, message: `location not unlocked: ${cmd.locationId}` };
      }
      dispatch({ type: "TRAVEL", payload: { locationId: cmd.locationId } });
      return { ok: true, message: `travelling to ${cmd.locationId}` };
    }
    case "speed": {
      const v = Math.max(1, Math.min(5, Math.floor(Number(cmd.value) || 1)));
      dispatch({ type: "SET_SPEED", payload: { speed: v } });
      return { ok: true, message: `speed set to ${v}` };
    }
    case "autoProceed": {
      if (state.autoProceed !== cmd.value) dispatch({ type: "TOGGLE_AUTO_PROCEED" });
      return { ok: true, message: `auto-proceed ${cmd.value ? "on" : "off"}` };
    }
    case "autoCatch": {
      if (state.autoCatch !== cmd.value) dispatch({ type: "TOGGLE_AUTO_CATCH" });
      return { ok: true, message: `auto-catch ${cmd.value ? "on" : "off"}` };
    }
    case "raid": {
      if (state.party.length === 0) return { ok: false, message: "no party to raid with" };
      dispatch({ type: "START_RAID", payload: cmd.tier ? { tier: cmd.tier as never } : {} });
      return { ok: true, message: `starting raid${cmd.tier ? ` (${cmd.tier})` : ""}` };
    }
    case "gym": {
      if (isInBattle(state)) return { ok: false, message: "already in a battle" };
      const region = regionOf(state);
      const g = region.gymLeaders.find((x) => x.id === cmd.gymId);
      if (!g) return { ok: false, message: `unknown gym: ${cmd.gymId}` };
      if (state.defeatedGyms.includes(g.id)) return { ok: false, message: `${g.name} already defeated` };
      if (!state.unlockedLocations.includes(g.locationKey)) return { ok: false, message: `${g.name}'s town not unlocked` };
      const { team } = buildTeam(g.team, seed(`gym_${g.id}`));
      dispatch({
        type: "START_BOSS_BATTLE",
        payload: { bossId: g.id, bossType: "gym", trainerName: g.name, trainerClass: "gym", trainerTeam: team, spriteKey: g.spriteKey },
      });
      return { ok: true, message: `challenging ${g.name}` };
    }
    case "eliteFour":
    case "champion": {
      if (isInBattle(state)) return { ok: false, message: "already in a battle" };
      const region = regionOf(state);
      if (regionBadgeCount(state, region) < region.gymLeaders.length) {
        return { ok: false, message: "need all gym badges first" };
      }
      const queue: BossBattle[] = [];
      for (const m of region.eliteFour) {
        if (state.defeatedEliteFour.includes(m.id)) continue;
        const { team } = buildTeam(m.team, seed(`e4_${m.id}`));
        queue.push({ bossId: m.id, bossType: "e4", trainerName: m.name, trainerClass: "e4", trainerTeam: team, currentTrainerPokemonIndex: 0, spriteKey: m.spriteKey });
      }
      const champion = region.champion;
      if (champion && !state.defeatedChampions.includes(champion.id)) {
        const { team } = buildTeam(champion.team, seed(`champion_${champion.id}`));
        queue.push({ bossId: champion.id, bossType: "champion", trainerName: champion.name, trainerClass: "champion", trainerTeam: team, currentTrainerPokemonIndex: 0, spriteKey: champion.spriteKey });
      }
      if (queue.length === 0) return { ok: false, message: "Elite Four & Champion already cleared" };
      const [first, ...rest] = queue;
      dispatch({
        type: "START_BOSS_BATTLE",
        payload: {
          bossId: first.bossId, bossType: first.bossType, trainerName: first.trainerName,
          trainerClass: first.trainerClass, trainerTeam: first.trainerTeam, spriteKey: first.spriteKey,
          bossQueue: rest,
        },
      });
      return { ok: true, message: `starting the Elite Four gauntlet (${queue.length} battles)` };
    }
    default:
      return { ok: false, message: "unknown command" };
  }
}
