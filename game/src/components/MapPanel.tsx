import { useGame } from "../state/GameContext";
import { routes } from "../data/routes";

export function MapPanel() {
  const { state, dispatch } = useGame();
  const ordered = Object.values(routes).sort(
    (a, b) => a.unlockOrder - b.unlockOrder
  );
  return (
    <div className="map-panel">
      <h2>Map</h2>
      <p>
        Currently at: <strong>{routes[state.currentLocation]?.name ?? state.currentLocation}</strong>
      </p>
      <div className="map-grid">
        {ordered.map((r) => {
          const unlocked = state.unlockedLocations.includes(r.id);
          const battles = state.battlesWonByLocation[r.id] ?? 0;
          return (
            <button
              key={r.id}
              className={`map-tile ${unlocked ? "unlocked" : "locked"} ${
                state.currentLocation === r.id ? "current" : ""
              }`}
              disabled={!unlocked}
              onClick={() => dispatch({ type: "TRAVEL", payload: { locationId: r.id } })}
              title={r.description}
            >
              <strong>{r.name}</strong>
              <small>
                {r.type}
                {battles > 0 && ` · ${battles} won`}
              </small>
            </button>
          );
        })}
      </div>
    </div>
  );
}
