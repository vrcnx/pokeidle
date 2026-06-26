import { useEffect } from "react";
import { useGame } from "../state/GameContext";
import { moves as movesTable } from "../data/moves";

// Surfaces level-up notifications and lets the player swap out a move when
// the new ones would push the moveset above 4. The reducer's `appendNewMoves`
// auto-replaces the last slot when full; this modal lets the player override
// that choice.

export function LevelUpModal() {
  const { state, dispatch } = useGame();
  const note = state.levelUpNotification;

  // ESC dismisses — added as part of the UI/UX audit pass. Hook must
  // run unconditionally per React rules; the inner guard short-circuits
  // when the modal isn't open.
  useEffect(() => {
    if (!note) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dispatch({ type: "CLEAR_LEVEL_UP" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [note, dispatch]);

  if (!note || !state.playerPokemon) return null;

  const pokemon =
    state.party.find((p) => p.id === note.pokemonId) ??
    (state.playerPokemon.id === note.pokemonId ? state.playerPokemon : null);
  if (!pokemon) return null;

  const newMoves = note.newMoves.filter((m) => !pokemon.moves.some((mm) => mm.id === m));

  function dismiss() {
    dispatch({ type: "CLEAR_LEVEL_UP" });
  }

  function swap(oldMoveId: string, newMoveId: string) {
    if (!pokemon) return;
    const moveIds = pokemon.moves.map((m) => (m.id === oldMoveId ? newMoveId : m.id));
    dispatch({
      type: "SET_MOVES",
      payload: { pokemonId: pokemon.id, moveIds },
    });
    dispatch({ type: "CLEAR_LEVEL_UP" });
  }

  return (
    <div className="modal-overlay" onClick={dismiss}>
      <div
        className="g-modal"
        role="dialog"
        aria-label="Level up"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="g-modal-head">
          <h2>{pokemon.name} grew to level {note.level}!</h2>
          <button className="g-modal-close" onClick={dismiss} aria-label="Close">×</button>
        </header>
        <div className="g-modal-body">
          {newMoves.length === 0 ? (
            <p className="dim small" style={{ margin: 0 }}>No new moves this time.</p>
          ) : (
            newMoves.map((id) => {
              const def = movesTable[id];
              return (
                <section key={id} className="g-card level-up-move">
                  <h3>Wants to learn <span className="accent">{def?.name ?? id}</span></h3>
                  {def && (
                    <small className="dim">
                      {def.type} · {def.category} · Pwr {def.power} · Acc {def.accuracy}
                    </small>
                  )}
                  <p className="dim small" style={{ margin: "6px 0" }}>
                    Choose a move to forget, or skip:
                  </p>
                  <div className="move-grid">
                    {pokemon.moves.map((m) => {
                      const oldDef = movesTable[m.id];
                      return (
                        <button
                          key={m.id}
                          className="g-btn-ghost g-btn-small"
                          onClick={() => swap(m.id, id)}
                        >
                          Forget {oldDef?.name ?? m.id}
                        </button>
                      );
                    })}
                  </div>
                </section>
              );
            })
          )}
        </div>
        <footer className="g-modal-foot">
          <button className="g-btn-primary" onClick={dismiss}>
            {newMoves.length === 0 ? "OK" : "Skip all"}
          </button>
        </footer>
      </div>
    </div>
  );
}
