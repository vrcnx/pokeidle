import { useEffect, useRef, useState } from "react";
import { useGame } from "../state/GameContext";
import { regions, regionForLocation, DEFAULT_REGION } from "../data/regions";
import { regionBadgeCount } from "../utils/unlocks";
import { BattleScene } from "./BattleScene";
import { MovesPanel, MovesToolbar } from "./MovesPanel";
import { RouteCardList } from "./RouteCardList";
import { PartyColumn } from "./PartyColumn";
import { ContextPanel, UnlockHint } from "./ContextPanel";
import { BagTab, PCTab, MartTab, DexTab } from "./BottomTabs";
import { MetaDock } from "./GlobalDock";
import { MiniChat } from "./MiniChat";
import { PvpMobileStage, PvpMobilePanel, pvpBattleSignals } from "./PvpArena";
import { usePvpState } from "../state/pvp";
import { nextPvpMobileView, type PvpMobileView } from "../utils/pvpMobileNav";
import {
  IconPin, IconBag, IconMap, IconChat, IconBackpack, IconMonitor, IconCart, IconBook,
  IconSwords,
} from "./Icon";
import { useT } from "../i18n/useT";

// Mobile single-column layout. Battle scene + moves are always pinned
// at the top; the bottom area swaps between six top-level tabs that
// match how the desktop dashboard organises content — without nested
// tab strips that confused the navigation before. The Pokédex rides
// inside the PC tab as a sub-view (see pcView below) — a seventh
// top-level tab would wrap the bar on a 360px phone.
type MobileTab = "world" | "party" | "mart" | "bag" | "pc" | "chat";
// "world" merges the old Here + Map tabs into a single bottom-bar slot
// with an internal sub-tab toggle so we don't overflow into a second
// row on phones. Six tabs comfortably fit a 360px viewport.

