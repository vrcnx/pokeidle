import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { DEFAULT_MAP_POSITIONS } from "../defaults/mapPositions";
import { DEFAULT_MAP_CONNECTIONS } from "../defaults/mapConnections";

interface Pos { x: number; y: number }
type Positions = Record<string, Pos>;
interface Crop { x: number; y: number; w: number; h: number }

// The town map asset is served by the GAME frontend, not the admin app.
// This was hardcoded to http://localhost:5173, so in production the
// editor rendered a broken image over which the operator was still
// dragging markers — saving coordinates against a backdrop they could
// not see. Resolve the game origin the same way App.tsx does for its
// redirect, and let VITE_GAME_URL override.
const GAME_ORIGIN: string =
  (import.meta as any).env?.VITE_GAME_URL
  ?? (typeof window !== "undefined" && window.location.hostname !== "localhost"
    ? "https://pokeidle.com"
    : "http://localhost:5173");
const MAP_IMG = `${GAME_ORIGIN.replace(/\/$/, "")}/ui/townmap.png`;

// Editing modes — markers (drag pins around) vs crop (drag a rectangle
// over the playable region of the source image so the game cuts away
// decorative borders / sky / unused chrome).
type Mode = "markers" | "crop";

export function MapEditorPage() {
  const [positions, setPositions] = useState<Positions>({});
  const [mapImgFailed, setMapImgFailed] = useState(false);
  const [crop, setCrop] = useState<Crop | null>(null);
  const [mode, setMode] = useState<Mode>("markers");
  const [loaded, setLoaded] = useState(false);
  const [posDirty, setPosDirty] = useState(false);
  const [cropDirty, setCropDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [snap, setSnap] = useState(true);
  const dragState = useRef<{ id: string; offX: number; offY: number } | null>(null);
  const cropDragState = useRef<
    | { kind: "move"; startCrop: Crop; startX: number; startY: number }
    | { kind: "resize"; corner: "tl" | "tr" | "bl" | "br"; startCrop: Crop; startX: number; startY: number }
    | { kind: "create"; startX: number; startY: number; rectX: number; rectY: number }
    | null
  >(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    Promise.all([api.getMapPositions(), api.getMapCrop()])
      .then(([p, c]) => {
        setPositions({ ...DEFAULT_MAP_POSITIONS, ...p.positions });
        setCrop(c.crop);
        setLoaded(true);
      })
      .catch((e) => setErr(e.message));
  }, []);

  const startDrag = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cur = positions[id];
    const cx = (cur.x / 100) * rect.width;
    const cy = (cur.y / 100) * rect.height;
    dragState.current = {
      id,
      offX: e.clientX - (rect.left + cx),
      offY: e.clientY - (rect.top + cy),
    };
    setSelected(id);
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragState.current;
      const canvas = canvasRef.current;
      if (!drag || !canvas) return;
      const rect = canvas.getBoundingClientRect();
      let x = ((e.clientX - drag.offX - rect.left) / rect.width) * 100;
      let y = ((e.clientY - drag.offY - rect.top) / rect.height) * 100;
      // Clamp to canvas.
      x = Math.max(0, Math.min(100, x));
      y = Math.max(0, Math.min(100, y));
      // Snap to 0.5% grid (~3 pixels at 600 wide). Hold Alt to disable.
      if (snap && !e.altKey) {
        x = Math.round(x * 2) / 2;
        y = Math.round(y * 2) / 2;
      }
      setPositions((p) => ({ ...p, [drag.id]: { x, y } }));
      setPosDirty(true);
    };
    const onCropMove = (e: MouseEvent) => {
      const cd = cropDragState.current;
      const canvas = canvasRef.current;
      if (!cd || !canvas) return;
      const rect = canvas.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * 100;
      const py = ((e.clientY - rect.top) / rect.height) * 100;
      if (cd.kind === "create") {
        const x = Math.max(0, Math.min(cd.rectX, px));
        const y = Math.max(0, Math.min(cd.rectY, py));
        const w = Math.max(2, Math.abs(px - cd.rectX));
        const h = Math.max(2, Math.abs(py - cd.rectY));
        setCrop({ x, y, w, h });
        setCropDirty(true);
      } else if (cd.kind === "move") {
        const dx = ((e.clientX - cd.startX) / rect.width) * 100;
        const dy = ((e.clientY - cd.startY) / rect.height) * 100;
        const nx = Math.max(0, Math.min(100 - cd.startCrop.w, cd.startCrop.x + dx));
        const ny = Math.max(0, Math.min(100 - cd.startCrop.h, cd.startCrop.y + dy));
        setCrop({ ...cd.startCrop, x: nx, y: ny });
        setCropDirty(true);
      } else if (cd.kind === "resize") {
        const dx = ((e.clientX - cd.startX) / rect.width) * 100;
        const dy = ((e.clientY - cd.startY) / rect.height) * 100;
        const sc = cd.startCrop;
        let { x, y, w, h } = sc;
        if (cd.corner === "tl") { x = sc.x + dx; y = sc.y + dy; w = sc.w - dx; h = sc.h - dy; }
        if (cd.corner === "tr") { y = sc.y + dy; w = sc.w + dx; h = sc.h - dy; }
        if (cd.corner === "bl") { x = sc.x + dx; w = sc.w - dx; h = sc.h + dy; }
        if (cd.corner === "br") { w = sc.w + dx; h = sc.h + dy; }
        // Clamp.
        x = Math.max(0, x); y = Math.max(0, y);
        w = Math.max(5, Math.min(100 - x, w));
        h = Math.max(5, Math.min(100 - y, h));
        setCrop({ x, y, w, h });
        setCropDirty(true);
      }
    };
    const onUp = () => { dragState.current = null; cropDragState.current = null; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mousemove", onCropMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mousemove", onCropMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [snap]);

  const save = async () => {
    setErr(null);
    setSaved(false);
    try {
      if (posDirty) await api.saveMapPositions(positions);
      if (cropDirty) await api.saveMapCrop(crop);
      setPosDirty(false);
      setCropDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const clearCrop = () => { setCrop(null); setCropDirty(true); };

  const startCropCreate = (e: React.MouseEvent) => {
    if (mode !== "crop") return;
    if (crop) return; // don't start a new rect if one already exists
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * 100;
    const py = ((e.clientY - rect.top) / rect.height) * 100;
    cropDragState.current = { kind: "create", startX: e.clientX, startY: e.clientY, rectX: px, rectY: py };
    setCrop({ x: px, y: py, w: 1, h: 1 });
    setCropDirty(true);
  };

  const startCropMove = (e: React.MouseEvent) => {
    if (!crop) return;
    e.preventDefault();
    e.stopPropagation();
    cropDragState.current = { kind: "move", startCrop: crop, startX: e.clientX, startY: e.clientY };
  };

  const startCropResize = (corner: "tl" | "tr" | "bl" | "br") => (e: React.MouseEvent) => {
    if (!crop) return;
    e.preventDefault();
    e.stopPropagation();
    cropDragState.current = { kind: "resize", corner, startCrop: crop, startX: e.clientX, startY: e.clientY };
  };

  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify({ positions, crop }, null, 2));
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e: any) {
      setErr(`Copy failed: ${e.message}`);
    }
  };
  const dirty = posDirty || cropDirty;

  if (!loaded) return <div className="page-loading">Loading map…</div>;

  const ids = Object.keys(positions).sort();
  const isTown = (id: string) =>
    /Town|City|Plat|Island|safariZone|raidIsland/.test(id);

  return (
    <div className="page map-editor-page">
      <header className="page-head">
        <h1>Map editor</h1>
        <p className="dim">
          Drag markers to reposition. Switch to crop mode to define the playable region —
          everything outside the rectangle gets cut from the in-game town map.
        </p>
      </header>

      <div className="map-toolbar">
        <div className="mode-toggle">
          <button
            className={mode === "markers" ? "active" : ""}
            onClick={() => setMode("markers")}
          >Markers</button>
          <button
            className={mode === "crop" ? "active" : ""}
            onClick={() => setMode("crop")}
          >Crop</button>
        </div>
        {mode === "markers" && (
          <label className="map-snap">
            <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />
            Snap to grid
          </label>
        )}
        <span className="dim">
          {mode === "markers"
            ? `${ids.length} markers`
            : crop
              ? `crop ${crop.w.toFixed(1)} × ${crop.h.toFixed(1)}%`
              : "no crop — click & drag on the map"}
        </span>
        <span style={{ flex: 1 }} />
        {mode === "crop" && crop && (
          <button className="btn-ghost" onClick={clearCrop}>Remove crop</button>
        )}
        <button className="btn-ghost" onClick={copyJson}>Copy JSON</button>
        <button className="btn-primary" onClick={save} disabled={!dirty}>
          {dirty ? "Save changes" : saved ? "Saved ✓" : "No changes"}
        </button>
      </div>

      {err && <div className="page-err">{err}</div>}

      <div className="map-canvas-wrap">
        <div
          ref={canvasRef}
          className={`map-canvas ${mode === "crop" ? "crop-mode" : ""}`}
          onMouseDown={startCropCreate}
        >
          <img
            className="map-img"
            src={MAP_IMG}
            alt=""
            draggable={false}
            onLoad={() => setMapImgFailed(false)}
            onError={() => setMapImgFailed(true)}
          />
          {mapImgFailed && (
            <div className="map-img-error" role="alert">
              <strong>Map image failed to load</strong>
              <span className="dim small">
                Tried <code>{MAP_IMG}</code>. Marker positions below are still
                real and still saveable, but you are placing them without the
                backdrop — set <code>VITE_GAME_URL</code> if the game is served
                from a different origin.
              </span>
            </div>
          )}

          {/* Grid overlay — 2% minor lines, 10% major lines. Helps the
              admin eyeball positions and crop boundaries. Always
              rendered above the image, below markers/crop. */}
          <svg
            className="map-grid"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden
          >
            {Array.from({ length: 50 }, (_, i) => (i + 1) * 2)
              .filter((p) => p < 100)
              .map((p) => {
                const major = p % 10 === 0;
                return (
                  <g key={p}>
                    <line
                      x1={p} y1={0} x2={p} y2={100}
                      stroke={major ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.06)"}
                      strokeWidth={major ? 0.15 : 0.08}
                      vectorEffect="non-scaling-stroke"
                    />
                    <line
                      x1={0} y1={p} x2={100} y2={p}
                      stroke={major ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.06)"}
                      strokeWidth={major ? 0.15 : 0.08}
                      vectorEffect="non-scaling-stroke"
                    />
                  </g>
                );
              })}
          </svg>

          {/* Route connections — gold ribbons between linked nodes,
              same coordinate system as the markers. De-duped by
              sorting endpoints so each pair is drawn once even when
              both sides list the connection. */}
          <svg
            className="map-edges"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden
          >
            {(() => {
              const seen = new Set<string>();
              const lines: { key: string; ax: number; ay: number; bx: number; by: number }[] = [];
              for (const [from, conns] of Object.entries(DEFAULT_MAP_CONNECTIONS)) {
                const a = positions[from];
                if (!a) continue;
                for (const to of conns) {
                  const b = positions[to];
                  if (!b) continue;
                  const key = [from, to].sort().join("--");
                  if (seen.has(key)) continue;
                  seen.add(key);
                  lines.push({ key, ax: a.x, ay: a.y, bx: b.x, by: b.y });
                }
              }
              return lines.map((e) => (
                <g key={e.key}>
                  <line
                    x1={e.ax} y1={e.ay} x2={e.bx} y2={e.by}
                    stroke="rgba(251, 191, 36, 0.45)"
                    strokeWidth="3.2"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
                  <line
                    x1={e.ax} y1={e.ay} x2={e.bx} y2={e.by}
                    stroke="#fbbf24"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              ));
            })()}
          </svg>

          {/* Crop overlay — dim everything outside the rectangle so the
              admin can clearly see the playable region. */}
          {crop && (
            <>
              <div className="crop-mask" style={{
                clipPath: `polygon(
                  0 0, 100% 0, 100% 100%, 0 100%, 0 ${crop.y}%,
                  ${crop.x}% ${crop.y}%, ${crop.x}% ${crop.y + crop.h}%,
                  ${crop.x + crop.w}% ${crop.y + crop.h}%, ${crop.x + crop.w}% ${crop.y}%,
                  0 ${crop.y}%
                )`
              }} />
              <div
                className={`crop-rect ${mode === "crop" ? "interactive" : ""}`}
                style={{
                  left: `${crop.x}%`,
                  top: `${crop.y}%`,
                  width: `${crop.w}%`,
                  height: `${crop.h}%`,
                }}
                onMouseDown={mode === "crop" ? startCropMove : undefined}
              >
                {mode === "crop" && (
                  <>
                    <span className="crop-handle tl" onMouseDown={startCropResize("tl")} />
                    <span className="crop-handle tr" onMouseDown={startCropResize("tr")} />
                    <span className="crop-handle bl" onMouseDown={startCropResize("bl")} />
                    <span className="crop-handle br" onMouseDown={startCropResize("br")} />
                  </>
                )}
              </div>
            </>
          )}

          {/* Markers — only interactive in markers mode. */}
          {mode === "markers" && ids.map((id) => {
            const p = positions[id];
            return (
              <button
                key={id}
                type="button"
                className={`map-marker ${isTown(id) ? "town" : "route"} ${selected === id ? "selected" : ""}`}
                style={{ left: `${p.x}%`, top: `${p.y}%` }}
                onMouseDown={(e) => startDrag(e, id)}
                onClick={(e) => { e.stopPropagation(); setSelected(id); }}
                title={`${id} (${p.x.toFixed(2)}, ${p.y.toFixed(2)})`}
              >
                <span className="map-marker-dot" />
                {selected === id && <span className="map-marker-label">{id}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {mode === "markers" && selected && (
        <div className="map-detail">
          <strong>{selected}</strong>
          <span>x: <input
            type="number"
            step={0.1}
            value={positions[selected].x.toFixed(2)}
            onChange={(e) => { setPositions((p) => ({ ...p, [selected]: { ...p[selected], x: Number(e.target.value) } })); setPosDirty(true); }}
          /></span>
          <span>y: <input
            type="number"
            step={0.1}
            value={positions[selected].y.toFixed(2)}
            onChange={(e) => { setPositions((p) => ({ ...p, [selected]: { ...p[selected], y: Number(e.target.value) } })); setPosDirty(true); }}
          /></span>
        </div>
      )}

      {mode === "crop" && crop && (
        <div className="map-detail">
          <strong>Crop</strong>
          <span>x: <input type="number" step={0.5} value={crop.x.toFixed(2)} onChange={(e) => { setCrop({ ...crop, x: Number(e.target.value) }); setCropDirty(true); }} /></span>
          <span>y: <input type="number" step={0.5} value={crop.y.toFixed(2)} onChange={(e) => { setCrop({ ...crop, y: Number(e.target.value) }); setCropDirty(true); }} /></span>
          <span>w: <input type="number" step={0.5} value={crop.w.toFixed(2)} onChange={(e) => { setCrop({ ...crop, w: Number(e.target.value) }); setCropDirty(true); }} /></span>
          <span>h: <input type="number" step={0.5} value={crop.h.toFixed(2)} onChange={(e) => { setCrop({ ...crop, h: Number(e.target.value) }); setCropDirty(true); }} /></span>
        </div>
      )}
    </div>
  );
}
