// The Pokémon Idle reducer. Handles every action that mutates the game state.
//
// Significant simplification from the original bundle: the original drives
// battle animations through an event queue (`pendingEvents`, `currentEventIndex`,
// `EXECUTE_TURN` -> series of `CONSUME_EVENT`s) so the UI can step through
// damage / faint / level-up animations frame by frame. This implementation
// resolves each turn atomically inside `EXECUTE_TURN`. Visually less rich,
// but functionally equivalent. The `battleLog` accumulates the per-event
// messages so the player still sees what happened.

import type { Action, ActiveEffect, BossBattle, GameState, Pokemon, TrainerBattle } from "../types";
import { pokemonTable } from "../data/pokemon";
import { routes } from "../data/routes";
import { mergedEncounters, regions } from "../data/regions";
import { pokeballs } from "../data/pokeballs";
import { consumables } from "../data/consumables";
import { evolutionStones } from "../data/evolutionStones";
import { evolutions } from "../data/evolutions";
import { calcAllStats, capTotalExp, expYield } from "../utils/stats";
import { createPokemon, toMove, ZERO_EVS, rollShiny } from "../utils/pokemon";
import { grantShinyCharmIfEarned, hasShinyCharm, SHINY_CHARM_ITEM } from "../utils/shinyCharm";
import { resolveEvolutionTarget } from "../utils/evolution";
import { evYieldFor, applyEvYield } from "../data/evYields";
import { levelUpsForExp } from "../utils/moves";
import { moves as movesTable } from "../data/moves";
import { executeTurn, type BattleSide } from "../utils/battle";
import { rollCatch } from "../utils/catching";
import { REPEL_IDS } from "../utils/encounters";
import { unlockedFromProgress, pendingRegionStarter } from "../utils/unlocks";
import {
  pickRandomLegendary,
  pickRandomLegendaryForTier,
  raidTiers,
  DEFAULT_RAID_TIER,
  RAID_START_LEVEL,
  RAID_COOLDOWN_MS,
} from "../data/raidLegendaries";
import { itemsCatalog } from "../data/itemsCatalog";

function pushLog(state: GameState, ...lines: string[]): GameState {
  if (lines.length === 0) return state;
  const log = [...state.battleLog, ...lines];
  return { ...state, battleLog: log.slice(-50) };
}

function withTypes(p: Pokemon): BattleSide {
  // Deep-clone the moves array so executeTurn can decrement PP
  // safely without mutating the original Pokemon's moves (which
  // would silently mutate state and break React's render
  // assumptions). The reducer reads back the cloned moves after
  // executeTurn returns and dispatches the persisted PP values.
  return {
    ...p,
    moves: p.moves.map((m) => ({ ...m })),
    types: pokemonTable[p.speciesKey]?.types ?? [],
  };
}

// Sync the active player Pokémon back into the party slot.
function syncPlayerToParty(state: GameState): GameState {
  if (!state.playerPokemon) return state;
  const idx = state.activePlayerPokemonIndex;
  if (idx < 0 || idx >= state.party.length) return state;
  if (state.party[idx]?.id !== state.playerPokemon.id) return state;
  const party = [...state.party];
  party[idx] = state.playerPokemon;
  return { ...state, party };
}

// First non-fainted index in the party (or 0 if everyone's KO'd).
function firstHealthyIndex(party: Pokemon[]): number {
  const idx = party.findIndex((p) => p.currentHp > 0);
  return idx >= 0 ? idx : 0;
}

// Whether the player is currently in any kind of fight (vs idle / healing /
// evolving). Used to decide whether a party reorder takes effect now (idle:
// active re-derives immediately) or queues for the next encounter (battle:
// the in-battle Pokémon stays, but `activePlayerPokemonIndex` updates so
// that the new slot 0 is picked up at the next START_ENCOUNTER).
function isInBattle(state: GameState): boolean {
  return (
    state.phase === "battle" ||
    state.phase === "trainerBattle" ||
    state.phase === "bossBattle"
  );
}

// Tear down the active battle without healing the party. Used by actions
// the player triggers from menus (evolve, move to PC, release, etc.) so
// they work even if a wild/trainer fight is in progress — same idea as
// START_HEALING bailing out of an encounter, just without the heal.
function bailFromBattle(state: GameState): GameState {
  if (!isInBattle(state)) return state;
  return {
    ...state,
    phase: "idle",
    enemyPokemon: null,
    trainerBattle: null,
    bossBattle: null,
    pendingEvents: [],
    currentEventIndex: 0,
    awaitingSwitch: false,
    playerVolatile: null,
    battleWeather: null,
  };
}

// Recompute the active Pokémon (= first healthy in the party). When in
// battle we leave `playerPokemon` alone — the in-battle reference stays —
// but still update `activePlayerPokemonIndex` so the next encounter's
// START_* handler picks up whoever's now in slot 0.
function rederiveActive(state: GameState): GameState {
  const idx = firstHealthyIndex(state.party);
  if (isInBattle(state)) {
    return { ...state, activePlayerPokemonIndex: idx };
  }
  return {
    ...state,
    activePlayerPokemonIndex: idx,
    playerPokemon: state.party[idx] ?? state.playerPokemon,
  };
}

// Apply experience + EVs to the active Pokémon and any party members holding
// Exp Share. EVs come from the defeated species' yield table.
function applyExp(
  state: GameState,
  exp: number,
  evYield?: import("../types").Stats
): { state: GameState; logs: string[] } {
  const logs: string[] = [];
  if (!state.playerPokemon) return { state, logs };

  const active = state.playerPokemon;
  const species = pokemonTable[active.speciesKey];
  const newTotalExp = capTotalExp(active.totalExp + exp, species.growthRate);
  const ups = levelUpsForExp(active.speciesKey, species.growthRate, active.level, newTotalExp);
  const newEvs = evYield ? applyEvYield(active.evs ?? ZERO_EVS, evYield) : (active.evs ?? ZERO_EVS);

  let updated: Pokemon = { ...active, totalExp: newTotalExp, evs: newEvs };
  let levelUpNotification = state.levelUpNotification;
  // Recalc stats whenever EVs grew, or whenever level grew.
  const evsChanged = !!evYield;
  if (ups.length > 0 || evsChanged) {
    const newLevel = ups.length > 0 ? ups[ups.length - 1].newLevel : active.level;
    const stats = calcAllStats(species, newLevel, active.ivs, newEvs, active.nature);
    if (ups.length > 0) {
      const learnedMoves = ups.flatMap((u) => u.newMoves);
      learnedMoves.forEach((moveId) => logs.push(`${active.name} learned ${moveId}!`));
      logs.push(`${active.name} grew to level ${newLevel}!`);
      updated = { ...updated, moves: appendNewMoves(updated.moves, learnedMoves) };
      levelUpNotification = { pokemonId: active.id, level: newLevel, newMoves: learnedMoves };
    }
    const hpDelta = stats.hp - active.maxHp;
    updated = {
      ...updated,
      level: newLevel,
      maxHp: stats.hp,
      currentHp: Math.min(stats.hp, active.currentHp + Math.max(0, hpDelta)),
      attack: stats.attack,
      defense: stats.defense,
      spAttack: stats.spAttack,
      spDefense: stats.spDefense,
      speed: stats.speed,
    };
  }

  let next: GameState = { ...state, playerPokemon: updated, levelUpNotification };
  next = syncPlayerToParty(next);

  // Exp Share: distribute 25% EXP + the same EV yield to each non-fainted
  // member. Player feedback flagged the previous 3% as "almost no EXP" —
  // bumping to 25% lands in the right neighborhood for the modern
  // mainline ratio (~50% for held-item version, but our buff is a single
  // global toggle covering the entire backline so we land halfway).
  // Skip effects flagged paused — the player explicitly turned the
  // buff off so battles shouldn't consume its remaining counter.
  const hasExpShare = state.activeEffects.some((e) => e.itemId === "expShare" && !e.paused);
  if (hasExpShare && state.party.length > 1) {
    const shared = Math.floor(exp * 0.25);
    if (shared > 0 || evYield) {
      const party = next.party.map((p, idx) => {
        if (idx === next.activePlayerPokemonIndex) return p;
        if (p.currentHp <= 0) return p;
        const sp = pokemonTable[p.speciesKey];
        const newExp = capTotalExp(p.totalExp + shared, sp.growthRate);
        const subUps = levelUpsForExp(p.speciesKey, sp.growthRate, p.level, newExp);
        const memberEvs = evYield ? applyEvYield(p.evs ?? ZERO_EVS, evYield) : (p.evs ?? ZERO_EVS);
        if (shared > 0) logs.push(`${p.name} gained ${shared} EXP from Exp Share.`);
        const newLevel = subUps.length > 0 ? subUps[subUps.length - 1].newLevel : p.level;
        const stats = calcAllStats(sp, newLevel, p.ivs, memberEvs, p.nature);
        const learnedMoves = subUps.flatMap((u) => u.newMoves);
        learnedMoves.forEach((id) => {
          const def = movesTable[id];
          if (def) logs.push(`${p.name} learned ${def.name}!`);
        });
        if (subUps.length > 0) logs.push(`${p.name} grew to level ${newLevel}!`);
        const moves = appendNewMoves(p.moves, learnedMoves);
        const hpDelta = stats.hp - p.maxHp;
        return {
          ...p,
          totalExp: newExp,
          evs: memberEvs,
          level: newLevel,
          maxHp: stats.hp,
          currentHp: Math.min(stats.hp, p.currentHp + Math.max(0, hpDelta)),
          attack: stats.attack,
          defense: stats.defense,
          spAttack: stats.spAttack,
          spDefense: stats.spDefense,
          speed: stats.speed,
          moves,
        };
      });
      next = { ...next, party };
    }
  }

  return { state: next, logs };
}

// When a Pokémon learns a new move, push it into an empty slot if there is one.
// If all 4 slots are full, leave the moveset alone — the player chooses which
// move to forget via the Manage Moves modal. The original game behaves the
// same way (you "didn't learn" the move unless you confirm a swap).
function appendNewMoves(existing: Pokemon["moves"], newIds: string[]): Pokemon["moves"] {
  const moves = [...existing];
  for (const id of newIds) {
    if (moves.some((m) => m.id === id)) continue;
    if (moves.length < 4) moves.push(toMove(id));
  }
  return moves;
}

function decrementEffects(effects: ActiveEffect[]): ActiveEffect[] {
  // Return the SAME array when there is nothing to change. `.map().filter()`
  // always allocates, so this used to hand back a brand-new (often empty)
  // array on every single battle — for every player, whether or not they
  // had any effects at all.
  //
  // That churn was not cosmetic: `state.activeEffects` is a dependency of
  // the cloud-save effect in GameContext, compared by reference. A new
  // array every battle re-ran that effect, whose cleanup cleared the
  // 1.5s save debounce. Battles resolve in well under 1.5s at speed 2+,
  // so the debounce was reset forever and the cloud save NEVER fired —
  // the save indicator sat on "Unsaved" and players reported coming back
  // to lost progress. Measured: 30s of idling = 37 resets, 0 saves.
  if (effects.length === 0) return effects;
  if (effects.every((e) => e.paused)) return effects;
  return effects
    .map((e) => (e.paused ? e : { ...e, battlesRemaining: e.battlesRemaining - 1 }))
    .filter((e) => e.battlesRemaining > 0);
}

function appendUnlocks(state: GameState): GameState {
  const next = unlockedFromProgress(state);
  if (next.length === state.unlockedLocations.length) return state;
  return { ...state, unlockedLocations: next };
}

// Dex tracking helpers
function markSeen(state: GameState, key: string): GameState {
  if (state.pokedexSeen.includes(key)) return state;
  return { ...state, pokedexSeen: [...state.pokedexSeen, key] };
}

function markCaught(state: GameState, key: string): GameState {
  const next = state.pokedexCaught.includes(key)
    ? state
    : { ...state, pokedexCaught: [...state.pokedexCaught, key] };
  const seen = next.pokedexSeen.includes(key)
    ? next
    : { ...next, pokedexSeen: [...next.pokedexSeen, key] };
  return grantShinyCharmOnCompletion(seen);
}

// Completing the Pokédex hands over the Shiny Charm — as an item, with a line
// in the log. Every dex registration in the game funnels through markCaught,
// so this is the one place the grant has to live.
//
// Before this the charm was an invisible multiplier with no grant and no
// notification: `hasShinyCharm` doubled rollShiny's odds and nothing else
// acknowledged it existed, so finishing the dex produced no observable result
// at all. The item itself was a phantom — in the catalog, described as "earned
// automatically by completing the Pokédex", added to no inventory anywhere.
function grantShinyCharmOnCompletion(state: GameState): GameState {
  const granted = grantShinyCharmIfEarned(state);
  if (granted === state) return state;
  const name = itemsCatalog[SHINY_CHARM_ITEM]?.name ?? "Shiny Charm";
  return pushLog(
    granted,
    `✨ Pokédex complete! The ${name} was added to your Bag — shiny rate doubled.`,
  );
}

