import { useMemo, useState } from "react";
import { useGame } from "../state/GameContext";
import { routes } from "../data/routes";
import { encounters } from "../data/encounters";
import { regions, regionForLocation } from "../data/regions";
import { pokemonSpriteUrl } from "../utils/sprites";
import { pokemonTable } from "../data/pokemon";
import { useT } from "../i18n/useT";
import { IconHome, IconMountain, IconLeaf, IconIsland } from "./Icon";
import { TabPaneHead } from "./TabPaneHead";
import type { GameState, Route } from "../types";

// Sprites shown per route card before collapsing the rest into a "+N" chip.
// Two comfortable rows at typical card widths.
const ROUTE_CARD_MONS = 12;

// Card-based replacement for the graphical TownMap — same TRAVEL dispatch
// and unlock rules, but a scrollable, filterable list instead of pins on
// a background image. TownMap.tsx is left in place (unmounted) in case
// the graphical map comes back later; this is a parallel view, not a
// rewrite of it.

function iconForType(type?: string) {
  switch (type) {
    case "town":        return <IconHome size={14} />;
    case "cave":        return <IconMountain size={14} />;
    case "victoryRoad": return <IconMountain size={14} />;
    case "raid":        return <IconIsland size={14} />;
    default:            return <IconLeaf size={14} />;
  }
}

interface RequirementProgress {
  label: string;
  cur: number;
  target: number;
  done: boolean;
}

// Mirrors ContextPanel.tsx's local describeRequirements() — kept as its
// own small copy rather than exported/shared since it's a few lines and
// the two call sites want slightly different rendering around it.
function routeRequirementProgress(u: Route["unlock"], state: GameState): RequirementProgress[] {
  const out: RequirementProgress[] = [];
  if (u.battlesAtLocation) {
    for (const r of u.battlesAtLocation) {
      const won = state.battlesWonByLocation[r.locationId] ?? 0;
      out.push({
        label: `Battles at ${routes[r.locationId]?.name ?? r.locationId}`,
        cur: Math.min(won, r.count),
        target: r.count,
        done: won >= r.count,
      });
    }
  }
  if (u.badgesRequired) {
    const cur = state.defeatedGyms.length;
    out.push({ label: "Badges", cur: Math.min(cur, u.badgesRequired), target: u.badgesRequired, done: cur >= u.badgesRequired });
  }
  if (u.championDefeated) {
    out.push({ label: "Defeat the Champion", cur: state.championDefeated ? 1 : 0, target: 1, done: !!state.championDefeated });
  }
  return out;
}

export function RouteCardList() {
  const { state, dispatch } = useGame();
  const t = useT();
  const regionList = useMemo(() => Object.values(regions), []);
  // Raid islands get their own tab rather than being buried mid-list inside
  // whichever region happens to own them — they're a separate activity, not a
  // step on a region's route chain.
  const RAID_TAB = "__raid";
  const [activeRegion, setActiveRegion] = useState(regionList[0]?.id ?? "");

  const routesInRegion = useMemo(
    () =>
      Object.values(routes)
        .filter((r) =>
          activeRegion === RAID_TAB
            ? r.type === "raid"
            : regionForLocation(r.id) === activeRegion && r.type !== "raid"
        )
        .sort((a, b) => a.unlockOrder - b.unlockOrder),
    [activeRegion]
  );

  function travel(id: string) {
    if (!state.unlockedLocations.includes(id)) return;
    dispatch({ type: "TRAVEL", payload: { locationId: id } });
  }

  const currentName = routes[state.currentLocation]?.name ?? state.currentLocation;

  return (
    <div className="tab-pane route-card-list">
      <TabPaneHead
        title=""
        className="route-card-head-pane"
        meta={
          <span className="route-head-meta">
            <nav className="route-region-tabs" role="tablist">
              {regionList.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  role="tab"
                  aria-selected={activeRegion === r.id}
                  className={`route-region-tab ${activeRegion === r.id ? "active" : ""}`}
                  onClick={() => setActiveRegion(r.id)}
                >
                  {r.name}
                </button>
              ))}
              <button
                type="button"
                role="tab"
                aria-selected={activeRegion === RAID_TAB}
                className={`route-region-tab ${activeRegion === RAID_TAB ? "active" : ""}`}
                onClick={() => setActiveRegion(RAID_TAB)}
              >
                {t("Raids")}
              </button>
            </nav>
            <span className="dim small route-here">{t("Here: ")}{currentName}</span>
          </span>
        }
      />
      <div className="route-card-grid">
        {routesInRegion.map((route) => (
          <RouteCard key={route.id} route={route} onTravel={travel} />
        ))}
      </div>
    </div>
  );
}

