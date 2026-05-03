import { useEffect } from "react";
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

  useEffect(() => {
    musicManager.setCategory(cat);
  }, [cat]);

  return null;
}
