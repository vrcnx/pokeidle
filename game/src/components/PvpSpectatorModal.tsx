import { useEffect, useRef } from "react";
import {
  usePvpState,
  leaveSpectator,
  clearSpectator,
  type SpectateRoom,
  type BattleLogEntry,
} from "../state/pvp";
import { pokemonSpriteUrl } from "../utils/sprites";
import { useT } from "../i18n/useT";

// Read-only viewer of an in-progress battle as a spectator. Mounts
// whenever pvp state has a `spectate` room. Mirrors PvpBattleModal's
// layout but with no choice picker (we're observers, not players)
// and the live mons are derived from the omniscient log.
//
// "Leave" sends a battle:spectate:leave to the server (so the room's
// spectator set drops us) and clears the local state. We also auto-
// clear after the result lands + a brief grace period.
export function PvpSpectatorModal() {
  const { spectate } = usePvpState();
  if (!spectate) return null;
  return <SpectatorDialog spec={spectate} />;
}

function SpectatorDialog({ spec }: { spec: SpectateRoom }) {
  const logRef = useRef<HTMLDivElement | null>(null);
  const t = useT();

  useEffect(() => {
    if (!logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [spec.log.length]);

  // Auto-close shortly after the result lands.
  useEffect(() => {
    if (!spec.result) return;
    const timer = setTimeout(() => clearSpectator(), 4000);
    return () => clearTimeout(timer);
  }, [spec.result]);

  // Derive each side's currently-active mon from the omniscient log.
  // We track BOTH sides equally — there's no "you / them" here.
  const aMon = lastSwitch(spec.log, "a");
  const bMon = lastSwitch(spec.log, "b");

  const verdict = spec.result
    ? spec.result.winnerId === spec.a.userId ? `${spec.a.username} wins`
    : spec.result.winnerId === spec.b.userId ? `${spec.b.username} wins`
    : t("Battle ended")
    : null;

  const leave = () => {
    leaveSpectator(spec.battleId);
    clearSpectator();
  };

  return (
    <div className="modal-overlay">
      <div
        className="g-modal pvp-modal pvp-spectator-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t("Spectator view")}
      >
        <header className="g-modal-head">
          <h2>
            {t("Spectating")}
            <span className="dim small" style={{ marginLeft: 12 }}>
              {spec.a.username} vs {spec.b.username}
            </span>
          </h2>
          <button className="g-modal-close" onClick={leave} aria-label={t("Leave")}>×</button>
        </header>

        <div className="g-modal-body">
          <div className="pvp-board">
            <div className="pvp-side pvp-side-foe">
              <div className="pvp-side-name">{spec.a.username}</div>
              {aMon ? <Fighter mon={aMon} /> : <div className="dim small">{t("Waiting…")}</div>}
            </div>
            <div className="pvp-side pvp-side-you">
              <div className="pvp-side-name">{spec.b.username}</div>
              {bMon ? <Fighter mon={bMon} /> : <div className="dim small">{t("Waiting…")}</div>}
            </div>
          </div>

          <section className="g-card g-card-full pvp-log-card">
            <h3>{t("Battle log")}</h3>
            <div className="pvp-log" ref={logRef}>
              {spec.log.length === 0 && <div className="dim small">{t("Waiting for the next turn…")}</div>}
              {spec.log.map((entry, i) => <SpectatorLogLine key={i} entry={entry} a={spec.a.username} b={spec.b.username} />)}
            </div>
          </section>

          {verdict && (
            <div className="pvp-verdict" role="status">
              <strong>{verdict}</strong>
            </div>
          )}
        </div>

        <footer className="g-modal-foot">
          <span style={{ flex: 1 }} />
          <button className="g-btn-ghost" onClick={leave}>{t("Leave spectator")}</button>
        </footer>
      </div>
    </div>
  );
}

interface FighterMon { name: string; speciesKey: string; hpPct: number; status: string | null; faint: boolean; }
function Fighter({ mon }: { mon: FighterMon }) {
  const url = pokemonSpriteUrl(mon.speciesKey, false, false);
  const hpClass = mon.hpPct > 50 ? "ok" : mon.hpPct > 20 ? "warn" : "low";
  return (
    <div className={`pvp-fighter ${mon.faint ? "fainted" : ""}`}>
      {url ? (
        <img className="pvp-fighter-sprite" src={url} alt="" style={{ imageRendering: "pixelated" }} />
      ) : (
        <div className="pvp-fighter-sprite missing">?</div>
      )}
      <div className="pvp-fighter-info">
        <strong>{mon.name}</strong>
        <div className={`pvp-fighter-hp ${hpClass}`}>
          <div className="pvp-fighter-hp-fill" style={{ width: `${Math.max(0, Math.min(100, mon.hpPct))}%` }} />
        </div>
        {mon.status && <span className={`pvp-fighter-status status-${mon.status}`}>{mon.status.toUpperCase()}</span>}
      </div>
    </div>
  );
}

function SpectatorLogLine({ entry, a, b }: { entry: BattleLogEntry; a: string; b: string }) {
  if (entry.kind === "other" || entry.kind === "request") return null;
  // Spectator framing: replace "Your"/"Foe's" with the actual usernames
  // since there's no first-person seat. We only rewrite when the
  // decoded text starts with one of those tokens — leave structural
  // lines (Turn N, X wins) untouched.
  let text = entry.text ?? entry.raw;
  if (entry.side === "a" && text.startsWith("Your ")) text = `${a}'s ` + text.slice(5);
  if (entry.side === "a" && text.startsWith("Foe's ")) text = `${a}'s ` + text.slice(6);
  if (entry.side === "b" && text.startsWith("Your ")) text = `${b}'s ` + text.slice(5);
  if (entry.side === "b" && text.startsWith("Foe's ")) text = `${b}'s ` + text.slice(6);
  return (
    <div className={`pvp-log-line pvp-log-${entry.kind} ${entry.side ? `side-${entry.side}` : ""}`}>
      {text}
    </div>
  );
}

// Walk the log to find the latest switch for one side, plus subsequent
// HP / status / faint events.
function lastSwitch(log: BattleLogEntry[], side: "a" | "b"): FighterMon | null {
  let mon: FighterMon | null = null;
  for (const entry of log) {
    if (entry.side !== side) continue;
    const parts = entry.raw.split("|");
    if (entry.kind === "switch") {
      const ident = parts[2] ?? "";
      const details = parts[3] ?? "";
      const cond = parts[4] ?? "100/100";
      const colon = ident.indexOf(":");
      mon = {
        name: colon >= 0 ? ident.slice(colon + 1).trim() : ident,
        speciesKey: (details.split(",")[0] ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, ""),
        hpPct: parseHp(cond),
        status: parseStatus(cond),
        faint: cond.includes("fnt"),
      };
    } else if (mon && (entry.kind === "damage" || entry.kind === "heal")) {
      const cond = parts[3] ?? "";
      mon.hpPct = parseHp(cond);
      if (cond.includes("fnt")) mon.faint = true;
    } else if (mon && entry.kind === "status") {
      mon.status = parts[3] ?? null;
    } else if (mon && entry.kind === "faint") {
      mon.faint = true;
      mon.hpPct = 0;
    }
  }
  return mon;
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
