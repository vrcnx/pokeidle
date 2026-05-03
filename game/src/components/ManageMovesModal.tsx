import { useEffect, useMemo, useState } from "react";
import type { Pokemon, PokemonType } from "../types";
import { useGame } from "../state/GameContext";
import { moves as movesTable } from "../data/moves";
import { learnableMovesUpToLevel, type LearnedMove } from "../utils/moves";
import { useModalEnter } from "../utils/animate";
import { pokemonTable } from "../data/pokemon";

// Imperative open/close — same pattern as PokemonDetailModal.
type Target = { type: "party"; index: number };
let _target: Target | null = null;
const _listeners = new Set<(t: Target | null) => void>();
export function openManageMoves(t: Target) {
  _target = t;
  _listeners.forEach((l) => l(t));
}
export function closeManageMoves() {
  _target = null;
  _listeners.forEach((l) => l(null));
}
function useTarget(): Target | null {
  const [t, setT] = useState<Target | null>(_target);
  useEffect(() => {
    _listeners.add(setT);
    return () => { _listeners.delete(setT); };
  }, []);
  return t;
}

const TYPE_COLOR: Record<PokemonType, string> = {
  Normal:   "#a8a878", Fire:     "#f08030", Water:    "#6890f0",
  Electric: "#f8d030", Grass:    "#78c850", Ice:      "#98d8d8",
  Fighting: "#c03028", Poison:   "#a040a0", Ground:   "#e0c068",
  Flying:   "#a890f0", Psychic:  "#f85888", Bug:      "#a8b820",
  Rock:     "#b8a038", Ghost:    "#705898", Dragon:   "#7038f8",
  Dark:     "#705848", Steel:    "#b8b8d0", Fairy:    "#ee99ac",
};
const CATEGORY_ICON: Record<string, string> = {
  physical: "✴", special: "◎", status: "☯",
};

export function ManageMovesModal() {
  const { state, dispatch } = useGame();
  const target = useTarget();
  const pokemon: Pokemon | undefined =
    target ? state.party[target.index] : undefined;

  const [draft, setDraft] = useState<string[]>([]);
  useEffect(() => {
    setDraft(pokemon ? pokemon.moves.map((m) => m.id) : []);
  }, [target, pokemon?.id]);

  const learnable = useMemo<LearnedMove[]>(() => {
    if (!pokemon) return [];
    return learnableMovesUpToLevel(pokemon.speciesKey, pokemon.level);
  }, [pokemon?.speciesKey, pokemon?.level]);

  if (!target || !pokemon) return null;

  function toggleMove(id: string) {
    if (draft.includes(id)) {
      // remove
      setDraft(draft.filter((m) => m !== id));
    } else if (draft.length < 4) {
      setDraft([...draft, id]);
    } else {
      // 4 already chosen — swap into the LAST slot (most recently added)
      setDraft([...draft.slice(0, -1), id]);
    }
  }

  function reorderInDraft(slot: number, dir: -1 | 1) {
    const next = [...draft];
    const t = slot + dir;
    if (t < 0 || t >= next.length) return;
    [next[slot], next[t]] = [next[t], next[slot]];
    setDraft(next);
  }

  function confirm() {
    if (!target) return;
    dispatch({
      type: "SET_MOVES",
      payload: { pokemonId: pokemon!.id, moveIds: draft },
    });
    closeManageMoves();
  }

  function reset() {
    setDraft(pokemon!.moves.map((m) => m.id));
  }

  // Pick the 4 highest-scoring learnable moves, using a simple
  // heuristic: power × accuracy × STAB (1.5×) + a small bonus for
  // type variety so the kit isn't four copies of the same type when
  // alternatives exist. Status moves count too at a flat ~40 score.
  function optimize() {
    if (!pokemon) return;
    const ownerTypes = new Set(pokemonTable[pokemon.speciesKey]?.types ?? []);
    const scored = learnable
      .map((lm) => {
        const d = movesTable[lm.moveId];
        if (!d) return null;
        const stab = ownerTypes.has(d.type) ? 1.5 : 1;
        const acc = (d.accuracy ?? 100) / 100;
        const power = d.power || 40; // status moves: floor instead of 0
        return { id: lm.moveId, type: d.type, score: power * acc * stab };
      })
      .filter((m): m is { id: string; type: PokemonType; score: number } => !!m)
      .sort((a, b) => b.score - a.score);

    const picked: string[] = [];
    const usedTypes = new Set<PokemonType>();
    // First pass: top scorer per type for coverage diversity
    for (const m of scored) {
      if (picked.length >= 4) break;
      if (usedTypes.has(m.type)) continue;
      picked.push(m.id);
      usedTypes.add(m.type);
    }
    // Second pass: fill remaining slots with next best regardless of type
    for (const m of scored) {
      if (picked.length >= 4) break;
      if (picked.includes(m.id)) continue;
      picked.push(m.id);
    }
    setDraft(picked);
  }

  const hasChanges =
    draft.length !== pokemon.moves.length ||
    draft.some((id, i) => pokemon.moves[i]?.id !== id);

  return (
    <div className="modal-overlay" onClick={closeManageMoves}>
      <ManageMovesDialog
        pokemon={pokemon}
        draft={draft}
        learnable={learnable}
        toggleMove={toggleMove}
        reorderInDraft={reorderInDraft}
        confirm={confirm}
        reset={reset}
        optimize={optimize}
        hasChanges={hasChanges}
      />
    </div>
  );
}