// Rare Bottle Cap drop on completing a raid (catching the legendary). Bottle
// Caps are the ONLY source of perfect IVs (Hyper Training) and their only
// source is raids — so most raids drop nothing. Gold (all IVs) is rarer than
// Silver (one IV). `wasInRaid` is the raid flag from BEFORE the catch.
// EXP for a successful catch. Knocking a wild Pokémon out awarded EXP but
// CATCHING it awarded nothing, so filling the Pokédex actively cost you
// progress — players (rightly) flagged that catching should still train the
// party. Mirrors Gen 6+ behaviour: a catch grants the same EXP (and EV yield)
// the defeat would have.
function applyCatchExp(next: GameState, enemy: Pokemon): GameState {
  const species = pokemonTable[enemy.speciesKey];
  if (!species || !next.playerPokemon) return next;
  const exp = expYield(species, enemy.level);
  if (exp <= 0) return next;
  const { state: afterExp, logs } = applyExp(next, exp, evYieldFor(enemy.speciesKey));
  return pushLog(afterExp, ...logs, `${afterExp.playerPokemon?.name ?? "Your Pokémon"} gained ${exp} EXP!`);
}

function maybeRaidBottleCapDrop(next: GameState, wasInRaid: boolean): GameState {
  if (!wasInRaid) return next;
  const r = Math.random();
  const drop = r < 0.03 ? "goldbottlecap" : r < 0.15 ? "silverbottlecap" : null;
  if (!drop) return next;
  const inventory = { ...next.inventory, [drop]: (next.inventory[drop] ?? 0) + 1 };
  return pushLog({ ...next, inventory }, `✨ The raid yielded a ${itemsCatalog[drop]?.name ?? drop}!`);
}

// THE single "the raid wave was cleared, bring on the next one" routine.
//
// A wave ends one of two ways — the legendary faints, or the player catches
// it — and both MUST continue the raid. They used to be written out
// separately (only the faint path existed), so catching a legendary left
// `inRaid: true` with no enemy on the field and the raid silently stalled.
// Every caller now funnels through here so the two outcomes cannot drift
// apart again.
//
// The next legendary is rolled fresh from the SAME tier the player started
// in (persisted on `raidLegendary.tier`; older saves without a tier fall
// back to the legacy level-based picker) at +5 levels, capped at 100. Shiny
// rate matches wild encounters. The lead is re-derived so a party reorder
// made during the fight takes effect between waves.
//
// There is deliberately NO terminal condition: like the faint path always
// has, the raid runs until the player wipes (handleFaint / resolveTurnEnd)
// or bails (TRAVEL / HEAL / END_RAID). At level 100 the cap simply holds and
// waves keep coming at 100.
//
// Returns null when this isn't a live raid so callers fall through to their
// normal end-of-encounter handling. Note it applies `decrementEffects`
// itself — callers must not also decrement.
function spawnNextRaidWave(state: GameState, clearedLevel: number): GameState | null {
  if (!state.inRaid || !state.raidLegendary) return null;
  const newLevel = Math.min(100, clearedLevel + 5);
  const tierId = state.raidLegendary.tier;
  const nextSpeciesKey = tierId
    ? pickRandomLegendaryForTier(tierId, newLevel)
    : pickRandomLegendary(newLevel);
  const isShiny = rollShiny(hasShinyCharm(state));
  const incoming = createPokemon(nextSpeciesKey, newLevel, state.nextPokemonId, isShiny);
  const leadIdx = firstHealthyIndex(state.party);
  const lead = state.party[leadIdx] ?? state.playerPokemon;
  const playerSwapped = !!lead && lead.id !== state.playerPokemon?.id;
  return pushLog(
    {
      ...state,
      phase: "battle",
      enemyPokemon: incoming,
      raidLegendary: { speciesKey: nextSpeciesKey, level: newLevel, tier: tierId },
      raidLevel: state.raidLevel + 1,
      nextPokemonId: state.nextPokemonId + 1,
      activeEffects: decrementEffects(state.activeEffects),
      activePlayerPokemonIndex: leadIdx,
      playerPokemon: lead,
      // Reset volatile so the new lead doesn't inherit the previous mon's
      // stat stages / locked move.
      playerVolatile: playerSwapped
        ? {
            statStages: { attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0 },
            mustRecharge: false,
            lockedMove: null,
            lockTurnsRemaining: 0,
          }
        : state.playerVolatile,
    },
    ...(playerSwapped && lead ? [`Go, ${lead.name}!`] : []),
    `Wave ${state.raidLevel + 1}: ${incoming.name} appears at Lv. ${newLevel}!`
  );
}

// Everything that happens once a ball actually connects. Shared by the
// instant path (CATCH_POKEMON) and the animated path
// (TRY_CATCH -> CATCH_RESOLVE) so the two can't diverge: party/box
// placement, Pokédex + shiny registration, the "Gotcha!" line, the raid
// Bottle Cap roll, catch EXP, and the win counters.
//
// `next` is the state with the ball already spent (and, on the animated
// path, `catchAnim` already cleared). `enemy` is the Pokémon that was on
// the field. `wasInRaid` is the raid flag read before the catch.
//
// In a raid the catch clears the wave exactly like a KO does and the next
// legendary comes straight in; outside a raid the encounter ends and the
// player drops to idle, unchanged.
function applyCatchSuccess(state: GameState, enemy: Pokemon, wasInRaid: boolean): GameState {
  const caught: Pokemon = { ...enemy, id: String(state.nextPokemonId) };
  let next: GameState = { ...state, nextPokemonId: state.nextPokemonId + 1 };
  if (next.party.length < 6) {
    next = { ...next, party: [...next.party, caught] };
  } else {
    next = { ...next, box: [...next.box, caught] };
  }
  next = markCaught(next, caught.speciesKey);
  if (caught.isShiny && !next.shinyCaught.includes(caught.speciesKey)) {
    next = { ...next, shinyCaught: [...next.shinyCaught, caught.speciesKey] };
  }
  next = pushLog(next, `Gotcha! ${caught.name} was caught!`);
  next = maybeRaidBottleCapDrop(next, wasInRaid);
  next = applyCatchExp(next, enemy);
  next = {
    ...next,
    wildBattlesWon: next.wildBattlesWon + 1,
    battlesWonByLocation: {
      ...next.battlesWonByLocation,
      [next.currentLocation]: (next.battlesWonByLocation[next.currentLocation] ?? 0) + 1,
    },
  };
  // Raid: the wave is cleared, so summon the next one (+5 levels) rather
  // than dumping the player to idle with `inRaid` still set.
  const continued = spawnNextRaidWave(next, enemy.level);
  if (continued) return continued;
  // Outside a raid: end the battle and go idle.
  return {
    ...next,
    phase: "idle",
    enemyPokemon: null,
    activeEffects: decrementEffects(next.activeEffects),
  };
}