// Compact money formatter for the mobile header strip — keeps the
// stats row readable on narrow screens. The full amount is in the
// title attribute for anyone who wants the exact number.
function compactMoney(n: number): string {
  if (n < 1_000) return `$${n}`;
  if (n < 10_000) return `$${(n / 1_000).toFixed(1)}K`;
  if (n < 1_000_000) return `$${Math.round(n / 1_000)}K`;
  if (n < 10_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  return `$${Math.round(n / 1_000_000)}M`;
}

function tabIcon(id: MobileTab) {
  switch (id) {
    case "world": return <IconMap size={18} />;
    case "party": return <IconBag size={18} />;
    case "mart":  return <IconCart size={18} />;
    case "bag":   return <IconBackpack size={18} />;
    case "pc":    return <IconMonitor size={18} />;
    case "chat":  return <IconChat size={18} />;
  }
}

/* The PvP bar's icons. "team" reuses the Party glyph and "chat" reuses the
   Chat glyph on purpose — they mean the same thing they mean in the idle bar,
   so the bar reads as the same object switching modes rather than a different
   application. */
function pvpTabIcon(id: PvpMobileView) {
  switch (id) {
    case "battle": return <IconSwords size={18} />;
    case "team":   return <IconBag size={18} />;
    case "log":    return <IconBook size={18} />;
    case "chat":   return <IconChat size={18} />;
  }
}

export function MobileShell() {
  const { state } = useGame();
  const t = useT();
  const region = regions[regionForLocation(state.currentLocation) ?? DEFAULT_REGION] ?? regions[DEFAULT_REGION];
  const badgeCount = regionBadgeCount(state, region);
  const badgeTotal = region.gymLeaders.length;
  const TABS: { id: MobileTab; label: string }[] = [
    { id: "world", label: t("World") },
    { id: "party", label: t("Party") },
    { id: "mart",  label: t("Mart") },
    { id: "bag",   label: t("Bag") },
    { id: "pc",    label: t("PC") },
    { id: "chat",  label: t("Chat") },
  ];
  const [tab, setTab] = useState<MobileTab>("world");

  // ─── PvP takeover ──────────────────────────────────────────────────
  //
  // A live PvP battle replaces the arena row AND the bottom bar for its
  // duration. That is not a shortcut — it is the honest layout, because the
  // idle game is PARKED while a room exists (App.tsx passes `useIsPvpBattle()`
  // into `useBattleLoop`), so every one of the six idle tabs leads to a frozen
  // game and the phone's most valuable surface would be spent pointing at it.
  //
  // The shell itself is NOT unmounted and neither is the idle battle scene —
  // it is hidden by CSS a few lines down. `BattleScene` owns WhiteoutOverlay
  // and HealOverlay, which are the only components that can dispatch out of
  // `phase: "healing"`, and a battle that starts while a heal is playing would
  // otherwise leave the idle game stuck there for the rest of the session.
  // Keeping it mounted costs one hidden subtree and removes that class of bug
  // entirely.
  const { room: pvpRoom } = usePvpState();
  const pvpLive = pvpRoom != null;
  const [pvpView, setPvpView] = useState<PvpMobileView>("battle");
  const pvpSignals = pvpBattleSignals(pvpRoom);
  const lastPvpSignals = useRef<ReturnType<typeof pvpBattleSignals> | null>(null);
  useEffect(() => {
    const prev = lastPvpSignals.current;
    lastPvpSignals.current = pvpSignals;
    setPvpView((cur) => nextPvpMobileView(cur, prev, pvpSignals));
    // The rule reads only these three fields; depending on the object would
    // re-run it on every socket frame and re-assert a forced view the player
    // had already tabbed away from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pvpSignals.battleId, pvpSignals.forceSwitch, pvpSignals.over]);

  const PVP_TABS: { id: PvpMobileView; label: string }[] = [
    { id: "battle", label: t("Battle") },
    { id: "team",   label: t("Teams") },
    { id: "log",    label: t("Log") },
    { id: "chat",   label: t("Chat") },
  ];
  // Sub-tab inside the World tab: "here" shows the location/raid
  // panel, "map" shows the world map. Persisted across the World
  // tab's lifecycle so toggling away and back doesn't reset the view.
  const [worldView, setWorldView] = useState<"here" | "map">("here");
  // Sub-tab inside the PC tab: "box" is the storage view, "dex" is
  // the Pokédex (which has no top-level slot in the bottom bar — too
  // many tabs would wrap on a phone, so we tuck it into PC).
  const [pcView, setPcView] = useState<"box" | "dex">("box");

  // Auto-hop to "World → Here" on the FIRST entry into a boss battle
  // (gym leaders, E4, champion) so the player notices, but not on
  // every wild/trainer tick — those happen constantly and yanking the
  // user is annoying.
  const lastBossPhase = useRef(state.phase === "bossBattle");
  useEffect(() => {
    const isBoss = state.phase === "bossBattle";
    if (isBoss && !lastBossPhase.current) {
      setTab("world");
      setWorldView("here");
    }
    lastBossPhase.current = isBoss;
  }, [state.phase]);

  return (
    <div className={pvpLive ? `mobile-shell pvp-live pvp-view-${pvpView}` : `mobile-shell tab-${tab}`}>
      <header className="mobile-header">
        <div className="mobile-stats">
          <span title={`$${state.money.toLocaleString()}`}>
            <span className="mobile-stat-icon">💰</span>{compactMoney(state.money)}
          </span>
          <span title={`${badgeCount} of ${badgeTotal} ${region.name} badges`}>
            <span className="mobile-stat-icon">🏅</span>{badgeCount}/{badgeTotal}
          </span>
          {state.victoryTokens > 0 && (
            <span title={`${state.victoryTokens} Victory Tokens`}>
              <span className="mobile-stat-icon">🎟</span>{state.victoryTokens}
            </span>
          )}
          {state.championDefeated && <span title={t("Champion")}>👑</span>}
        </div>
        <div className="mobile-meta-buttons">
          <MetaDock />
        </div>
      </header>

      {/* The arena row. In PvP the battle window and its status strip take it;
          the idle scene stays MOUNTED but hidden (see the note above — it owns
          the two overlays that can clear a terminal phase). The moves toolbar
          and panel need no rule of their own: app.css already hides them on
          every tab but "world", and a PvP shell has no `tab-world` class. */}
      <div className={pvpLive ? "mobile-arena is-pvp" : "mobile-arena"}>
        {pvpLive && <PvpMobileStage />}
        <BattleScene />
        <MovesToolbar />
        <MovesPanel />
      </div>

      <div className="mobile-content">
        {pvpLive && (
          pvpView === "chat" ? <MiniChat /> : <PvpMobilePanel view={pvpView} />
        )}
        {!pvpLive && tab === "world" && (
          <div className="mobile-world">
            <div className="mobile-world-tabs" role="tablist">
              <button
                role="tab"
                aria-selected={worldView === "here"}
                className={worldView === "here" ? "active" : ""}
                onClick={() => setWorldView("here")}
              >
                <IconPin size={14} /> <span>{t("Here")}</span>
              </button>
              <button
                role="tab"
                aria-selected={worldView === "map"}
                className={worldView === "map" ? "active" : ""}
                onClick={() => setWorldView("map")}
              >
                <IconMap size={14} /> <span>{t("Map")}</span>
              </button>
            </div>
            <div className="mobile-world-body">
              {worldView === "here" ? (
                <>
                  {/* Next-goal tracker — surfaces post-Champion endgame
                      content (Raid Island, Reward Shop) + visible
                      unlock requirements for the next route. Was
                      previously desktop-only; player feedback was
                      "lost on what to do after Elite 4". */}
                  <UnlockHint />
                  <ContextPanel />
                </>
              ) : (
                <RouteCardList />
              )}
            </div>
          </div>
        )}
        {!pvpLive && tab === "party" && <PartyColumn />}
        {/* Bag / Mart / PC reuse the desktop tab-body chrome (the
            parchment / tile / CRT-monitor backgrounds + frosted card
            styles defined under .bottom-tab-body:has(> .X-tab)). */}
        {!pvpLive && tab === "mart"  && <div className="bottom-tab-body"><MartTab /></div>}
        {!pvpLive && tab === "bag"   && <div className="bottom-tab-body"><BagTab /></div>}
        {!pvpLive && tab === "pc"    && (
          <div className={`bottom-tab-body pc-host pc-view-${pcView}`}>
            <div className="mobile-pc-tabs" role="tablist">
              <button
                role="tab"
                aria-selected={pcView === "box"}
                className={pcView === "box" ? "active" : ""}
                onClick={() => setPcView("box")}
              >
                <IconMonitor size={14} /> <span>{t("Box")}</span>
              </button>
              <button
                role="tab"
                aria-selected={pcView === "dex"}
                className={pcView === "dex" ? "active" : ""}
                onClick={() => setPcView("dex")}
              >
                <IconBook size={14} /> <span>{t("Dex")}</span>
              </button>
            </div>
            {pcView === "box" ? <PCTab /> : <DexTab />}
          </div>
        )}
        {!pvpLive && tab === "chat"  && <MiniChat />}
      </div>

      {/* One bar, two modes. `role="tablist"` and the aria-selected state are
          on the PvP bar because it is genuinely a tab strip over one content
          region; the idle bar predates that and is left exactly as it was. */}
      {pvpLive ? (
        <nav className="mobile-tabbar pvp-tabbar" role="tablist" aria-label={t("PvP Battle")}>
          {PVP_TABS.map((v) => (
            <button
              key={v.id}
              role="tab"
              aria-selected={pvpView === v.id}
              className={pvpView === v.id ? "active" : ""}
              onClick={() => setPvpView(v.id)}
            >
              <span className="tab-icon">{pvpTabIcon(v.id)}</span>
              <span className="tab-label">{v.label}</span>
            </button>
          ))}
        </nav>
      ) : (
        <nav className="mobile-tabbar">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? "active" : ""}
              onClick={() => setTab(t.id)}
            >
              <span className="tab-icon">{tabIcon(t.id)}</span>
              <span className="tab-label">{t.label}</span>
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
