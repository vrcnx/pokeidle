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
import { raidMachines, RAID_MACHINE_DROP_CHANCE } from "../data/machineSources";
import { itemSpriteUrl } from "../utils/sprites";
import { journeyLevelOffset, applyJourneyOffset } from "../utils/regionJourney";
import { itemSpriteSlug } from "../utils/items";
import "./raidTiers.css";
import { rememberRaidReturn } from "../hooks/useRaidReturn";
import { pokemonTable } from "../data/pokemon";
import { MASTERY_TIERS, earnedLevel, nextTier, winsOn, isMasterable } from "../data/routeMastery";
import "./routeMastery.css";
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
  const [q, setQ] = useState("");

  // Searching looks across EVERY region, not just the open tab.
  //
  // "Where is Mt. Moon" is the question a map search answers, and answering
  // it with "not in Kanto" when the player is standing on the Johto tab is
  // answering a different one. A hit outside the open region says which
  // region it is in, so the answer is never ambiguous.
  const needle = q.trim().toLowerCase();
  const searchHits = useMemo(() => {
    if (!needle) return null;
    return Object.values(routes)
      .filter((r) => r.type !== "raid" && r.name.toLowerCase().includes(needle))
      .sort((a, b) => a.unlockOrder - b.unlockOrder);
  }, [needle]);

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

  // ── The tree ──────────────────────────────────────────────────────
  // Cities, with the places you reach from them underneath.
  //
  // A flat list in unlock order is the order you SEE these locations, not
  // the shape they have: forty rows of "Route 11, Route 12, Diglett's Cave,
  // Route 13" with nothing saying which town any of them hangs off. The
  // information was in the ordering and only in the ordering, so the moment
  // you were looking for somewhere rather than reading top to bottom, it
  // told you nothing.
  //
  // The rule is the nearest PRECEDING town in unlock order. That is not a
  // guess about geography — it is what the unlock chain already means: you
  // reach a town, and the places past it open up. Anything before the first
  // town of a region (Kanto opens on Route 1) becomes a leading group with
  // no head, rather than being forced under a town it does not belong to.
  const groups = useMemo(() => {
    const out: { head: Route | null; kids: Route[] }[] = [];
    for (const r of routesInRegion) {
      if (r.type === "town") out.push({ head: r, kids: [] });
      else if (out.length === 0) out.push({ head: null, kids: [r] });
      else out[out.length - 1].kids.push(r);
    }
    return out;
  }, [routesInRegion]);

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
      <input
        className="route-search"
        type="search"
        placeholder={t("Find a place")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label={t("Search locations")}
      />
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
      {searchHits ? (
        <div className="route-card-grid">
          {searchHits.length === 0 ? (
            <p className="mart-note">{t("No place by that name.")}</p>
          ) : (
            searchHits.map((route) => (
              <RouteCard
                key={route.id}
                route={route}
                onTravel={travel}
                // Which region a hit is in. The tree's city headings are what
                // normally answer that, and a flat result list has none.
                regionLabel={regions[regionForLocation(route.id) ?? ""]?.name}
              />
            ))
          )}
        </div>
      ) : activeRegion === RAID_TAB ? (
        <RaidTierList />
      ) : (
        <div className="route-card-grid">
          {groups.map((g, i) => (
            <div className="route-group" key={g.head?.id ?? `lead-${i}`}>
              {g.head && <RouteCard route={g.head} onTravel={travel} />}
              {g.kids.length > 0 && (
                // Indented under the town, with a rail down the side. The
                // cards themselves are unchanged — this nests them, it does
                // not restyle them.
                <div className={`route-group-kids${g.head ? "" : " is-lead"}`}>
                  {g.kids.map((route) => (
                    <RouteCard key={route.id} route={route} onTravel={travel} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RouteCard({ route, onTravel, regionLabel }: {
  route: Route;
  onTravel: (id: string) => void;
  /** Set only in search results, where the tree's city heading is missing. */
  regionLabel?: string;
}) {
  const { state } = useGame();
  const t = useT();
  const unlocked = state.unlockedLocations.includes(route.id);
  const current = state.currentLocation === route.id;
  const enc = encounters[route.id]?.encounters ?? [];
  const totalWeight = enc.reduce((s, e) => s + e.weight, 0) || 1;
  const sorted = useMemo(() => [...enc].sort((a, b) => b.weight - a.weight), [enc]);
  const caughtCount = enc.filter((e) => state.pokedexCaught.includes(e.speciesKey)).length;

  // ── MASTERY, ON THE ROW ──────────────────────────────────────────────
  // The mastery card in the side column only ever shows the route you are
  // STANDING ON, so the one question the map is for — "which of these have I
  // actually worked, and which am I close to finishing?" — could not be
  // answered from the map at all. You had to travel somewhere to find out how
  // far along it was.
  //
  // `isMasterable` excludes towns: their battles are trainer rematches on a
  // fixed roster, so a mastery bar there would measure patience rather than
  // the route.
  const masterable = unlocked && isMasterable(route.id);
  const wins = masterable ? winsOn(state, route.id) : 0;
  const level = earnedLevel(wins);
  const next = nextTier(wins);
  // The label is what you are working TOWARD, not what you hold — "Familiar"
  // on a route with nothing earned reads as the goal, which is the useful
  // thing on a screen you open to decide where to go. The pips carry what is
  // already banked.
  const masteryLabel = next ? next.label : "Fully Mastered";
  // Progress through the CURRENT band, not from zero: at 1,199 wins a bar
  // measured from zero sits at 99.9% and has looked full for the last eight
  // hundred battles.
  const bandFrom = level > 0 ? MASTERY_TIERS[level - 1].wins : 0;
  const bandTo = next?.wins ?? wins;
  const bandPct = next
    ? Math.max(0, Math.min(100, ((wins - bandFrom) / Math.max(1, bandTo - bandFrom)) * 100))
    : 100;

  return (
    <div
      className={`route-card ${current ? "current" : ""} ${!unlocked ? "locked" : ""}`}
      // ONLY an attribute — no new elements, no wrappers. The card's children
      // are placed by explicit `grid-column` rules in app.css, so anything
      // that moves them out of that grid breaks the layout; that is exactly
      // what the reverted redesign did.
      data-type={route.type}
    >
      <div className="route-card-head">
        <span className="route-card-icon">{iconForType(route.type)}</span>
        <strong className="route-card-name" title={unlocked ? route.name : undefined}>{unlocked ? route.name : t("???")}</strong>
        {regionLabel && <span className="route-card-region">{regionLabel}</span>}
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
                // Same rule as the Wild Pokemon panel: the level range and the
                // encounter chance are already one click away for an unseen
                // species, so hiding them on hover hid nothing and cost a
                // click. Only the NAME is withheld.
                // The band the player will ACTUALLY meet. Printing the raw
                // data here would advertise Lv40-42 on a route that rolls
                // Lv2-4 in journey mode, which is a worse lie than the
                // inflated levels this feature set out to fix.
                const shown = applyJourneyOffset(e, journeyLevelOffset(route.id, state));
                const meta = `Lv${shown.minLevel}-${shown.maxLevel} · ${Math.round((e.weight / totalWeight) * 100)}%`;
                const label = seen
                  ? `${sp?.name ?? e.speciesKey} · ${meta}`
                  : `??? · ${meta}`;
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
          {masterable && (
            <div
              className="route-card-mastery"
              title={next
                ? `${wins.toLocaleString()} / ${next.wins.toLocaleString()} ${t("wins toward")} ${next.label}`
                : `${t("Fully mastered")} — ${wins.toLocaleString()} ${t("wins")}`}
            >
              <span className="route-card-mastery-label">{t(masteryLabel)}</span>
              <div className="mastery-pips" aria-hidden>
                {MASTERY_TIERS.map((tier) => (
                  <span key={tier.level} className={tier.level <= level ? "mastery-on" : ""} />
                ))}
              </div>
              <span className="route-card-mastery-count dim">
                {next ? `${wins.toLocaleString()} / ${next.wins.toLocaleString()}` : wins.toLocaleString()}
              </span>
              {next && (
                <div className="route-card-mastery-bar" aria-hidden>
                  <span style={{ width: `${bandPct}%` }} />
                </div>
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

// ── The Raids tab ───────────────────────────────────────────────────
// It used to list Raid Island as a travel card: one card, one Go button,
// and the actual choice — which tier you want to fight — was on the other
// side of it, in the panel that appears once you have arrived. A tab named
// "Raids" that contains a route rather than any raids.
//
// The tiers are here now, and Start does the travelling. The trip was never
// a decision; it was a step between you and the decision.
/** The non-Pokemon half of a raid's payout, named. */
function RaidSpoils() {
  const { state } = useGame();
  const t = useT();
  const missing = raidMachines.filter((m) => (state.inventory[m.id] ?? 0) <= 0);
  const machinePct = Math.round(RAID_MACHINE_DROP_CHANCE * 100);

  return (
    <div className="raid-spoils">
      <h4 className="raid-spoils-head">{t("Catching the legendary can also drop")}</h4>
      <ul className="raid-spoils-list">
        <li>
          <img
            src={itemSpriteUrl("goldbottlecap", itemSpriteSlug("goldbottlecap"))}
            alt="" width={22} height={22} style={{ imageRendering: "pixelated" }}
          />
          <span>
            <strong>{t("Bottle Caps")}</strong>
            <em>{t("The only source of perfect IVs. Gold 3%, Silver 12%.")}</em>
          </span>
        </li>
        <li>
          <img
            src={itemSpriteUrl("hm03", itemSpriteSlug("hm03"))}
            alt="" width={22} height={22} style={{ imageRendering: "pixelated" }}
          />
          <span>
            <strong>{t("Machines nothing else sells")}</strong>
            <em>
              {machinePct}% — {raidMachines.length} {t("of them: every HM, plus Hyper Beam, Giga Impact, Solar Beam, Overheat and Explosion.")}
              {" "}
              {missing.length === 0
                ? t("You have them all.")
                : `${missing.length} ${t("still to find.")}`}
            </em>
          </span>
        </li>
      </ul>
    </div>
  );
}

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
  // "Ready in 287s" is a number, not an answer. A five-minute cooldown wants
  // minutes; the last minute wants seconds, because that is when a player is
  // actually waiting on it.
  const untilReady = (ms: number) => {
    const total = Math.ceil(ms / 1000);
    if (total >= 60) {
      const m = Math.floor(total / 60);
      const sec = total % 60;
      return sec > 0 ? `${m}m ${sec}s` : `${m}m`;
    }
    return `${total}s`;
  };

  if (!islandUnlocked) {
    return (
      <p className="mart-note">
        {t("Raid Island opens once you have beaten the Champion.")}
      </p>
    );
  }

  const resume = () => {
    if (state.currentLocation !== "raidIsland") {
      rememberRaidReturn(state.currentLocation);
      dispatch({ type: "TRAVEL", payload: { locationId: "raidIsland" } });
    }
    closeHub();
  };

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

  const anyCd = raidTiersOrdered.some((x) => cooldownLeftFor(x.id) > 0);

  return (
    <>
      {/* The rule, said once, where it applies. It was implicit in six
          disabled buttons — a player could see that they could not raid and
          had nothing telling them when that changes, or why. */}
      {/* ── WHAT A RAID IS FOR ────────────────────────────────────────
          The page listed six tiers and their Pokemon and said nothing about
          the rest of the payout, so the machines that ONLY come from raids —
          every HM, and the five heaviest TMs, none of which any shop sells —
          were invisible to anyone who had not read the patch notes.

          The numbers come from the drop code (data/machineSources.ts and the
          reducer's roll), not from prose, so they cannot drift away from what
          actually happens. The missing count is personal: "11 still to find"
          is a reason to raid, "11 exist" is a fact about the game. */}
      <RaidSpoils />

      {(state.inRaid || anyCd) && (
        <p className="raid-rule">
          {state.inRaid
            ? t("You are in a raid. Finish or leave it and every tier is available again — cooldowns only start when a raid ends.")
            : t("Each tier cools down on its own after a raid. The others are ready now.")}
        </p>
      )}
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
                  {tier.unlockChampionId
                      && !state.defeatedChampions.includes(tier.unlockChampionId)
                    // Checked FIRST and named: a player standing here has
                    // eight badges from somewhere, so "Needs 8 badges" would
                    // be both wrong and unactionable.
                    ? `${t("Beat")} ${tier.unlockChampionId}`
                    : tier.unlockChampionDefeated && !state.championDefeated
                      ? t("Beat the Champion")
                      : `${t("Needs")} ${tier.unlockBadges} ${t("badges")}`}
                </span>
              ) : busy ? (
                <span className="raid-tier-why">{t("Finish your raid first")}</span>
              ) : cd > 0 ? (
                <span className="raid-tier-why">
                  {t("Ready in")} {untilReady(cd)}
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
                // In a raid, this is the way BACK to it rather than a dead
                // control. Every tier reading "Already in a raid" with six
                // greyed buttons and no route to the raid in question is the
                // state this screen was worst in.
                disabled={!ready && !busy}
                onClick={() => (busy ? resume() : start(tier))}
                title={busy
                  ? t("Go back to the raid you are in")
                  : ready
                    ? t("Travel to Raid Island and begin")
                    : undefined}
              >
                {busy ? t("Resume") : t("Raid")}
              </button>
            </div>
          </li>
        );
      })}
      </ul>
    </>
  );
}
