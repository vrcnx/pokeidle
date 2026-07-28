import type { GameState, Dispatch, BossBattle } from "../types";
import { regions, regionForLocation, DEFAULT_REGION, mergedGymLeaders } from "../data/regions";
import { buildTeam } from "./trainerFactory";
import { regionBadgeCount } from "./unlocks";
import { noteOperatorCommand } from "./streamMemory";
import { leagueRoster } from "./streamRematch";

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
  | { kind: "champion" }
  // Endgame rematches. `gym` and `eliteFour` both hard-refuse an already
  // beaten opponent ("already defeated" / "Elite Four & Champion already
  // cleared"), which is right for progression and useless for a rotation, so
  // refighting gets its own pair of verbs rather than a flag on those.
  | { kind: "rematch"; bossId: string }
  | { kind: "leagueRematch"; regionId?: string };

export interface StreamCommandResult { ok: boolean; message: string }

/** Who asked. Defaults to "operator" so the socket handler in GameContext —
 *  and any future caller — is treated as a human at the dashboard without
 *  needing to know this exists. The autonomous director passes "director". */
export type StreamCommandSource = "operator" | "director";

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
  source: StreamCommandSource = "operator",
): StreamCommandResult {
  // The admin's hand outranks the autopilot. Stamp every hand-issued command
  // so the director stands down for a while instead of travelling straight
  // back on its next tick — from the dashboard, an autopilot that instantly
  // undoes you is indistinguishable from a remote control that doesn't work.
  if (source === "operator") noteOperatorCommand();

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
    case "rematch": {
      if (isInBattle(state)) return { ok: false, message: "already in a battle" };
      // Resolved from the MERGED roster, not from `regionOf(state)`. Gym ids
      // are globally unique by construction (regions/index.ts namespaces
      // Johto's Koga/Bruno/Lance precisely so they cannot collide with
      // Kanto's), so a global lookup is unambiguous — and it means the answer
      // does not depend on where the account happens to be standing when the
      // command arrives. Position-dependent choices are the bug that made the
      // grind rung flip between two routes every 6 s; a rematch issued one
      // tick before a travel lands should not resolve to a different gym.
      const g = mergedGymLeaders.find((x) => x.id === cmd.bossId);
      if (!g) return { ok: false, message: `unknown gym: ${cmd.bossId}` };
      // Inverted against the `gym` case on purpose: this verb refights beaten
      // leaders only. An undefeated gym is progression — it awards a badge
      // and a Victory Token — and belongs to the ladder's gym rung with its
      // own level margin, so letting it through here would quietly route
      // real progress around that gating.
      if (!state.defeatedGyms.includes(g.id)) {
        return { ok: false, message: `${g.name} has not been beaten yet — use "gym"` };
      }
      if (!state.unlockedLocations.includes(g.locationKey)) {
        return { ok: false, message: `${g.name}'s town not unlocked` };
      }
      const { team } = buildTeam(g.team, seed(`rematch_${g.id}`));
      // START_BOSS_BATTLE returns the state UNCHANGED when trainerTeam[0] is
      // missing (reducer.ts:1920), and a dispatch that silently no-ops is how
      // a director rung ends up firing forever. Check the BUILT team, not the
      // roster definition — buildTeam is what actually feeds the reducer.
      if (team.length === 0) return { ok: false, message: `${g.name} has no team to field` };
      dispatch({
        type: "START_BOSS_BATTLE",
        payload: { bossId: g.id, bossType: "gym", trainerName: g.name, trainerClass: "gym", trainerTeam: team, spriteKey: g.spriteKey },
      });
      return { ok: true, message: `rematching ${g.name}` };
    }
    case "leagueRematch": {
      if (isInBattle(state)) return { ok: false, message: "already in a battle" };
      // Explicit region, defaulting to where we stand — same reasoning as the
      // gym lookup above, except an Elite Four has no unique id to key on so
      // the caller names the region instead.
      const region = (cmd.regionId ? regions[cmd.regionId] : undefined) ?? regionOf(state);
      if (regionBadgeCount(state, region) < region.gymLeaders.length) {
        return { ok: false, message: "need all gym badges first" };
      }
      // Every member, unfiltered — that is the entire difference from the
      // `eliteFour` verb, whose `defeatedEliteFour` filter empties the queue
      // to nothing once the region is cleared.
      const roster = leagueRoster(region);
      if (roster.length === 0) return { ok: false, message: `${region.name} has no League to refight` };
      const queue: BossBattle[] = roster.map((m) => {
        const { team } = buildTeam(m.team, seed(`rematch_${m.id}`));
        const isChampion = m.id === region.champion?.id;
        return {
          bossId: m.id,
          bossType: isChampion ? "champion" : "e4",
          trainerName: m.name,
          trainerClass: isChampion ? "champion" : "e4",
          trainerTeam: team,
          currentTrainerPokemonIndex: 0,
          spriteKey: m.spriteKey,
        };
      });
      // Checked across the WHOLE queue. endBossBattle's queue advance reads
      // `nextBoss.trainerTeam[0]` with no emptiness check (reducer.ts:2486),
      // so an empty member in the middle of the gauntlet would hand
      // `enemyPokemon: undefined` to a live battle phase and hang the stream
      // until the pre-guard watchdog dug it out 30 s later.
      if (queue.some((b) => b.trainerTeam.length === 0)) {
        return { ok: false, message: `${region.name}'s League has an empty roster entry` };
      }
      const [first, ...rest] = queue;
      dispatch({
        type: "START_BOSS_BATTLE",
        payload: {
          bossId: first.bossId, bossType: first.bossType, trainerName: first.trainerName,
          trainerClass: first.trainerClass, trainerTeam: first.trainerTeam, spriteKey: first.spriteKey,
          bossQueue: rest,
        },
      });
      return { ok: true, message: `rematching the ${region.name} League (${queue.length} battles)` };
    }
    default:
      return { ok: false, message: "unknown command" };
  }
}
