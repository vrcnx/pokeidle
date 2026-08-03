import { useEffect, useMemo, useState } from "react";
import type { Pokemon, PokemonType } from "../types";
import { useGame } from "../state/GameContext";
import { moves as movesTable } from "../data/moves";
import { availableMovesFor, type AvailableMove } from "../utils/moves";
import { machinesForSpecies } from "../utils/machines";
import { useDragAndDrop } from "../hooks/useDrag";
import { useModalEnter } from "../utils/animate";
import { pokemonTable } from "../data/pokemon";
import { useT } from "../i18n/useT";
import { displayName } from "../utils/pokemon";

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

  // Level-up moves AND the moves of every machine the player owns that this
  // species can learn. Recomputed when the inventory changes, so finding a TM
  // mid-session makes its move appear here without a reload.
  const learnable = useMemo<AvailableMove[]>(() => {
    if (!pokemon) return [];
    return availableMovesFor(pokemon.speciesKey, pokemon.level, state.inventory);
  }, [pokemon?.speciesKey, pokemon?.level, state.inventory]);

  // The other half of the compatibility picture: what this species can learn
  // that the player hasn't found yet. Computed here rather than in the
  // presentational half so the dialog stays a pure function of its props.
  const missingMachines = useMemo(() => {
    if (!pokemon) return [];
    return machinesForSpecies(pokemon.speciesKey)
      .filter((m) => (state.inventory[m.id] ?? 0) <= 0)
      .map((m) => ({ id: m.id, label: m.label, moveName: m.moveName }));
  }, [pokemon?.speciesKey, state.inventory]);

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

  /**
   * Drag a move into a slot.
   *
   * ── ADDRESSED BY MOVE ID, NOT BY SLOT ────────────────────────────
   * Same reasoning as RELEASE_MANY: the list being dragged IS the list being
   * mutated, so a slot index captured when the drag started can point at a
   * different move by the time it is dropped. Both ends resolve by id.
   *
   * Three cases, and they are genuinely different actions:
   *   · a slot dragged onto another slot   -> reorder (swap)
   *   · an available move onto an empty slot -> fill it
   *   · an available move onto a filled slot -> replace THAT one
   *
   * The third is the one the old UI could not do at all. `toggleMove`
   * always swapped into the LAST slot, so replacing move 2 meant removing
   * it, adding the new one, and then pressing ↑ twice.
   */
  function dropOnSlot(slot: number, payload: { from: "slot" | "pool"; moveId: string }) {
    const next = [...draft];
    if (payload.from === "pool") {
      // Already in the kit — dropping it somewhere else is a reorder, not a
      // second copy. Four slots and no duplicates is the whole constraint.
      const existing = next.indexOf(payload.moveId);
      if (existing !== -1) {
        const t = next[slot];
        next[existing] = t;
        next[slot] = payload.moveId;
        setDraft(next.filter(Boolean));
        return;
      }
      if (slot >= next.length) next.push(payload.moveId);
      else next[slot] = payload.moveId;
      setDraft(next);
      return;
    }
    const fromIdx = next.indexOf(payload.moveId);
    if (fromIdx === -1 || fromIdx === slot) return;
    [next[fromIdx], next[slot]] = [next[slot], next[fromIdx]];
    setDraft(next);
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
    // Above the detail sheet (120), because it opens from it — see
    // .manage-moves-overlay. Without this it appeared UNDER the sheet that
    // launched it, which is the bug the detail sheet itself had.
    <div className="modal-overlay manage-moves-overlay" onClick={closeManageMoves}>
      <ManageMovesDialog
        pokemon={pokemon}
        draft={draft}
        learnable={learnable}
        toggleMove={toggleMove}
        reorderInDraft={reorderInDraft}
        dropOnSlot={dropOnSlot}
        confirm={confirm}
        reset={reset}
        optimize={optimize}
        hasChanges={hasChanges}
        missingMachines={missingMachines}
      />
    </div>
  );
}

type PoolFilter = "all" | "level" | "machine";