function ManageMovesDialog({
  pokemon, draft, learnable, toggleMove, reorderInDraft, confirm, reset, optimize, hasChanges,
}: {
  pokemon: Pokemon;
  draft: string[];
  learnable: LearnedMove[];
  toggleMove: (id: string) => void;
  reorderInDraft: (slot: number, dir: -1 | 1) => void;
  confirm: () => void;
  reset: () => void;
  optimize: () => void;
  hasChanges: boolean;
}) {
  const dialogRef = useModalEnter();
  return (
    <div ref={dialogRef} className="g-modal manage-moves-modal-v2" onClick={(e) => e.stopPropagation()}>
      <header className="g-modal-head">
        <h2>Manage Moves</h2>
        <button className="g-modal-close" onClick={closeManageMoves} aria-label="Close">×</button>
      </header>

      <div className="g-modal-body">
        <section className="g-card g-card-full">
          <h3>{pokemon.name} <span className="dim">— Lv. {pokemon.level}</span></h3>
          <div className="manage-current-v2">
            <span className="dim small" style={{ marginBottom: 4 }}>Current ({draft.length}/4)</span>
            {[0, 1, 2, 3].map((slot) => {
              const id = draft[slot];
              const def = id ? movesTable[id] : null;
              return (
                <div
                  key={slot}
                  className={`current-slot ${def ? "filled" : "empty"}`}
                  style={def ? { background: TYPE_COLOR[def.type] } : undefined}
                >
                  {def ? (
                    <>
                      <span className="cs-name">
                        <span className="cs-cat">{CATEGORY_ICON[def.category]}</span>
                        {def.name}
                      </span>
                      <div className="cs-actions">
                        <button title="Move up" onClick={() => reorderInDraft(slot, -1)} disabled={slot === 0}>↑</button>
                        <button title="Move down" onClick={() => reorderInDraft(slot, 1)} disabled={slot === draft.length - 1}>↓</button>
                        <button title="Remove" onClick={() => toggleMove(id)}>✕</button>
                      </div>
                    </>
                  ) : (
                    <span className="cs-empty">empty</span>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <section className="g-card g-card-full">
          <h3>Available Moves</h3>
          <ul className="manage-available">
            {learnable.length === 0 && (
              <li className="g-help">No moves learned yet.</li>
            )}
            {learnable.map((lm) => {
              const def = movesTable[lm.moveId];
              if (!def) return null;
              const equipped = draft.includes(lm.moveId);
              return (
                <li
                  key={lm.moveId}
                  className={equipped ? "equipped" : ""}
                  style={{ background: TYPE_COLOR[def.type] + (equipped ? "ff" : "55") }}
                  onClick={() => toggleMove(lm.moveId)}
                >
                  <span className="ma-cat">{CATEGORY_ICON[def.category]}</span>
                  <span className="ma-name">{def.name}</span>
                  <span className="ma-stats">
                    Pwr {def.power || "—"} · {def.accuracy}% · Lv.{lm.learnLevel}
                  </span>
                  <span className="ma-action">{equipped ? "✓" : "+"}</span>
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      <footer className="g-modal-foot">
        <button
          className="g-btn-ghost g-btn-small"
          onClick={optimize}
          disabled={learnable.length === 0}
          title="Auto-pick the four highest-impact moves (STAB + power + type diversity)"
        >
          ⚡ Optimize
        </button>
        <button className="g-btn-ghost g-btn-small" onClick={reset} disabled={!hasChanges}>Reset</button>
        <span style={{ flex: 1 }} />
        <button className="g-btn-ghost g-btn-small" onClick={closeManageMoves}>Cancel</button>
        <button
          className="g-btn-primary"
          onClick={confirm}
          disabled={!hasChanges || draft.length === 0}
        >
          Save
        </button>
      </footer>
    </div>
  );
}