export function reducer(state: GameState, action: Action): GameState {
  switch (action.type) {
    case "SELECT_STARTER": {
      const { speciesKey, isShiny } = action.payload;
      const starter = createPokemon(speciesKey, 5, state.nextPokemonId, !!isShiny);
      let next: GameState = {
        ...state,
        phase: "idle",
        playerPokemon: starter,
        party: [starter],
        nextPokemonId: state.nextPokemonId + 1,
        currentLocation: "palletTown",
        currentRoute: "route1",
        activePlayerPokemonIndex: 0,
      };
      next = markCaught(next, speciesKey);
      if (isShiny) {
        next = {
          ...next,
          shinyCaught: next.shinyCaught.includes(speciesKey)
            ? next.shinyCaught
            : [...next.shinyCaught, speciesKey],
          shinySeen: next.shinySeen.includes(speciesKey)
            ? next.shinySeen
            : [...next.shinySeen, speciesKey],
        };
      }
      return pushLog(next, `You chose ${starter.name}!`);
    }

    case "SELECT_REGION_STARTER": {
      const { region: regionId, speciesKey, isShiny } = action.payload;
      const region = regions[regionId];
      // Defensive no-ops: already claimed, or a payload that doesn't match
      // this region's actual starter roster (shouldn't happen from the UI,
      // which only ever dispatches region.starters, but a stale/replayed
      // dispatch after a reload could otherwise double-grant a starter).
      if (!region || state.claimedRegionStarters.includes(regionId)) return state;
      if (!region.starters.includes(speciesKey)) return state;
      const starter = createPokemon(speciesKey, 5, state.nextPokemonId, !!isShiny);
      const roomInParty = state.party.length < 6;
      let next: GameState = {
        ...state,
        phase: "idle",
        nextPokemonId: state.nextPokemonId + 1,
        claimedRegionStarters: [...state.claimedRegionStarters, regionId],
        party: roomInParty ? [...state.party, starter] : state.party,
        box: roomInParty ? state.box : [...state.box, starter],
      };
      if (roomInParty) next = rederiveActive(next);
      next = markCaught(next, speciesKey);
      if (isShiny) {
        next = {
          ...next,
          shinyCaught: next.shinyCaught.includes(speciesKey)
            ? next.shinyCaught
            : [...next.shinyCaught, speciesKey],
          shinySeen: next.shinySeen.includes(speciesKey)
            ? next.shinySeen
            : [...next.shinySeen, speciesKey],
        };
      }
      return pushLog(
        next,
        roomInParty
          ? `You received ${starter.name}!`
          : `You received ${starter.name}! (sent to Box — party full)`,
      );
    }

    case "START_ENCOUNTER": {
      const enemy = action.payload.pokemon;
      let next = markSeen(state, enemy.speciesKey);
      if (enemy.isShiny && !next.shinySeen.includes(enemy.speciesKey)) {
        next = { ...next, shinySeen: [...next.shinySeen, enemy.speciesKey] };
      }
      // Battle starts with whoever is currently first healthy in the party.
      // This consumes any "queued" reorder the player did between battles.
      const idx = firstHealthyIndex(next.party);
      return {
        ...next,
        phase: "battle",
        enemyPokemon: enemy,
        pendingEvents: [],
        battleWeather: null,
        activePlayerPokemonIndex: idx,
        playerPokemon: next.party[idx] ?? next.playerPokemon,
        battleLog: [...next.battleLog, `A wild ${enemy.name}${enemy.isShiny ? " ✨" : ""} appeared!`],
        playerVolatile: {
          statStages: { attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0 },
          mustRecharge: false,
          lockedMove: null,
          lockTurnsRemaining: 0,
        },
      };
    }

    case "EXECUTE_TURN": {
      if (!state.playerPokemon || !state.enemyPokemon) return state;
      if (state.pendingEvents.length > 0) return state; // events still draining
      const isTrainer = !!state.trainerBattle;
      const isBoss = !!state.bossBattle;
      const smartEnemy = isTrainer || isBoss;
      // Manual mode passes the chosen move id; auto mode leaves it undefined
      // and the AI picks one. Locked-move / recharge override either way.
      const playerMoveId = action.payload?.playerMoveId;

      // Simulate the turn on cloned sides. Events carry hp-after per step;
      // the EventDriver consumes them one-by-one (typewriter-gated) via
      // CONSUME_EVENT, so HP changes ride in lockstep with the log lines.
      const player: BattleSide = withTypes({ ...state.playerPokemon });
      const enemy: BattleSide = withTypes({ ...state.enemyPokemon });
      Object.assign(player, state.playerVolatile ?? {});
      // Mutable weather context — the resolver may read/set it; we persist
      // the result back to state.battleWeather after the turn.
      const weatherCtx = { current: state.battleWeather ?? null };
      const events = executeTurn(player, enemy, smartEnemy, playerMoveId, weatherCtx);

      // Read the post-turn PP back out of the (now-mutated) BattleSide
      // clone and persist it to state.playerPokemon. executeTurn
      // decrements pp on the move slot for any "fresh" pick (skipping
      // recharge / continuing-lock turns to match canonical PP rules).
      // Mirror to the party slot so the same Pokemon viewed from the
      // party rail / Manage Moves modal reads the same PP values.
      const updatedPlayer: Pokemon = { ...state.playerPokemon, moves: player.moves };
      const partyIdx = state.activePlayerPokemonIndex;
      const updatedParty =
        partyIdx >= 0 && partyIdx < state.party.length && state.party[partyIdx]?.id === updatedPlayer.id
          ? state.party.map((p, i) => (i === partyIdx ? updatedPlayer : p))
          : state.party;

      return {
        ...state,
        playerPokemon: updatedPlayer,
        party: updatedParty,
        pendingEvents: events,
        battleWeather: weatherCtx.current,
        // Apply volatile (stat stages / locked move) immediately — these
        // never animate and only matter for the next turn's calculations.
        playerVolatile: {
          statStages: {
            attack: player.statStages?.attack ?? 0,
            defense: player.statStages?.defense ?? 0,
            spAttack: player.statStages?.spAttack ?? 0,
            spDefense: player.statStages?.spDefense ?? 0,
            speed: player.statStages?.speed ?? 0,
          },
          mustRecharge: !!player.mustRecharge,
          lockedMove: player.lockedMove ?? null,
          lockTurnsRemaining: player.lockTurnsRemaining ?? 0,
        },
      };
    }

    case "APPLY_EXP": {
      if (!state.playerPokemon) return state;
      const { state: after, logs } = applyExp(state, action.payload.exp);
      return pushLog(after, ...logs);
    }

    case "HEAL": {
      if (!state.playerPokemon) return state;
      const healed: Pokemon = { ...state.playerPokemon, currentHp: state.playerPokemon.maxHp };
      return syncPlayerToParty({ ...state, playerPokemon: healed });
    }

    case "HEAL_PARTY": {
      // If everyone was fainted (eg defensive auto-heal in useBattleLoop),
      // play the white-out fade animation as a courtesy.
      const wasAllFainted =
        state.party.length > 0 && state.party.every((p) => p.currentHp <= 0);
      const party = state.party.map((p) => ({
        ...p,
        currentHp: p.maxHp,
        moves: p.moves.map((m) => ({ ...m, pp: m.maxPp })),
      }));
      const playerPokemon = party[state.activePlayerPokemonIndex] ?? state.playerPokemon;
      // Heal also functions as a "bail out" — if the player is mid-battle
      // (or in a raid), it ends the encounter cleanly so the user can use
      // it as a panic button without losing money.
      const wasInRaid = state.inRaid;
      const wasInBattle =
        state.phase === "battle" ||
        state.phase === "trainerBattle" ||
        state.phase === "bossBattle" ||
        state.pendingEvents.length > 0;
      let next: GameState = {
        ...state,
        party,
        playerPokemon,
        phase: "idle",
        enemyPokemon: null,
        pendingEvents: [],
        currentEventIndex: 0,
        trainerBattle: null,
        bossBattle: null,
        bossQueue: [],
        playerVolatile: null,
        awaitingSwitch: false,
        whiteoutAnim: wasAllFainted ? { key: Date.now() } : state.whiteoutAnim,
      };
      if (wasInRaid) {
        const cooldownEnd = Date.now() + RAID_COOLDOWN_MS;
        const tierId = state.raidLegendary?.tier ?? DEFAULT_RAID_TIER;
        next = {
          ...next,
          inRaid: false,
          raidLegendary: null,
          raidLevel: 0,
          currentLocation: state.preRaidLocation ?? "palletTown",
          currentRoute: state.preRaidLocation ?? "route1",
          preRaidLocation: null,
          raidCooldownEnd: cooldownEnd,
          raidCooldowns: { ...state.raidCooldowns, [tierId]: cooldownEnd },
        };
      }
      const msg = wasInBattle
        ? "You retreated and healed your party!"
        : "Your party was fully healed!";
      return pushLog(next, msg);
    }

    case "SET_SPEED":
      return { ...state, speed: action.payload.speed };

    case "SET_BATTLE_MODE":
      return { ...state, battleMode: action.payload.mode };

    case "TOGGLE_PAUSE":
      return { ...state, paused: !state.paused };

    case "CLEAR_LEVEL_UP":
      return { ...state, levelUpNotification: null };

    case "PHASE_IDLE":
      return { ...state, phase: "idle", enemyPokemon: null };

    case "ADD_LOG":
      return pushLog(state, action.payload.text);

    case "SET_MOVES": {
      const updateMoves = (p: Pokemon) =>
        p.id === action.payload.pokemonId
          ? { ...p, moves: action.payload.moveIds.map(toMove) }
          : p;
      return syncPlayerToParty({
        ...state,
        playerPokemon:
          state.playerPokemon && state.playerPokemon.id === action.payload.pokemonId
            ? { ...state.playerPokemon, moves: action.payload.moveIds.map(toMove) }
            : state.playerPokemon,
        party: state.party.map(updateMoves),
        box: state.box.map(updateMoves),
      });
    }

    case "CATCH_POKEMON": {
      if (!state.enemyPokemon) return state;
      const ballId = action.payload.ballId;
      const inv = { ...state.inventory };
      if ((inv[ballId] ?? 0) <= 0) return pushLog(state, "You don't have any!");
      inv[ballId] = inv[ballId] - 1;
      const catchHpFrac = state.enemyPokemon.maxHp > 0
        ? state.enemyPokemon.currentHp / state.enemyPokemon.maxHp : 1;
      const success = ballId === "masterball" || rollCatch(state.enemyPokemon.speciesKey, ballId, catchHpFrac);
      if (!success) {
        return pushLog({ ...state, inventory: inv }, `Oh no! The ${state.enemyPokemon.name} broke free!`);
      }
      // Shared with CATCH_RESOLVE — party/box, dex, EXP, counters, and (in a
      // raid) the next wave.
      return applyCatchSuccess({ ...state, inventory: inv }, state.enemyPokemon, state.inRaid);
    }

    case "TRY_CATCH": {
      // Manual ball throw with the catch animation. Decrements the ball,
      // pre-rolls the result so the animation can be honest about it,
      // and stashes everything in catchAnim. The visual layer plays the
      // arc + 3-shake then dispatches CATCH_RESOLVE to apply the outcome.
      if (!state.enemyPokemon) return state;
      // While an animation is already running, ignore further throws.
      if (state.catchAnim) return state;
      const ballId = action.payload.ballId;
      const inv = { ...state.inventory };
      if ((inv[ballId] ?? 0) <= 0) return pushLog(state, "You don't have any!");
      inv[ballId] = inv[ballId] - 1;
      const tryCatchHpFrac = state.enemyPokemon.maxHp > 0
        ? state.enemyPokemon.currentHp / state.enemyPokemon.maxHp : 1;
      const success = ballId === "masterball" || rollCatch(state.enemyPokemon.speciesKey, ballId, tryCatchHpFrac);
      const ballName = pokeballs[ballId]?.name ?? itemsCatalog[ballId]?.name ?? ballId;
      return pushLog(
        {
          ...state,
          inventory: inv,
          catchAnim: { ballId, success, key: Date.now() },
        },
        `You threw a ${ballName}!`
      );
    }

    case "CLEAR_WHITEOUT_ANIM":
      return { ...state, whiteoutAnim: null };

    case "APPLY_DAILY_REWARD": {
      // The server has already recorded the claim + streak; this just adds
      // the returned reward to the local save. The unconditional localStorage
      // write means the reward survives even if the cloud upload is offline.
      const inventory = { ...state.inventory };
      for (const it of action.payload.items) {
        inventory[it.itemId] = Math.min(999_999, (inventory[it.itemId] ?? 0) + it.quantity);
      }
      const money = Math.min(999_999_999, state.money + Math.max(0, action.payload.money));
      return { ...state, inventory, money };
    }

    case "CATCH_RESOLVE": {
      // Animation finished — apply the pre-rolled outcome. If success, copy
      // the (still-on-field) enemy into the party/box and end the encounter
      // (or, in a raid, roll straight into the next wave); if failure, just
      // clear the animation and let the battle continue.
      const anim = state.catchAnim;
      if (!anim || !state.enemyPokemon) {
        return { ...state, catchAnim: null };
      }
      if (!anim.success) {
        // Failed catch costs a turn — the enemy gets a free attack
        // before the player can act again. Run executeTurn with the
        // playerSkipped flag so only the enemy step + end-of-turn
        // ticks (weather / status) fire. The events drain through
        // the normal pendingEvents pipeline so HP changes animate.
        // If for some reason the player has no active mon (shouldn't
        // happen mid-battle), fall back to the no-turn path.
        if (!state.playerPokemon) {
          return pushLog(
            { ...state, catchAnim: null },
            `Oh no! The ${state.enemyPokemon.name} broke free!`
          );
        }
        const player: BattleSide = withTypes({ ...state.playerPokemon });
        const enemy: BattleSide = withTypes({ ...state.enemyPokemon });
        Object.assign(player, state.playerVolatile ?? {});
        const weatherCtx = { current: state.battleWeather ?? null };
        const events = executeTurn(player, enemy, !!state.trainerBattle || !!state.bossBattle, undefined, weatherCtx, true);
        return pushLog(
          {
            ...state,
            catchAnim: null,
            pendingEvents: events,
            battleWeather: weatherCtx.current,
            playerVolatile: {
              statStages: {
                attack: player.statStages?.attack ?? 0,
                defense: player.statStages?.defense ?? 0,
                spAttack: player.statStages?.spAttack ?? 0,
                spDefense: player.statStages?.spDefense ?? 0,
                speed: player.statStages?.speed ?? 0,
              },
              mustRecharge: !!player.mustRecharge,
              lockedMove: player.lockedMove ?? null,
              lockTurnsRemaining: player.lockTurnsRemaining ?? 0,
            },
          },
          `Oh no! The ${state.enemyPokemon.name} broke free!`
        );
      }
      // Shared with CATCH_POKEMON — party/box, dex, EXP, counters, and (in a
      // raid) the next wave.
      return applyCatchSuccess({ ...state, catchAnim: null }, state.enemyPokemon, state.inRaid);
    }

    case "TOGGLE_AUTO_CATCH":
      return { ...state, autoCatch: !state.autoCatch };

    case "REORDER_PARTY": {
      const { from, to } = action.payload;
      if (from < 0 || to < 0 || from >= state.party.length || to >= state.party.length) return state;
      const party = [...state.party];
      const [moved] = party.splice(from, 1);
      party.splice(to, 0, moved);
      // Active = first healthy. In battle, queue for next encounter; out of
      // battle, the new slot 0 becomes active immediately.
      return rederiveActive({ ...state, party });
    }

    case "SWAP_PARTY": {
      const { a, b } = action.payload;
      if (a === b) return state;
      const party = [...state.party];
      [party[a], party[b]] = [party[b], party[a]];
      // Active = first healthy. In battle, the in-battle Pokémon stays but
      // we update the index so the NEXT encounter starts with the new slot 0.
      return rederiveActive({ ...state, party });
    }

    case "PARTY_TO_BOX": {
      if (state.party.length <= 1) return pushLog(state, "Cannot deposit your last Pokemon!");
      const cleared = bailFromBattle(state);
      const idx = action.payload.partyIndex;
      const party = cleared.party.filter((_, i) => i !== idx);
      const box = [...cleared.box, cleared.party[idx]];
      return rederiveActive({ ...cleared, party, box });
    }

    case "BOX_TO_PARTY": {
      if (state.party.length >= 6) return pushLog(state, "Party is full!");
      const cleared = bailFromBattle(state);
      const idx = action.payload.boxIndex;
      const box = cleared.box.filter((_, i) => i !== idx);
      const party = [...cleared.party, cleared.box[idx]];
      return rederiveActive({ ...cleared, party, box });
    }

    case "SWAP_PARTY_BOX": {
      const cleared = bailFromBattle(state);
      const { partyIndex, boxIndex } = action.payload;
      const party = [...cleared.party];
      const box = [...cleared.box];
      [party[partyIndex], box[boxIndex]] = [box[boxIndex], party[partyIndex]];
      return rederiveActive({ ...cleared, party, box });
    }

    case "TRAVEL": {
      const id = action.payload.locationId;
      if (!state.unlockedLocations.includes(id)) return state;
      // Clean break: cancel any active battle, drain events, clear trainer
      // and raid state. The player can click the map at any time.
      const wasInRaid = state.inRaid;
      let next: GameState = {
        ...state,
        currentLocation: id,
        currentRoute: id,
        phase: "idle",
        enemyPokemon: null,
        pendingEvents: [],
        currentEventIndex: 0,
        trainerBattle: null,
        bossBattle: null,
        bossQueue: [],
        playerVolatile: null,
        awaitingSwitch: false,
      };
      if (wasInRaid) {
        next = {
          ...next,
          inRaid: false,
          raidLegendary: null,
          raidLevel: 0,
          preRaidLocation: null,
        };
      }
      // Re-derive the active Pokémon — if the previous active is fainted
      // and we have healthy ones, slot 0 (or first healthy) becomes the
      // lead so the encounter loop isn't stuck on a KO'd active.
      next = rederiveActive(next);
      if (pendingRegionStarter(next.claimedRegionStarters, id)) {
        next = { ...next, phase: "regionStarterSelect" };
      }
      return pushLog(next, `Travelled to ${routes[id]?.name ?? id}.`);
    }

    case "START_EVOLUTION": {
      // Evolve can be triggered mid-battle from the detail modal — bail
      // out of the encounter so the evolution animation has the scene
      // to itself and the player drops to idle when it finishes.
      //
      // `pokemonId` re-anchors the slot for callers that did not compute the
      // index in the same frame they dispatched it. useAutoEvolve reads the
      // party out of a committed render, and a reorder, a box swap or a
      // release landing in between would leave the index pointing at a
      // DIFFERENT Pokémon — which evolves, irreversibly, and is not the one
      // that qualified. Re-finding by id makes the index advisory; an id that
      // is no longer in the party means the mon left and there is nothing to
      // do, so the action is dropped rather than applied to a stranger.
      const requestedIndex = action.payload.partyIndex;
      const { pokemonId } = action.payload;
      const partyIndex = pokemonId
        ? state.party.findIndex((p) => p.id === pokemonId)
        : requestedIndex;
      if (pokemonId && partyIndex < 0) return state;
      const evolving = state.party[partyIndex];
      // A branching line's target belongs to the POKÉMON, not the caller.
      // START_EVOLUTION is dispatched from four places, one of which (the
      // stream auto-player) scans for the first satisfied level trigger and
      // has no notion of branch predicates — so it would happily ask for a
      // Hitmonlee from a Tyrogue whose Defense is higher. Re-resolving here
      // means every entry point lands on the same branch without any of them
      // having to agree on how the split works.
      const toSpeciesKey = evolving
        ? resolveEvolutionTarget(evolving, action.payload.toSpeciesKey)
        : action.payload.toSpeciesKey;
      const cleared = bailFromBattle(state);
      return {
        ...cleared,
        phase: "evolution",
        evolutionState: {
          partyIndex,
          toSpeciesKey,
          step: 0,
        },
      };
    }

    case "EVOLUTION_STEP":
      if (!state.evolutionState) return state;
      return {
        ...state,
        evolutionState: { ...state.evolutionState, step: state.evolutionState.step + 1 },
      };

    case "COMPLETE_EVOLUTION": {
      if (!state.evolutionState) return state;
      const { partyIndex, toSpeciesKey } = state.evolutionState;
      const party = [...state.party];
      const old = party[partyIndex];
      if (!old) return { ...state, evolutionState: null, phase: "idle" };
      const sp = pokemonTable[toSpeciesKey];
      // Defensive: if the evolution target isn't in the dex data (a bad
      // evolution entry pointing at an unimplemented species), bail cleanly
      // instead of crashing on sp.baseStats. Callers guard before consuming
      // items, so nothing is lost here either.
      if (!sp) {
        return pushLog(
          { ...state, evolutionState: null, phase: "idle" },
          `${old.name} glowed… but its evolution isn't available yet.`,
        );
      }
      // Forward EVs + nature into the post-evolution stat recompute so
      // hard-earned EV training and ±10% nature multipliers survive
      // the species swap. The level-up and exp-share branches both
      // already pass these; this one was an outlier that silently
      // zeroed out evs and used a 1.0× nature multiplier.
      const stats = calcAllStats(sp, old.level, old.ivs, old.evs, old.nature);
      const evolved: Pokemon = {
        ...old,
        speciesKey: toSpeciesKey,
        name: sp.name,
        maxHp: stats.hp,
        currentHp: Math.min(stats.hp, old.currentHp + Math.max(0, stats.hp - old.maxHp)),
        attack: stats.attack,
        defense: stats.defense,
        spAttack: stats.spAttack,
        spDefense: stats.spDefense,
        speed: stats.speed,
      };
      party[partyIndex] = evolved;
      let next: GameState = {
        ...state,
        party,
        playerPokemon:
          state.activePlayerPokemonIndex === partyIndex ? evolved : state.playerPokemon,
        evolutionState: null,
        phase: "idle",
      };
      next = markCaught(next, toSpeciesKey);
      return pushLog(next, `${old.name} evolved into ${evolved.name}!`);
    }

    case "SET_CATCH_RULE": {
      const { routeKey, speciesKey, settings } = action.payload;
      const routeRules = { ...(state.catchSettings[routeKey] ?? {}) };
      routeRules[speciesKey] = settings;
      return {
        ...state,
        catchSettings: { ...state.catchSettings, [routeKey]: routeRules },
      };
    }

    case "SET_GLOBAL_CATCH_DEFAULTS": {
      const { settings, routeKey } = action.payload;
      let catchSettings = state.catchSettings;
      const existingRouteRules = routeKey ? state.catchSettings[routeKey] : undefined;
      if (routeKey && existingRouteRules) {
        // A per-species override is a full snapshot, not a diff against
        // the global default — so without this, changing Mode/Balls
        // here does nothing for any species on this route that already
        // has an override (multiple bug reports: "I set it to Always,
        // the JSON still shows pokedex_new"). Refresh mode/threshold/
        // balls on every existing override for the route being viewed;
        // NEVER touch `enabled` — that is deliberately per-species.
        const routeRules: Record<string, typeof settings> = {};
        for (const [speciesKey, rule] of Object.entries(existingRouteRules)) {
          routeRules[speciesKey] = {
            ...rule,
            mode: settings.mode,
            levelThreshold: settings.levelThreshold,
            enabledBalls: settings.enabledBalls,
          };
        }
        catchSettings = { ...state.catchSettings, [routeKey]: routeRules };
      }
      return { ...state, globalCatchDefaults: settings, catchSettings };
    }

    case "TOGGLE_ROUTE_CATCH_ALL": {
      const { routeKey, enabled } = action.payload;
      // Previously only iterated over EXISTING per-species rules — so
      // "All" / "None" did nothing on a fresh route where the user
      // had never customized anything. Multiple bug reports of
      // "catch settings do nothing" traced back here. Now enumerate
      // the route's actual encounter list and materialize a rule for
      // every species (starting from globalCatchDefaults + the
      // requested enabled state). Uses a lazy import of the merged
      // encounters map from data/regions since reducer.ts avoided
      // that dependency previously.
      //
      // Always builds from the LIVE state.globalCatchDefaults, never
      // from a pre-existing per-species entry — that entry can be a
      // stale snapshot from months ago (mode/balls the player has since
      // changed), and "All"/"None" should mean "catch everything using
      // my CURRENT settings", not "re-apply whatever was frozen here".
      const encs = mergedEncounters[routeKey]?.encounters ?? [];
      const existing = state.catchSettings[routeKey] ?? {};
      const rules: Record<string, typeof state.globalCatchDefaults> = { ...existing };
      for (const e of encs) {
        rules[e.speciesKey] = { ...state.globalCatchDefaults, enabled };
      }
      // Also flip any pre-existing rules that weren't on the encounter
      // list (defensive — old data or renamed species keys) so "None"
      // truly silences the route. `rules[k] === existing[k]` means the
      // encs loop above hasn't already replaced this key.
      for (const k of Object.keys(existing)) {
        if (rules[k] === existing[k]) rules[k] = { ...state.globalCatchDefaults, enabled };
      }
      return {
        ...state,
        catchSettings: { ...state.catchSettings, [routeKey]: rules },
      };
    }

    case "MARK_SEEN":
      return markSeen(state, action.payload.speciesKey);
    case "MARK_CAUGHT":
      return markCaught(state, action.payload.speciesKey);
    case "MARK_SHINY_CAUGHT":
      return state.shinyCaught.includes(action.payload.speciesKey)
        ? state
        : { ...state, shinyCaught: [...state.shinyCaught, action.payload.speciesKey] };
    case "MARK_SHINY_SEEN":
      return state.shinySeen.includes(action.payload.speciesKey)
        ? state
        : { ...state, shinySeen: [...state.shinySeen, action.payload.speciesKey] };

    case "BUY_ITEM": {
      const { itemId, quantity } = action.payload;
      // Catalog wins; legacy pokeballs/consumables/stones tables are fallbacks
      // for back-compat with items that haven't been migrated yet.
      const cat = itemsCatalog[itemId];
      const ball = pokeballs[itemId];
      const consumable = consumables[itemId];
      const stone = evolutionStones[itemId];
      const price =
        cat?.buyPrice ??
        ball?.buyPrice ??
        consumable?.buyPrice ??
        (stone ? 2100 : null);
      if (price === null || price === undefined) return pushLog(state, "This item isn't for sale.");
      const total = price * quantity;
      if (state.money < total) return pushLog(state, "Not enough money!");
      // Special case: Exp. Share is a buff, not a stockpile-able held item.
      // Buying it (re)activates the active-effect timer for `quantity * duration`
      // battles. Doesn't go into inventory. We previously hard-capped at
      // 3× duration (900 battles) which silently wasted any over-purchase
      // — player feedback was "stops at 999 but money gets deducted".
      // Now we stack uncapped so the player gets what they paid for.
      if (itemId === "expShare") {
        const def = consumables.expShare;
        const addBattles = (def?.duration ?? 300) * quantity;
        const existing = state.activeEffects.find((e) => e.itemId === "expShare");
        const activeEffects = existing
          ? state.activeEffects.map((e) =>
              e === existing
                ? { ...e, battlesRemaining: e.battlesRemaining + addBattles }
                : e
            )
          : [
              ...state.activeEffects,
              { itemId, battlesRemaining: addBattles, speciesKey: "", routeKey: "" },
            ];
        return pushLog(
          { ...state, money: state.money - total, activeEffects },
          `Activated Exp. Share (+${addBattles} battles).`
        );
      }
      return {
        ...state,
        money: state.money - total,
        inventory: {
          ...state.inventory,
          [itemId]: (state.inventory[itemId] ?? 0) + quantity,
        },
      };
    }

    case "USE_POKEBALL":
      // Handled via CATCH_POKEMON above; kept as alias for compatibility.
      return state;

    case "CONSUME_ITEM": {
      const { itemId, quantity = 1 } = action.payload;
      const owned = state.inventory[itemId] ?? 0;
      if (owned <= 0) return state;
      const next = Math.max(0, owned - quantity);
      const inventory = { ...state.inventory };
      if (next === 0) delete inventory[itemId];
      else inventory[itemId] = next;
      return { ...state, inventory };
    }

    case "SELL_ITEM": {
      // Sell N of an item at its catalog sellPrice. Refuses to sell
      // items without a sellPrice (Master Ball, key items, HM/TM
      // display-only entries) since those are non-fungible by design.
      const { itemId, quantity } = action.payload;
      if (quantity <= 0) return state;
      const owned = state.inventory[itemId] ?? 0;
      if (owned <= 0) return state;
      const sellPrice = itemsCatalog[itemId]?.sellPrice ?? 0;
      if (sellPrice <= 0) return pushLog(state, "This item can't be sold.");
      const actualQty = Math.min(quantity, owned);
      const gained = actualQty * sellPrice;
      const inventory = { ...state.inventory };
      const remaining = owned - actualQty;
      if (remaining <= 0) delete inventory[itemId];
      else inventory[itemId] = remaining;
      const name = itemsCatalog[itemId]?.name ?? itemId;
      return pushLog(
        { ...state, inventory, money: state.money + gained },
        actualQty > 1
          ? `Sold ${actualQty}× ${name} for $${gained.toLocaleString()}.`
          : `Sold ${name} for $${gained.toLocaleString()}.`
      );
    }

    case "USE_LINK_CABLE": {
      // Solo trade-evolution. Lets offline players evolve trade-only
      // species (Kadabra→Alakazam, etc.) and trade-with-item species
      // (Onix+Metal Coat→Steelix, etc.) without an actual trade
      // partner. The Link Cable is consumed; for trade+item entries
      // the catalyst (Metal Coat / King's Rock / etc.) is consumed
      // from the Pokémon's heldItem slot too, matching the live
      // peer-to-peer trade flow.
      const { partyIndex } = action.payload;
      if (partyIndex < 0 || partyIndex >= state.party.length) return state;
      const owned = state.inventory.linkcable ?? 0;
      if (owned <= 0) return pushLog(state, "You don't have a Link Cable.");
      const target = state.party[partyIndex];
      if (!target) return state;
      const evos = evolutions[target.speciesKey] ?? [];
      // Prefer trade+item matches (more specific) over pure trade.
      const tradeEvo =
        evos.find((e) => "trade" in e && "item" in e && (e as any).item === target.heldItem)
        ?? evos.find((e) => "trade" in e && !("item" in e));
      if (!tradeEvo) {
        const tradeWithItem = evos.find((e) => "trade" in e && "item" in e) as any;
        if (tradeWithItem) {
          const itemName = itemsCatalog[tradeWithItem.item]?.name ?? tradeWithItem.item;
          return pushLog(state, `${target.name} needs to be holding ${itemName} to evolve via Link Cable.`);
        }
        return pushLog(state, `${target.name} can't evolve via Link Cable.`);
      }
      // Don't consume anything if the evolution target isn't implemented —
      // otherwise the cable + held catalyst are burned for a broken evolve.
      if (!pokemonTable[(tradeEvo as any).into]) {
        return pushLog(state, `${target.name}'s evolution isn't available yet — no items were used.`);
      }
      // Consume the cable from inventory.
      const inventory = { ...state.inventory };
      const remaining = owned - 1;
      if (remaining <= 0) delete inventory.linkcable;
      else inventory.linkcable = remaining;
      // For trade+item evolutions also strip the held catalyst — the
      // peer-to-peer flow does the same in TRADE_COMPLETE.
      let party = state.party;
      if ("item" in tradeEvo) {
        party = state.party.map((p, i) =>
          i === partyIndex ? { ...p, heldItem: undefined } : p
        );
      }
      const cleared = bailFromBattle({ ...state, inventory, party });
      return pushLog(
        {
          ...cleared,
          phase: "evolution",
          evolutionState: {
            partyIndex,
            toSpeciesKey: (tradeEvo as any).into,
            step: 0,
          },
        },
        `Used a Link Cable on ${target.name}!`
      );
    }

    case "USE_STONE": {
      // Item-first stone evolution. Validate → consume 1 → evolve, all
      // atomically (mirrors USE_LINK_CABLE), so a stone is never spent
      // without an evolution and a wrong target gets a clear message
      // instead of the old silent no-op. Party-only: evolutionState indexes
      // into state.party.
      const { itemId, partyIndex } = action.payload;
      if (partyIndex < 0 || partyIndex >= state.party.length) return state;
      const owned = state.inventory[itemId] ?? 0;
      const stoneName = itemsCatalog[itemId]?.name ?? evolutionStones[itemId]?.name ?? itemId;
      if (owned <= 0) return pushLog(state, `You don't have a ${stoneName}.`);
      const target = state.party[partyIndex];
      if (!target) return state;
      const match = (evolutions[target.speciesKey] ?? []).find(
        (e) => "item" in e && !("trade" in e) && (e as any).item === itemId,
      ) as { into: string } | undefined;
      if (!match) return pushLog(state, `The ${stoneName} had no effect on ${target.name}.`);
      // Don't spend the stone if the evolution target isn't implemented.
      if (!pokemonTable[match.into]) {
        return pushLog(state, `${target.name}'s evolution isn't available yet — the ${stoneName} was not used.`);
      }
      const inventory = { ...state.inventory };
      const remaining = owned - 1;
      if (remaining <= 0) delete inventory[itemId];
      else inventory[itemId] = remaining;
      const cleared = bailFromBattle({ ...state, inventory });
      return pushLog(
        {
          ...cleared,
          phase: "evolution",
          evolutionState: { partyIndex, toSpeciesKey: match.into, step: 0 },
        },
        `Used a ${stoneName} on ${target.name}!`,
      );
    }

    case "USE_BOTTLE_CAP": {
      // Hyper Training. Gold Bottle Cap → all IVs to 31; Silver Bottle Cap →
      // one chosen stat's IV to 31. Recomputes the mon's stats and consumes
      // the cap. Works on a party OR box Pokémon.
      const { itemId, source, index, stat } = action.payload;
      const list = source === "party" ? state.party : state.box;
      if (index < 0 || index >= list.length) return state;
      const owned = state.inventory[itemId] ?? 0;
      const capName = itemsCatalog[itemId]?.name ?? itemId;
      if (owned <= 0) return pushLog(state, `You don't have a ${capName}.`);
      const mon = list[index];
      if (!mon) return state;
      const sp = pokemonTable[mon.speciesKey];
      if (!sp) return state;
      let newIvs = { ...mon.ivs };
      if (itemId === "goldbottlecap") {
        newIvs = { hp: 31, attack: 31, defense: 31, spAttack: 31, spDefense: 31, speed: 31 };
      } else {
        if (!stat || !(stat in newIvs)) return pushLog(state, "Pick a stat to hyper-train.");
        if ((newIvs as any)[stat] >= 31) return pushLog(state, `${mon.name}'s ${stat} is already perfect.`);
        newIvs = { ...newIvs, [stat]: 31 };
      }
      const stats = calcAllStats(sp, mon.level, newIvs, mon.evs, mon.nature);
      const hpGain = Math.max(0, stats.hp - mon.maxHp);
      const trained: Pokemon = {
        ...mon,
        ivs: newIvs,
        maxHp: stats.hp,
        currentHp: Math.min(stats.hp, mon.currentHp + hpGain),
        attack: stats.attack,
        defense: stats.defense,
        spAttack: stats.spAttack,
        spDefense: stats.spDefense,
        speed: stats.speed,
      };
      const inventory = { ...state.inventory };
      const remaining = owned - 1;
      if (remaining <= 0) delete inventory[itemId];
      else inventory[itemId] = remaining;
      const newList = [...list];
      newList[index] = trained;
      let next: GameState = source === "party"
        ? { ...state, party: newList, inventory }
        : { ...state, box: newList, inventory };
      if (source === "party" && state.activePlayerPokemonIndex === index) {
        next = { ...next, playerPokemon: trained };
      }
      return pushLog(
        next,
        itemId === "goldbottlecap"
          ? `${mon.name} was hyper-trained — perfect IVs (31 all)!`
          : `${mon.name}'s ${String(stat)} IV was maxed to 31!`,
      );
    }

    case "USE_EXP_SHARE": {
      // Activating from the Bag. Buying an Exp. Share credits the inventory,
      // but nothing consumed it — players sat on a stack with no way to turn
      // it on and no sign of whether it was running. Consumes one and adds
      // (or extends) the shared-EXP effect, reusing the same uncapped
      // stacking the purchase path uses.
      const owned = state.inventory.expShare ?? 0;
      if (owned <= 0) return pushLog(state, "You don't have an Exp. Share.");
      const addBattles = consumables.expShare?.duration ?? 300;
      const inventory = { ...state.inventory };
      const remaining = owned - 1;
      if (remaining <= 0) delete inventory.expShare;
      else inventory.expShare = remaining;
      const existing = state.activeEffects.find((e) => e.itemId === "expShare");
      const activeEffects = existing
        ? state.activeEffects.map((e) =>
            e === existing ? { ...e, battlesRemaining: e.battlesRemaining + addBattles } : e
          )
        : [
            ...state.activeEffects,
            { itemId: "expShare", battlesRemaining: addBattles, speciesKey: "", routeKey: "" },
          ];
      const total = existing ? existing.battlesRemaining + addBattles : addBattles;
      return pushLog(
        { ...state, inventory, activeEffects },
        `Exp. Share activated — sharing EXP for the next ${total} battles.`,
      );
    }

    case "USE_EV_BERRY": {
      // Lower one stat's EVs by 10. EV training had no undo, so a mon trained
      // into the wrong spread was permanently mis-built — players asked for a
      // way back. Mirrors USE_BOTTLE_CAP: validate, recompute, consume.
      type EvStat = "hp" | "attack" | "defense" | "spAttack" | "spDefense" | "speed";
      const EV_BERRY_STAT: Record<string, EvStat> = {
        pomegberry: "hp",
        kelpsyberry: "attack",
        qualotberry: "defense",
        hondewberry: "spAttack",
        grepaberry: "spDefense",
        tamatoberry: "speed",
      };
      const { itemId, source, index } = action.payload;
      const stat = EV_BERRY_STAT[itemId];
      if (!stat) return state;
      const list = source === "party" ? state.party : state.box;
      if (index < 0 || index >= list.length) return state;
      const owned = state.inventory[itemId] ?? 0;
      const berryName = itemsCatalog[itemId]?.name ?? itemId;
      if (owned <= 0) return pushLog(state, `You don't have a ${berryName}.`);
      const mon = list[index];
      if (!mon) return state;
      const sp = pokemonTable[mon.speciesKey];
      if (!sp) return state;
      const curEvs = mon.evs ?? { hp: 0, attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0 };
      if ((curEvs[stat] ?? 0) <= 0) {
        return pushLog(state, `${mon.name} has no ${String(stat)} EVs to lower.`);
      }
      const newEvs = { ...curEvs, [stat]: Math.max(0, (curEvs[stat] ?? 0) - 10) } as typeof curEvs;
      const stats = calcAllStats(sp, mon.level, mon.ivs, newEvs, mon.nature);
      const updated: Pokemon = {
        ...mon,
        evs: newEvs,
        maxHp: stats.hp,
        // Never leave the mon above its (possibly lower) new max.
        currentHp: Math.min(stats.hp, mon.currentHp),
        attack: stats.attack,
        defense: stats.defense,
        spAttack: stats.spAttack,
        spDefense: stats.spDefense,
        speed: stats.speed,
      };
      const inventory = { ...state.inventory };
      const remaining = owned - 1;
      if (remaining <= 0) delete inventory[itemId];
      else inventory[itemId] = remaining;
      const newList = [...list];
      newList[index] = updated;
      let next: GameState = source === "party"
        ? { ...state, party: newList, inventory }
        : { ...state, box: newList, inventory };
      if (source === "party" && state.activePlayerPokemonIndex === index) {
        next = { ...next, playerPokemon: updated };
      }
      return pushLog(next, `${mon.name}'s ${String(stat)} EVs fell to ${newEvs[stat]}.`);
    }

    case "REORDER_BOX": {
      const { from, to } = action.payload;
      if (from < 0 || to < 0 || from >= state.box.length || to >= state.box.length) return state;
      const box = [...state.box];
      const [m] = box.splice(from, 1);
      box.splice(to, 0, m);
      return { ...state, box };
    }

    case "SORT_BOX": {
      const box = [...state.box];
      const mode = action.payload.mode;
      box.sort((a, b) => {
        if (mode === "level") return b.level - a.level;
        if (mode === "name") return a.name.localeCompare(b.name);
        if (mode === "id")
          return (pokemonTable[a.speciesKey]?.id ?? 0) - (pokemonTable[b.speciesKey]?.id ?? 0);
        return 0;
      });
      return { ...state, box };
    }

    case "TRADE_COMPLETE": {
      // Atomic post-trade swap. The server has already confirmed both
      // sides locked; this just commits the agreed outcome locally:
      //   1. Remove the mon we sent (matched by id) from party or box
      //   2. Insert the mon we received in the same slot
      //   3. Re-derive activePlayerPokemonIndex / playerPokemon
      //   4. If the received species has a trade-only evolution, fire
      //      START_EVOLUTION immediately so the evolution cinematic plays
      //      right after the trade animation.
      const { sentMonId, received } = action.payload;
      // Find the source slot. Trade can swap a party mon OR a box mon.
      let where: "party" | "box" | null = null;
      let idx = state.party.findIndex((p) => p.id === sentMonId);
      if (idx >= 0) where = "party";
      else {
        idx = state.box.findIndex((p) => p.id === sentMonId);
        if (idx >= 0) where = "box";
      }
      if (!where || idx < 0) {
        // The sent mon isn't where we expect — drop the trade rather than
        // fabricating data. Shouldn't happen given server validation, but
        // protects against e.g. a stale tab.
        return pushLog(state, "Trade failed — sent Pokémon not found.");
      }
      // Re-bake the incoming mon into a known-good Pokemon shape. The
      // server round-trips the JSON unchanged, but we still assign it a
      // fresh local id (so the same id can't collide with our own
      // numbering) and pin its currentHp/maxHp at full.
      const incoming = received as unknown as Pokemon;
      const fresh: Pokemon = {
        ...incoming,
        id: `t${state.nextPokemonId}`,
        currentHp: incoming.maxHp,
      };
      const nextPokemonId = state.nextPokemonId + 1;
      let next: GameState;
      if (where === "party") {
        const party = [...state.party];
        party[idx] = fresh;
        const lead = firstHealthyIndex(party);
        next = {
          ...state,
          party,
          nextPokemonId,
          activePlayerPokemonIndex: lead,
          playerPokemon: party[lead] ?? state.playerPokemon,
        };
      } else {
        const box = [...state.box];
        box[idx] = fresh;
        next = { ...state, box, nextPokemonId };
      }
      next = pushLog(next, `Traded for ${fresh.nickname ?? fresh.name}!`);

      // Trade-evolution rider — if the received species has a `{ trade: true }`
      // entry, kick off the evolution sequence right away. Only fires for
      // a party-side trade (you can't evolve a boxed mon mid-flight).
      //
      // Two flavours:
      //   - { trade: true }            → pure trade (Kadabra→Alakazam, etc.)
      //   - { trade: true, item: "x" } → trade WITH held item (Onix+
      //     Metal Coat → Steelix). Item is canonically consumed on
      //     evolution, so we null heldItem in the party slot before
      //     handing off to START_EVOLUTION.
      if (where === "party") {
        const evos = evolutions[fresh.speciesKey] ?? [];
        const tradeEvo = evos.find(
          (e) =>
            "trade" in e &&
            (!("item" in e) || (e as any).item === fresh.heldItem)
        );
        if (tradeEvo) {
          // If the evolution requires a held item, consume it now so
          // the post-evolution Pokemon doesn't keep the catalyst.
          if ("item" in tradeEvo) {
            const party = [...next.party];
            party[idx] = { ...party[idx], heldItem: undefined };
            next = { ...next, party };
          }
          next = {
            ...next,
            phase: "evolution",
            evolutionState: {
              partyIndex: idx,
              toSpeciesKey: tradeEvo.into,
              step: 0,
            },
          };
        }
      }
      return next;
    }

    case "AUCTION_SETTLED": {
      // Server-pushed reconciliation for an auction that settled while
      // this client may or may not have been open — see
      // lib/auctionSettlement.ts server-side. `money` is always the
      // server's authoritative post-settlement value (set, not added),
      // since the server is the sole writer for this mutation.
      const { payload } = action;
      let next: GameState = { ...state, money: payload.money };
      if (payload.role === "seller") {
        const pIdx = next.party.findIndex((p) => p.id === payload.removedPokemonId);
        if (pIdx >= 0) {
          const party = next.party.filter((_, i) => i !== pIdx);
          const active = Math.min(next.activePlayerPokemonIndex, Math.max(0, party.length - 1));
          next = { ...next, party, activePlayerPokemonIndex: active, playerPokemon: party[active] ?? null };
        } else {
          const bIdx = next.box.findIndex((p) => p.id === payload.removedPokemonId);
          if (bIdx >= 0) next = { ...next, box: next.box.filter((_, i) => i !== bIdx) };
        }
      } else {
        const incoming = payload.pokemon;
        const fresh: Pokemon = { ...incoming, id: `a${next.nextPokemonId}`, currentHp: incoming.maxHp };
        const nextPokemonId = next.nextPokemonId + 1;
        next = next.party.length < 6
          ? { ...next, party: [...next.party, fresh], nextPokemonId }
          : { ...next, box: [...next.box, fresh], nextPokemonId };
      }
      return pushLog(next, payload.logMessage);
    }

    case "RECEIVE_GIFT": {
      // Prizes the server has ALREADY folded into cloud saveData, echoed back
      // so live state matches the bytes it stored. Money is ADDED (the server
      // likewise added it) and items are ADDED, with the same ceilings the
      // server clamps to — the echoed amounts are the delta that actually
      // landed, so applying them here reproduces the stored save exactly.
      //
      // A prize mon uses the id the SERVER assigned (`assignedId`), never a
      // fresh local one. The box reconcile keys on id, so minting our own here
      // would leave the same physical mon under two ids — cloud's and ours —
      // and any later merge would see two mons and duplicate a one-off prize.
      //
      // The legacy `gift:received` socket path carries no assignedId (the
      // older server wrote the save itself and never reported an id), so it
      // keeps minting `gift<n>`. That re-id is REQUIRED there: `mon.id` on
      // that path is the admin client's template id, identical for every
      // recipient, and would collide with a mon the player already owns.
      //
      // This action carries NO delivery bookkeeping, and must never grow any.
      // Whether a grant gets paid is decided by PendingGrant.deliveredAt in
      // the database; a copy of that decision living in the save blob is a
      // gate the client supplies, which is exactly the exploit that was
      // removed. Applying the prize here is only so the winner's own tab does
      // not have to wait for the adopt to show it.
      let next: GameState = state;
      let nextPokemonId = next.nextPokemonId;
      let box = next.box;
      let inventory = next.inventory;
      let money = next.money;
      const labels: string[] = [];
      for (const p of action.payload.prizes) {
        if (p.kind === "money") {
          money = Math.min(999_999_999, money + p.amount);
          labels.push(`$${p.amount.toLocaleString()}`);
        } else if (p.kind === "item") {
          inventory = { ...inventory, [p.itemId]: Math.min(999_999, (inventory[p.itemId] ?? 0) + p.quantity) };
          labels.push(`${p.quantity}× ${p.itemId}`);
        } else if (p.kind === "pokemon" && p.mon && typeof p.mon === "object") {
          const assigned = typeof p.assignedId === "string" && p.assignedId ? p.assignedId : null;
          const mon = { ...(p.mon as unknown as Pokemon), id: assigned ?? `gift${nextPokemonId}` };
          // Already holding this exact prize (a re-delivered echo, or a copy
          // that arrived through the cloud first): applying it again would
          // hand out a one-off prize twice.
          const dupe = assigned !== null
            && (box.some((m) => m.id === assigned) || next.party.some((m) => m.id === assigned));
          if (!dupe) box = [...box, mon];
          // Only the locally-minted branch consumes a number from the local
          // sequence. A server-assigned id is derived from the grant, not from
          // nextPokemonId, so bumping it here would drift us off the server's
          // copy for no gain.
          if (assigned === null) nextPokemonId += 1;
          labels.push(p.label ?? mon.name ?? "a Pokémon");
        }
      }
      next = { ...next, money, inventory, box, nextPokemonId };
      // Nothing to announce (an empty or fully-deduped prize list). Say
      // nothing rather than logging "You received a gift: !".
      if (labels.length === 0) return next;
      return pushLog(next, `🎁 You received a gift: ${labels.join(", ")}!`);
    }

    case "RELEASE_POKEMON": {
      const { source, index } = action.payload;
      if (source === "party") {
        if (state.party.length <= 1) return pushLog(state, "Cannot release your last Pokemon!");
        const cleared = bailFromBattle(state);
        const party = cleared.party.filter((_, i) => i !== index);
        const active = Math.min(cleared.activePlayerPokemonIndex, party.length - 1);
        return { ...cleared, party, activePlayerPokemonIndex: active, playerPokemon: party[active] ?? null };
      }
      const box = state.box.filter((_, i) => i !== index);
      return { ...state, box };
    }

    case "SET_ALWAYS_CATCH_SHINIES":
      return { ...state, alwaysCatchShinies: action.payload.value };

    case "TOGGLE_EFFECT_PAUSED": {
      const { itemId, speciesKey, routeKey } = action.payload;
      // speciesKey/routeKey are optional so the id-only callers (Exp. Share,
      // which targets nothing) keep working unchanged. When they ARE given,
      // only that one effect toggles — otherwise pausing the Repel on one
      // species would pause every repel on every route at once.
      return {
        ...state,
        activeEffects: state.activeEffects.map((e) =>
          e.itemId === itemId &&
          (speciesKey === undefined || e.speciesKey === speciesKey) &&
          (routeKey === undefined || (e.routeKey ?? "") === routeKey)
            ? { ...e, paused: !e.paused }
            : e
        ),
      };
    }

    case "SET_NICKNAME": {
      const { pokemonId, nickname } = action.payload;
      // Sanitize: strip control chars and angle brackets (defence-in-depth —
      // React already escapes text nodes, but keeping bad input out of state
      // also keeps the save file clean), collapse whitespace, length-limit.
      const cleaned = nickname
        .replace(/[\x00-\x1f\x7f]/g, "")
        .replace(/[<>]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 12);
      const next = cleaned.length > 0 ? cleaned : undefined;
      const apply = (p: Pokemon): Pokemon =>
        p.id === pokemonId ? { ...p, nickname: next } : p;
      return syncPlayerToParty({
        ...state,
        playerPokemon: state.playerPokemon ? apply(state.playerPokemon) : state.playerPokemon,
        party: state.party.map(apply),
        box: state.box.map(apply),
      });
    }

    case "TOGGLE_AUTO_PROCEED":
      return { ...state, autoProceed: !state.autoProceed };

    case "SET_AUTO_EVOLVE":
      return { ...state, autoEvolve: action.payload.value };

    case "SET_EVOLVE_LOCK": {
      const { pokemonId, locked } = action.payload;
      // Store `true` or nothing at all — never `false`. An absent field is
      // already the unlocked state (that is how every pre-existing save reads),
      // so clearing the lock should restore the exact original shape rather
      // than leave a `noEvolve: false` behind for the next reader to wonder at.
      const apply = (p: Pokemon): Pokemon => {
        if (p.id !== pokemonId) return p;
        if (locked) return { ...p, noEvolve: true };
        if (p.noEvolve === undefined) return p;
        const { noEvolve: _dropped, ...rest } = p;
        return rest;
      };
      // Same three-surface update as SET_NICKNAME: the mon may be the active
      // one, in the party, or in the box, and all three copies must agree.
      return syncPlayerToParty({
        ...state,
        playerPokemon: state.playerPokemon ? apply(state.playerPokemon) : state.playerPokemon,
        party: state.party.map(apply),
        box: state.box.map(apply),
      });
    }

    case "RESET_ELITE_FOUR":
      return { ...state, defeatedEliteFour: [] };

    case "BUY_REWARD_ITEM": {
      const { itemId, cost } = action.payload;
      if (state.victoryTokens < cost) return pushLog(state, "Not enough Victory Tokens.");
      // Same special case as BUY_ITEM below: Exp. Share is a buff, not a
      // stockpile-able held item, so it can't just go into `inventory`
      // like every other reward-shop item — applyExp() only ever checks
      // `activeEffects`, never inventory counts. Without this branch the
      // purchase silently did nothing: tokens spent, buff never turns on.
      if (itemId === "expShare") {
        const def = consumables.expShare;
        const addBattles = def?.duration ?? 300;
        const existing = state.activeEffects.find((e) => e.itemId === "expShare");
        const activeEffects = existing
          ? state.activeEffects.map((e) =>
              e === existing
                ? { ...e, battlesRemaining: e.battlesRemaining + addBattles }
                : e
            )
          : [
              ...state.activeEffects,
              { itemId, battlesRemaining: addBattles, speciesKey: "", routeKey: "" },
            ];
        return pushLog(
          { ...state, victoryTokens: state.victoryTokens - cost, activeEffects },
          `Activated Exp. Share (+${addBattles} battles).`
        );
      }
      return {
        ...state,
        victoryTokens: state.victoryTokens - cost,
        inventory: {
          ...state.inventory,
          [itemId]: (state.inventory[itemId] ?? 0) + 1,
        },
      };
    }

    case "USE_EFFECT_ITEM": {
      const { itemId, speciesKey, routeKey } = action.payload;
      const inv = { ...state.inventory };
      if ((inv[itemId] ?? 0) <= 0) return state;
      const def = consumables[itemId];
      if (!def) return state;
      // Repel/Super Repel/Max Repel share ONE slot per species+route. They
      // are the same halving at different lengths, so a second tier has to
      // extend the timer rather than sit beside the first as a second
      // effect (which would silently compound to a quarter weight and make
      // the cheap Repel a strength multiplier for the expensive one).
      const isRepel = REPEL_IDS.has(itemId);
      const existing = state.activeEffects.find(
        (e) =>
          e.speciesKey === speciesKey &&
          e.routeKey === routeKey &&
          (isRepel ? REPEL_IDS.has(e.itemId) : e.itemId === itemId)
      );
      let activeEffects: ActiveEffect[];
      if (existing) {
        // The slot keeps whichever tier lasts longest, so the badge names
        // the best repel the player has put into it and the 3x stacking cap
        // is measured against that tier (Repel 1,500 → Max Repel 6,000).
        const prevDef = consumables[existing.itemId];
        const bestDef = prevDef && prevDef.duration > def.duration ? prevDef : def;
        const cap = bestDef.duration * 3;
        // Refuse rather than eat the item. Previously a use at the cap
        // consumed the consumable and added nothing, which reads to the
        // player as "the button doesn't work".
        if (existing.battlesRemaining >= cap) {
          return pushLog(
            state,
            `${def.name} not used — ${pokemonTable[speciesKey]?.name ?? speciesKey} is already at the ${cap.toLocaleString()}-battle cap.`
          );
        }
        activeEffects = state.activeEffects.map((e) =>
          e === existing
            ? {
                ...e,
                itemId: bestDef.id,
                battlesRemaining: Math.min(e.battlesRemaining + def.duration, cap),
              }
            : e
        );
      } else {
        activeEffects = [
          ...state.activeEffects,
          { itemId, speciesKey, routeKey, battlesRemaining: def.duration },
        ];
      }
      inv[itemId] = inv[itemId] - 1;
      return pushLog(
        { ...state, inventory: inv, activeEffects },
        `Used ${def.name} on ${pokemonTable[speciesKey]?.name ?? speciesKey}.`
      );
    }

    case "GIVE_HELD_ITEM": {
      const { pokemonId, itemId } = action.payload;
      const inv = { ...state.inventory };
      if ((inv[itemId] ?? 0) <= 0) return state;
      // Only genuinely equippable items. Equipping MOVES the item out of the
      // inventory, so without this any id at all — a Poké Ball, a TM, or the
      // Shiny Charm — could be parked on a Pokémon. That matters most for the
      // charm: it is the Pokédex-completion reward and `hasShinyCharm` reads
      // inventory ownership, so letting it be equipped would quietly halve the
      // shiny rate of the player who just finished the dex. The picker in
      // PokemonDetailModal already offers held-category items only; this makes
      // the reducer agree instead of trusting its caller.
      if (itemsCatalog[itemId]?.category !== "held") return state;
      // Find the target Pokemon in party or box.
      const idxParty = state.party.findIndex((p) => p.id === pokemonId);
      const idxBox = idxParty < 0 ? state.box.findIndex((p) => p.id === pokemonId) : -1;
      if (idxParty < 0 && idxBox < 0) return state;
      // If they already hold something, return that to inventory first.
      const target = idxParty >= 0 ? state.party[idxParty] : state.box[idxBox];
      if (target.heldItem) {
        inv[target.heldItem] = (inv[target.heldItem] ?? 0) + 1;
      }
      inv[itemId] = inv[itemId] - 1;
      if (inv[itemId] <= 0) delete inv[itemId];
      const updated = { ...target, heldItem: itemId };
      const party = idxParty >= 0
        ? state.party.map((p, i) => (i === idxParty ? updated : p))
        : state.party;
      const box = idxBox >= 0
        ? state.box.map((p, i) => (i === idxBox ? updated : p))
        : state.box;
      const playerPokemon = state.playerPokemon?.id === pokemonId
        ? { ...state.playerPokemon, heldItem: itemId }
        : state.playerPokemon;
      return { ...state, inventory: inv, party, box, playerPokemon };
    }

    case "TAKE_HELD_ITEM": {
      const { pokemonId } = action.payload;
      const idxParty = state.party.findIndex((p) => p.id === pokemonId);
      const idxBox = idxParty < 0 ? state.box.findIndex((p) => p.id === pokemonId) : -1;
      if (idxParty < 0 && idxBox < 0) return state;
      const target = idxParty >= 0 ? state.party[idxParty] : state.box[idxBox];
      if (!target.heldItem) return state;
      const inv = { ...state.inventory };
      inv[target.heldItem] = (inv[target.heldItem] ?? 0) + 1;
      const updated: Pokemon = { ...target, heldItem: undefined };
      const party = idxParty >= 0
        ? state.party.map((p, i) => (i === idxParty ? updated : p))
        : state.party;
      const box = idxBox >= 0
        ? state.box.map((p, i) => (i === idxBox ? updated : p))
        : state.box;
      const playerPokemon = state.playerPokemon?.id === pokemonId
        ? { ...state.playerPokemon, heldItem: undefined }
        : state.playerPokemon;
      return { ...state, inventory: inv, party, box, playerPokemon };
    }

    case "UPDATE_VOLATILE":
      return {
        ...state,
        playerVolatile: state.playerVolatile
          ? { ...state.playerVolatile, ...action.payload }
          : null,
      };

    case "APPLY_SHARED_EXP":
      // Already applied inline within APPLY_EXP; no-op here for compatibility.
      return state;

    case "SWITCH_PLAYER_POKEMON": {
      const idx = action.payload.partyIndex;
      if (idx < 0 || idx >= state.party.length) return state;
      const target = state.party[idx];
      if (target.currentHp <= 0) return pushLog(state, `${target.name} has fainted!`);
      return {
        ...state,
        activePlayerPokemonIndex: idx,
        playerPokemon: target,
        awaitingSwitch: false,
        playerVolatile: {
          statStages: { attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0 },
          mustRecharge: false,
          lockedMove: null,
          lockTurnsRemaining: 0,
        },
      };
    }

    case "START_TRAINER_BATTLE": {
      const { trainerId, trainerName, trainerClass, trainerTeam, spriteKey } = action.payload;
      const first = trainerTeam[0];
      if (!first) return state;
      // Active = first healthy party member (consumes any pre-battle reorder).
      const idx = firstHealthyIndex(state.party);
      return pushLog(
        {
          ...state,
          phase: "trainerBattle",
          enemyPokemon: first,
          pendingEvents: [],
          battleWeather: null,
          activePlayerPokemonIndex: idx,
          playerPokemon: state.party[idx] ?? state.playerPokemon,
          trainerBattle: {
            trainerId,
            trainerName,
            trainerClass,
            trainerTeam,
            currentTrainerPokemonIndex: 0,
            spriteKey,
          },
          playerVolatile: {
            statStages: { attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0 },
            mustRecharge: false,
            lockedMove: null,
            lockTurnsRemaining: 0,
          },
        },
        `${trainerName} wants to battle!`,
        `${trainerName} sent out ${first.name}!`
      );
    }

    case "START_BOSS_BATTLE": {
      const { bossId, bossType, trainerName, trainerClass, trainerTeam, spriteKey, bossQueue } = action.payload;
      const first = trainerTeam[0];
      if (!first) return state;
      // First clear out any active wild/trainer fight so the boss starts
      // from a clean state — players can punch the Challenge button mid-
      // battle and we just abort the current encounter.
      const cleared = bailFromBattle(state);
      // Park the boss in pendingBossBattle and play the heal animation
      // first. COMPLETE_HEALING (fired by HealOverlay's `ended` event)
      // drains pendingBossBattle into bossBattle and transitions to
      // "bossBattle" phase, so the player sees the heal cinematic before
      // the trainer actually challenges them. Mid-gauntlet send-next
      // moves use BOSS_BATTLE_END's queue advance, not this action — so
      // the "no heal between E4 fights" rule still holds.
      return {
        ...cleared,
        phase: "healing",
        healingState: { step: 0 },
        pendingBossBattle: {
          battle: {
            bossId,
            bossType,
            trainerName,
            trainerClass,
            trainerTeam,
            currentTrainerPokemonIndex: 0,
            spriteKey,
          },
          queue: bossQueue ?? [],
        },
      };
    }

    case "TRAINER_SEND_NEXT_POKEMON": {
      // The reducer's EXECUTE_TURN already auto-sends; this exists for parity
      // with the original action shape. Honoured for explicit dispatches.
      const idx = action.payload.newPokemonIndex;
      if (state.bossBattle) {
        const incoming = state.bossBattle.trainerTeam[idx];
        if (!incoming) return state;
        return {
          ...state,
          enemyPokemon: incoming,
          bossBattle: { ...state.bossBattle, currentTrainerPokemonIndex: idx },
        };
      }
      if (state.trainerBattle) {
        const incoming = state.trainerBattle.trainerTeam[idx];
        if (!incoming) return state;
        return {
          ...state,
          enemyPokemon: incoming,
          trainerBattle: { ...state.trainerBattle, currentTrainerPokemonIndex: idx },
        };
      }
      return state;
    }

    case "TRAINER_BATTLE_END":
      return endTrainerBattle(state, action.payload.won, action.payload.moneyDelta);

    case "BOSS_BATTLE_END":
      return endBossBattle(state, action.payload.won, action.payload.moneyDelta);

    case "START_HEALING":
      // Heal can be triggered any time — including mid-battle. If you do,
      // we abort the current encounter (the heal animation plays, party is
      // restored, and you're dropped back to idle).
      return {
        ...state,
        phase: "healing",
        healingState: { step: 0 },
        enemyPokemon: null,
        trainerBattle: null,
        bossBattle: null,
        pendingEvents: [],
        currentEventIndex: 0,
        awaitingSwitch: false,
        playerVolatile: null,
        battleWeather: null,
      };
    case "HEALING_STEP":
      return state.healingState
        ? { ...state, healingState: { step: state.healingState.step + 1 } }
        : state;
    case "COMPLETE_HEALING": {
      const party = state.party.map((p) => ({
        ...p,
        currentHp: p.maxHp,
        moves: p.moves.map((m) => ({ ...m, pp: m.maxPp })),
      }));
      // Pre-boss heal: if a boss was parked in pendingBossBattle when
      // healing started, drop straight into the boss fight (don't pass
      // through "idle"). The fully-healed party + healthy lead are baked
      // in here so the boss always sees a fresh team.
      const pending = state.pendingBossBattle;
      if (pending) {
        const idx = firstHealthyIndex(party);
        const playerPokemon = party[idx] ?? state.playerPokemon;
        const first = pending.battle.trainerTeam[0];
        if (!first) {
          return pushLog(
            {
              ...state,
              party,
              playerPokemon,
              activePlayerPokemonIndex: idx,
              phase: "idle",
              healingState: null,
              pendingBossBattle: null,
            },
            "Your party was fully healed!"
          );
        }
        return pushLog(
          {
            ...state,
            party,
            playerPokemon,
            activePlayerPokemonIndex: idx,
            phase: "bossBattle",
            healingState: null,
            pendingBossBattle: null,
            enemyPokemon: first,
            pendingEvents: [],
            bossBattle: pending.battle,
            bossQueue: pending.queue,
            playerVolatile: {
              statStages: { attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0 },
              mustRecharge: false,
              lockedMove: null,
              lockTurnsRemaining: 0,
            },
          },
          "Your party was fully healed!",
          `${pending.battle.trainerName} wants to battle!`,
          `${pending.battle.trainerName} sent out ${first.name}!`
        );
      }
      return pushLog(
        {
          ...state,
          party,
          playerPokemon: party[state.activePlayerPokemonIndex] ?? state.playerPokemon,
          phase: "idle",
          healingState: null,
        },
        "Your party was fully healed!"
      );
    }

    case "START_RAID": {
      // Payload is fully optional. Tier-based picker is the new path:
      // if `tier` is set, the level (if not also passed) defaults to
      // that tier's starting level, and the species is picked from the
      // tier's pool. The legacy callers passing `speciesKey`/`level`
      // continue to work unchanged. Shiny encounters obey the same
      // 1/8192 (or 1/4096 with Shiny Charm) rate as wild encounters.
      const tierId = action.payload?.tier;
      const tier = tierId ? raidTiers[tierId] ?? raidTiers[DEFAULT_RAID_TIER] : null;
      const level = action.payload?.level ?? tier?.startLevel ?? RAID_START_LEVEL;
      const speciesKey =
        action.payload?.speciesKey ??
        (tier ? pickRandomLegendaryForTier(tier.id, level) : pickRandomLegendary(level));
      const isShiny = rollShiny(hasShinyCharm(state));
      const enemy = createPokemon(speciesKey, level, state.nextPokemonId, isShiny);
      // Heal party on raid entry (matches the original)
      const party = state.party.map((p) => ({
        ...p, currentHp: p.maxHp,
        moves: p.moves.map((m) => ({ ...m, pp: m.maxPp })),
      }));
      const playerPokemon = party[state.activePlayerPokemonIndex] ?? state.playerPokemon;
      return {
        ...state,
        party,
        playerPokemon,
        inRaid: true,
        raidLegendary: { speciesKey, level, tier: tier?.id },
        raidLevel: level,
        preRaidLocation: state.currentLocation,
        currentLocation: "raidIsland",
        currentRoute: "raidIsland",
        phase: "battle",
        enemyPokemon: enemy,
        pendingEvents: [],
        nextPokemonId: state.nextPokemonId + 1,
        playerVolatile: {
          statStages: { attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0 },
          mustRecharge: false,
          lockedMove: null,
          lockTurnsRemaining: 0,
        },
        battleLog: [...state.battleLog, `A wild ${pokemonTable[speciesKey]?.name ?? speciesKey} appeared!`],
      };
    }

    case "END_RAID": {
      const cooldownEnd = Date.now() + RAID_COOLDOWN_MS;
      const tierId = state.raidLegendary?.tier ?? DEFAULT_RAID_TIER;
      return {
        ...state,
        inRaid: false,
        raidLegendary: null,
        raidLevel: 0,
        currentLocation: state.preRaidLocation ?? "palletTown",
        currentRoute: state.preRaidLocation ?? "route1",
        preRaidLocation: null,
        raidCooldownEnd: cooldownEnd,
        raidCooldowns: { ...state.raidCooldowns, [tierId]: cooldownEnd },
        phase: "idle",
        enemyPokemon: null,
      };
    }

    case "CONSUME_EVENT": {
      // Pop the next pending event, apply its side-effect to game state, and
      // emit its message into the battleLog. When the queue drains, resolve
      // the turn outcome (battle end / next mon / faint switch).
      if (state.pendingEvents.length === 0) return state;
      const [event, ...rest] = state.pendingEvents;
      let next: GameState = { ...state, pendingEvents: rest };
      const target = (event.payload as any)?.target;

      switch (event.type) {
        case "damage":
        case "recoil":
        // statusTick: burn/poison/toxic/hail/sandstorm end-of-turn damage.
        // itemTrigger: Leftovers heal (carries hpAfter); Focus Sash trigger
        //   (no hpAfter — falls through to a no-op safely).
        // Each carries `hpAfter` in payload; apply it to the targeted side.
        case "statusTick":
        case "itemTrigger": {
          const hpAfter = (event.payload as any)?.hpAfter;
          if (typeof hpAfter !== "number") break;
          if (target === "player" && next.playerPokemon) {
            next = {
              ...next,
              playerPokemon: { ...next.playerPokemon, currentHp: hpAfter },
            };
            next = syncPlayerToParty(next);
          } else if (target === "enemy" && next.enemyPokemon) {
            next = {
              ...next,
              enemyPokemon: { ...next.enemyPokemon, currentHp: hpAfter },
            };
          }
          break;
        }
        case "faint": {
          // HP already reached 0 via the prior damage event. The faint event
          // is a chance for the UI to play the fade-out animation.
          break;
        }
        // attack / miss / critical / effectiveness / recharge / statChange:
        // log only — the typewriter shows the message.
        default:
          break;
      }

      if (event.message) next = pushLog(next, event.message);

      // After consuming the last event, the turn is over — resolve outcome.
      if (next.pendingEvents.length === 0) {
        next = resolveTurnEnd(next, state);
      }
      return next;
    }

    case "LOAD_SAVE": {
      // saveGen is the ONLY in-state signal that the entire save was
      // replaced rather than mutated. Pokemon ids are `String(nextPokemonId)`
      // from a per-save counter that RESTARTS at 1, so after an admin reset
      // or a cloud-lineage adopt a brand-new Pokemon can inherit an id a
      // listener still holds an opinion about. Deliberately NOT persisted —
      // it describes this tab's session, not the save.
      const merged = {
        ...state,
        ...(action.payload.state as object),
        saveGen: (state.saveGen ?? 0) + 1,
      } as GameState;
      // Only promote out of "idle" — LOAD_SAVE fires mid-session for cloud
      // reconciliation too, and we don't want to steal a phase (battle,
      // evolution, etc.) that's genuinely in flight when it does.
      if (merged.phase === "idle" && pendingRegionStarter(merged.claimedRegionStarters, merged.currentLocation)) {
        return { ...merged, phase: "regionStarterSelect" };
      }
      return merged;
    }

    default:
      return state;
  }
}

