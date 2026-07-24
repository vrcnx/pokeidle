import { useEffect, useRef, useState } from "react";
import { api, ApiError, type BroadcastStatus, type BroadcastPatch, type TwitchInfo } from "../api";
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

      {/* ── Remote control (drive the streamed account) ────────────── */}
      {state?.accountUserId && (
        <div className="broadcast-card">
          <StreamRemoteControl userId={state.accountUserId} />
        </div>
      )}

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
