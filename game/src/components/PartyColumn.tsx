import { useGame } from "../state/GameContext";
import { pokemonSpriteUrl, itemSpriteUrl } from "../utils/sprites";
import { pokemonTable } from "../data/pokemon";
import { itemsCatalog } from "../data/itemsCatalog";
import { itemSpriteSlug } from "../utils/items";
import { expForLevel } from "../utils/stats";
import { openPokemonDetail } from "./PokemonDetailModal";
import { ContextPanel } from "./ContextPanel";
import { animatePop } from "../utils/animate";
import { openContextMenu } from "./ContextMenu";
import { evolutions } from "../data/evolutions";
import { useDragAndDrop } from "../hooks/useDrag";
import type { Pokemon, GameState, StatusCondition } from "../types";

// Returns true when this party member can evolve right now — either
// it has reached the level threshold, or it has a stone-evolution
// trigger and the player owns the stone in inventory. Trade-only
// evolutions are excluded (those fire from the trade flow). Used to
// paint a glow on ready party rows so the player knows to act.
function canEvolveNow(p: Pokemon, inventory: GameState["inventory"]): boolean {
  const triggers = evolutions[p.speciesKey] ?? [];
  for (const t of triggers) {
    if ("level" in t && p.level >= t.level) return true;
    if ("item" in t && (inventory[t.item] ?? 0) > 0) return true;
  }
  return false;
}

// 3-letter abbreviations for the major status conditions, used by
// the party-row badge. Mirrors the in-battle HP-card abbreviations
// for consistency (PAR/SLP/BRN/FRZ/PSN/TOX) so a player learns one
// vocabulary across both surfaces.
const STATUS_ABBREV: Record<StatusCondition, string> = {
  paralyzed: "PAR",
  asleep: "SLP",
  burned: "BRN",
  frozen: "FRZ",
  poisoned: "PSN",
  badlyPoisoned: "TOX",
};
function statusBadgeClass(s: StatusCondition): string {
  // Class names match the in-battle HP-card status-badge styles in
  // app.css so we don't duplicate colour rules — see hp-status-badge
  // *.par/*.slp/*.brn/etc.
  switch (s) {
    case "paralyzed":     return "par";
    case "asleep":        return "slp";
    case "burned":        return "brn";
    case "frozen":        return "frz";
    case "poisoned":      return "psn";
    case "badlyPoisoned": return "tox";
  }
}

// Left column: Party list on top, footer with Settings + Heal at the
// bottom. Drag a party row onto another to swap slots; drag a box
// Pokémon onto a party slot to move/swap. The drag system is
// pointer-events-based (not HTML5 DnD) so it works on touch.
//
// Two exports — `PartyColumn` is the legacy desktop column (list +
// ContextPanel), retained for the mobile shell. `PartyList` is just
// the list section, used by the new desktop LeftNav as its "Party"
// tab pane (ContextPanel is its own tab there).
export function PartyColumn() {
  return (
    <div className="party-column">
      <PartyList />
      <ContextPanel />
    </div>
  );
}

export function PartyList() {
  const { state } = useGame();
  return (
    <section className="ctx-section party-card">
      <h4>Party</h4>
      <ul className="party-list">
        {state.party.map((p, idx) => (
          <PartyRow key={p.id} pokemon={p} index={idx} />
        ))}
      </ul>
    </section>
  );
}

