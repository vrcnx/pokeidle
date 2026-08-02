import { useGame } from "../state/GameContext";
import { useAuth } from "../auth/AuthContext";
import { useT } from "../i18n/useT";
import { openHub, useHubSection, useHubBadges, type HubSection } from "./HubModal";
import { PokemonSprite } from "./Sprite";
import {
  IconMap, IconCart, IconBackpack, IconMonitor, IconBook,
  IconSwords, IconChat, IconSettings,
} from "./Icon";
import { regions, regionForLocation, DEFAULT_REGION } from "../data/regions";
import { regionBadgeCount } from "../utils/unlocks";
import { caughtObtainableCount, obtainableCount } from "../utils/obtainable";
import "./trainerCorner.css";

// The top of the LEFT rail.
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
  // The same counts the hub rail shows. A badge that exists in one place and
  // not the other is how a player ends up knowing something is waiting
  // without knowing where — which is exactly what happened with the friend
  // request that lit up the rail and nothing out here.
  const waiting = useHubBadges();

  const lead = state.party[0];
  const region = regions[regionForLocation(state.currentLocation) ?? DEFAULT_REGION] ?? regions[DEFAULT_REGION];
  const badges = regionBadgeCount(state, region);
  const caught = caughtObtainableCount(state.pokedexCaught);
  const total = obtainableCount();
  const name = me?.name ?? me?.username ?? t("Trainer");

  // The destinations that used to be the tab strip, as shortcuts. The
  // strip's real virtue was that Map and Bag were ONE click away, and losing
  // that to tidiness would be a bad trade — so they are still one click,
  // they just land in the hub instead of a panel with its own rules.
  // The app's own icon set — the same drawings the tab strip used for these
  // five, which is what made that strip readable at a glance.
  const go = [
    { id: "map"  as HubSection, Icon: IconMap,      label: t("Map") },
    { id: "mart" as HubSection, Icon: IconCart,     label: t("Mart") },
    { id: "bag"  as HubSection, Icon: IconBackpack, label: t("Bag") },
    { id: "pc"   as HubSection, Icon: IconMonitor,  label: t("PC") },
  ];
  // The three that used to be their own dock, plus the Dex. They point at
  // hub sections like everything else here, so a second toolbar for them was
  // one toolbar too many — and it sat directly under this card, which is why
  // they read as belonging to it long before they were part of it.
  //
  // The Dex sits in this row rather than the one above so both rows are four
  // wide and the icons line up in a grid. It reads correctly here too: the
  // Pokedex is a record of what you have caught, which is a fact about you,
  // not a place in the world you travel to.
  const you = [
    { id: "dex"      as HubSection, Icon: IconBook,     label: t("Dex") },
    { id: "pvp"      as HubSection, Icon: IconSwords,   label: t("PvP") },
    { id: "social"   as HubSection, Icon: IconChat,     label: t("Social") },
    { id: "settings" as HubSection, Icon: IconSettings, label: t("Settings") },
  ];

  return (
    <section className="trainer-corner" aria-label={t("Trainer")}>
      <button
        type="button"
        className={`trainer-corner-main${openSection === "trainer" ? " is-active" : ""}`}
        // The strip this replaced opened the trainer card, and that is the
        // action this surface means — it is the block ABOUT you. It opens
        // the card INSIDE the hub rather than as a dialog of its own, so
        // this card and the hub's identity block are the same door to the
        // same room: press either, land in the same place, and the rest of
        // the game is one rail away instead of behind a Close button.
        onClick={() => openHub("trainer")}
        title={t("Open trainer card")}
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

      {[go, you].map((row, n) => (
        <nav
          key={n}
          className={`trainer-corner-links trainer-corner-links--${n === 0 ? "go" : "you"}`}
          aria-label={n === 0 ? t("Go") : t("You")}
        >
          {row.map((sc) => (
            <button
              key={sc.id}
              type="button"
              className={`trainer-corner-link${openSection === sc.id ? " is-active" : ""}`}
              onClick={() => openHub(sc.id)}
              title={sc.label}
            >
              <span className="trainer-corner-link-icon" aria-hidden><sc.Icon size={15} /></span>
              <span className="trainer-corner-link-label">{sc.label}</span>
              {(waiting[sc.id] ?? 0) > 0 && (
                <span
                  className="trainer-corner-link-badge"
                  aria-label={`${waiting[sc.id]} ${t("waiting")}`}
                >
                  {(waiting[sc.id] ?? 0) > 9 ? "9+" : String(waiting[sc.id])}
                </span>
              )}
            </button>
          ))}
        </nav>
      ))}
    </section>
  );
}