// Called after every event in the turn has been consumed. Looks at current
// HP to decide what happens next: enemy fainted → wild win / next trainer mon,
// player fainted → switch / white-out, otherwise stay in battle for the next
// EXECUTE_TURN tick. Mirrors what the old atomic EXECUTE_TURN did at the end.
function resolveTurnEnd(state: GameState, _preTurn: GameState): GameState {
  const player = state.playerPokemon;
  const enemy = state.enemyPokemon;
  if (!player || !enemy) return state;
  const isTrainer = !!state.trainerBattle;
  const isBoss = !!state.bossBattle;

  if (enemy.currentHp <= 0 && player.currentHp > 0) {
    const exp = expYield(pokemonTable[enemy.speciesKey], enemy.level);
    const yld = evYieldFor(enemy.speciesKey);
    const { state: afterExp, logs } = applyExp(state, exp, yld);
    let next: GameState = pushLog(afterExp, ...logs, `${player.name} gained ${exp} EXP!`);

    // Deferred party-reorder swap: if the player rearranged their party
    // during this fight, the new slot-0 (or first healthy) takes over now
    // that the enemy mon is down. In a wild fight there's no "next mon"
    // to swap into, but in trainer/boss fights this acts like the
    // mainline-game prompt that lets you change leads between mons. Skip
    // when slot-0 is fainted — fall back to first-healthy.
    if (isTrainer || isBoss) {
      const leadIdx = firstHealthyIndex(next.party);
      const lead = next.party[leadIdx];
      if (
        lead &&
        lead.currentHp > 0 &&
        next.playerPokemon &&
        lead.id !== next.playerPokemon.id
      ) {
        next = pushLog(
          {
            ...next,
            activePlayerPokemonIndex: leadIdx,
            playerPokemon: lead,
            playerVolatile: {
              statStages: { attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0 },
              mustRecharge: false,
              lockedMove: null,
              lockTurnsRemaining: 0,
            },
          },
          `Go, ${lead.name}!`
        );
      }
    }

    if (isBoss && next.bossBattle) {
      const b = next.bossBattle;
      const nextIdx = b.currentTrainerPokemonIndex + 1;
      if (nextIdx < b.trainerTeam.length) {
        const incoming = b.trainerTeam[nextIdx];
        return pushLog(
          {
            ...next,
            enemyPokemon: incoming,
            bossBattle: { ...b, currentTrainerPokemonIndex: nextIdx },
          },
          `${b.trainerName} sent out ${incoming.name}!`
        );
      }
      return endBossBattle(next, true, trainerPrize(b.trainerClass, b.trainerTeam));
    }
    if (isTrainer && next.trainerBattle) {
      const t = next.trainerBattle;
      const nextIdx = t.currentTrainerPokemonIndex + 1;
      if (nextIdx < t.trainerTeam.length) {
        const incoming = t.trainerTeam[nextIdx];
        return pushLog(
          {
            ...next,
            enemyPokemon: incoming,
            trainerBattle: { ...t, currentTrainerPokemonIndex: nextIdx },
          },
          `${t.trainerName} sent out ${incoming.name}!`
        );
      }
      return endTrainerBattle(next, true, trainerPrize(t.trainerClass, t.trainerTeam));
    }

    // Raid: when the legendary faints, spawn a stronger version (+5 levels)
    // immediately. raidLevel grows so the player can rack up wins until they
    // wipe. Money / battle counts still tick. Shared with the catch paths —
    // see spawnNextRaidWave.
    const nextWave = spawnNextRaidWave(next, enemy.level);
    if (nextWave) return nextWave;

    // Wild battles award no money — only trainer / gym / E4 / champion
    // fights pay out. Wild fights still grant XP, items (catches), and
    // location-progress counters; cash flow comes from intentional
    // human-vs-human battles only.
    next = {
      ...next,
      phase: "idle",
      enemyPokemon: null,
      wildBattlesWon: next.wildBattlesWon + 1,
      battlesWonByLocation: {
        ...next.battlesWonByLocation,
        [next.currentLocation]: (next.battlesWonByLocation[next.currentLocation] ?? 0) + 1,
      },
      activeEffects: decrementEffects(next.activeEffects),
    };
    return appendUnlocks(next);
  }

  if (player.currentHp <= 0) {
    let next: GameState = pushLog(state, `${player.name} fainted!`);
    const aliveIdx = next.party.findIndex(
      (p, i) => i !== next.activePlayerPokemonIndex && p.currentHp > 0
    );
    if (aliveIdx === -1) {
      // Pass 0 — the single capped money penalty is applied by handleFaint
      // (called inside these on a loss). Passing a penalty here too would
      // double-charge the player.
      if (isBoss) return endBossBattle(next, false, 0);
      if (isTrainer) return endTrainerBattle(next, false, 0);
      // Raid wipe: bail out, no white-out penalty. Player returns to the
      // pre-raid location, party stays fainted (heal at a Center first).
      if (next.inRaid) {
        const cooldownEnd = Date.now() + RAID_COOLDOWN_MS;
        const tierId = next.raidLegendary?.tier ?? DEFAULT_RAID_TIER;
        return pushLog(
          {
            ...next,
            phase: "idle",
            enemyPokemon: null,
            inRaid: false,
            raidLegendary: null,
            raidLevel: 0,
            currentLocation: next.preRaidLocation ?? "palletTown",
            currentRoute: next.preRaidLocation ?? "route1",
            preRaidLocation: null,
            raidCooldownEnd: cooldownEnd,
            raidCooldowns: { ...next.raidCooldowns, [tierId]: cooldownEnd },
          },
          "The raid ended. You stagger back to the mainland."
        );
      }
      return handleFaint(next);
    }
    const incoming = next.party[aliveIdx];
    return pushLog(
      {
        ...next,
        activePlayerPokemonIndex: aliveIdx,
        playerPokemon: incoming,
        awaitingSwitch: false,
        playerVolatile: {
          statStages: { attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0 },
          mustRecharge: false,
          lockedMove: null,
          lockTurnsRemaining: 0,
        },
      },
      `Go, ${incoming.name}!`
    );
  }

  return state;
}