function RouteCard({ route, onTravel }: { route: Route; onTravel: (id: string) => void }) {
  const { state } = useGame();
  const t = useT();
  const unlocked = state.unlockedLocations.includes(route.id);
  const current = state.currentLocation === route.id;
  const enc = encounters[route.id]?.encounters ?? [];
  const totalWeight = enc.reduce((s, e) => s + e.weight, 0) || 1;
  const sorted = useMemo(() => [...enc].sort((a, b) => b.weight - a.weight), [enc]);
  const caughtCount = enc.filter((e) => state.pokedexCaught.includes(e.speciesKey)).length;

  return (
    <div className={`route-card ${current ? "current" : ""} ${!unlocked ? "locked" : ""}`}>
      <div className="route-card-head">
        <span className="route-card-icon">{iconForType(route.type)}</span>
        <strong className="route-card-name" title={unlocked ? route.name : undefined}>{unlocked ? route.name : t("???")}</strong>
        {current && <span className="route-card-current-badge">{t("Here")}</span>}
      </div>

      {unlocked ? (
        <>
          {sorted.length > 0 && (
            <div className="route-card-mons">
              {/* Show up to ROUTE_CARD_MONS species, then a "+N" chip. Showing
                  ALL of them made the Safari Zone's 21 balloon the card (and
                  push the travel button out of reach); hard-capping at 8 was
                  worse — the count said 9 while 8 rendered, so the rarest
                  silently vanished. The chip keeps the card compact AND makes
                  the remainder discoverable; the Wild Pokémon panel lists
                  every species in full. */}
              {sorted.slice(0, ROUTE_CARD_MONS).map((e) => {
                const seen = state.pokedexSeen.includes(e.speciesKey);
                const sp = pokemonTable[e.speciesKey];
                const label = seen
                  ? `${sp?.name ?? e.speciesKey} · Lv${e.minLevel}-${e.maxLevel} · ${Math.round((e.weight / totalWeight) * 100)}%`
                  : t("Not yet seen");
                return (
                  <span key={e.speciesKey} className="route-card-mon" title={label}>
                    {seen ? (
                      <img
                        src={pokemonSpriteUrl(e.speciesKey)}
                        alt={sp?.name ?? e.speciesKey}
                        width={26}
                        height={26}
                        style={{ imageRendering: "pixelated" }}
                        draggable={false}
                      />
                    ) : (
                      <span className="route-card-mon-mystery">?</span>
                    )}
                    <span className="route-card-mon-tip">{label}</span>
                  </span>
                );
              })}
              {sorted.length > ROUTE_CARD_MONS && (
                <span
                  className="route-card-mon-more"
                  title={sorted.slice(ROUTE_CARD_MONS).map((e) => pokemonTable[e.speciesKey]?.name ?? e.speciesKey).join(", ")}
                >
                  +{sorted.length - ROUTE_CARD_MONS}
                </span>
              )}
            </div>
          )}
          {enc.length > 0 && (
            <div className="route-card-progress dim small">
              {caughtCount}/{enc.length} {t("Caught")}
            </div>
          )}
          <button
            type="button"
            className={`g-btn-small ${current ? "g-btn-ghost" : "g-btn-primary"}`}
            disabled={current}
            onClick={() => onTravel(route.id)}
          >
            {current ? t("Here") : t("Go")}
          </button>
        </>
      ) : (
        <ul className="route-card-reqs">
          {routeRequirementProgress(route.unlock, state).map((r, i) => (
            <li key={i} className={r.done ? "done" : ""}>
              <span className="route-card-req-label">{r.label}</span>
              <span className="route-card-req-bar">
                <span
                  className="route-card-req-fill"
                  style={{ width: `${Math.min(100, (r.cur / Math.max(1, r.target)) * 100)}%` }}
                />
              </span>
              <span className="dim small">{r.cur}/{r.target}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
