import { useGame } from "../state/GameContext";
import { pokemonTable } from "../data/pokemon";
import { PokemonSprite } from "./Sprite";
import { encounters } from "../data/encounters";
import { routes } from "../data/routes";
import { evolutions } from "../data/evolutions";
import { raidLegendaries, MYTHICAL_MIN_LEVEL } from "../data/raidLegendaries";
import { STARTER_KEYS } from "../state/initialState";
import { abilitiesFor, abilityInfo } from "../data/abilities";
import { ownsSpecies } from "../utils/pokemon";
import { useModalEnter } from "../utils/animate";
import { useT } from "../i18n/useT";
import type { PokemonType, EvolutionTrigger } from "../types";

const TYPE_COLOR: Record<PokemonType, string> = {
  Normal:   "#a8a878",
  Fire:     "#f08030",
  Water:    "#6890f0",
  Electric: "#f8d030",
  Grass:    "#78c850",
  Ice:      "#98d8d8",
  Fighting: "#c03028",
  Poison:   "#a040a0",
  Ground:   "#e0c068",
  Flying:   "#a890f0",
  Psychic:  "#f85888",
  Bug:      "#a8b820",
  Rock:     "#b8a038",
  Ghost:    "#705898",
  Dragon:   "#7038f8",
  Dark:     "#705848",
  Steel:    "#b8b8d0",
  Fairy:    "#ee99ac",
};

interface Props {
  speciesKey: string;
  onClose: () => void;
}

