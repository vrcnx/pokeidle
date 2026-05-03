import { useEffect, useRef } from "react";
import { useGame } from "../state/GameContext";
import { routes } from "../data/routes";
import { pokemonTable } from "../data/pokemon";
import { musicManager } from "../utils/music";
import { sfxManager } from "../utils/sfx";
import type { MusicCategory } from "../data/musicPlaylists";

// Watches game state and tells the music manager which playlist
// category to play. No DOM rendering — just an effect.
//
// Category priority:
//   1. Boss battle (gym leader / E4 / champion) → "challenge"
//   2. Active raid                              → "challenge"
//   3. Indigo Plateau (typed as a town, but conceptually a landmark
//      that should share Victory Road's mood)        → "special"
//   4. currentLocation route type:
//        victoryRoad type        → "special"
//        town                    → "city"
//        anything else           → "routes"
//
// Wild and trainer encounters keep the route's music — only boss-tier
// fights swap to challenge.
// Locations that should play the "special" playlist regardless of
// their route type. Add an id here when a new landmark needs the
// approach-the-summit mood (Cerulean Cave, Mt. Silver, etc).
const SPECIAL_LOCATIONS = new Set([
  "victoryRoad",
  // Indigo Plateau is typed "town" in the route data (the unlock
  // graph + shop logic treat it like a city) but musically it belongs
  // with Victory Road — same final-stretch atmosphere.
  "indigoPlat",
]);

function pickCategory(state: ReturnType<typeof useGame>["state"]): MusicCategory | null {
  if (state.phase === "bossBattle" || state.bossBattle) return "challenge";
  if (state.inRaid) return "challenge";
  const here = routes[state.currentLocation];
  if (!here) return null;
  if (SPECIAL_LOCATIONS.has(state.currentLocation)) return "special";
  if (here.type === "victoryRoad") return "special";
  if (here.type === "town") return "city";
  return "routes";
}

export function MusicPlayer() {
  const { state } = useGame();
  const cat = pickCategory(state);
  // Track the last category we told the manager about so we can tell
  // whether a location change should trigger setCategory (which picks
  // a fresh track from the new playlist) or just next() (which rolls
  // to a different track inside the SAME playlist). Initialised to a
  // sentinel UNSET so the first render is treated as a category
  // change — otherwise the music manager never gets its initial
  // setCategory call and nothing plays at boot.
  const UNSET = "__unset__" as const;
  const lastCat = useRef<MusicCategory | null | typeof UNSET>(UNSET);
  const lastLoc = useRef<string>(state.currentLocation);
  const lastBossId = useRef<string | null>(state.bossBattle?.bossId ?? null);

  useEffect(() => {
    const bossId = state.bossBattle?.bossId ?? null;
    const isFirstRun = lastCat.current === UNSET;
    const categoryChanged = isFirstRun || lastCat.current !== cat;
    const locationChanged = lastLoc.current !== state.currentLocation;
    const bossChanged = lastBossId.current !== bossId;

    if (categoryChanged) {
      musicManager.setCategory(cat);
    } else if (cat && (locationChanged || bossChanged)) {
      // Same playlist category, but the player moved (route → route,
      // town → town, gym → gym). Skip to a fresh track so each new
      // location feels distinct instead of dragging the same loop on.
      musicManager.next();
    }

    lastCat.current = cat;
    lastLoc.current = state.currentLocation;
    lastBossId.current = bossId;
  }, [cat, state.currentLocation, state.bossBattle?.bossId]);

  // Pokemon cry on encounter — fires whenever a new enemy Pokemon
  // appears (wild encounter, trainer's next mon, gym leader's lead,
  // etc). Keyed by enemy id + speciesKey so consecutive wilds of the
  // same species each play a cry.
  const lastEnemyId = useRef<string | null>(null);
  const enemyKey = state.enemyPokemon?.speciesKey ?? null;
  const enemyId = state.enemyPokemon?.id ?? null;
  useEffect(() => {
    if (!enemyKey || !enemyId) {
      lastEnemyId.current = null;
      return;
    }
    if (lastEnemyId.current === enemyId) return;
    lastEnemyId.current = enemyId;
    const dexId = pokemonTable[enemyKey]?.id;
    if (dexId) sfxManager.playCry(dexId);
  }, [enemyKey, enemyId]);

  return null;
}
