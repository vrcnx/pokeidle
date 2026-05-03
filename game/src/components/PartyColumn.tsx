import { useEffect, useState } from "react";
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
import type { Pokemon, GameState } from "../types";

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

// Left column: Party list on top, footer with Settings + Heal at the bottom.
// Party rows are draggable — drop one row onto another to swap slots, which
// updates "who comes out next" because active = first healthy (see reducer).
export function PartyColumn() {
  const { state, dispatch } = useGame();
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  // Track whether the user has actually dragged (vs. just clicked-and-released
  // without movement). If they dragged, suppress the click-to-open-details
  // handler that would otherwise fire when the press lands on the same row.
  const [didDrag, setDidDrag] = useState(false);

  // Toggle a body-level "is-dragging" class so drop targets across the
  // page (other party rows, PC slots) can hint they're valid receivers.
  useEffect(() => {
    const cls = "is-dragging";
    if (dragIdx !== null) document.body.classList.add(cls);
    else document.body.classList.remove(cls);
    return () => document.body.classList.remove(cls);
  }, [dragIdx]);

  return (
    <div className="party-column">
      <section className="ctx-section party-card">
        <h4>Party</h4>
        <ul className="party-list">
        {state.party.map((p, idx) => {
          const sp = pokemonTable[p.speciesKey];
          const hpPct = (p.currentHp / p.maxHp) * 100;
          const hpClass = hpPct > 50 ? "ok" : hpPct > 20 ? "warn" : "low";
          const baseExp = expForLevel(p.level, sp.growthRate);
          const nextExp = expForLevel(p.level + 1, sp.growthRate);
          const expSpan = Math.max(1, nextExp - baseExp);
          const expIntoLevel = Math.max(0, p.totalExp - baseExp);
          const expRaw = (expIntoLevel / expSpan) * 100;
          const expPct = expRaw === 0
            ? 0
            : Math.max(2, Math.min(100, expRaw));
          const active = idx === state.activePlayerPokemonIndex;
          const isDragging = dragIdx === idx;
          const isDropTarget = overIdx === idx && dragIdx !== null && dragIdx !== idx;
          const evoReady = canEvolveNow(p, state.inventory);
          return (
            <li
              key={p.id}
              className={[
                "party-row",
                active ? "active" : "",
                p.currentHp <= 0 ? "fainted" : "",
                isDragging ? "dragging" : "",
                isDropTarget ? "drop-target" : "",
                evoReady ? "evo-ready" : "",
              ].filter(Boolean).join(" ")}
              draggable
              onDragStart={(e) => {
                setDragIdx(idx);
                setDidDrag(false);
                e.dataTransfer.setData("text/plain", `party:${idx}`);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDidDrag(true);
                if (overIdx !== idx) setOverIdx(idx);
              }}
              onDragLeave={() => {
                if (overIdx === idx) setOverIdx(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const raw = e.dataTransfer.getData("text/plain");
                // Sources: "party:N" (own row) or "box:N" (PC tab cell).
                // Plain numbers also work for back-compat with the old
                // party-only protocol.
                const [kind, idxStr] = raw.includes(":") ? raw.split(":") : ["party", raw];
                const from = Number(idxStr);
                let dropped = false;
                if (!Number.isNaN(from)) {
                  if (kind === "party" && from !== idx) {
                    dispatch({ type: "SWAP_PARTY", payload: { a: from, b: idx } });
                    dropped = true;
                  } else if (kind === "box") {
                    if (state.party[idx]) {
                      dispatch({
                        type: "SWAP_PARTY_BOX",
                        payload: { partyIndex: idx, boxIndex: from },
                      });
                    } else {
                      dispatch({ type: "BOX_TO_PARTY", payload: { boxIndex: from } });
                    }
                    dropped = true;
                  }
                }
                if (dropped) {
                  const target = e.currentTarget as HTMLElement;
                  requestAnimationFrame(() => animatePop(target, 1.06));
                }
                setDragIdx(null);
                setOverIdx(null);
              }}
              onDragEnd={() => {
                setDragIdx(null);
                setOverIdx(null);
              }}
              onClick={() => {
                if (didDrag) {
                  setDidDrag(false);
                  return;
                }
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
              title={`Click for details · drag to reorder · right-click for actions`}
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
                  <span>Lv{p.level}</span>
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
                </div>
              </div>
            </li>
          );
        })}
        </ul>
      </section>

      <ContextPanel />
    </div>
  );
}
