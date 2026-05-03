import { useEffect, useMemo, useState } from "react";
import { useGame } from "../state/GameContext";
import { routes } from "../data/routes";
import { api } from "../net/api";

// Optional crop loaded from the admin dashboard. Caches the result on
// the module so it persists across TownMap mounts (otherwise we'd hit
// the API every time the player switches to the Map tab).
type Crop = { x: number; y: number; w: number; h: number } | null;
let cachedCrop: Crop | undefined;
const cropListeners = new Set<(c: Crop) => void>();
function loadCrop() {
  if (cachedCrop !== undefined) return;
  cachedCrop = null; // mark as "in flight"
  api.mapCrop()
    .then((res) => { cachedCrop = res.crop; cropListeners.forEach((l) => l(cachedCrop!)); })
    .catch(() => {/* network failure → no crop, fall back to full image */});
}

// Visual graph map matching the original pkmn-idle.com design:
//   - towns / cities: red squares
//   - routes:         small green dots
//   - current:        gold-ringed marker with label below
//   - connections:    thick brown wooden ribbons (SVG)
//   - Only the current location shows a label by default; hover/title gives
//     the rest.

interface RouteNode {
  id: string;
  name: string;
  type: string;
  x: number;
  y: number;
  connections: string[];
}

export function TownMap() {
  const { state, dispatch } = useGame();
  const [crop, setCrop] = useState<Crop>(cachedCrop ?? null);
  useEffect(() => {
    loadCrop();
    cropListeners.add(setCrop);
    return () => { cropListeners.delete(setCrop); };
  }, []);
  // Map clicks are always allowed — TRAVEL bails out of any active battle
  // or raid (see reducer's TRAVEL case). The only block is on locked nodes.

  const nodes = useMemo<RouteNode[]>(
    () =>
      Object.values(routes)
        .filter((r) => r.position)
        .map((r) => ({
          id: r.id,
          name: r.name,
          type: r.type,
          x: r.position.x,
          y: r.position.y,
          connections: r.connections,
        })),
    []
  );

  const edges = useMemo(() => {
    const seen = new Set<string>();
    const out: { ax: number; ay: number; bx: number; by: number; key: string; lit: boolean }[] = [];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const unlocked = new Set(state.unlockedLocations);
    for (const n of nodes) {
      for (const c of n.connections) {
        const m = byId.get(c);
        if (!m) continue;
        const k = [n.id, c].sort().join("--");
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({
          ax: n.x,
          ay: n.y,
          bx: m.x,
          by: m.y,
          key: k,
          lit: unlocked.has(n.id) && unlocked.has(c),
        });
      }
    }
    return out;
  }, [nodes, state.unlockedLocations]);

  const wins = state.battlesWonByLocation[state.currentLocation] ?? 0;
  const trainerCount = state.trainerBattlesWon;

  function travel(id: string) {
    if (!state.unlockedLocations.includes(id)) return;
    dispatch({ type: "TRAVEL", payload: { locationId: id } });
  }

  return (
    <div className="town-map">
      <header className="town-map-header">
        <span className="town-map-label-left">TOWN MAP</span>
        <strong className="town-map-current-name">
          {routes[state.currentLocation]?.name ?? state.currentLocation}
        </strong>
        <span className="town-map-counter">
          {wins}W <span className="dim">{trainerCount}T</span>
        </span>
      </header>
      <div
        className="town-map-canvas"
        style={crop ? {
          // Zoom into the crop region: scale the source image up so the
          // crop fills the canvas exactly. The canvas keeps its 16:9
          // aspect ratio — we accept that the image is stretched
          // non-uniformly when the crop's ratio differs. Markers and
          // edges follow the same stretch so they stay anchored.
          //
          // background-size in % is relative to the canvas, so
          //   image_size = canvas_size × 100 / cropSize.
          //
          // background-position in % follows CSS's interpolation rule
          // (0% = image left at canvas left, 100% = image right at
          // canvas right). To put the cropX point of the source image
          // flush with the canvas left edge:
          //   bgPosX% = cropX × 100 / (100 − cropW)
          // (and analogously for Y). This is NOT the same as a naive
          // pixel-shift formula — that's the bug we had earlier.
          backgroundSize: `${10000 / crop.w}% ${10000 / crop.h}%`,
          backgroundPosition: `${(crop.x * 100) / (100 - crop.w)}% ${(crop.y * 100) / (100 - crop.h)}%`,
        } : undefined}
      >
        {/* Two SVG layers: dim base for all edges, lit overlay for unlocked-to-unlocked.
            When a crop is active, remap the SVG viewBox so x/y stay in
            the same source-image coordinates the markers use. */}
        <svg
          className="town-map-edges"
          viewBox={crop ? `${crop.x} ${crop.y} ${crop.w} ${crop.h}` : "0 0 100 100"}
          preserveAspectRatio="none"
          aria-hidden
        >
          {/* base (locked / unknown) — faint white tracing line */}
          {edges.map((e) => (
            <line
              key={`b-${e.key}`}
              x1={e.ax}
              y1={e.ay}
              x2={e.bx}
              y2={e.by}
              stroke="rgba(255,255,255,0.10)"
              strokeWidth="0.55"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {/* lit (unlocked path) — soft gold ribbon, brighter on top */}
          {edges
            .filter((e) => e.lit)
            .map((e) => (
              <line
                key={`l-${e.key}`}
                x1={e.ax}
                y1={e.ay}
                x2={e.bx}
                y2={e.by}
                stroke="rgba(251, 191, 36, 0.45)"
                strokeWidth="3.2"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          {edges
            .filter((e) => e.lit)
            .map((e) => (
              <line
                key={`l2-${e.key}`}
                x1={e.ax}
                y1={e.ay}
                x2={e.bx}
                y2={e.by}
                stroke="#fbbf24"
                strokeWidth="1.4"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
        </svg>
        {nodes.map((n) => {
          const unlocked = state.unlockedLocations.includes(n.id);
          const current = state.currentLocation === n.id;
          const isTown = n.type === "town";
          // Remap (x, y) into the crop's coordinate system. If a marker
          // sits outside the crop, hide it — it's not part of the
          // playable region the admin chose to show.
          let lx = n.x;
          let ly = n.y;
          if (crop) {
            if (
              n.x < crop.x || n.x > crop.x + crop.w ||
              n.y < crop.y || n.y > crop.y + crop.h
            ) {
              return null;
            }
            lx = ((n.x - crop.x) / crop.w) * 100;
            ly = ((n.y - crop.y) / crop.h) * 100;
          }
          return (
            <button
              key={n.id}
              className={[
                "town-map-node",
                isTown ? "town" : n.type === "raid" ? "raid" : "route-node",
                unlocked ? "unlocked" : "locked",
                current ? "current" : "",
              ].join(" ")}
              style={{ left: `${lx}%`, top: `${ly}%` }}
              disabled={!unlocked}
              onClick={() => travel(n.id)}
              title={unlocked ? n.name : "???"}
            >
              <span className="town-map-marker" />
              {unlocked && (
                <span
                  className={`town-map-label ${current ? "current" : "hover-only"}`}
                >
                  {n.name}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
