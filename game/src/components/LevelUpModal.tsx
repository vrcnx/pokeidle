import { useGame } from "../state/GameContext";
import { moves as movesTable } from "../data/moves";

// Surfaces level-up notifications and lets the player swap out a move when
// the new ones would push the moveset above 4. The reducer's `appendNewMoves`
// auto-replaces the last slot when full; this modal lets the player override
// that choice.

export function LevelUpModal() {
  const { state, dispatch } = useGame();
  const note = state.levelUpNotification;
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
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{pokemon.name} grew to level {note.level}!</h2>
        {newMoves.length === 0 ? (
          <>
            <p>No new moves this time.</p>
            <button onClick={dismiss}>OK</button>
          </>
        ) : (
          <>
            {newMoves.map((id) => {
              const def = movesTable[id];
              return (
                <div key={id} className="level-up-move">
                  <h3>Wants to learn <span className="accent">{def?.name ?? id}</span></h3>
                  {def && (
                    <small className="dim">
                      {def.type} · {def.category} · Pwr {def.power} · Acc {def.accuracy}
                    </small>
                  )}
                  <p>Choose a move to forget, or skip:</p>
                  <div className="move-grid">
                    {pokemon.moves.map((m) => {
                      const oldDef = movesTable[m.id];
                      return (
                        <button key={m.id} onClick={() => swap(m.id, id)}>
                          Forget {oldDef?.name ?? m.id}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            <button className="dismiss" onClick={dismiss}>Skip all</button>
          </>
        )}
      </div>
    </div>
  );
}
