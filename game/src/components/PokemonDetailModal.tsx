import { useEffect, useState } from "react";
import type { Pokemon, EvolutionTrigger, PokemonType } from "../types";
import { useGame } from "../state/GameContext";
import { pokemonTable } from "../data/pokemon";
import { moves as movesTable } from "../data/moves";
import { evolutions } from "../data/evolutions";
import { evolutionStones } from "../data/evolutionStones";
import { findNature } from "../data/natures";
import { abilityInfo } from "../data/abilities";
import { itemsCatalog } from "../data/itemsCatalog";
import { itemSpriteUrl } from "../utils/sprites";
import { pokemonSpriteUrl } from "../utils/sprites";
import { expForLevel } from "../utils/stats";
import { useModalEnter } from "../utils/animate";
import { openManageMoves } from "./ManageMovesModal";

// Held item row + assignment popover. Lets the player give/take a held
// item from the open Pokémon. The picker filters the player's inventory
// to held-category items with implemented effects.
function HeldItemRow({ pokemon }: { pokemon: Pokemon }) {
  const { state, dispatch } = useGame();
  const [picking, setPicking] = useState(false);
  const heldId = pokemon.heldItem;
  const heldDef = heldId ? itemsCatalog[heldId] : null;

  // Available held items the player owns.
  const ownedHeld = Object.entries(state.inventory ?? {})
    .filter(([id, qty]) => qty > 0 && itemsCatalog[id]?.category === "held")
    .map(([id]) => itemsCatalog[id])
    .filter((it): it is NonNullable<typeof it> => !!it && it.implemented !== false)
    // Exclude items that are non-equippable utility (Exp Share, Shiny Charm).
    .filter((it) => it.id !== "expShare" && it.id !== "shinycharm");

  const give = (itemId: string) => {
    dispatch({ type: "GIVE_HELD_ITEM", payload: { pokemonId: pokemon.id, itemId } });
    setPicking(false);
  };
  const take = () => {
    dispatch({ type: "TAKE_HELD_ITEM", payload: { pokemonId: pokemon.id } });
  };

  return (
    <div className="detail-held">
      <span className="dim">Held:</span>{" "}
      {heldDef ? (
        <>
          <img
            className="detail-held-icon"
            src={itemSpriteUrl(heldDef.id, heldDef.spriteOverride)}
            alt=""
            width={20}
            height={20}
            style={{ imageRendering: "pixelated" }}
          />
          <span className="detail-held-name" title={heldDef.description}>
            {heldDef.name}
          </span>
          <button className="detail-held-btn" onClick={take}>Take</button>
        </>
      ) : (
        <button className="detail-held-btn" onClick={() => setPicking(!picking)}>
          {picking ? "Cancel" : "Give item…"}
        </button>
      )}
      {picking && (
        <div className="detail-held-picker">
          {ownedHeld.length === 0 ? (
            <span className="dim small">No held items in bag.</span>
          ) : (
            ownedHeld.map((it) => (
              <button
                key={it.id}
                className="detail-held-pick"
                title={it.description}
                onClick={() => give(it.id)}
              >
                <img
                  src={itemSpriteUrl(it.id, it.spriteOverride)}
                  alt=""
                  width={24}
                  height={24}
                  style={{ imageRendering: "pixelated" }}
                />
                <span>{it.name}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// Type colors — kept in sync with MovesPanel so move tiles look uniform.
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
const CATEGORY_ICON: Record<string, string> = {
  physical: "✴",
  special:  "◎",
  status:   "☯",
};

// Tiny event-bus so any component can open the detail modal. View-state
// only, kept out of the global reducer.
type Source = { type: "party"; index: number } | { type: "box"; index: number };
let _selected: Source | null = null;
const _listeners = new Set<(s: Source | null) => void>();

export function openPokemonDetail(s: Source) {
  _selected = s;
  _listeners.forEach((l) => l(s));
}
export function closePokemonDetail() {
  _selected = null;
  _listeners.forEach((l) => l(null));
}
function useSelected(): Source | null {
  const [s, setS] = useState<Source | null>(_selected);
  useEffect(() => {
    _listeners.add(setS);
    return () => { _listeners.delete(setS); };
  }, []);
  return s;
}

export function PokemonDetailModal() {
  const { state, dispatch } = useGame();
  const selected = useSelected();

  // Escape closes the modal — matches the rest of the modal surfaces
  // (PvP hub, replay, etc.). The hook always runs (no early return)
  // so React doesn't error out on the conditional.
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePokemonDetail();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  if (!selected) return null;
  const p: Pokemon | undefined =
    selected.type === "party" ? state.party[selected.index] : state.box[selected.index];
  if (!p) return null;

  const sp = pokemonTable[p.speciesKey];
  const baseExp = expForLevel(p.level, sp.growthRate);
  const nextExp = expForLevel(p.level + 1, sp.growthRate);
  const expIntoLevel = p.totalExp - baseExp;
  const expSpan = Math.max(1, nextExp - baseExp);
  const expPct = Math.max(0, Math.min(100, (expIntoLevel / expSpan) * 100));

  const isActive =
    selected.type === "party" && state.activePlayerPokemonIndex === selected.index;
  // Evolution is the one phase where we lock the modal — the animation is
  // already running and stacking another evolve dispatch breaks the queue.
  // Other phases (battle, healing, idle) all permit menu actions; the
  // reducer bails out of any active battle automatically.
  const blocking = state.phase === "evolution" || state.phase === "starterSelect";
  const inBattle = blocking;

  // All evolution paths for this species, with eligibility flag. We show
  // every possible evolution (greyed out when not eligible) so the player
  // knows what to aim for.
  type EvoOption = { trigger: EvolutionTrigger; reason: string; eligible: boolean };
  const allEvolutions: EvoOption[] = [];
  for (const t of evolutions[p.speciesKey] ?? []) {
    if ("level" in t) {
      const eligible = p.level >= t.level;
      allEvolutions.push({
        trigger: t,
        reason: eligible ? `Level ${t.level} reached` : `Reach Lv ${t.level}`,
        eligible,
      });
    } else if ("item" in t) {
      const owned = state.inventory[t.item] ?? 0;
      const eligible = owned > 0;
      const itemName = evolutionStones[t.item]?.name ?? t.item;
      allEvolutions.push({
        trigger: t,
        reason: eligible ? `Use ${itemName}` : `Needs ${itemName}`,
        eligible,
      });
    } else if ("trade" in t) {
      // Trade-only evolutions — listed for awareness but never
      // eligible from the menu. The actual evolution fires
      // automatically after a successful trade with another player.
      allEvolutions.push({
        trigger: t,
        reason: "Trade with another player",
        eligible: false,
      });
    }
  }
  const isPartySelection = selected.type === "party";

  function evolveTo(trigger: EvolutionTrigger) {
    if (!selected || !isPartySelection) return;
    if ("item" in trigger) {
      dispatch({ type: "CONSUME_ITEM", payload: { itemId: trigger.item, quantity: 1 } });
    }
    dispatch({
      type: "START_EVOLUTION",
      payload: { partyIndex: selected.index, toSpeciesKey: trigger.into },
    });
    closePokemonDetail();
  }

  return (
    <div className="modal-overlay" onClick={closePokemonDetail}>
      <PokemonDetailDialog
        pokemon={p}
        species={sp}
        isActive={isActive}
        inBattle={inBattle}
        isPartySelection={isPartySelection}
        allEvolutions={allEvolutions}
        evolveTo={evolveTo}
        selected={selected}
        partySize={state.party.length}
        party={state.party}
        expIntoLevel={expIntoLevel}
        expSpan={expSpan}
        expPct={expPct}
        onSwitch={() => {
          dispatch({
            type: "SWITCH_PLAYER_POKEMON",
            payload: { partyIndex: selected.index },
          });
          closePokemonDetail();
        }}
        onPartyToBox={() => {
          dispatch({ type: "PARTY_TO_BOX", payload: { partyIndex: selected.index } });
          closePokemonDetail();
        }}
        onBoxToParty={() => {
          dispatch({ type: "BOX_TO_PARTY", payload: { boxIndex: selected.index } });
          closePokemonDetail();
        }}
        onSwapWithParty={(partyIndex: number) => {
          dispatch({
            type: "SWAP_PARTY_BOX",
            payload: { partyIndex, boxIndex: selected.index },
          });
          closePokemonDetail();
        }}
        onRelease={() => {
          if (confirm(`Release ${p.name}?`)) {
            dispatch({
              type: "RELEASE_POKEMON",
              payload: { source: selected.type, index: selected.index },
            });
            closePokemonDetail();
          }
        }}
      />
    </div>
  );
}

// Inner dialog renders inside the .g-modal shell. Split from the parent
// so `useModalEnter` only runs when the dialog is actually mounted.
function PokemonDetailDialog({
  pokemon: p,
  species: sp,
  isActive,
  inBattle,
  isPartySelection,
  allEvolutions,
  evolveTo,
  selected,
  partySize,
  party,
  expIntoLevel,
  expSpan,
  expPct,
  onSwitch,
  onPartyToBox,
  onBoxToParty,
  onSwapWithParty,
  onRelease,
}: any) {
  const dialogRef = useModalEnter(".g-profile-hero, .g-card");
  // Box → Party swap picker. Opens an inline list of party slots so the
  // player can pick which mon to swap out without leaving the detail
  // sheet. Especially useful on mobile where drag-and-drop swaps are
  // awkward and PARTY-IS-FULL would otherwise block "→ Party" outright.
  const [swapPicking, setSwapPicking] = useState(false);
  return (
    <div
      ref={dialogRef}
      className="g-modal pokemon-detail-v2"
      onClick={(e) => e.stopPropagation()}
      role="dialog"
      aria-label={p.name}
    >
      <header className="g-modal-head">
        <h2><NicknameField pokemon={p} /></h2>
        <button className="g-modal-close" onClick={closePokemonDetail} aria-label="Close">×</button>
      </header>

      <div className="g-modal-body">
        <section className="g-profile-hero">
          <img
            className="g-pokemon-sprite-hero"
            src={pokemonSpriteUrl(p.speciesKey, false, p.isShiny)}
            alt={p.name}
            width={64}
            height={64}
            style={{ imageRendering: "pixelated" }}
          />
          <div className="g-profile-info">
            <div className="g-profile-name">
              {p.name}{p.isShiny ? " ✨" : ""}
              <span className="g-profile-species">{sp.name}</span>
            </div>
            <div className="dex-species-types">
              {sp.types.map((t: PokemonType) => (
                <span key={t} className="dex-species-type" style={{ background: TYPE_COLOR[t] }}>{t}</span>
              ))}
            </div>
          </div>
          <div className="g-profile-stats">
            <div className="g-stat-pill"><strong>{p.level}</strong><span>Level</span></div>
            <div className="g-stat-pill"><strong>{p.currentHp}/{p.maxHp}</strong><span>HP</span></div>
            <div className="g-stat-pill"><strong>{Math.round(expPct)}%</strong><span>EXP</span></div>
          </div>
        </section>

        <section className="g-card g-card-full pokemon-meta-card">
          <div className="pokemon-meta-row">
            {p.nature && (
              <div className="pokemon-meta-item">
                <span className="dim">Nature</span>
                <strong>{p.nature}</strong>
              </div>
            )}
            {p.ability && abilityInfo[p.ability] && (
              <div className="pokemon-meta-item" title={abilityInfo[p.ability].description}>
                <span className="dim">Ability</span>
                <strong>{abilityInfo[p.ability].name}</strong>
              </div>
            )}
            <div className="pokemon-meta-item pokemon-meta-held">
              <HeldItemRow pokemon={p} />
            </div>
          </div>
          <div className="pokemon-exp-row">
            <span className="dim small">EXP to next</span>
            <div className="exp-bar">
              <div className="exp-fill" style={{ width: `${expPct}%` }} />
            </div>
            <small className="dim">{expIntoLevel} / {expSpan}</small>
          </div>
        </section>

        <div className="g-grid">
          <section className="g-card">
            <h3>Stats</h3>
            <ul className="detail-stats">
              <StatRow label="HP" value={p.maxHp} pokemon={p} stat="hp" />
              <StatRow label="Attack" value={p.attack} pokemon={p} stat="attack" />
              <StatRow label="Defense" value={p.defense} pokemon={p} stat="defense" />
              <StatRow label="Sp. Atk" value={p.spAttack} pokemon={p} stat="spAttack" />
              <StatRow label="Sp. Def" value={p.spDefense} pokemon={p} stat="spDefense" />
              <StatRow label="Speed" value={p.speed} pokemon={p} stat="speed" />
            </ul>
          </section>

          <section className="g-card">
            <h3>EV training</h3>
            <EvRadar evs={p.evs ?? { hp: 0, attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0 }} ivs={p.ivs} />
          </section>
        </div>

        <section className="g-card g-card-full">
          <div className="detail-moves-header">
            <h3>Moves</h3>
            {selected.type === "party" && !inBattle && (
              <button
                className="g-btn-ghost g-btn-small"
                onClick={() => {
                  closePokemonDetail();
                  openManageMoves({ type: "party", index: selected.index });
                }}
                title="Open the move manager for this Pokémon"
              >
                Manage moves
              </button>
            )}
          </div>
          <ul className="detail-moves">
            {p.moves.map((m: any) => {
              const def = movesTable[m.id];
              const color = def ? TYPE_COLOR[def.type] : "#666";
              const icon = def ? CATEGORY_ICON[def.category] ?? "✴" : "✴";
              return (
                <li key={m.id} style={{ background: color }}>
                  <strong>
                    <span style={{ marginRight: 4, opacity: 0.85 }}>{icon}</span>
                    {def?.name ?? m.id}
                  </strong>
                  <small>
                    Pwr {def?.power || "—"} · Acc {def?.accuracy}% · {def?.type ?? "—"}
                  </small>
                </li>
              );
            })}
          </ul>
        </section>

        {allEvolutions.length > 0 && (
          <section className="g-card g-card-full">
            <h3>Evolution</h3>
            <ul className="detail-evos">
              {allEvolutions.map((e: any) => {
                const target = pokemonTable[e.trigger.into];
                return (
                  <li key={e.trigger.into} className={e.eligible ? "" : "evo-locked"}>
                    <img
                      src={pokemonSpriteUrl(e.trigger.into, false, p.isShiny)}
                      alt={target?.name ?? e.trigger.into}
                      width={40}
                      height={40}
                      style={{
                        imageRendering: "pixelated",
                        filter: e.eligible ? "none" : "grayscale(1) brightness(0.6)",
                      }}
                    />
                    <div>
                      <strong>→ {target?.name ?? e.trigger.into}</strong>
                      <small className="dim">{e.reason}</small>
                    </div>
                    <button
                      disabled={!isPartySelection || inBattle || !e.eligible}
                      title={
                        !e.eligible ? e.reason :
                        !isPartySelection ? "Move to party first" :
                        undefined
                      }
                      onClick={() => e.eligible && evolveTo(e.trigger)}
                    >
                      Evolve
                    </button>
                  </li>
                );
              })}
            </ul>
            {!isPartySelection && allEvolutions.some((e: any) => e.eligible) && (
              <p className="g-help">Move this Pokémon to your party to evolve it.</p>
            )}
          </section>
        )}
      </div>

      {swapPicking && (
        <div className="swap-picker-overlay">
          <div className="swap-picker">
            <header className="swap-picker-head">
              <strong>Swap {p.name} with…</strong>
              <button className="g-modal-close" onClick={() => setSwapPicking(false)} aria-label="Cancel">×</button>
            </header>
            <ul className="swap-picker-list">
              {(party as Pokemon[]).map((m, i) => (
                <li key={m.id}>
                  <button
                    type="button"
                    className="swap-picker-row"
                    onClick={() => { setSwapPicking(false); onSwapWithParty(i); }}
                  >
                    <img
                      src={pokemonSpriteUrl(m.speciesKey, false, m.isShiny)}
                      alt=""
                      width={32}
                      height={32}
                      style={{ imageRendering: "pixelated" }}
                    />
                    <div className="swap-picker-meta">
                      <strong>{m.nickname || m.name}</strong>
                      <small className="dim">Lv {m.level} · {m.currentHp}/{m.maxHp} HP</small>
                    </div>
                    <span className="swap-picker-arrow">⇄</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <footer className="g-modal-foot">
        <button className="g-btn-danger-ghost" onClick={onRelease}>Release</button>
        <span style={{ flex: 1 }} />
        {selected.type === "party" && !isActive && p.currentHp > 0 && !inBattle && (
          <button className="g-btn-ghost g-btn-small" onClick={onSwitch}>Make active</button>
        )}
        {selected.type === "party" && partySize > 1 && !inBattle && (
          <button className="g-btn-ghost g-btn-small" onClick={onPartyToBox}>→ Box</button>
        )}
        {selected.type === "box" && partySize < 6 && !inBattle && (
          <button className="g-btn-ghost g-btn-small" onClick={onBoxToParty}>→ Party</button>
        )}
        {selected.type === "box" && partySize > 0 && !inBattle && (
          <button className="g-btn-ghost g-btn-small" onClick={() => setSwapPicking(true)}>
            Swap with party
          </button>
        )}
        <button className="g-btn-primary" onClick={closePokemonDetail}>Close</button>
      </footer>
    </div>
  );
}

function statShort(k: keyof import("../types").Stats): string {
  return ({
    hp: "HP", attack: "Atk", defense: "Def",
    spAttack: "SpA", spDefense: "SpD", speed: "Spd",
  } as const)[k];
}

// One row in the Stats list. Shows a +/- arrow when the Pokemon's nature
// boosts or hinders this stat.
function StatRow({
  label, value, pokemon, stat,
}: {
  label: string;
  value: number;
  pokemon: Pokemon;
  stat: keyof import("../types").Stats;
}) {
  const nature = pokemon.nature ? findNature(pokemon.nature) : undefined;
  const boost =
    nature && nature.plus !== nature.minus
      ? nature.plus === stat ? "up" : nature.minus === stat ? "down" : null
      : null;
  return (
    <li className={boost ? `nature-${boost}` : ""}>
      <span>
        {label}
        {boost === "up" && <span className="nature-arrow up"> ▲</span>}
        {boost === "down" && <span className="nature-arrow down"> ▼</span>}
      </span>
      <span>{value}</span>
    </li>
  );
}

// Inline rename input. Submits on blur or Enter.
function NicknameField({ pokemon }: { pokemon: Pokemon }) {
  const { dispatch } = useGame();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(pokemon.nickname ?? "");

  useEffect(() => {
    setDraft(pokemon.nickname ?? "");
  }, [pokemon.id, pokemon.nickname]);

  function commit() {
    dispatch({
      type: "SET_NICKNAME",
      payload: { pokemonId: pokemon.id, nickname: draft },
    });
    setEditing(false);
  }

  if (editing) {
    return (
      <h2>
        <input
          autoFocus
          className="nickname-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
          placeholder={pokemon.name}
          maxLength={12}
        />
        <small> Lv. {pokemon.level}</small>
      </h2>
    );
  }
  return (
    <h2 onClick={() => setEditing(true)} title="Click to rename" style={{ cursor: "text" }}>
      {pokemon.nickname || pokemon.name}{pokemon.isShiny ? " ✨" : ""}
      <small> Lv. {pokemon.level}</small>
    </h2>
  );
}

// ── EV / IV radar ──────────────────────────────────────────────────
// Hexagonal stat radar: outer hexagon = max EVs (252), inner filled
// polygon = current EVs, with IV pips alongside each stat label.
// Rendered as inline SVG (~200 lines of pure geometry — no chart lib
// needed, dashboard-style). EV cap is enforced server-side; this just
// visualises the current state.
function EvRadar({
  evs,
  ivs,
}: {
  evs: { hp: number; attack: number; defense: number; spAttack: number; spDefense: number; speed: number };
  ivs: { hp: number; attack: number; defense: number; spAttack: number; spDefense: number; speed: number };
}) {
  // Six-stat vertices. Order matches the canonical Showdown radar:
  // HP (top), Atk, Def, SpA, SpD, Spe. We rotate so HP is at the top.
  const STAT_LABELS: Array<{ key: keyof typeof evs; short: string; full: string }> = [
    { key: "hp",        short: "HP",  full: "HP" },
    { key: "attack",    short: "Atk", full: "Attack" },
    { key: "defense",   short: "Def", full: "Defense" },
    { key: "spAttack",  short: "SpA", full: "Sp. Atk" },
    { key: "spDefense", short: "SpD", full: "Sp. Def" },
    { key: "speed",     short: "Spe", full: "Speed" },
  ];
  const N = STAT_LABELS.length;
  const SIZE = 220;
  const CX = SIZE / 2;
  const CY = SIZE / 2;
  const R = SIZE / 2 - 28;  // leave margin for outer labels
  const MAX_EV = 252;

  // Vertex angle for each stat. Start at -90° (top) and go clockwise.
  const angle = (i: number) => (-Math.PI / 2) + (i * 2 * Math.PI) / N;
  const vertex = (i: number, r: number) => ({
    x: CX + Math.cos(angle(i)) * r,
    y: CY + Math.sin(angle(i)) * r,
  });

  // Background hex grid: 25%, 50%, 75%, 100% of full radius.
  const gridLevels = [0.25, 0.5, 0.75, 1.0];

  // Filled polygon for current EV values.
  const evPoly = STAT_LABELS.map((s, i) => {
    const ratio = Math.min(1, (evs[s.key] ?? 0) / MAX_EV);
    const v = vertex(i, R * ratio);
    return `${v.x.toFixed(1)},${v.y.toFixed(1)}`;
  }).join(" ");

  // Total EV count — capped at 510 in-game.
  const evTotal = STAT_LABELS.reduce((sum, s) => sum + (evs[s.key] ?? 0), 0);
  const ivTotal = STAT_LABELS.reduce((sum, s) => sum + (ivs[s.key] ?? 0), 0);

  // Label positions sit slightly outside each vertex so they don't
  // clip the polygon. Anchor based on whether the vertex is above /
  // below / on the centre horizontal so labels read correctly.
  const labelPos = (i: number): { x: number; y: number; anchor: "middle" | "start" | "end" } => {
    const v = vertex(i, R + 14);
    const a = angle(i);
    const cosA = Math.cos(a);
    const anchor: "middle" | "start" | "end" =
      Math.abs(cosA) < 0.2 ? "middle" : cosA > 0 ? "start" : "end";
    return { x: v.x, y: v.y, anchor };
  };

  return (
    <div className="ev-radar-wrap">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="ev-radar" aria-label="EV radar">
        {/* Background hex grid rings */}
        {gridLevels.map((lvl, ringIdx) => {
          const points = STAT_LABELS.map((_, i) => {
            const v = vertex(i, R * lvl);
            return `${v.x.toFixed(1)},${v.y.toFixed(1)}`;
          }).join(" ");
          return (
            <polygon
              key={ringIdx}
              points={points}
              fill="none"
              stroke="rgba(255,255,255,0.08)"
              strokeWidth={1}
            />
          );
        })}

        {/* Spokes from centre to each vertex */}
        {STAT_LABELS.map((_, i) => {
          const v = vertex(i, R);
          return (
            <line
              key={i}
              x1={CX} y1={CY}
              x2={v.x} y2={v.y}
              stroke="rgba(255,255,255,0.06)"
              strokeWidth={1}
            />
          );
        })}

        {/* Filled EV polygon */}
        <polygon
          points={evPoly}
          fill="rgba(96, 165, 250, 0.30)"
          stroke="#60a5fa"
          strokeWidth={1.5}
          strokeLinejoin="round"
        />

        {/* EV vertex dots */}
        {STAT_LABELS.map((s, i) => {
          const ratio = Math.min(1, (evs[s.key] ?? 0) / MAX_EV);
          const v = vertex(i, R * ratio);
          return <circle key={s.key} cx={v.x} cy={v.y} r={2.5} fill="#60a5fa" />;
        })}

        {/* Stat labels */}
        {STAT_LABELS.map((s, i) => {
          const pos = labelPos(i);
          return (
            <g key={s.key}>
              <text
                x={pos.x}
                y={pos.y - 2}
                textAnchor={pos.anchor}
                className="ev-radar-label"
              >
                {s.short}
              </text>
              <text
                x={pos.x}
                y={pos.y + 9}
                textAnchor={pos.anchor}
                className="ev-radar-value"
              >
                {evs[s.key] ?? 0}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="ev-radar-totals">
        <div>
          <span>EV total</span>
          <strong>{evTotal} <span className="dim">/ 510</span></strong>
        </div>
        <div>
          <span>IV total</span>
          <strong>{ivTotal} <span className="dim">/ 186</span></strong>
        </div>
      </div>

      <ul className="ev-radar-iv-list">
        {STAT_LABELS.map((s) => (
          <li key={s.key}>
            <span className="ev-radar-iv-label">{s.short}</span>
            <span className="ev-radar-iv-pips">
              {Array.from({ length: 31 }, (_, i) => (
                <span
                  key={i}
                  className={`ev-radar-iv-pip ${i < (ivs[s.key] ?? 0) ? "filled" : ""}`}
                />
              ))}
            </span>
            <span className="ev-radar-iv-num">{ivs[s.key] ?? 0}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