// Trainer prize money — base * highest team level. Tuned to feel rewarding.
function trainerPrize(trainerClass: string, team: Pokemon[]): number {
  const PRIZES: Record<string, number> = {
    youngster: 16,
    lass: 16,
    bugCatcher: 12,
    hiker: 36,
    swimmer: 20,
    camper: 24,
    sailor: 36,
    gentleman: 100,
    channeler: 36,
    beauty: 56,
    coolTrainer: 36,
    psychic: 28,
    scientist: 36,
    tamer: 28,
    juggler: 28,
    superNerd: 36,
    ace: 36,
    blackbelt: 24,
  };
  const base = PRIZES[trainerClass] ?? 32;
  const top = team.reduce((m, p) => Math.max(m, p.level), 0);
  return base * top;
}

function wildMoneyReward(level: number): number {
  return 10 + level * 4;
}

// Whiteout cash penalty. Capped in ABSOLUTE terms so an auto-battle loss can
// never wipe a fortune. The idle loop fights continuously without the player's
// input, so the old "lose 25% of your entire balance" rule scaled the sting
// with wealth — a couple of unattended losses could crater a rich player's
// bank, which is exactly what "my money goes down even when I'm winning"
// reports were: small per-win prizes couldn't offset percentage-of-net-worth
// losses. 5% capped at $5,000 keeps a minor sting without punishing progress.
function defeatPenalty(money: number): number {
  return Math.min(Math.floor(money * 0.05), 5000);
}

