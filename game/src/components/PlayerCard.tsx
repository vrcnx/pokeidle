import { useGame } from "../state/GameContext";
import { useAuth } from "../auth/AuthContext";
import { useT } from "../i18n/useT";
import { openHub, useHubSection, type HubSection } from "./HubModal";
import { PokemonSprite } from "./Sprite";
import { regions, regionForLocation, DEFAULT_REGION } from "../data/regions";
import { regionBadgeCount } from "../utils/unlocks";
import { caughtObtainableCount, obtainableCount } from "../utils/obtainable";
import "./trainerCorner.css";

// The top of the right rail.
//
// ── WHAT WAS HERE ───────────────────────────────────────────────────
// A five-tab strip — Map, Mart, Bag, PC, Dex — pinned under the battle
// scene with its own navigation, in its own corner, competing with the hub
// for the same job. Those five were always destinations; they just had a
// second menu of their own, so the game had two answers to "where do I go
// to do a thing" and the answer depended on which thing.
//
// They are hub sections now, and this is what the corner became: who you
// are, and one way in. A player card earns the space the strip was using
// because it says something the rest of the screen does not — your lead
// Pokémon, your badges, how much of the dex you have actually filled.
//
// ── WHY A CARD AND NOT JUST A BUTTON ────────────────────────────────
// A single "Menu" button in a 300px corner is a lot of nothing around a
// small target. The card is the target: the whole surface opens the hub,
// so the hit area is the corner rather than a pill inside it.

export function PlayerCard() {
  const { state } = useGame();
  const { me } = useAuth();
  const t = useT();
  const openSection = useHubSection();

  const lead = state.party[0];
  const region = regions[regionForLocation(state.currentLocation) ?? DEFAULT_REGION] ?? regions[DEFAULT_REGION];
  const badges = regionBadgeCount(state, region);
  const caught = caughtObtainableCount(state.pokedexCaught);
  const total = obtainableCount();
  const name = me?.name ?? me?.username ?? t("Trainer");

  // The five destinations that used to be the tab strip, as shortcuts. The
  // strip's real virtue was that Map and Bag were ONE click away, and losing
  // that to tidiness would be a bad trade — so they are still one click,
  // they just land in the hub instead of a panel with its own rules.
  const shortcuts: Array<{ id: HubSection; icon: string; label: string }> = [
    { id: "map",  icon: "▣", label: t("Map") },
    { id: "mart", icon: "⛁", label: t("Mart") },
    { id: "bag",  icon: "⛃", label: t("Bag") },
    { id: "pc",   icon: "▤", label: t("PC") },
    { id: "dex",  icon: "▥", label: t("Dex") },
  ];

  return (
    <section className="trainer-corner" aria-label={t("Trainer")}>
      <button
        type="button"
        className="trainer-corner-main"
        onClick={() => openHub()}
        title={t("Open the menu")}
      >
        <span className="trainer-corner-lead">
          {lead
            ? (
              <PokemonSprite
                speciesKey={lead.speciesKey}
                isShiny={!!lead.isShiny}
                alt=""
                width={56}
                height={56}
                style={{ imageRendering: "pixelated" }}
              />
            )
            : <span className="trainer-corner-lead-empty" aria-hidden>?</span>}
        </span>

        <span className="trainer-corner-text">
          <span className="trainer-corner-name">{name}</span>
          <span className="trainer-corner-meta">
            <span>{t("Lv")} <strong>{me?.accountLevel ?? 1}</strong></span>
            <span className="trainer-corner-money">${state.money.toLocaleString()}</span>
          </span>
          {/* Two numbers that are otherwise three clicks away, and the two a
              player checks most often to know how they are doing. */}
          <span className="trainer-corner-progress">
            <span>{t("Badges")} <strong>{badges}</strong>/{region.gymLeaders.length}</span>
            <span>{t("Dex")} <strong>{caught}</strong>/{total}</span>
          </span>
        </span>

        <span className="trainer-corner-open" aria-hidden>›</span>
      </button>

      <nav className="trainer-corner-links" aria-label={t("Go")}>
        {shortcuts.map((sc) => (
          <button
            key={sc.id}
            type="button"
            className={`trainer-corner-link${openSection === sc.id ? " is-active" : ""}`}
            onClick={() => openHub(sc.id)}
            title={sc.label}
          >
            <span className="trainer-corner-link-icon" aria-hidden>{sc.icon}</span>
            <span className="trainer-corner-link-label">{sc.label}</span>
          </button>
        ))}
      </nav>
    </section>
  );
}