// Pokédex species overview — opens when the player clicks a seen/caught
// dex cell. Shows the sprite, types, base stats, and where this species
// can be encountered. Read-only (separate from PokemonDetailModal which
// is for individual party/box members with their own stats and moves).
export function DexSpeciesModal({ speciesKey, onClose }: Props) {
  const { state } = useGame();
  const sp = pokemonTable[speciesKey];
  const dialogRef = useModalEnter(".g-profile-hero, .g-card");
  const t = useT();
  if (!sp) return null;

  const caught = state.pokedexCaught.includes(speciesKey);
  const seen = state.pokedexSeen.includes(speciesKey);
  const shiny = state.shinyCaught.includes(speciesKey);
  // Two different facts, and the header used to state only the first: the
  // dex remembers every species you have ever caught, whether or not one is
  // still in your party or PC.
  const owned = ownsSpecies(state.party, state.box, speciesKey);

  // Find every route that lists this species in its encounter table.
  const foundIn = Object.entries(encounters).flatMap(([routeKey, def]) => {
    const entry = def.encounters.find((e) => e.speciesKey === speciesKey);
    if (!entry) return [];
    const totalWeight = def.encounters.reduce((s, e) => s + e.weight, 0);
    const ratePct = totalWeight > 0 ? (entry.weight / totalWeight) * 100 : 0;
    return [{
      routeKey,
      name: routes[routeKey]?.name ?? routeKey,
      ratePct,
      minLevel: entry.minLevel,
      maxLevel: entry.maxLevel,
    }];
  });

  // Reverse-lookup: which species evolves INTO this one, and how.
  const evolvesFrom: { fromKey: string; fromName: string; trigger: EvolutionTrigger }[] = [];
  for (const [fromKey, triggers] of Object.entries(evolutions)) {
    for (const trig of triggers) {
      if (trig.into === speciesKey) {
        evolvesFrom.push({
          fromKey,
          fromName: pokemonTable[fromKey]?.name ?? fromKey,
          trigger: trig,
        });
      }
    }
  }

  const isStarter = STARTER_KEYS.includes(speciesKey);
  const raidEntry = raidLegendaries.find((l) => l.speciesKey === speciesKey);

  const hasAnySource =
    foundIn.length > 0 || evolvesFrom.length > 0 || isStarter || !!raidEntry;

  const ab = abilitiesFor(speciesKey);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="g-modal dex-species-modal-v2"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={sp.name}
      >
        <header className="g-modal-head">
          <h2>
            <span className="dex-species-id">#{String(sp.id).padStart(3, "0")}</span>
            <span style={{ marginLeft: 8 }}>{sp.name}</span>
          </h2>
          <button className="g-modal-close" onClick={onClose} aria-label={t("Close")}>×</button>
        </header>

        <div className="g-modal-body">
          <section className="g-profile-hero">
            <PokemonSprite
              className="g-pokemon-sprite-hero"
              speciesKey={speciesKey}
              isShiny={shiny && caught}
              alt={sp.name}
              width={64}
              height={64}
              style={{ imageRendering: "pixelated" }}
            />
            <div className="g-profile-info">
              <div className="g-profile-name">{sp.name}</div>
              <div className="dex-species-types">
                {sp.types.map((t) => (
                  <span
                    key={t}
                    className="dex-species-type"
                    style={{ background: TYPE_COLOR[t] }}
                  >
                    {t}
                  </span>
                ))}
                <span className="dex-species-status-inline">
                  {owned && (
                    <span className="dex-status-tag caught" title={t("You have at least one in your party or PC")}>
                      {t("✓ In your collection")}
                    </span>
                  )}
                  {caught && !owned && (
                    <span
                      className="dex-status-tag registered"
                      title={t("Caught before, so it stays in the Pokédex — but you don't have one right now")}
                    >
                      {t("✓ Registered · none owned")}
                    </span>
                  )}
                  {!caught && seen && <span className="dex-status-tag seen">{t("Seen — not caught yet")}</span>}
                  {shiny && <span className="dex-status-tag shiny">{t("✨ Shiny")}</span>}
                </span>
              </div>
            </div>
          </section>

          <div className="g-grid">
            <section className="g-card">
              <h3>{t("Base Stats")}</h3>
              <ul className="dex-species-stats">
                {(["hp","attack","defense","spAttack","spDefense","speed"] as const).map((stat) => {
                  const val = sp.baseStats[stat];
                  const pct = Math.min(100, (val / 200) * 100);
                  return (
                    <li key={stat}>
                      <span className="dex-stat-label">{labelFor(stat)}</span>
                      <span className="dex-stat-value">{val}</span>
                      <div className="dex-stat-bar">
                        <div className="dex-stat-fill" style={{ width: `${pct}%` }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>

            {ab && (
              <section className="g-card">
                <h3>{t("Abilities")}</h3>
                <ul className="dex-species-abilities">
                  {ab.primary.map((id) => {
                    const info = abilityInfo[id];
                    if (!info) return null;
                    return (
                      <li key={id}>
                        <span className="dex-ability-name">{info.name}</span>
                        <span className="dim dex-ability-desc">{info.description}</span>
                      </li>
                    );
                  })}
                  {ab.hidden && abilityInfo[ab.hidden] && (
                    <li className="dex-ability-hidden">
                      <span className="dex-ability-name">
                        {abilityInfo[ab.hidden].name}
                        <span className="dim small">{t(" · Hidden")}</span>
                      </span>
                      <span className="dim dex-ability-desc">{abilityInfo[ab.hidden].description}</span>
                    </li>
                  )}
                </ul>
              </section>
            )}
          </div>

          <section className="g-card g-card-full">
            <h3>{t("Where to Find")}</h3>
            {!hasAnySource && (
              <p className="g-help">{t("No known source.")}</p>
            )}

            {foundIn.length > 0 && (
              <ul className="dex-species-routes">
                {foundIn.map((r) => {
                  const lvl = r.minLevel === r.maxLevel
                    ? `Lv ${r.minLevel}`
                    : `Lv ${r.minLevel}-${r.maxLevel}`;
                  return (
                    <li key={r.routeKey}>
                      <span>{r.name} <span className="dim">({lvl})</span></span>
                      <span className="dim">{r.ratePct.toFixed(1)}%</span>
                    </li>
                  );
                })}
              </ul>
            )}

            {(isStarter || evolvesFrom.length > 0 || raidEntry) && (
              <ul className="dex-species-routes" style={{ marginTop: foundIn.length > 0 ? 6 : 0 }}>
                {isStarter && (
                  <li>
                    <span>{t("Starter")}</span>
                    <span className="dim">{t("Prof. Oak's gift")}</span>
                  </li>
                )}
                {evolvesFrom.map((ev) => (
                  <li key={ev.fromKey}>
                    <span>{t("Evolve ")}{ev.fromName}</span>
                    <span className="dim">{evolutionLabel(ev.trigger)}</span>
                  </li>
                ))}
                {raidEntry && (
                  <li>
                    <span>{t("Raid")}</span>
                    <span className="dim">
                      {raidEntry.mythical ? `Lv ${MYTHICAL_MIN_LEVEL}+ raid` : `Lv ${raidEntry.level}+ raid`}
                    </span>
                  </li>
                )}
              </ul>
            )}
          </section>
        </div>

        <footer className="g-modal-foot">
          <button className="g-btn-primary" onClick={onClose}>{t("Close")}</button>
        </footer>
      </div>
    </div>
  );
}

function evolutionLabel(trig: EvolutionTrigger): string {
  if ("level" in trig) return `Lv ${trig.level}`;
  // Trade-checks before pure item because trade+item has both.
  if ("trade" in trig) {
    return "item" in trig ? `Trade w/ ${prettyItem((trig as any).item)}` : "Trade";
  }
  if ("item" in trig) return prettyItem(trig.item);
  return "—";
}

function prettyItem(item: string): string {
  switch (item) {
    case "firestone":    return "Fire Stone";
    case "waterstone":   return "Water Stone";
    case "thunderstone": return "Thunder Stone";
    case "leafstone":    return "Leaf Stone";
    case "moonstone":    return "Moon Stone";
    case "sunstone":     return "Sun Stone";
    default:
      return item.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
  }
}

function labelFor(stat: string): string {
  switch (stat) {
    case "hp": return "HP";
    case "attack": return "Atk";
    case "defense": return "Def";
    case "spAttack": return "Sp.Atk";
    case "spDefense": return "Sp.Def";
    case "speed": return "Speed";
    default: return stat;
  }
}
