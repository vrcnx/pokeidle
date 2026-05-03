import { useGame } from "../state/GameContext";
import { routes } from "../data/routes";

// Per-biome fallbacks. Mirrors BattleScene so a missing per-location asset
// still produces a sensible blurred backdrop.
const BG_BY_TYPE: Record<string, string> = {
  town: "/backgrounds/town.png",
  cave: "/backgrounds/cave.png",
  victoryRoad: "/backgrounds/mountain.png",
  raid: "/backgrounds/town_port.png",
  route: "/backgrounds/grassland.png",
};

// Full-screen blurred backdrop that always reflects the player's current
// area. Sits behind every other element via z-index: -1, with a heavy
// blur + dark overlay so foreground UI stays readable. Two stacked
// <img>s give a graceful fallback: the per-location PNG renders, and
// any 404 falls through to the biome default.
export function AppBackground() {
  const { state } = useGame();
  const route = routes[state.currentLocation];
  const locationBg = `/backgrounds/${state.currentLocation}.png`;
  const fallbackBg = BG_BY_TYPE[route?.type ?? "route"] ?? BG_BY_TYPE.route;

  return (
    <div className="app-background" aria-hidden>
      <img
        key={`appbg-${state.currentLocation}`}
        src={locationBg}
        alt=""
        onError={(e) => {
          const t = e.target as HTMLImageElement;
          if (t.src !== window.location.origin + fallbackBg) t.src = fallbackBg;
        }}
      />
      <div className="app-background-scrim" />
    </div>
  );
}