function PartyRow({ pokemon: p, index: idx }: { pokemon: Pokemon; index: number }) {
  const { state, dispatch } = useGame();
  const sp = pokemonTable[p.speciesKey];
  const hpPct = (p.currentHp / p.maxHp) * 100;
  const hpClass = hpPct > 50 ? "ok" : hpPct > 20 ? "warn" : "low";
  const baseExp = expForLevel(p.level, sp.growthRate);
  const nextExp = expForLevel(p.level + 1, sp.growthRate);
  const expSpan = Math.max(1, nextExp - baseExp);
  const expIntoLevel = Math.max(0, p.totalExp - baseExp);
  const expRaw = (expIntoLevel / expSpan) * 100;
  const expPct = expRaw === 0 ? 0 : Math.max(2, Math.min(100, expRaw));
  const active = idx === state.activePlayerPokemonIndex;
  const evoReady = canEvolveNow(p, state.inventory);

  const ref = useDragAndDrop<HTMLLIElement>({
    source: {
      payload: () => ({ kind: "party", data: { index: idx, id: p.id } }),
    },
    target: {
      // Accept other party rows OR PC box cells. Reject self-drop.
      accept: (payload) => {
        if (payload.kind === "party") {
          const fromIdx = (payload.data as { index: number }).index;
          return fromIdx !== idx;
        }
        return payload.kind === "box";
      },
      onDrop: (payload) => {
        if (payload.kind === "party") {
          const fromIdx = (payload.data as { index: number }).index;
          if (fromIdx === idx) return;
          dispatch({ type: "SWAP_PARTY", payload: { a: fromIdx, b: idx } });
        } else if (payload.kind === "box") {
          const boxIdx = (payload.data as { index: number }).index;
          if (state.party[idx]) {
            dispatch({
              type: "SWAP_PARTY_BOX",
              payload: { partyIndex: idx, boxIndex: boxIdx },
            });
          } else {
            dispatch({ type: "BOX_TO_PARTY", payload: { boxIndex: boxIdx } });
          }
        }
        if (ref.current) requestAnimationFrame(() => animatePop(ref.current!, 1.06));
      },
    },
  });

  return (
    <li
      ref={ref}
      className={[
        "party-row",
        active ? "active" : "",
        p.currentHp <= 0 ? "fainted" : "",
        evoReady ? "evo-ready" : "",
      ].filter(Boolean).join(" ")}
      onClick={() => {
        // The drag controller suppresses click propagation if a real
        // drag fired — so a click here means "tap, no drag", which
        // should open the detail modal.
        openPokemonDetail({ type: "party", index: idx });
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const isFront = idx === 0;
        const partySize = state.party.length;
        openContextMenu(e, [
          {
            label: "View details",
            onClick: () => openPokemonDetail({ type: "party", index: idx }),
          },
          {
            label: "Send out next",
            disabled: isFront || p.currentHp <= 0,
            onClick: () =>
              dispatch({ type: "REORDER_PARTY", payload: { from: idx, to: 0 } }),
          },
          {
            label: "Move to PC",
            disabled: partySize <= 1,
            onClick: () =>
              dispatch({ type: "PARTY_TO_BOX", payload: { partyIndex: idx } }),
          },
          {
            label: "Release",
            danger: true,
            disabled: partySize <= 1,
            onClick: () => {
              if (window.confirm(`Release ${p.name}? This cannot be undone.`)) {
                dispatch({
                  type: "RELEASE_POKEMON",
                  payload: { source: "party", index: idx },
                });
              }
            },
          },
        ]);
      }}
      title="Tap for details · hold-and-drag to reorder · right-click for actions"
    >
      <div className="party-row-sprite">
        <img
          src={pokemonSpriteUrl(p.speciesKey, false, p.isShiny)}
          alt={p.name}
          width={48}
          height={48}
          style={{ imageRendering: "pixelated" }}
          draggable={false}
        />
        {p.heldItem && itemsCatalog[p.heldItem] && (
          <img
            className="held-item-badge"
            src={itemSpriteUrl(p.heldItem, itemSpriteSlug(p.heldItem))}
            alt=""
            title={itemsCatalog[p.heldItem]?.name ?? p.heldItem}
            width={20}
            height={20}
            draggable={false}
          />
        )}
      </div>
      <div className="party-row-info">
        <div className="party-row-name">
          <strong>{p.name}{p.isShiny ? " ✨" : ""}</strong>
          <span className="party-row-types">
            {sp?.types.map((t) => (
              <span key={t} className={`party-type-chip type-${t.toLowerCase()}`}>{t}</span>
            ))}
          </span>
          <span className="party-row-level">Lv{p.level}</span>
        </div>
        <div className="party-bar-wrap">
          <span className="party-bar-label">HP</span>
          <div className={`party-bar hp ${hpClass}`}>
            <div className="party-bar-fill" style={{ width: `${hpPct}%` }} />
          </div>
        </div>
        <div className="party-bar-wrap">
          <span className="party-bar-label">EXP</span>
          <div className="party-bar exp">
            <div
              className="party-bar-fill"
              style={{ width: `${expPct}%` }}
              title={`${expIntoLevel} / ${expSpan} exp to next level`}
            />
          </div>
          {p.status && (
            <span
              className={`party-status-badge hp-status-badge ${statusBadgeClass(p.status)}`}
              title={p.status}
            >
              {STATUS_ABBREV[p.status]}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}