function endTrainerBattle(state: GameState, won: boolean, moneyDelta: number): GameState {
  const money = Math.max(0, state.money + moneyDelta);
  const trainerBattlesWon = won ? state.trainerBattlesWon + 1 : state.trainerBattlesWon;
  const battlesWonByLocation = won
    ? {
        ...state.battlesWonByLocation,
        [state.currentLocation]: (state.battlesWonByLocation[state.currentLocation] ?? 0) + 1,
      }
    : state.battlesWonByLocation;
  const activeEffects = won ? decrementEffects(state.activeEffects) : state.activeEffects;
  const trainerId = state.trainerBattle?.trainerId;
  const defeatedTrainers =
    won && trainerId && !state.defeatedTrainers.includes(trainerId)
      ? [...state.defeatedTrainers, trainerId]
      : state.defeatedTrainers;
  const log = won ? `Got $${moneyDelta} for winning!` : `You were defeated...`;
  let next: GameState = pushLog(
    {
      ...state,
      phase: "idle",
      enemyPokemon: null,
      trainerBattle: null,
      money,
      trainerBattlesWon,
      battlesWonByLocation,
      activeEffects,
      defeatedTrainers,
    },
    log
  );
  if (!won) next = handleFaint(next);
  return appendUnlocks(next);
}