function ManageMovesDialog({
  pokemon, draft, learnable, toggleMove, reorderInDraft, dropOnSlot, confirm, reset, optimize, hasChanges,
  missingMachines,
}: {
  pokemon: Pokemon;
  draft: string[];
  learnable: AvailableMove[];
  toggleMove: (id: string) => void;
  reorderInDraft: (slot: number, dir: -1 | 1) => void;
  dropOnSlot: (slot: number, payload: { from: "slot" | "pool"; moveId: string }) => void;
  confirm: () => void;
  reset: () => void;
  optimize: () => void;
  hasChanges: boolean;
  /** Machines this species can learn that the player hasn't found yet. */
  missingMachines: { id: string; label: string; moveName: string }[];
}) {
  const dialogRef = useModalEnter();
  const t = useT();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<PoolFilter>("all");

  const machineCount = learnable.filter((m) => m.source === "machine").length;
  const levelCount = learnable.length - machineCount;

  // Name search only. Filtering by type or power sounds useful and is not:
  // the question at this dialog is "where is the move I already have in
  // mind", and that is a name.
  //
  // The SOURCE filter is different, and earns its place: with machines in the
  // pool the list roughly doubles, and "show me only what my TMs give me" is
  // the question a player has right after finding one.
  const needle = q.trim().toLowerCase();
  const shown = learnable.filter((lm) => {
    if (filter !== "all" && lm.source !== filter) return false;
    if (!needle) return true;
    return (movesTable[lm.moveId]?.name ?? lm.moveId).toLowerCase().includes(needle);
  });
  return (
    <div ref={dialogRef} className="g-modal manage-moves-modal-v2" onClick={(e) => e.stopPropagation()}>
      <header className="g-modal-head">
        <h2>{t("Manage Moves")}</h2>
        <button className="g-modal-close" onClick={closeManageMoves} aria-label={t("Close")}>×</button>
      </header>

      {/* TWO COLUMNS: what you could learn on the left, what it knows on the
          right. The two lists were stacked, so choosing a move meant reading
          the top of the dialog, scrolling to the bottom to find the one you
          wanted, and scrolling back to see where it landed. Side by side,
          the source and the destination of the drag are both on screen —
          which is the only arrangement in which dragging between them is a
          feature rather than a trick. */}
      <div className="g-modal-body manage-moves-body">
        <section className="g-card manage-pool-card">
          <div className="detail-moves-header">
            <h3>{t("Available Moves")}</h3>
            <span className="dim small">{shown.length}/{learnable.length}</span>
          </div>
          {/* Search, because a fully-grown Pokemon can learn fifty of these
              and the list was the only way through them. */}
          <input
            className="manage-search"
            type="search"
            placeholder={t("Search moves")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label={t("Search available moves")}
          />
          {/* Source filter. Only worth showing when there is a second source
              to filter TO — a player with no compatible TM sees the dialog
              they always saw. */}
          {machineCount > 0 && (
            <div className="manage-source-filter" role="group" aria-label={t("Filter by how the move is learned")}>
              {([
                ["all", t("All"), learnable.length],
                ["level", t("Level-up"), levelCount],
                ["machine", t("TM/HM"), machineCount],
              ] as const).map(([key, label, count]) => (
                <button
                  key={key}
                  className={`manage-source-tab${filter === key ? " is-active" : ""}`}
                  aria-pressed={filter === key}
                  onClick={() => setFilter(key as PoolFilter)}
                >
                  {label} <span className="dim">{count}</span>
                </button>
              ))}
            </div>
          )}
          <ul className="manage-available">
            {learnable.length === 0 && (
              <li className="g-help">{t("No moves learned yet.")}</li>
            )}
            {learnable.length > 0 && shown.length === 0 && (
              <li className="g-help">{t("Nothing matches.")}</li>
            )}
            {shown.map((lm) => {
              const def = movesTable[lm.moveId];
              if (!def) return null;
              const equipped = draft.includes(lm.moveId);
              const fromMachine = lm.source === "machine";
              return (
                <AvailableMove
                  key={lm.moveId}
                  moveId={lm.moveId}
                  className={`${equipped ? "equipped" : ""}${fromMachine ? " from-machine" : ""}`}
                  style={{ background: TYPE_COLOR[def.type] + (equipped ? "ff" : "55") }}
                  onClick={() => toggleMove(lm.moveId)}
                  title={
                    equipped
                      ? undefined
                      : fromMachine
                        ? `Taught by ${lm.machineLabel}. Click to add, or drag onto a slot.`
                        : "Click to add, or drag onto a slot to place it"
                  }
                >
                  <span className="ma-cat">{CATEGORY_ICON[def.category]}</span>
                  <span className="ma-name">{def.name}</span>
                  <span className="ma-stats">
                    {t("Pwr ")}{def.power || "—"}{t(" · ")}{def.accuracy}
                    {/* Where it came from, in the space that used to always
                        say "Lv." — a machine move has no learn level, and
                        printing "Lv.undefined" is what it did before. */}
                    {fromMachine ? `% · ${lm.machineLabel}` : `% · Lv.${lm.learnLevel}`}
                  </span>
                  <span className="ma-action">{equipped ? "✓" : "+"}</span>
                </AvailableMove>
              );
            })}
          </ul>
          {/* What this Pokémon COULD learn if you found the machine. Without
              it, a species' TM pool is invisible until you happen to own the
              right disc — which is exactly the information that makes a route
              drop worth going after. */}
          {missingMachines.length > 0 && (
            <details className="manage-missing">
              <summary>
                {t("Needs a machine you don't have")}{" "}
                <span className="dim">{missingMachines.length}</span>
              </summary>
              <ul>
                {missingMachines.map((m) => (
                  <li key={m.id}>
                    <strong>{m.label}</strong> {m.moveName}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>

        <section className="g-card manage-current-card">
          <h3>{displayName(pokemon)} <span className="dim">{t("— Lv. ")}{pokemon.level}</span></h3>
          <div className="manage-current-v2">
            <span className="dim small" style={{ marginBottom: 4 }}>{t("Current (")}{draft.length}{t("/4)")}</span>
            {[0, 1, 2, 3].map((slot) => {
              const id = draft[slot];
              const def = id ? movesTable[id] : null;
              return (
                <MoveSlot
                  key={slot}
                  slot={slot}
                  moveId={id}
                  tint={def ? TYPE_COLOR[def.type] : undefined}
                  onDrop={dropOnSlot}
                >
                  {def ? (
                    <>
                      <span className="cs-name">
                        <span className="cs-cat">{CATEGORY_ICON[def.category]}</span>
                        {def.name}
                      </span>
                      <div className="cs-actions">
                        <button title={t("Move up")} onClick={() => reorderInDraft(slot, -1)} disabled={slot === 0}>↑</button>
                        <button title={t("Move down")} onClick={() => reorderInDraft(slot, 1)} disabled={slot === draft.length - 1}>↓</button>
                        <button title={t("Remove")} onClick={() => toggleMove(id)}>✕</button>
                      </div>
                    </>
                  ) : (
                    <span className="cs-empty">{t("empty")}</span>
                  )}
                </MoveSlot>
              );
            })}
          </div>
        </section>

      </div>

      <footer className="g-modal-foot">
        <button
          className="g-btn-ghost g-btn-small"
          onClick={optimize}
          disabled={learnable.length === 0}
          title={t("Auto-pick the four highest-impact moves (STAB + power + type diversity)")}
        >
          {t("⚡ Optimize")}
        </button>
        <button className="g-btn-ghost g-btn-small" onClick={reset} disabled={!hasChanges}>{t("Reset")}</button>
        <span style={{ flex: 1 }} />
        <button className="g-btn-ghost g-btn-small" onClick={closeManageMoves}>{t("Cancel")}</button>
        <button
          className="g-btn-primary"
          onClick={confirm}
          disabled={!hasChanges || draft.length === 0}
        >
          {t("Save")}
        </button>
      </footer>
    </div>
  );
}

/**
 * One of the four move slots: a drag source AND a drop target.
 *
 * The arrows stay. Dragging is the faster way to say it and a keyboard
 * cannot drag — removing them would trade one group of players for another,
 * which is not what a quality-of-life change is for.
 */
function MoveSlot({
  slot, moveId, tint, onDrop, children,
}: {
  slot: number;
  moveId: string | undefined;
  tint?: string;
  onDrop: (slot: number, payload: { from: "slot" | "pool"; moveId: string }) => void;
  children: React.ReactNode;
}) {
  const ref = useDragAndDrop<HTMLDivElement>({
    // An empty slot is not draggable — there is nothing to pick up — but it
    // IS a target, which is how an available move gets in.
    source: moveId
      ? { payload: () => ({ kind: "move", data: { from: "slot", moveId } }) }
      : undefined,
    target: {
      accept: (p) => p.kind === "move",
      onDrop: (p) => onDrop(slot, p.data as { from: "slot" | "pool"; moveId: string }),
    },
  });
  return (
    <div
      ref={ref}
      className={`current-slot ${moveId ? "filled" : "empty"} is-droppable`}
      style={tint ? { background: tint } : undefined}
    >
      {children}
    </div>
  );
}

/** A move in the Available list — drag source only. */
function AvailableMove({
  moveId, children, className, style, onClick, title,
}: {
  moveId: string;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  onClick?: () => void;
  title?: string;
}) {
  const ref = useDragAndDrop<HTMLLIElement>({
    source: { payload: () => ({ kind: "move", data: { from: "pool", moveId } }) },
  });
  return (
    <li ref={ref} className={className} style={style} onClick={onClick} title={title}>
      {children}
    </li>
  );
}
