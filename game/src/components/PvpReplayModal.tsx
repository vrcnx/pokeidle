import { useEffect, useRef, useState } from "react";
import { api, type PvpReplayMatch } from "../net/api";
import { useAuth } from "../auth/AuthContext";
import { useModalEnter } from "../utils/animate";
import { pokemonSpriteUrl } from "../utils/sprites";

// Module-scoped open() so any component (the history list) can launch
// a replay. Holds the match id; the modal fetches the full payload
// from the server on open so the bundle stays slim.
let _openId: string | null = null;
const _listeners = new Set<(id: string | null) => void>();
export function openReplay(matchId: string) {
  _openId = matchId;
  for (const l of _listeners) l(matchId);
}
export function closeReplay() {
  _openId = null;
  for (const l of _listeners) l(null);
}
function useOpenId(): string | null {
  const [id, setId] = useState<string | null>(_openId);
  useEffect(() => {
    _listeners.add(setId);
    return () => { _listeners.delete(setId); };
  }, []);
  return id;
}

// Step rates for the playback control. "instant" jumps to the end
// (no animation), the others advance lines on a wall-clock timer.
const STEP_RATES_MS: Record<string, number> = {
  "1x": 1000,
  "2x": 500,
  "4x": 250,
  instant: 0,
};

// Render a saved match by walking its protocol log line-by-line at
// the chosen speed. Reuses the same battle-fighter layout as the live
// modal so the visual style stays consistent.
//
// Read-only — no choice picker, no socket. The server has already
// frozen the match; this is purely a viewer.
export function PvpReplayModal() {
  const matchId = useOpenId();
  const dialogRef = useModalEnter(".g-card");
  const { me } = useAuth();
  const [match, setMatch] = useState<PvpReplayMatch | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Cursor advances through match.log. Starts at 0; reaches log.length
  // when playback completes. We render every line up to (and
  // including) cursor-1.
  const [cursor, setCursor] = useState(0);
  const [speed, setSpeed] = useState<keyof typeof STEP_RATES_MS>("1x");
  const [paused, setPaused] = useState(false);

  // Load the match payload when the modal opens.
  useEffect(() => {
    if (!matchId) {
      setMatch(null);
      setCursor(0);
      setPaused(false);
      return;
    }
    setBusy(true);
    setErr(null);
    api.matchReplay(matchId)
      .then((d) => setMatch(d.match))
      .catch((e) => setErr(e?.message ?? "Could not load replay."))
      .finally(() => setBusy(false));
  }, [matchId]);

  // Auto-advance the cursor at the configured rate while playing.
  useEffect(() => {
    if (!match || paused || cursor >= match.log.length) return;
    if (speed === "instant") {
      setCursor(match.log.length);
      return;
    }
    const ms = STEP_RATES_MS[speed];
    const t = setTimeout(() => setCursor((c) => Math.min(match.log.length, c + 1)), ms);
    return () => clearTimeout(t);
  }, [match, cursor, speed, paused]);

  // Press Escape to close.
  useEffect(() => {
    if (!matchId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeReplay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [matchId]);

  if (!matchId) return null;

  return (
    <div className="modal-overlay" onClick={closeReplay}>
      <div
        ref={dialogRef}
        className="g-modal pvp-replay-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Match replay"
      >
        <header className="g-modal-head">
          <h2>
            Replay
            {match && (
              <span className="dim small" style={{ marginLeft: 12 }}>
                {match.userAUsername} vs {match.userBUsername}
              </span>
            )}
          </h2>
          <button className="g-modal-close" onClick={closeReplay} aria-label="Close">×</button>
        </header>

        <div className="g-modal-body">
          {busy && <p className="dim">Loading replay…</p>}
          {err && <div className="page-err" style={{ color: "#fca5a5" }}>{err}</div>}
          {match && (
            <ReplayBody
              match={match}
              cursor={cursor}
              meId={me?.id ?? null}
            />
          )}
        </div>

        {match && (
          <footer className="g-modal-foot pvp-replay-foot">
            <button
              className="g-btn-ghost"
              onClick={() => setCursor(0)}
              disabled={cursor === 0}
            >
              ⟲ Restart
            </button>
            <button
              className="g-btn-ghost"
              onClick={() => setPaused((p) => !p)}
              disabled={cursor >= match.log.length}
            >
              {paused ? "▶ Play" : "❚❚ Pause"}
            </button>
            <button
              className="g-btn-ghost"
              onClick={() => setCursor((c) => Math.min(match.log.length, c + 1))}
              disabled={cursor >= match.log.length}
            >
              ⏵ Step
            </button>
            <button
              className="g-btn-ghost"
              onClick={() => setCursor(match.log.length)}
              disabled={cursor >= match.log.length}
            >
              ⏭ End
            </button>
            <span style={{ flex: 1 }} />
            <select
              value={speed}
              onChange={(e) => setSpeed(e.target.value as keyof typeof STEP_RATES_MS)}
            >
              <option value="1x">1x</option>
              <option value="2x">2x</option>
              <option value="4x">4x</option>
              <option value="instant">Instant</option>
            </select>
            <span className="dim small">
              {cursor} / {match.log.length}
            </span>
          </footer>
        )}
      </div>
    </div>
  );
}

// ─── Replay body ────────────────────────────────────────────────────
// Reads the protocol log up to `cursor` and derives:
//   - Each side's currently active mon (last switch event for that side)
//   - HP / status from the most recent damage / heal / status events
//   - The set of log lines to display in the chat-style log panel
//
// We track this in pure state (no refs) so a cursor scrub recomputes
// from scratch — keeps replay honest and idempotent.
function ReplayBody({ match, cursor, meId }: { match: PvpReplayMatch; cursor: number; meId: string | null }) {
  // From the player's POV, "side a" is whichever side I was on if I
  // played in this match; otherwise default to "a" so both sides
  // are visible from the recorder's seat.
  const mySide: "a" | "b" = meId === match.userBId ? "b" : "a";
  const opponentSide: "a" | "b" = mySide === "a" ? "b" : "a";

  const view = simulateLog(match.log.slice(0, cursor), match);

  return (
    <>
      <div className="pvp-board">
        <div className="pvp-side pvp-side-foe">
          <div className="pvp-side-name">{sideUsername(match, opponentSide)}</div>
          {view[opponentSide].active ? (
            <Fighter
              name={view[opponentSide].active!.name}
              speciesKey={view[opponentSide].active!.speciesKey}
              hpPct={view[opponentSide].active!.hpPct}
              status={view[opponentSide].active!.status}
              faint={view[opponentSide].active!.faint}
            />
          ) : (
            <p className="dim small">Waiting for first switch…</p>
          )}
        </div>
        <div className="pvp-side pvp-side-you">
          <div className="pvp-side-name">{sideUsername(match, mySide)}</div>
          {view[mySide].active ? (
            <Fighter
              name={view[mySide].active!.name}
              speciesKey={view[mySide].active!.speciesKey}
              hpPct={view[mySide].active!.hpPct}
              status={view[mySide].active!.status}
              faint={view[mySide].active!.faint}
            />
          ) : (
            <p className="dim small">Waiting for first switch…</p>
          )}
        </div>
      </div>

      <section className="g-card g-card-full pvp-log-card">
        <h3>Battle log</h3>
        <ReplayLog lines={view.lines} mySide={mySide} />
      </section>
    </>
  );
}

function ReplayLog({ lines, mySide }: { lines: string[]; mySide: "a" | "b" }) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Auto-scroll on every new line so the latest event stays visible.
  useEffect(() => {
    if (!ref.current) return;
    ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines.length]);
  return (
    <div className="pvp-log" ref={ref}>
      {lines.length === 0 && <div className="dim small">Press ▶ to start playback.</div>}
      {lines.map((raw, i) => {
        const decoded = decodeForReplay(raw, mySide);
        if (!decoded) return null;
        return (
          <div key={i} className={`pvp-log-line pvp-log-${decoded.kind} ${decoded.side ? `side-${decoded.side}` : ""}`}>
            {decoded.text}
          </div>
        );
      })}
    </div>
  );
}

function Fighter({ name, speciesKey, hpPct, status, faint }: {
  name: string; speciesKey: string; hpPct: number; status: string | null; faint: boolean;
}) {
  const url = pokemonSpriteUrl(speciesKey, false, false);
  const hpClass = hpPct > 50 ? "ok" : hpPct > 20 ? "warn" : "low";
  return (
    <div className={`pvp-fighter ${faint ? "fainted" : ""}`}>
      {url ? (
        <img className="pvp-fighter-sprite" src={url} alt="" style={{ imageRendering: "pixelated" }} />
      ) : (
        <div className="pvp-fighter-sprite missing">?</div>
      )}
      <div className="pvp-fighter-info">
        <strong>{name}</strong>
        <div className={`pvp-fighter-hp ${hpClass}`}>
          <div className="pvp-fighter-hp-fill" style={{ width: `${Math.max(0, Math.min(100, hpPct))}%` }} />
        </div>
        {status && <span className={`pvp-fighter-status status-${status}`}>{status.toUpperCase()}</span>}
      </div>
    </div>
  );
}

// ─── Simulator-on-the-client (replay-only) ────────────────────────
// Walks a slice of the protocol log forward, accumulating per-side
// active-mon state. This is purely a re-render helper — no battle
// resolution, no damage rolls, no decisions.
interface ReplayActive { name: string; speciesKey: string; hpPct: number; status: string | null; faint: boolean; }
interface ReplayView {
  a: { active: ReplayActive | null };
  b: { active: ReplayActive | null };
  lines: string[];
}

function simulateLog(slice: string[], _match: PvpReplayMatch): ReplayView {
  const view: ReplayView = {
    a: { active: null },
    b: { active: null },
    lines: [...slice],
  };
  for (const raw of slice) {
    const parts = raw.split("|");
    if (parts.length < 2) continue;
    const tag = parts[1];
    const sideOf = (token: string | undefined): "a" | "b" | undefined => {
      if (!token) return undefined;
      return token.startsWith("p1") ? "a" : token.startsWith("p2") ? "b" : undefined;
    };
    const side = sideOf(parts[2]);
    if (!side) continue;
    const monName = parts[2].includes(":") ? parts[2].slice(parts[2].indexOf(":") + 1).trim() : parts[2];
    if (tag === "switch" || tag === "drag") {
      const details = parts[3] ?? "";
      const cond = parts[4] ?? "100/100";
      const speciesKey = (details.split(",")[0] ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      view[side].active = {
        name: monName,
        speciesKey,
        hpPct: parseHp(cond),
        status: parseStatus(cond),
        faint: cond.includes("fnt"),
      };
    } else if (tag === "-damage" || tag === "-heal") {
      const cond = parts[3] ?? "";
      if (view[side].active) {
        view[side].active!.hpPct = parseHp(cond);
        if (cond.includes("fnt")) view[side].active!.faint = true;
      }
    } else if (tag === "-status") {
      if (view[side].active) view[side].active!.status = parts[3] ?? null;
    } else if (tag === "-curestatus") {
      if (view[side].active) view[side].active!.status = null;
    } else if (tag === "faint") {
      if (view[side].active) {
        view[side].active!.faint = true;
        view[side].active!.hpPct = 0;
      }
    }
  }
  return view;
}

function parseHp(cond: string): number {
  if (cond.includes("fnt")) return 0;
  const m = cond.match(/(\d+)\/(\d+)/);
  if (!m) return 100;
  const cur = parseInt(m[1], 10);
  const max = parseInt(m[2], 10);
  return max > 0 ? (cur / max) * 100 : 100;
}
function parseStatus(cond: string): string | null {
  for (const s of ["brn", "psn", "tox", "par", "slp", "frz"]) {
    if (cond.includes(s)) return s;
  }
  return null;
}

// ─── Per-line render for the chat log ─────────────────────────────
function decodeForReplay(line: string, mySide: "a" | "b"): { kind: string; text: string; side?: "a" | "b" } | null {
  const parts = line.split("|");
  if (parts.length < 2) return null;
  const tag = parts[1];
  const sideOf = (token: string | undefined): "a" | "b" | undefined => {
    if (!token) return undefined;
    return token.startsWith("p1") ? "a" : token.startsWith("p2") ? "b" : undefined;
  };
  const cleanName = (token: string | undefined): string => {
    if (!token) return "";
    const colon = token.indexOf(":");
    return colon >= 0 ? token.slice(colon + 1).trim() : token;
  };
  const yourTheir = (s: "a" | "b" | undefined) => s === mySide ? "Your" : s ? "Foe's" : "";

  switch (tag) {
    case "move": {
      const side = sideOf(parts[2]);
      return {
        kind: "move", side,
        text: `${yourTheir(side)} ${cleanName(parts[2])} used ${parts[3] ?? "?"}`,
      };
    }
    case "switch":
    case "drag": {
      const side = sideOf(parts[2]);
      return { kind: "switch", side, text: `${yourTheir(side)} sent out ${cleanName(parts[2])}.` };
    }
    case "-damage": {
      const side = sideOf(parts[2]);
      return { kind: "damage", side, text: `${yourTheir(side)} ${cleanName(parts[2])}: ${parts[3] ?? ""}` };
    }
    case "-heal": {
      const side = sideOf(parts[2]);
      return { kind: "heal", side, text: `${yourTheir(side)} ${cleanName(parts[2])} healed (${parts[3] ?? ""})` };
    }
    case "-status": {
      const side = sideOf(parts[2]);
      return { kind: "status", side, text: `${yourTheir(side)} ${cleanName(parts[2])} is ${parts[3] ?? ""}.` };
    }
    case "faint": {
      const side = sideOf(parts[2]);
      return { kind: "faint", side, text: `${yourTheir(side)} ${cleanName(parts[2])} fainted.` };
    }
    case "turn":
      return { kind: "turn", text: `── Turn ${parts[2]} ──` };
    case "win":
      return { kind: "win", text: `${parts[2]} wins!` };
    case "tie":
      return { kind: "tie", text: "It's a tie." };
    default:
      return null;
  }
}

function sideUsername(match: PvpReplayMatch, side: "a" | "b"): string {
  return side === "a" ? match.userAUsername : match.userBUsername;
}
