import { useGame } from "../state/GameContext";
import { pokemonTable } from "../data/pokemon";
import { encounters as encounterTable } from "../data/encounters";
import { pokemonSpriteUrl } from "../utils/sprites";
import { calcAllStats, perfectIVs } from "../utils/stats";
import { catchProbability } from "../utils/catching";
import { rarityFromRate, RARITY_LABEL, rateForSpecies } from "../utils/rarity";
import { useT } from "../i18n/useT";

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
  const repelOwned = state.inventory.repel ?? 0;
  const honeyOwned = state.inventory.honey ?? 0;

  const repelActive = state.activeEffects.find(
    (e) => e.itemId === "repel" && e.routeKey === routeKey && e.speciesKey === speciesKey
  );
  const honeyActive = state.activeEffects.find(
    (e) => e.itemId === "honey" && e.routeKey === routeKey && e.speciesKey === speciesKey
  );

  // Catch chance with a Poké Ball (the cheapest reference point).
  const catchPct = Math.round(catchProbability(speciesKey, "pokeball") * 100);

  return (
    <div className="wild-detail">
      <button className="wild-detail-close" onClick={onClose}>×</button>
      <div className="wild-detail-head">
        <img
          src={pokemonSpriteUrl(speciesKey, false, false)}
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
        <button
          disabled={!repelOwned}
          className={repelActive ? "active" : ""}
          title={t("Halves this species' encounter weight on this route for 500 battles")}
          onClick={() => dispatch({
            type: "USE_EFFECT_ITEM",
            payload: { itemId: "repel", speciesKey, routeKey },
          })}
        >
          {t("Repel")} ({repelOwned}){repelActive && ` · ${repelActive.battlesRemaining} left`}
        </button>
        <button
          disabled={!honeyOwned}
          className={honeyActive ? "active" : ""}
          title={t("Doubles this species' encounter weight on this route for 500 battles")}
          onClick={() => dispatch({
            type: "USE_EFFECT_ITEM",
            payload: { itemId: "honey", speciesKey, routeKey },
          })}
        >
          {t("Honey")} ({honeyOwned}){honeyActive && ` · ${honeyActive.battlesRemaining} left`}
        </button>
      </div>

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
