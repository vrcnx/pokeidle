import { useGame } from "../state/GameContext";
import { pokemonTable } from "../data/pokemon";
import { encounters as encounterTable } from "../data/encounters";
import { PokemonSprite } from "./Sprite";
import { calcAllStats, perfectIVs } from "../utils/stats";
import { catchProbability } from "../utils/catching";
import { rarityFromRate, RARITY_LABEL, rateForSpecies } from "../utils/rarity";
import { REPEL_TIERS } from "../utils/encounters";
import { consumables } from "../data/consumables";
import { useT } from "../i18n/useT";
import type { ActiveEffect } from "../types";

// Inline detail panel that renders below the Wild Pokemon grid when a tile
// is clicked. Mirrors the original: rarity tier, encounter % rate, types,
// visual stat bars (computed at the encounter's max level), and the
// Repel/Honey buttons that target THIS species specifically.

interface Props {
  speciesKey: string;
  routeKey: string;
  onClose: () => void;
}

const STAT_COLOR: Record<string, string> = {
  hp:        "#60a040",
  attack:    "#c86828",
  defense:   "#c8a828",
  spAttack:  "#5878c8",
  spDefense: "#60a040",
  speed:     "#d04870",
};

export function WildPokemonDetail({ speciesKey, routeKey, onClose }: Props) {
  const { state, dispatch } = useGame();
  const t = useT();
  const species = pokemonTable[speciesKey];
  const route = encounterTable[routeKey];
  if (!species || !route) return null;

  const encounter = route.encounters.find((e) => e.speciesKey === speciesKey);
  if (!encounter) return null;

  const ratePct = rateForSpecies(speciesKey, route.encounters);
  const rarity = rarityFromRate(ratePct);

  const seen = state.pokedexSeen.includes(speciesKey);
  const caught = state.pokedexCaught.includes(speciesKey);

  // Stat preview at the species' max encounter level with perfect IVs —
  // gives the player an idea of what they'd be catching.
  const stats = calcAllStats(species, encounter.maxLevel, perfectIVs());
  const maxStat = Math.max(...Object.values(stats));
  const honeyOwned = state.inventory.honey ?? 0;

  const effectOn = (itemId: string): ActiveEffect | undefined =>
    state.activeEffects.find(
      (e) => e.itemId === itemId && e.routeKey === routeKey && e.speciesKey === speciesKey
    );

  // One row per repel tier. This panel is the only place in the game that
  // can start a repel, and it used to be hardcoded to the base "repel" id —
  // so Super Repel and Max Repel were purchasable in five marts and could
  // never be used. Build the buttons off REPEL_TIERS so a new tier is
  // playable the moment it exists in consumables.ts.
  const repelTiers = REPEL_TIERS.map((id) => ({
    id,
    def: consumables[id],
    owned: state.inventory[id] ?? 0,
    active: effectOn(id),
  }));
  // Only ONE repel effect can exist per species+route (the tiers share a
  // slot — see USE_EFFECT_ITEM), so this is "the repel running here".
  const repelRunning = repelTiers.find((r) => r.active)?.active;
  const repelCap = repelRunning
    ? (consumables[repelRunning.itemId]?.duration ?? 0) * 3
    : 0;
  // Hide tiers the player neither owns nor has running, but always keep at
  // least one row so the affordance stays discoverable when the bag is empty.
  const shownRepels = repelTiers.filter((r) => r.owned > 0 || r.active);
  if (shownRepels.length === 0 && repelTiers[0]) shownRepels.push(repelTiers[0]);

  const honeyActive = effectOn("honey");
  const honeyDef = consumables.honey;

  // Catch chance with a Poké Ball (the cheapest reference point).
  const catchPct = Math.round(catchProbability(speciesKey, "pokeball") * 100);

  return (
    <div className="wild-detail">
      <button className="wild-detail-close" onClick={onClose}>×</button>
      <div className="wild-detail-head">
        <PokemonSprite
          speciesKey={speciesKey}
          alt={species.name}
          width={56}
          height={56}
          style={{
            imageRendering: "pixelated",
            filter: caught
              ? "none"
              : seen
              ? "grayscale(1) brightness(0.85)"
              : "brightness(0)",
          }}
        />
        <div>
          <h3>
            {seen ? species.name : "???"}
            <small> {t("Lv")} {encounter.minLevel}–{encounter.maxLevel}</small>
          </h3>
          <div className="wild-detail-types">
            {species.types.map((t) => (
              <span key={t} className={`type-badge type-${t.toLowerCase()}`}>{t}</span>
            ))}
          </div>
          <div className={`wild-detail-rarity rarity-${rarity}`}>
            {RARITY_LABEL[rarity]} · {ratePct.toFixed(1)}%
            {caught && <span className="check">{t(" ✓ caught")}</span>}
          </div>
        </div>
      </div>

      <div className="wild-detail-actions">
        {shownRepels.map(({ id, def, owned, active }) => {
          const atCap = !!repelRunning && repelRunning.battlesRemaining >= repelCap;
          const extending = !!repelRunning && !active;
          return (
            <button
              key={id}
              disabled={owned <= 0 || atCap}
              className={active ? "active" : ""}
              title={
                owned <= 0 && !active
                  ? `${t("None in your bag — buy")} ${def.name} ${t("at a Poké Mart")}`
                  : atCap
                  ? `${t("Already at the stacking cap of")} ${repelCap.toLocaleString()} ${t("battles")}`
                  : `${t("Halves this species' encounter weight on this route for")} ${def.duration.toLocaleString()} ${t("battles")}.` +
                    (extending
                      ? ` ${t("Adds to the repel already running here — the tiers share one timer and are equally strong.")}`
                      : "")
              }
              onClick={() => dispatch({
                type: "USE_EFFECT_ITEM",
                payload: { itemId: id, speciesKey, routeKey },
              })}
            >
              {t(def.name)} ({owned})
              {active && ` · ${active.battlesRemaining.toLocaleString()} ${t("left")}`}
            </button>
          );
        })}
        <button
          disabled={!honeyOwned}
          className={honeyActive ? "active" : ""}
          title={`${t("Doubles this species' encounter weight on this route for")} ${honeyDef.duration.toLocaleString()} ${t("battles")}.`}
          onClick={() => dispatch({
            type: "USE_EFFECT_ITEM",
            payload: { itemId: "honey", speciesKey, routeKey },
          })}
        >
          {t("Honey")} ({honeyOwned})
          {honeyActive && ` · ${honeyActive.battlesRemaining.toLocaleString()} ${t("left")}`}
        </button>
      </div>

      {/* What is actually running on THIS species right now. The buttons
          alone couldn't say this before: a Super/Max Repel left the base
          Repel button unlit, so a running repel looked like no repel. */}
      {(repelRunning || honeyActive) && (
        <div className="wild-detail-effects">
          {repelRunning && (
            <small className={repelRunning.paused ? "dim" : ""}>
              {t(consumables[repelRunning.itemId]?.name ?? "Repel")} ·{" "}
              {repelRunning.battlesRemaining.toLocaleString()} / {repelCap.toLocaleString()}{" "}
              {t("battles left")} —{" "}
              {repelRunning.paused
                ? t("paused, not applying")
                : t("encounter weight halved")}
            </small>
          )}
          {honeyActive && (
            <small className={honeyActive.paused ? "dim" : ""}>
              {t("Honey")} · {honeyActive.battlesRemaining.toLocaleString()} /{" "}
              {(honeyDef.duration * 3).toLocaleString()} {t("battles left")} —{" "}
              {honeyActive.paused
                ? t("paused, not applying")
                : t("encounter weight doubled")}
            </small>
          )}
        </div>
      )}

      <div className="wild-detail-stats">
        <small className="dim">{t("Stats at L")}{encounter.maxLevel}{t(" (perfect IVs):")}</small>
        {(Object.keys(stats) as (keyof typeof stats)[]).map((key) => (
          <div key={key} className="wild-stat-row">
            <span className="wild-stat-label">{statLabel(key, t)}</span>
            <div className="wild-stat-bar">
              <div
                className="wild-stat-fill"
                style={{
                  width: `${(stats[key] / maxStat) * 100}%`,
                  background: STAT_COLOR[key],
                }}
              />
            </div>
            <span className="wild-stat-value">{stats[key]}</span>
          </div>
        ))}
      </div>

      <div className="wild-detail-catch">
        <small className="dim">{t("Catch chance with Poké Ball: ")}<strong>{catchPct}%</strong></small>
      </div>
    </div>
  );
}

function statLabel(key: string, t: (str: string) => string): string {
  switch (key) {
    case "hp":        return t("HP");
    case "attack":    return t("Atk");
    case "defense":   return t("Def");
    case "spAttack":  return t("SpA");
    case "spDefense": return t("SpD");
    case "speed":     return t("Spd");
    default:          return key;
  }
}
