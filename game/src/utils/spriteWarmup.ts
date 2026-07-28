// Sprite warmup — pre-fetches Pokémon sprite GIFs into the browser
// cache as soon as we know the player will need them. Solves the
// "first-load lag" the operator flagged without needing a Service
// Worker or an IndexedDB blob cache.
//
// Why preload + browser cache, not IndexedDB or a Service Worker?
//
//   - The sprite CDN (jsDelivr) already serves with aggressive
//     Cache-Control headers, so the browser HTTP cache covers repeat
//     visits for free. The pain is just the FIRST sight of each
//     sprite mid-battle.
//   - IndexedDB blob caching adds a fetch+store layer and ~50 lines
//     of glue per sprite type. It buys nothing the HTTP cache doesn't
//     already give us, AND it permanently squats on the user's disk
//     quota even after we ship new sprites.
//   - A Service Worker is the right answer if we want true offline
//     play. Until that's a goal, it's overkill — and registering one
//     introduces version-skew bugs (stale clients clinging to old
//     bundles) we don't want to debug right now.
//
// So we just spawn hidden Image() objects pointing at the URLs we
// expect to need. The browser fetches each in parallel, populates the
// HTTP cache, and the actual <img> tags later render instantly.
//
// We warm:
//   - Every species the player has SEEN (so wild encounters in
//     already-seen areas render instantly)
//   - Every species in their party + box (so battle swaps + party
//     UI never flicker)
//
// New species (first encounter ever) still take the full network
// round-trip — there's no way around that without sticking 151+
// gifs in the initial bundle, which would tank time-to-interactive.

import { pokemonSpriteUrl } from "./sprites";

// URLs we have SEEN LOAD. Only a fired `load` event proves a cache entry
// exists, so nothing lands here until then.
const warmed = new Set<string>();
// Requests currently in the air. Keeps repeat warmup passes (this module is
// re-driven on every party/pokedex change, i.e. every HP tick) from spawning
// a second Image() for a URL whose first fetch hasn't settled yet.
const inflight = new Set<string>();
// Consecutive failures per URL. A blip should be retried on the next pass;
// a genuinely absent sprite should not be re-requested forever.
const failures = new Map<string, number>();
const MAX_WARM_ATTEMPTS = 3;

function warm(url: string) {
  if (!url) return;
  if (warmed.has(url) || inflight.has(url)) return;
  if ((failures.get(url) ?? 0) >= MAX_WARM_ATTEMPTS) return;
  inflight.add(url);
  // Image() in JS triggers a normal browser fetch + caches the result
  // under the same Cache-Control rules a real <img> would use. No DOM
  // mount needed; once the load fires the cache entry exists.
  const img = new Image();
  img.decoding = "async";
  img.fetchPriority = "low";
  // Bookkeeping used to be "mark done, then fire" — which meant a preload
  // that FAILED (CDN edge hiccup, wifi handoff, ad-blocker) was recorded as
  // warmed forever and the sprite was never fetched again for the rest of
  // the session. That turned a one-off blip into a permanently missing
  // sprite everywhere the species appeared. Record on the actual outcome.
  img.onload = () => {
    inflight.delete(url);
    failures.delete(url);
    warmed.add(url);
  };
  img.onerror = () => {
    inflight.delete(url);
    failures.set(url, (failures.get(url) ?? 0) + 1);
  };
  img.src = url;
}

export interface SpriteWarmupCandidate {
  speciesKey: string;
  isShiny?: boolean;
}

// Warm every front-facing sprite for the supplied species. We skip
// back sprites here — back sprites are only seen on the player's own
// side of an active battle, and the player's party is already covered
// by warmupParty() which fires both sides.
export function warmupSpecies(candidates: readonly SpriteWarmupCandidate[]): void {
  for (const { speciesKey, isShiny } of candidates) {
    warm(pokemonSpriteUrl(speciesKey, false, false));
    if (isShiny) warm(pokemonSpriteUrl(speciesKey, false, true));
  }
}

// Player's party — warm BOTH facings + shiny variant for any shiny on
// the team. These are the sprites the player will see the most so we
// hit them eagerly on app boot.
export function warmupParty(party: readonly { speciesKey: string; isShiny: boolean }[]): void {
  for (const p of party) {
    warm(pokemonSpriteUrl(p.speciesKey, false, p.isShiny));
    warm(pokemonSpriteUrl(p.speciesKey, true,  p.isShiny));
  }
}

// Wipes the warmup bookkeeping. Only used in tests + when the user signs
// out (so a different player's preload bookkeeping doesn't carry over).
export function resetWarmup(): void {
  warmed.clear();
  inflight.clear();
  failures.clear();
}
