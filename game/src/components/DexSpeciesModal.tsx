import { useGame } from "../state/GameContext";
import { closeHub } from "./HubModal";
import { pokemonTable } from "../data/pokemon";
import { PokemonSprite } from "./Sprite";
import { encounters } from "../data/encounters";
import { routes } from "../data/routes";
import { evolutions } from "../data/evolutions";
import { raidTiersOrdered, isTierUnlocked } from "../data/raidLegendaries";
import { STARTER_KEYS } from "../state/initialState";
import { abilitiesFor, abilityInfo } from "../data/abilities";
import { ownsSpecies } from "../utils/pokemon";
import { hasShinyCharm } from "../utils/shinyCharm";
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

// Pokédex species overview — opens when the player clicks any dex cell.
// Read-only (separate from PokemonDetailModal which is for individual
// party/box members with their own stats and moves).
//
// This is the shiny-hunting sheet: the dex opens it to answer "where do I
// get one", so Where to Find comes FIRST — routes sorted by encounter rate
// with the best one flagged, raid tiers named with their gates, and the
// real shiny odds up top. Stats and abilities are reference material and
// sit below.
//
// UNSEEN species open it too, redacted to location leads only (route
// names, evolution sources, raid tiers — no stats, abilities, rates or
// shiny status). Nothing here leaks that the game didn't already show:
// search matches unseen species by name, and route cards silhouette their
// unseen spawns, so the world is already an index of where unknown things
// live. What a disabled cell actually hid was the dex's core job — what's
// left, and where to look.
export function DexSpeciesModal({ speciesKey, onClose }: Props) {
  const { state, dispatch } = useGame();
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
  const revealed = caught || seen;

  // Find every route that lists this species in its encounter table,
  // best rate first — the shiny roll is identical everywhere (see below),
  // so the highest spawn rate IS the best shiny route.
  const foundIn = Object.entries(encounters)
    .flatMap(([routeKey, def]) => {
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
    })
    .sort((a, b) => b.ratePct - a.ratePct);

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
  // Every tier whose pool holds this species, not the old flattened one-line
  // "Lv 65+ raid" — the tier name, its starting level and its unlock gate
  // are what a player actually needs to go start the right raid.
  const raidTierHits = raidTiersOrdered.filter((tier) => speciesKey in tier.pool);

  const hasAnySource =
    foundIn.length > 0 || evolvesFrom.length > 0 || isStarter || raidTierHits.length > 0;

  const ab = abilitiesFor(speciesKey);
  // Real numbers from rollShiny (utils/pokemon.ts): 1/8192 base, 1/4096
  // holding the Shiny Charm. Per encounter, independent of route.
  const charm = hasShinyCharm(state);

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
              alt={revealed ? sp.name : "???"}
              width={64}
              height={64}
              style={{
                imageRendering: "pixelated",
                // Same silhouette treatment the grid and route cards use.
                filter: revealed ? undefined : "brightness(0)",
              }}
            />
            <div className="g-profile-info">
              <div className="g-profile-name">{sp.name}</div>
              <div className="dex-species-types">
                {revealed && sp.types.map((ty) => (
                  <span
                    key={ty}
                    className="dex-species-type"
                    style={{ background: TYPE_COLOR[ty] }}
                  >
                    {ty}
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
                  {!revealed && <span className="dex-status-tag seen">{t("Not seen yet")}</span>}
                  {shiny && <span className="dex-status-tag shiny">{t("✨ Shiny")}</span>}
                </span>
              </div>
            </div>
          </section>

          {/* WHERE TO FIND — first, not last. This card used to open 1–2
              screens down, below stats nobody asked for; it is the question
              the dex exists to answer. */}
          <section className="g-card g-card-full">
            <h3>{t("Where to Find")}</h3>

            {revealed && (
              <p className="dex-shiny-odds">
                <span className="dex-shiny-odds-rate">
                  {charm
                    ? t("✨ Shiny odds: 1 in 4,096 per encounter")
                    : t("✨ Shiny odds: 1 in 8,192 per encounter")}
                </span>
                <span className="dim">
                  {charm
                    ? t(" — Shiny Charm active")
                    : t(" — complete the Pokédex to earn the Shiny Charm and double them")}
                </span>
              </p>
            )}
            {revealed && foundIn.length > 0 && (
              <p className="g-help dex-shiny-note">
                {t("The roll is the same on every route, so your best shiny route is simply wherever it spawns most often.")}
              </p>
            )}
            {!revealed && hasAnySource && (
              <p className="g-help">
                {t("Location leads only — see one in the wild to unlock stats, abilities and spawn rates.")}
              </p>
            )}
            {!hasAnySource && (
              <p className="g-help">{t("No known source.")}</p>
            )}

            {foundIn.length > 0 && (
              <ul className="dex-species-routes">
                {foundIn.map((r, i) => {
                  const unlocked = state.unlockedLocations.includes(r.routeKey);
                  const here = state.currentLocation === r.routeKey;
                  const lvl = r.minLevel === r.maxLevel
                    ? `Lv ${r.minLevel}`
                    : `Lv ${r.minLevel}-${r.maxLevel}`;
                  const best = revealed && i === 0 && foundIn.length > 1;
                  return (
                    <li key={r.routeKey} className={`${unlocked ? "" : "locked"} ${best ? "best" : ""}`.trim()}>
                      <span>
                        {r.name}
                        {revealed && <span className="dim"> ({lvl})</span>}
                        {here && (
                          <span className="dex-route-here" title={t("You are here")}> 📍</span>
                        )}
                        {best && <span className="dex-route-best">{t("best")}</span>}
                      </span>
                      <span className="dim">
                        {revealed && `${r.ratePct.toFixed(1)}%`}
                        {!unlocked && `${revealed ? " · " : ""}${t("not unlocked yet")}`}
                      </span>
                      {/* Go. This list tells a player exactly where a Pokemon
                          lives and then made them close the dialog, open the
                          Map, and find the route again by name — the answer
                          was on screen and not actionable.
                          Locked routes keep their row and say why, rather
                          than offering a button that refuses. */}
                      {unlocked && (
                        <button
                          type="button"
                          className="dex-route-go"
                          disabled={here}
                          onClick={() => {
                            dispatch({ type: "TRAVEL", payload: { locationId: r.routeKey } });
                            // Both dialogs are in the way of the thing you
                            // just asked for. The species sheet can sit above
                            // the hub (it opens from the Dex), so closing one
                            // would leave the other.
                            onClose();
                            closeHub();
                          }}
                          title={here ? t("You are here") : `${t("Travel to")} ${r.name}`}
                        >
                          {here ? t("Here") : t("Go")}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {(isStarter || evolvesFrom.length > 0 || raidTierHits.length > 0) && (
              <ul className="dex-species-routes" style={{ marginTop: foundIn.length > 0 ? 6 : 0 }}>
                {isStarter && (
                  <li>
                    <span>{t("Starter")}</span>
                    <span className="dim">{t("Prof. Oak's gift")}</span>
                  </li>
                )}
                {/* Evolution sources stay visible for unseen species too —
                    for evolved forms they are usually the ONLY source, and
                    hiding them would turn those entries back into the dead
                    end this reveal exists to fix. */}
                {evolvesFrom.map((ev) => (
                  <li key={ev.fromKey}>
                    <span>{t("Evolve ")}{ev.fromName}</span>
                    <span className="dim">{evolutionLabel(ev.trigger)}</span>
                  </li>
                ))}
                {raidTierHits.map((tier) => {
                  const unlocked = isTierUnlocked(tier, state);
                  const bits = [`Lv ${tier.startLevel}+`];
                  if (tier.unlockBadges > 0) bits.push(`${tier.unlockBadges} ${t("badges")}`);
                  if (tier.unlockChampionDefeated) bits.push(t("Champion first"));
                  if (!unlocked) bits.push(t("locked"));
                  return (
                    <li key={tier.id} className={unlocked ? "" : "locked"}>
                      <span>{t("Raids")} — {tier.name}</span>
                      <span className="dim">{bits.join(" · ")}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {revealed && (
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
          )}
        </div>
        {/* No footer: the Close button there duplicated the header × and
            cost 54px of a phone-height modal. */}
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
