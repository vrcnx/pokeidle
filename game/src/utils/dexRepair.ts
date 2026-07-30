import type { GameState, Pokemon } from "../types";

/**
 * Save-integrity repairs that must run on EVERY way a save enters the app.
 *
 * There are two of those ways and they do not share code: the localStorage boot
 * in GameContext builds the initial state directly, and LOAD_SAVE merges a cloud
 * blob into the live session. A repair wired into only one of them silently
 * skips half the players, which is why these live here rather than inside the
 * reducer.
 *
 * Both functions are ADDITIVE and idempotent. Neither removes a dex entry nor
 * lowers a counter, so running them twice, or on an already-healthy save, is a
 * no-op that preserves array identity.
 */

/** Every Pokémon the save holds, party then box, skipping holes. */
function ownedMons(state: Pick<GameState, "party" | "box">): Pokemon[] {
  const out: Pokemon[] = [];
  for (const mon of state.party ?? []) if (mon) out.push(mon);
  for (const mon of state.box ?? []) if (mon) out.push(mon);
  return out;
}

/**
 * Anything you HOLD is registered in the Pokédex.
 *
 * The reducer's registerAcquired covers every path where the CLIENT hands you a
 * Pokémon, but the SERVER has paths of its own: auction settlement and prize
 * grants push a mon straight into the winner's stored save, and admin edits do
 * the same. If the player was offline for the socket echo, the cloud adopt is
 * the only thing that ever sees that mon — and nothing on load registered it.
 * You owned a Pokémon that was permanently absent from your own Pokédex.
 * Production showed 39 such species across 28 accounts, including legendaries
 * (reshiram, lugia, entei, raikou, genesect, deoxys) that the client has no
 * local path to register at all.
 *
 * It also repairs history. The evolution path spent a long time calling
 * markCaught instead of registerAcquired, costing 163 SHINY dex entries across
 * 70 real saves (br_2f7754077bfd6e9629). pokedexCaught is append-only, so
 * nothing else was ever going to fix those. Every affected mon is still in its
 * owner's save, so walking what they own restores every entry on next load —
 * no migration, no database write, nothing for the player to do.
 *
 * Safe to run unconditionally: the four dex lists are append-only, saveReconcile
 * UNIONs them across lineages (MONOTONIC_KEYS) and the server rejects uploads
 * that shrink shinyCaught/shinySeen. Set-based rather than a per-mon reduce
 * because a 9,999-slot PC is a supported box size.
 */
export function repairDexFromOwned<T extends GameState>(state: T): T {
  const owned = ownedMons(state);
  if (owned.length === 0) return state;
  const caught = new Set(state.pokedexCaught ?? []);
  const seen = new Set(state.pokedexSeen ?? []);
  const shinyCaught = new Set(state.shinyCaught ?? []);
  const shinySeen = new Set(state.shinySeen ?? []);
  const before = caught.size + seen.size + shinyCaught.size + shinySeen.size;
  for (const mon of owned) {
    const key = mon.speciesKey;
    if (!key) continue;
    caught.add(key);
    seen.add(key);
    // `isShiny` is optional on legacy mons. Only a literal `true` registers a
    // shiny entry, so `undefined` can never invent one.
    if (mon.isShiny === true) {
      shinyCaught.add(key);
      shinySeen.add(key);
    }
  }
  if (caught.size + seen.size + shinyCaught.size + shinySeen.size === before) {
    return state; // healthy — keep every array's identity
  }
  return {
    ...state,
    pokedexCaught: [...caught],
    pokedexSeen: [...seen],
    shinyCaught: [...shinyCaught],
    shinySeen: [...shinySeen],
  };
}

/**
 * The floor `nextPokemonId` must never sink below: one past the highest id any
 * live Pokémon holds.
 *
 * Ids are `String(nextPokemonId)` from a per-save counter that RESTARTS at 1
 * after an admin reset or a cloud-lineage adopt, so an incoming blob can carry a
 * counter far below mons already sitting in the party or box. Once the counter
 * climbs back through them, two different Pokémon share an id and every
 * id-addressed operation targets the wrong one: RELEASE_POKEMON's re-anchor
 * releases a bystander, START/COMPLETE_EVOLUTION transform one, and the
 * auction/gift dedupe mistakes a new mon for an already-delivered prize.
 *
 * Non-numeric ids (`gift12`, server-assigned grant ids) are skipped — they live
 * outside the counter's space on purpose and must not inflate it.
 */
export function pokemonIdFloor(state: Pick<GameState, "party" | "box">): number {
  let highest = 0;
  for (const mon of ownedMons(state)) {
    const n = Number(mon.id);
    if (Number.isInteger(n) && n > highest) highest = n;
  }
  return highest + 1;
}

/** Both repairs, for callers that want the whole treatment. */
export function repairLoadedSave<T extends GameState>(state: T): T {
  const withIds: T = {
    ...state,
    nextPokemonId: Math.max(state.nextPokemonId ?? 1, pokemonIdFloor(state)),
  };
  return repairDexFromOwned(withIds);
}