function endBossBattle(state: GameState, won: boolean, moneyDelta: number): GameState {
  const money = Math.max(0, state.money + moneyDelta);
  const trainerBattlesWon = won ? state.trainerBattlesWon + 1 : state.trainerBattlesWon;
  const battlesWonByLocation = won
    ? {
        ...state.battlesWonByLocation,
        [state.currentLocation]: (state.battlesWonByLocation[state.currentLocation] ?? 0) + 1,
      }
    : state.battlesWonByLocation;
  const activeEffects = won ? decrementEffects(state.activeEffects) : state.activeEffects;
  const log = won ? `Got $${moneyDelta} for winning!` : `You were defeated...`;
  let defeatedGyms = state.defeatedGyms;
  let defeatedEliteFour = state.defeatedEliteFour;
  let championDefeated = state.championDefeated;
  let defeatedChampions = state.defeatedChampions;
  let victoryTokens = state.victoryTokens;
  const extras: string[] = [];
  if (won && state.bossBattle) {
    const { bossType, bossId } = state.bossBattle;
    if (bossType === "gym" && !defeatedGyms.includes(bossId)) {
      defeatedGyms = [...defeatedGyms, bossId];
      victoryTokens += 1;
      extras.push("Earned a Victory Token!");
    } else if (bossType === "e4" && !defeatedEliteFour.includes(bossId)) {
      defeatedEliteFour = [...defeatedEliteFour, bossId];
    } else if (bossType === "champion") {
      championDefeated = true;
      if (!defeatedChampions.includes(bossId)) defeatedChampions = [...defeatedChampions, bossId];
      victoryTokens += 1;
      extras.push("Earned a Victory Token!");
    }
  }
  // If a boss queue is in play, immediately start the next boss
  if (won && state.bossQueue.length > 0) {
    const [nextBoss, ...rest] = state.bossQueue;
    const first = nextBoss.trainerTeam[0];
    let advanced: GameState = pushLog(
      {
        ...state,
        money,
        trainerBattlesWon,
        battlesWonByLocation,
        activeEffects,
        defeatedGyms,
        defeatedEliteFour,
        championDefeated,
        defeatedChampions,
        victoryTokens,
        phase: "bossBattle",
        enemyPokemon: first,
        bossBattle: {
          ...nextBoss,
          currentTrainerPokemonIndex: 0,
        },
        bossQueue: rest,
      },
      log,
      ...extras,
      `${nextBoss.trainerName} wants to battle!`,
      `${nextBoss.trainerName} sent out ${first.name}!`
    );
    return appendUnlocks(advanced);
  }
  let next: GameState = pushLog(
    {
      ...state,
      phase: "idle",
      enemyPokemon: null,
      bossBattle: null,
      money,
      trainerBattlesWon,
      battlesWonByLocation,
      activeEffects,
      defeatedGyms,
      defeatedEliteFour,
      championDefeated,
      defeatedChampions,
      victoryTokens,
    },
    log,
    ...extras
  );
  if (!won) next = handleFaint(next);
  return appendUnlocks(next);
}

