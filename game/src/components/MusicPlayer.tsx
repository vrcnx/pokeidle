import { useEffect, useRef } from "react";
import { useGame } from "../state/GameContext";
import { routes } from "../data/routes";
import { musicManager } from "../utils/music";
import type { MusicCategory } from "../data/musicPlaylists";

// Watches game state and tells the music manager which playlist
// category to play. No DOM rendering — just an effect.
//
// Category priority:
//   1. Boss battle (gym leader / E4 / champion) → "challenge"
//   2. Active raid                              → "challenge"
//   3. currentLocation route type:
//        town / mart / pc area  → "city"
//        anything else          → "routes"
//
// Wild and trainer encounters keep the route's music — only boss-tier
// fights swap to challenge.
function pickCategory(state: ReturnType<typeof useGame>["state"]): MusicCategory | null {
  if (state.phase === "bossBattle" || state.bossBattle) return "challenge";
  if (state.inRaid) return "challenge";
  const here = routes[state.currentLocation];
  if (!here) return null;
  if (here.type === "town") return "city";
  return "routes";
}

export function MusicPlayer() {
  const { state } = useGame();
  const cat = pickCategory(state);
  // Track the last category we told the manager about so we can tell
  // whether a location change should trigger setCategory (which picks
  // a fresh track from the new playlist) or just next() (which rolls
  // to a different track inside the SAME playlist).
  const lastCat = useRef<MusicCategory | null>(cat);
  const lastLoc = useRef<string>(state.currentLocation);
  const lastBossId = useRef<string | null>(state.bossBattle?.bossId ?? null);

  useEffect(() => {
    const bossId = state.bossBattle?.bossId ?? null;
    const categoryChanged = lastCat.current !== cat;
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

  return null;
}
