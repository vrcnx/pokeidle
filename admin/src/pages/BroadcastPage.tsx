import { useEffect, useRef, useState } from "react";
import { api, ApiError, type BroadcastStatus, type BroadcastPatch, type TwitchInfo, type StreamConfig } from "../api";
import { notify } from "../components/Confirm";
import { StreamRemoteControl } from "./UsersPage";

const RES_PRESETS: { label: string; width: number; height: number }[] = [
  { label: "1080p", width: 1920, height: 1080 },
  { label: "720p", width: 1280, height: 720 },
  { label: "480p", width: 854, height: 480 },
];

// Admin control for the 24/7 Twitch renderer. Writes the desired broadcast
// state; the standalone renderer service polls it, drives a headless browser +
// ffmpeg, and reports live status back here (refreshed every few seconds).
export function BroadcastPage() {
  const [state, setState] = useState<BroadcastStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Draft form values (seeded from the server, edited locally until applied).
  const [account, setAccount] = useState("");
  const [width, setWidth] = useState(1920);
  const [height, setHeight] = useState(1080);
  const [fps, setFps] = useState(30);
  const [bitrate, setBitrate] = useState(6000);
  const seeded = useRef(false);

  async function load() {
    try {
      const s = await api.broadcastGet();
      setState(s);
      setErr(null);
      // Seed the form once, so live polling doesn't stomp the operator's edits.
      if (!seeded.current) {
        setAccount(s.account?.username ?? s.accountUserId ?? "");
        setWidth(s.width); setHeight(s.height); setFps(s.fps); setBitrate(s.bitrateKbps);
        seeded.current = true;
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  async function apply(patch: BroadcastPatch, okMsg: string) {
    setBusy(true);
    try {
      const s = await api.broadcastSet(patch);
      setState(s);
      setErr(null);
      void notify(okMsg);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      setErr(msg);
      void notify(`Failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  }

  const draftPatch = (): BroadcastPatch => ({ account: account.trim() || null, width, height, fps, bitrateKbps: bitrate });
  const goLive = () => apply({ ...draftPatch(), enabled: true }, "Broadcast started");
  const stop = () => apply({ enabled: false }, "Broadcast stopped");
  const applySettings = () => apply(draftPatch(), "Settings applied");

  const live = state?.live ?? false;
  const enabled = state?.enabled ?? false;
  // Only trust `streamKeyReady` when the typed account still matches the one
  // the server evaluated — otherwise let the server validate on Go live.
  const appliedAccount = state?.account?.username ?? state?.accountUserId ?? "";
  const accountUnchanged = account.trim() === appliedAccount;
  const goLiveBlocked = busy || !account.trim() || (accountUnchanged && !state?.streamKeyReady);
  const enc = state?.status?.encoder;
  const startedAt = state?.status?.startedAt ?? null;

  return (
    <div className="broadcast-page">
      <div className="page-head">
        <h2>Broadcast</h2>
        <p className="dim">
          Drive the 24/7 Twitch stream. This sets what the renderer service should do; the renderer
          opens the account in a headless browser and pushes video to Twitch. The Twitch key lives only
          on the renderer service — it is never entered here.
        </p>
      </div>

      {err && <div className="broadcast-err">{err}</div>}

      {/* ── Status ─────────────────────────────────────────────── */}
      <div className="broadcast-card">
        <div className="broadcast-status-row">
          <span className={`broadcast-pill ${live ? "on" : enabled ? "pending" : "off"}`}>
            {live ? "● LIVE" : enabled ? "… CONNECTING" : "○ OFFLINE"}
          </span>
          {enabled && !live && state?.statusStale && (
            <span className="dim small">renderer not reporting — is the service running?</span>
          )}
          <span className="broadcast-spacer" />
          {enabled ? (
            <button className="btn-danger" onClick={stop} disabled={busy}>Stop broadcast</button>
          ) : (
            <button
              className="btn-primary"
              onClick={goLive}
              disabled={goLiveBlocked}
              title={goLiveBlocked && accountUnchanged && !state?.streamKeyReady ? "The selected account has no enabled stream login yet" : ""}
            >
              Go live
            </button>
          )}
        </div>

        <div className="broadcast-stats">
          <Stat label="Account" value={state?.account ? `${state.account.name ?? state.account.username} (@${state.account.username})` : "—"} />
          <Stat label="Stream login" value={state?.streamKeyReady ? "✓ ready" : "✗ none — set one up in Users"} warn={!state?.streamKeyReady} />
          <Stat label="Output" value={`${state?.width ?? width}×${state?.height ?? height} @ ${state?.fps ?? fps}fps · ${(state?.bitrateKbps ?? bitrate)}k`} />
          <Stat label="Uptime" value={live && startedAt ? formatUptime(Date.now() - startedAt) : "—"} />
          <Stat label="Encoder" value={enc ? `${enc.fps ?? "?"}fps · ${enc.bitrate ?? "?"} · ${enc.speed ?? "?"}` : "—"} />
          <Stat label="Dropped frames" value={enc?.dropped != null ? String(enc.dropped) : "—"} warn={!!enc?.dropped && enc.dropped > 0} />
          <Stat label="Music tracks" value={state?.status?.music != null ? String(state.status.music) : "—"} />
          <Stat label="Restarts" value={state?.status?.restarts != null ? String(state.status.restarts) : "—"} />
        </div>
        {state?.status?.lastError && (
          <div className="broadcast-lasterr">Last error: {state.status.lastError}</div>
        )}
      </div>

      {/* ── Settings ───────────────────────────────────────────── */}
      <div className="broadcast-card">
        <h3>Settings</h3>
        <div className="broadcast-field">
          <label>Account (username)</label>
          <input
            value={account}
            onChange={(e) => setAccount(e.target.value.trim())}
            placeholder="e.g. StreamBot"
            disabled={busy}
          />
          <span className="dim small">The account the stream plays. It must have an enabled stream login (Users → its page → Stream login).</span>
        </div>

        <div className="broadcast-field">
          <label>Resolution</label>
          <div className="broadcast-btn-row">
            {RES_PRESETS.map((r) => (
              <button
                key={r.label}
                className={`btn-ghost btn-small ${width === r.width && height === r.height ? "sel" : ""}`}
                onClick={() => { setWidth(r.width); setHeight(r.height); }}
                disabled={busy}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        <div className="broadcast-field">
          <label>Frame rate</label>
          <div className="broadcast-btn-row">
            {[30, 60].map((f) => (
              <button key={f} className={`btn-ghost btn-small ${fps === f ? "sel" : ""}`} onClick={() => setFps(f)} disabled={busy}>
                {f}fps
              </button>
            ))}
            <span className="dim small">60fps costs ~2× the encode for a near-static idle UI — 30 looks identical.</span>
          </div>
        </div>

        <div className="broadcast-field">
          <label>Bitrate (kbps)</label>
          <input
            type="number"
            value={bitrate}
            min={1500}
            max={9000}
            step={500}
            onChange={(e) => setBitrate(Number(e.target.value) || 6000)}
            disabled={busy}
          />
          <span className="dim small">Twitch non-partner recommended max ≈ 6000. Higher may buffer for viewers.</span>
        </div>

        <div className="broadcast-btn-row">
          <button className="btn-secondary" onClick={applySettings} disabled={busy}>
            Apply settings{enabled ? " (restarts encoder)" : ""}
          </button>
        </div>
      </div>

      {/* ── Live browser (click into the streamed page) ────────────── */}
      <LiveBrowserCard />

      {/* ── Remote control (drive the streamed account) ────────────── */}
      {state?.accountUserId && (
        <div className="broadcast-card">
          <StreamRemoteControl userId={state.accountUserId} />
        </div>
      )}

      {/* ── Stream layout ──────────────────────────────────────────── */}
      {state?.accountUserId && <StreamLayoutCard userId={state.accountUserId} />}

      {/* ── Twitch channel info ────────────────────────────────────── */}
      <TwitchCard />

      <div className="broadcast-help">
        <h4>How it works</h4>
        <ol>
          <li>Give the streaming account an enabled <strong>Stream login</strong> on its Users page, and set its self-play config (start route, auto-buy balls, etc.).</li>
          <li>Deploy the <code>renderer</code> service on Railway with <code>TWITCH_STREAM_KEY</code>, <code>SERVER_URL</code> and <code>RENDERER_TOKEN</code> set.</li>
          <li>Pick the account here, choose quality, and hit <strong>Go live</strong>. Steer gameplay (fight E4, raids, travel) from the account's Users page — Remote control.</li>
        </ol>
      </div>
    </div>
  );
}

// Live browser control — shows a periodic screenshot of the streamed page and
// relays clicks/scroll/keystrokes back to it. Frames are only captured while
// this panel is open (the fetch itself signals "watching" to the renderer).
const MODIFIER_KEYS = new Set([
  "Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "NumLock", "ScrollLock", "ContextMenu", "Dead",
]);

function LiveBrowserCard() {
  const [on, setOn] = useState(false);
  const [frame, setFrame] = useState<string | null>(null);
  const [ageMs, setAgeMs] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Input errors get their own slot — the 1s frame poll would otherwise clear
  // a failed click's message before the operator ever saw it.
  const [inputErr, setInputErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const inputErrTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Self-scheduling poll: only one request in flight at a time, and an
  // out-of-order response can never render an older frame over a newer one.
  useEffect(() => {
    if (!on) { setFrame(null); setAgeMs(null); return; }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastAt = 0;
    const tick = async () => {
      try {
        const r = await api.broadcastFrame();
        if (cancelled) return;
        const at = r.at ?? Date.now();
        if (at >= lastAt) {
          lastAt = at;
          setFrame(r.frame);
          setAgeMs(r.ageMs ?? null);
        }
        setErr(null);
      } catch (e) {
        if (!cancelled) setErr(e instanceof ApiError ? e.message : String(e));
      } finally {
        if (!cancelled) timer = setTimeout(tick, 1000);
      }
    };
    tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [on]);

  useEffect(() => () => { if (inputErrTimer.current) clearTimeout(inputErrTimer.current); }, []);

  function flagInputErr(msg: string) {
    setInputErr(msg);
    if (inputErrTimer.current) clearTimeout(inputErrTimer.current);
    inputErrTimer.current = setTimeout(() => setInputErr(null), 6000);
  }

  async function send(command: Parameters<typeof api.broadcastInput>[0], quiet = true) {
    setBusy(true);
    try {
      await api.broadcastInput(command);
      setInputErr(null);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      flagInputErr(msg);
      // A full queue / server error is worth a toast even for "quiet" input —
      // it means nothing is getting through, not just this one click.
      const status = e instanceof ApiError ? (e as unknown as { status?: number }).status : undefined;
      if (!quiet || status === 429 || (status ?? 0) >= 500) void notify(`Failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  }

  // Translate a mouse event on the preview image into normalised page coords.
  function coordsFrom(e: React.MouseEvent): { x: number; y: number } | null {
    const el = imgRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    };
  }

  // One admin click = exactly one page click. (A double-click also fires the
  // single-click event first, so branching on e.detail relayed 3 clicks.)
  function onImgClick(e: React.MouseEvent) {
    const c = coordsFrom(e);
    if (c) void send({ kind: "click", x: c.x, y: c.y });
  }

  // Wheel events fire in bursts; coalesce them into one command per ~120ms so
  // a single scroll gesture can't fill the server's 50-slot input queue.
  const wheelAcc = useRef(0);
  const wheelPos = useRef<{ x: number; y: number } | null>(null);
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function flushWheel() {
    wheelTimer.current = null;
    const dy = Math.round(wheelAcc.current);
    wheelAcc.current = 0;
    const p = wheelPos.current;
    if (p && dy) void send({ kind: "scroll", x: p.x, y: p.y, dy });
  }
  function onWheel(e: React.WheelEvent) {
    const c = coordsFrom(e);
    if (!c) return;
    // deltaMode 1 = lines, 2 = pages — normalise both to CSS pixels, else
    // line-scrolling browsers (Firefox) scroll ~30× too little.
    const pageH = imgRef.current?.getBoundingClientRect().height || 800;
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? pageH : 1;
    wheelPos.current = c;
    wheelAcc.current += e.deltaY * scale;
    if (!wheelTimer.current) wheelTimer.current = setTimeout(flushWheel, 120);
  }

  // Keystrokes while the preview is focused go to the streamed page. Printable
  // single characters are typed; everything else is sent as a named key.
  function onKeyDown(e: React.KeyboardEvent) {
    // Escape releases focus rather than being relayed — otherwise capturing
    // Tab (which the streamed page legitimately needs) would trap the
    // keyboard here with no way out. The Esc BUTTON still sends a real Escape.
    if (e.key === "Escape") { e.preventDefault(); stageRef.current?.blur(); return; }
    if (MODIFIER_KEYS.has(e.key)) return;          // Shift/Ctrl/... alone: nothing to send
    if (e.repeat) return;                          // ignore auto-repeat floods
    // AltGr (and macOS Option) legitimately produce printable characters.
    const altGr = (e.ctrlKey && e.altKey) || e.getModifierState?.("AltGraph");
    if (!altGr && (e.metaKey || e.ctrlKey || e.altKey)) return;
    e.preventDefault();
    if (e.key.length === 1) void send({ kind: "type", text: e.key });
    else void send({ kind: "key", key: e.key });
  }

  // A frame older than a few seconds is a frozen picture, not a live view —
  // clicking it would send coordinates derived from stale content.
  const stale = ageMs != null && ageMs > 5000;

  return (
    <div className="broadcast-card broadcast-card-wide">
      <div className="broadcast-status-row">
        <h3 style={{ margin: 0 }}>Live browser</h3>
        <span className="broadcast-spacer" />
        {on && ageMs != null && <span className="dim small">frame {Math.round(ageMs / 100) / 10}s old</span>}
        <button className={on ? "btn-danger btn-small" : "btn-primary btn-small"} onClick={() => setOn(!on)}>
          {on ? "Stop control" : "Start control"}
        </button>
      </div>

      {!on ? (
        <p className="dim small">
          Opens a live view of the streamed browser so you can click into the game, scroll and type.
          Capturing frames costs renderer CPU, so it only runs while this is on.
        </p>
      ) : (
        <>
          {err && <div className="broadcast-lasterr">{err}</div>}
          {inputErr && <div className="broadcast-lasterr">input: {inputErr}</div>}
          <div
            ref={stageRef}
            className="live-browser-stage"
            tabIndex={0}
            onKeyDown={onKeyDown}
            title="Click to interact · click here first, then type to send keystrokes · Esc releases focus"
          >
            {frame ? (
              <>
                <img
                  ref={imgRef}
                  className={`live-browser-img${stale ? " stale" : ""}`}
                  src={`data:image/jpeg;base64,${frame}`}
                  alt="Streamed browser"
                  onClick={onImgClick}
                  onWheel={onWheel}
                  draggable={false}
                />
                {stale && (
                  <div className="live-browser-stale-tag">
                    frame {Math.round((ageMs ?? 0) / 1000)}s old — renderer not responding
                  </div>
                )}
              </>
            ) : (
              <div className="live-browser-empty dim">Waiting for a frame from the renderer…</div>
            )}
          </div>
          <div className="broadcast-btn-row" style={{ marginTop: 10 }}>
            <button className="btn-ghost btn-small" disabled={busy} onClick={() => void send({ kind: "reload" }, false)}>Reload page</button>
            <button className="btn-ghost btn-small" disabled={busy} onClick={() => void send({ kind: "home" }, false)}>Back to game</button>
            <button className="btn-ghost btn-small" disabled={busy} onClick={() => void send({ kind: "key", key: "Escape" }, false)}>Esc</button>
            <button className="btn-ghost btn-small" disabled={busy} onClick={() => void send({ kind: "key", key: "Enter" }, false)}>Enter</button>
            <span className="dim small">Click the image to click the page · scroll to scroll · focus it and type to send keys</span>
          </div>
        </>
      )}
    </div>
  );
}

// Twitch channel controls — title, category, tags via the server's Helix
// integration. Renders a "not configured" hint until the server env is set.
function TwitchCard() {
  const [info, setInfo] = useState<TwitchInfo | null>(null);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const seeded = useRef(false);

  async function load() {
    try {
      const i = await api.twitchGet();
      setInfo(i);
      setErr(i.error ?? null);
      if (i.channel && !seeded.current) {
        setTitle(i.channel.title);
        setCategory(i.channel.gameName);
        setTags(i.channel.tags.join(", "));
        seeded.current = true;
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }
  useEffect(() => { load(); }, []);

  async function save() {
    setBusy(true); setErr(null);
    try {
      const i = await api.twitchSet({ title, gameName: category, tags });
      setInfo(i);
      if (i.channel) {
        setTitle(i.channel.title);
        setCategory(i.channel.gameName);
        setTags(i.channel.tags.join(", "));
      }
      void notify("Twitch channel updated");
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      setErr(msg);
      void notify(`Failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  }

  if (info && !info.configured) {
    return (
      <div className="broadcast-card">
        <h3>Twitch channel</h3>
        <p className="dim small">
          Not configured. Set <code>TWITCH_CLIENT_ID</code>, <code>TWITCH_CLIENT_SECRET</code> and{" "}
          <code>TWITCH_REFRESH_TOKEN</code> (scope <code>channel:manage:broadcast</code>) on the server service
          to control the title, category and tags from here.
        </p>
      </div>
    );
  }

  return (
    <div className="broadcast-card">
      <h3>Twitch channel</h3>
      {err && <div className="broadcast-lasterr">{err}</div>}
      <div className="broadcast-field">
        <label>Title</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} placeholder="Pokémon Idle — 24/7 auto-play" style={{ maxWidth: 480 }} disabled={busy} />
      </div>
      <div className="broadcast-field">
        <label>Category</label>
        <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Pokémon FireRed/LeafGreen" disabled={busy} />
        <span className="dim small">Must match an existing Twitch category name exactly.</span>
      </div>
      <div className="broadcast-field">
        <label>Tags</label>
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="comma, separated, tags" disabled={busy} />
        <span className="dim small">Up to 10 · alphanumeric · ≤25 chars each.</span>
      </div>
      <div className="broadcast-btn-row">
        <button className="btn-primary" onClick={save} disabled={busy}>Save to Twitch</button>
        {info?.channel && <span className="dim small">Live now: {info.channel.title || "—"} · {info.channel.gameName || "—"}</span>}
      </div>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="broadcast-stat">
      <span className="broadcast-stat-label">{label}</span>
      <span className={`broadcast-stat-value ${warn ? "warn" : ""}`}>{value}</span>
    </div>
  );
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// Which desktop layout the STREAMED browser boots into. This has to live in
// the account's stream config rather than the game's own device preference:
// the renderer opens a fresh browser context on every launch, so anything
// stored client-side is back at the default each time the stream restarts.
function StreamLayoutCard({ userId }: { userId: string }) {
  const [cfg, setCfg] = useState<StreamConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    api.streamKeyGet(userId)
      .then((r) => { if (!dead) setCfg(r.config ?? {}); })
      .catch((e) => { if (!dead) setErr(e instanceof ApiError ? e.message : String(e)); });
    return () => { dead = true; };
  }, [userId]);

  async function pick(layout: "classic" | "wide") {
    setBusy(true);
    try {
      // Merge, never replace: this endpoint takes the WHOLE config, so
      // sending just the layout would wipe startRoute/auto-buy/speed.
      const next: StreamConfig = { ...(cfg ?? {}), layout };
      const r = await api.streamKeySet(userId, "config", { config: next });
      setCfg(r.config ?? next);
      setErr(null);
      void notify(`Stream layout set to ${layout}. Restart the stream to apply.`);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      setErr(msg);
      void notify(`Failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  }

  const active = cfg?.layout ?? "classic";
  return (
    <div className="broadcast-card">
      <h3>Stream layout</h3>
      {err && <div className="broadcast-lasterr">{err}</div>}
      <div className="broadcast-btn-row">
        {(["classic", "wide"] as const).map((id) => (
          <button
            key={id}
            className={`btn-ghost btn-small ${active === id ? "sel" : ""}`}
            disabled={busy || !cfg}
            onClick={() => pick(id)}
          >
            {id === "classic" ? "Classic" : "Wide"}
          </button>
        ))}
        <span className="dim small">
          Applies on the stream's next boot — hit Stop then Go live to switch immediately.
        </span>
      </div>
    </div>
  );
}