// On faint: switch to next live party member. If none alive, full-heal and
// either bail back to the pre-raid location (raid wipe) or scurry to Pallet
// Town (regular white-out). Either way the raid cooldown timer is set.
function handleFaint(state: GameState): GameState {
  const next = state.party.findIndex((p) => p.currentHp > 0 && p.id !== state.playerPokemon?.id);
  if (next >= 0) {
    return {
      ...state,
      activePlayerPokemonIndex: next,
      playerPokemon: state.party[next],
      phase: "idle",
      enemyPokemon: null,
    };
  }
  // White out — full party heal.
  const party = state.party.map((p) => ({
    ...p,
    currentHp: p.maxHp,
    moves: p.moves.map((m) => ({ ...m, pp: m.maxPp })),
  }));
  // White-out money penalty — capped so an unattended auto-battle loss can't
  // wipe a fortune (see defeatPenalty). This is the SINGLE place a loss costs
  // money; the trainer/boss end handlers no longer deduct separately.
  const moneyLost = defeatPenalty(state.money);
  const moneyAfter = state.money - moneyLost;

  // Raid wipe: bail back to the location the player was at when they
  // started the raid (preRaidLocation), set the raid cooldown, clear raid
  // state. Non-raid white-out: send to Pallet Town as before.
  if (state.inRaid) {
    const back = state.preRaidLocation || "palletTown";
    const cooldownEnd = Date.now() + RAID_COOLDOWN_MS;
    const tierId = state.raidLegendary?.tier ?? DEFAULT_RAID_TIER;
    return pushLog(
      {
        ...state,
        party,
        playerPokemon: party[0] ?? null,
        activePlayerPokemonIndex: 0,
        phase: "idle",
        enemyPokemon: null,
        inRaid: false,
        raidLegendary: null,
        raidLevel: 0,
        preRaidLocation: null,
        raidCooldownEnd: cooldownEnd,
        raidCooldowns: { ...state.raidCooldowns, [tierId]: cooldownEnd },
        currentLocation: back,
        currentRoute: back,
        money: moneyAfter,
        whiteoutAnim: { key: Date.now() },
      },
      "Your team was wiped out! You retreat from the raid.",
      `You dropped $${moneyLost.toLocaleString()} in panic.`,
      `Returning to ${routes[back]?.name ?? back}.`
    );
  }
  return pushLog(
    {
      ...state,
      party,
      playerPokemon: party[0] ?? null,
      activePlayerPokemonIndex: 0,
      phase: "idle",
      enemyPokemon: null,
      money: moneyAfter,
      whiteoutAnim: { key: Date.now() },
    },
    `All your Pokemon fainted! You stagger back to ${routes[state.currentLocation]?.name ?? "the last town"}.`,
    `You dropped $${moneyLost.toLocaleString()} in panic.`
  );
}

