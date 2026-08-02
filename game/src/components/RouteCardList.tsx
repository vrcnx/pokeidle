import { useMemo, useState, useEffect } from "react";
import { useGame } from "../state/GameContext";
import { routes } from "../data/routes";
import { encounters } from "../data/encounters";
import { regions, regionForLocation } from "../data/regions";
import { HubHeaderSlot, useInHubHeader, closeHub } from "./HubModal";
import {
  raidTiersOrdered, isTierUnlocked,
  type RaidTier, type RaidTierId,
} from "../data/raidLegendaries";
import { PokemonSprite } from "./Sprite";
import "./raidTiers.css";
import "./routeMap.css";
import { rememberRaidReturn } from "../hooks/useRaidReturn";
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

  const inHub = useInHubHeader();
  const meta = (
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
  );
  const head = inHub
    ? <HubHeaderSlot>{meta}</HubHeaderSlot>
    : <TabPaneHead title="" className="route-card-head-pane" meta={meta} />;

  return (
    <div className="tab-pane route-card-list">
      {/* The region tabs go in the HUB's header when there is one: that bar
          held a title and a close button with 700px of nothing between them,
          while this row sat directly underneath it. Two bars, one empty.

          Outside the hub — MobileShell mounts this too — there is no header
          to move into, so the row keeps the TabPaneHead it always had. The
          markup is built once and placed twice; a second copy for the other
          case is how two tab rows end up disagreeing about what a region is. */}
      {head}
      {/* The Raids tab is a raid picker, not a route. See RaidTierList. */}
      {activeRegion === RAID_TAB ? (
        <RaidTierList />
      ) : (
        <div className="route-card-grid">
          {routesInRegion.map((route) => (
            <RouteCard key={route.id} route={route} onTravel={travel} />
          ))}
        </div>
      )}
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
    <div
      className={`route-card ${current ? "current" : ""} ${!unlocked ? "locked" : ""}`}
      // The kind of place, for the card's colour. It was the first thing a
      // player wants off a map and the only thing the old list did not show
      // at all — a town with nothing in it looked exactly like a route with
      // six species on it.
      data-type={route.type}
    >
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
                // `title` only — this cell used to carry a styled tooltip span
                // as well, with the same `label` text in both. The custom one
                // was absolutely positioned inside a 26px flex cell with
                // white-space: nowrap, so a ~130px label overhung ~52px each
                // side and got clipped by .route-card-grid's overflow-y (which
                // computes overflow-x to auto too) and by .bottom-tab-body's
                // overflow: hidden — br_a3f10a15331c5ff80c / br_5406e95a33f579a605,
                // whose reporter also spotted that it duplicated the native
                // tooltip. The native one cannot be clipped and works on touch
                // long-press; a styled tip would have to be portalled to the
                // body to escape those two scrollers, for the same words.
                return (
                  <span key={e.speciesKey} className="route-card-mon" title={label}>
                    {seen ? (
                      <PokemonSprite
                        speciesKey={e.speciesKey}
                        alt={sp?.name ?? e.speciesKey}
                        width={26}
                        height={26}
                        style={{ imageRendering: "pixelated" }}
                        draggable={false}
                      />
                    ) : (
                      <span className="route-card-mon-mystery">?</span>
                    )}
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
          {/* Progress and the action on one line, pinned to the bottom, so
              every card in a row ends together however many species it
              holds. */}
          <div className="route-card-foot">
            {enc.length > 0 && (
              <div className="route-card-progress">
                <span>{caughtCount}/{enc.length} {t("Caught")}</span>
                {/* A bar as well as the fraction. "5/5" and "1/5" are the
                    same shape at a glance; a bar is not. */}
                <span className={`route-card-bar${caughtCount >= enc.length ? " is-done" : ""}`}>
                  <span style={{ width: `${(caughtCount / enc.length) * 100}%` }} />
                </span>
              </div>
            )}
            <button
              type="button"
              className="route-card-go"
              disabled={current}
              onClick={() => onTravel(route.id)}
            >
              {current ? t("Here") : t("Go")}
            </button>
          </div>
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

// ── The Raids tab ───────────────────────────────────────────────────
// It used to list Raid Island as a travel card: one card, one Go button,
// and the actual choice — which tier you want to fight — was on the other
// side of it, in the panel that appears once you have arrived. A tab named
// "Raids" that contains a route rather than any raids.
//
// The tiers are here now, and Start does the travelling. The trip was never
// a decision; it was a step between you and the decision.
function RaidTierList() {
  const { state, dispatch } = useGame();
  const t = useT();

  // Ticks only while something is cooling down. A raid tier's readiness is
  // the one thing on this tab that changes without the player touching it.
  const [now, setNow] = useState(() => Date.now());
  const cooldownLeftFor = (id: RaidTierId) => {
    // Old saves only have the global raidCooldownEnd — honour it for every
    // tier so an upgrading player is not handed free raids mid-cooldown.
    // Once any new raid completes, the per-tier map takes over.
    const end = state.raidCooldowns
      ? state.raidCooldowns[id] ?? 0
      : state.raidCooldownEnd ?? 0;
    return Math.max(0, end - now);
  };
  const anyCooling = raidTiersOrdered.some((x) => cooldownLeftFor(x.id) > 0);
  useEffect(() => {
    if (!anyCooling) return;
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, [anyCooling]);

  const islandUnlocked = state.unlockedLocations.includes("raidIsland");

  if (!islandUnlocked) {
    return (
      <p className="mart-note">
        {t("Raid Island opens once you have beaten the Champion.")}
      </p>
    );
  }

  const start = (tier: RaidTier) => {
    // Travel first, THEN start. The raid runs at Raid Island — the battle
    // screen, the music and the "leave raid" route all assume you are
    // standing there — so this does the trip rather than pretending the
    // location does not matter. Two dispatches, applied in order by the
    // reducer, so the raid begins in the place it belongs to.
    if (state.currentLocation !== "raidIsland") {
      // So the raid can put you back where it found you — see useRaidReturn.
      rememberRaidReturn(state.currentLocation);
      dispatch({ type: "TRAVEL", payload: { locationId: "raidIsland" } });
    }
    dispatch({ type: "START_RAID", payload: { tier: tier.id } });
    closeHub();
  };

  return (
    <ul className="raid-tier-list">
      {raidTiersOrdered.map((tier) => {
        const unlocked = isTierUnlocked(tier, state);
        const cd = cooldownLeftFor(tier.id);
        const busy = state.inRaid;
        const ready = unlocked && cd === 0 && !busy;
        // Most likely spawns first — the same order the arrival panel uses,
        // so the tier reads the same from either side.
        const lineup = Object.entries(tier.pool)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([k]) => k);
        return (
          <li
            key={tier.id}
            className={`raid-tier${unlocked ? "" : " is-locked"}${ready ? " is-ready" : ""}`}
            // The tier's colour lives in CSS keyed on this, not in the data.
            // raidLegendaries.ts describes what a tier IS — its pool, its
            // level, what unlocks it — and a hex code is not that.
            data-tier={tier.id}
          >
            <div className="raid-tier-main">
              <div className="raid-tier-text">
                <strong className="raid-tier-name">{tier.name}</strong>
                <span className="raid-tier-blurb">{tier.blurb}</span>
              </div>
              <span className="raid-tier-lv">
                <span className="raid-tier-lv-k">{t("Lv")}</span>
                <span className="raid-tier-lv-n">{tier.startLevel}</span>
              </span>
            </div>

            {/* Who you might actually meet. The tier names alone said
                nothing about what was in them — "Birds & Beasts" is not a
                roster. On its own plate, because a row of sprites floating
                on the card background read as clip-art rather than as the
                thing you are about to fight. */}
            <div className="raid-tier-lineup" aria-hidden>
              {tier.rarityTag && <span className="raid-tier-rarity">{tier.rarityTag}</span>}
              <div className="raid-tier-roster">
                {lineup.map((k) => (
                  <PokemonSprite
                    key={k}
                    speciesKey={k}
                    alt=""
                    width={38}
                    height={38}
                    style={{ imageRendering: "pixelated" }}
                  />
                ))}
              </div>
            </div>

            <div className="raid-tier-foot">
              {!unlocked ? (
                <span className="raid-tier-why">
                  {tier.unlockChampionDefeated && !state.championDefeated
                    ? t("Beat the Champion")
                    : `${t("Needs")} ${tier.unlockBadges} ${t("badges")}`}
                </span>
              ) : busy ? (
                <span className="raid-tier-why">{t("Already in a raid")}</span>
              ) : cd > 0 ? (
                <span className="raid-tier-why">
                  {t("Ready in")} {Math.ceil(cd / 1000)}s
                </span>
              ) : (
                <span className="raid-tier-why raid-tier-ready">
                  <span className="raid-tier-dot" aria-hidden />
                  {t("Ready")}
                </span>
              )}
              <button
                type="button"
                className="raid-tier-go"
                disabled={!ready}
                onClick={() => start(tier)}
                title={ready
                  ? t("Travel to Raid Island and begin")
                  : undefined}
              >
                {t("Raid")}
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
