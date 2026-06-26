import { useEffect, useRef, useState } from "react";
import {
  usePvpState,
  chooseBattleAction,
  cancelBattle,
  clearBattleRoom,
  type BattleRoom,
  type BattleLogEntry,
} from "../state/pvp";
import { pokemonSpriteUrl } from "../utils/sprites";
import { moves as movesTable } from "../data/moves";
import { openPublicTrainerCard } from "./TrainerCardModal";

// Live PvP battle UI. Mounts whenever the pvp store has an active
// `room`. The actual simulation runs server-side via @pkmn/sim — this
// component is a spectator that:
//   1. Decodes |request| payloads into a move/switch picker
//   2. Renders both Pokémon's HP from the protocol stream
//   3. Forwards the player's choice via chooseBattleAction()
//
// On result.winnerId resolution we show a quick toast then auto-close.
export function PvpBattleModal() {
  const { room } = usePvpState();
  if (!room) return null;
  return <PvpBattleDialog room={room} />;
}

function PvpBattleDialog({ room }: { room: BattleRoom }) {
  const [confirmingForfeit, setConfirmingForfeit] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll the battle log on every new event.
  useEffect(() => {
    if (!logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [room.log.length]);

  // Auto-close shortly after the result lands, so the player isn't
  // stuck on the dead modal.
  useEffect(() => {
    if (!room.result) return;
    const t = setTimeout(() => clearBattleRoom(), 4000);
    return () => clearTimeout(t);
  }, [room.result]);

  // Verdict: the server sends winnerId as one side's real userId.
  // The client doesn't keep its own userId in the room state, but it
  // does keep the opponent's. So "did I win?" reduces to "is the
  // winnerId NOT the opponent's id?". This is what the original
  // `sideUserId` helper was supposed to express — its old "self"
  // sentinel could never match a real userId, so EVERY winner saw
  // "You lose.". Side-affinity comparison fixes both verdict text
  // and the rating-delta pill that keys off it.
  const youAmI = (id: string | null) => {
    if (id === null) return null;
    return id !== room.opponent.id;
  };
  const verdict = room.result
    ? room.result.winnerId === null
      ? "Cancelled"
      : youAmI(room.result.winnerId)
        ? "You win!"
        : "You lose."
    : null;

  // Pull HP / fainted snapshot from the |request| payload — the server
  // updates `request` after every protocol turn so it's the freshest
  // structured view of both teams.
  const myActive = room.request?.active?.[0];
  const mySidePoke = room.request?.side?.pokemon ?? [];
  const myActiveMon = mySidePoke.find((p) => p.active) ?? null;
  // Foe's active mon is announced in the protocol log; we pull the
  // most recent switch/drag for the OTHER side.
  const foeMon = lastFoeSwitch(room.log, room.side);
  const onChoose = (choice: string) => chooseBattleAction(room.battleId, choice);
  const isWaiting = !!room.request?.wait;
  const forceSwitch = room.request?.forceSwitch?.some(Boolean) ?? !!myActive?.forceSwitch;

  return (
    <div className="modal-overlay">
      <div
        className="g-modal pvp-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="PvP battle"
      >
        <header className="g-modal-head">
          <h2>
            Battle vs{" "}
            <button
              type="button"
              className="pvp-opponent-link"
              onClick={() => openPublicTrainerCard(room.opponent.username)}
              title={`View ${room.opponent.username}'s trainer card`}
            >
              <strong>{room.opponent.username}</strong>
            </button>
          </h2>
          {!room.result && room.turnDeadlineAt && <TurnTimer deadline={room.turnDeadlineAt} />}
          <button
            className="g-modal-close"
            onClick={() => setConfirmingForfeit(true)}
            aria-label="Forfeit"
            title="Forfeit"
            disabled={!!room.result}
          >×</button>
        </header>

        {confirmingForfeit && !room.result && (
          <div className="trade-cancel-confirm" role="alertdialog">
            <span>Forfeit the battle? Your opponent gets the win.</span>
            <div className="trade-cancel-confirm-actions">
              <button className="g-btn-ghost g-btn-small" onClick={() => setConfirmingForfeit(false)}>Keep fighting</button>
              <button className="g-btn-danger-ghost g-btn-small" onClick={() => { setConfirmingForfeit(false); cancelBattle(room.battleId); }}>Yes, forfeit</button>
            </div>
          </div>
        )}

        <div className="g-modal-body">
          <div className="pvp-board">
            <div className="pvp-side pvp-side-foe">
              <div className="pvp-side-name">{room.opponent.username}</div>
              {foeMon ? (
                <PvpFighter name={foeMon.name} speciesKey={foeMon.speciesKey} hpPct={foeMon.hpPct} status={foeMon.status} faint={foeMon.faint} />
              ) : (
                <div className="dim small">Waiting for opponent…</div>
              )}
            </div>
            <div className="pvp-side pvp-side-you">
              <div className="pvp-side-name">You</div>
              {myActiveMon ? (
                <PvpFighter
                  name={cleanName(myActiveMon.ident)}
                  speciesKey={detailsToSpeciesKey(myActiveMon.details)}
                  hpPct={parseConditionPct(myActiveMon.condition)}
                  status={parseConditionStatus(myActiveMon.condition)}
                  faint={myActiveMon.condition.includes("fnt")}
                />
              ) : (
                <div className="dim small">Loading your Pokémon…</div>
              )}
            </div>
          </div>

          <section className="g-card g-card-full pvp-log-card">
            <h3>Battle log</h3>
            <div className="pvp-log" ref={logRef}>
              {room.log.length === 0 && <div className="dim small">Waiting for the first turn…</div>}
              {room.log.map((entry, i) => <LogLine key={i} entry={entry} />)}
            </div>
          </section>

          {!room.result && (
            <section className="g-card g-card-full pvp-chooser-card">
              {isWaiting && <p className="dim">Waiting for opponent's choice…</p>}

              {!isWaiting && forceSwitch && mySidePoke.length > 0 && (
                <SwitchPicker
                  pokemon={mySidePoke}
                  onChoose={(slot) => onChoose(`switch ${slot + 1}`)}
                  disabledOnly={false}
                />
              )}

              {!isWaiting && !forceSwitch && myActive && (
                <MovePicker
                  active={myActive}
                  pokemon={mySidePoke}
                  onMove={(idx) => onChoose(`move ${idx + 1}`)}
                  onSwitch={(slot) => onChoose(`switch ${slot + 1}`)}
                />
              )}

              {!isWaiting && !forceSwitch && !myActive && (
                <p className="dim">Pick your team order…</p>
              )}
            </section>
          )}

          {verdict && (
            <div className="pvp-verdict" role="status">
              <strong>{verdict}</strong>
              {room.result?.reason === "forfeit" && <span className="dim small"> (forfeit)</span>}
              {room.result?.reason === "timeout" && <span className="dim small"> (timeout)</span>}
              {room.result?.ratingDelta && (
                <RatingDeltaPill room={room} verdict={verdict} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Move + switch pickers ──────────────────────────────────────────
interface ActiveMove { move: string; id: string; pp: number; maxpp: number; target: string; disabled?: boolean }
interface SidePokemon { ident: string; details: string; condition: string; active: boolean; stats: Record<string, number>; moves: string[]; ability: string; item: string; pokeball?: string }
interface ActiveSlot { moves: ActiveMove[]; canDynamax?: boolean; canTera?: boolean; forceSwitch?: boolean; trapped?: boolean }

function MovePicker({
  active, pokemon, onMove, onSwitch,
}: {
  active: ActiveSlot;
  pokemon: SidePokemon[];
  onMove: (idx: number) => void;
  onSwitch: (slot: number) => void;
}) {
  return (
    <>
      <h3>Pick a move</h3>
      <div className="pvp-moves">
        {active.moves.map((m: ActiveMove, i: number) => {
          const def = movesTable[m.id];
          const type = def?.type;
          return (
            <button
              key={`${m.id}-${i}`}
              className={`pvp-move ${type ? `move-type-${type.toLowerCase()}` : ""}`}
              onClick={() => onMove(i)}
              disabled={!!m.disabled || m.pp <= 0}
              title={def?.name ?? m.move}
            >
              <span className="pvp-move-name">{m.move}</span>
              <span className="pvp-move-meta">
                <span>{type ?? "?"}</span>
                <span>{m.pp}/{m.maxpp} PP</span>
              </span>
            </button>
          );
        })}
      </div>
      {pokemon.length > 1 && (
        <details className="pvp-switch-details">
          <summary>Switch out instead</summary>
          <SwitchPicker pokemon={pokemon} onChoose={onSwitch} disabledOnly />
        </details>
      )}
    </>
  );
}

function SwitchPicker({
  pokemon, onChoose, disabledOnly,
}: {
  pokemon: SidePokemon[];
  onChoose: (slot: number) => void;
  disabledOnly: boolean;
}) {
  return (
    <div className="pvp-switch-grid">
      {pokemon.map((p: SidePokemon, idx: number) => {
        const fainted = p.condition.includes("fnt");
        const active = p.active;
        const disable = active || fainted || (disabledOnly && active);
        const speciesKey = detailsToSpeciesKey(p.details);
        return (
          <button
            key={p.ident}
            className={`pvp-switch-card ${active ? "active" : ""} ${fainted ? "fainted" : ""}`}
            disabled={disable}
            onClick={() => onChoose(idx)}
            title={cleanName(p.ident)}
          >
            <img
              src={pokemonSpriteUrl(speciesKey, false, false)}
              alt=""
              width={48}
              height={48}
              style={{ imageRendering: "pixelated" }}
            />
            <div className="pvp-switch-info">
              <strong>{cleanName(p.ident)}</strong>
              <small>{p.condition}</small>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ─── Fighter card ──────────────────────────────────────────────────
function PvpFighter({
  name, speciesKey, hpPct, status, faint,
}: { name: string; speciesKey: string; hpPct: number; status: string | null; faint: boolean }) {
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

// Per-turn countdown badge. Reads the server-supplied deadline + ticks
// every second. Goes red in the last 30 seconds. The server still owns
// enforcement — this is purely UX; we never short-circuit a choice
// based on the local timer reaching zero.
function TurnTimer({ deadline }: { deadline: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const remainingMs = Math.max(0, deadline - now);
  const seconds = Math.ceil(remainingMs / 1000);
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  const urgent = remainingMs < 30_000;
  return (
    <span
      className={`pvp-turn-timer ${urgent ? "urgent" : ""}`}
      title={`Take a turn within ${seconds}s — afterwards you forfeit.`}
    >
      {min}:{sec.toString().padStart(2, "0")}
    </span>
  );
}

function RatingDeltaPill({ room, verdict }: { room: BattleRoom; verdict: string }) {
  const delta = room.result?.ratingDelta;
  if (!delta) return null;
  // Both sides see the SAME ratingDelta payload. Pick which delta is
  // mine: the winner gets aDelta (server-side aDelta is always the
  // positive winner delta — see endBattle's applyEloUpdate call).
  const youWon = verdict === "You win!";
  const myDelta = youWon ? delta.aDelta : delta.bDelta;
  const myRating = youWon ? delta.aRating : delta.bRating;
  const sign = myDelta >= 0 ? "+" : "";
  return (
    <div className="pvp-verdict-rating">
      <span className={`pvp-verdict-delta ${myDelta >= 0 ? "up" : "down"}`}>
        {sign}{myDelta}
      </span>
      <small className="dim">→ {myRating}</small>
    </div>
  );
}

function LogLine({ entry }: { entry: BattleLogEntry }) {
  if (entry.kind === "other" || entry.kind === "request") return null;
  return (
    <div className={`pvp-log-line pvp-log-${entry.kind} ${entry.side ? `side-${entry.side}` : ""}`}>
      {entry.text ?? entry.raw}
    </div>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────
function cleanName(ident: string): string {
  // "p1a: Pikachu" or "p2a: Squirtle" → "Pikachu"
  const colon = ident.indexOf(":");
  return colon >= 0 ? ident.slice(colon + 1).trim() : ident;
}

function detailsToSpeciesKey(details: string): string {
  // "Pikachu, L50, M, shiny" → "pikachu"
  // Handle Mr. Mime / Nidoran-F / etc — strip non-alphanum.
  const head = details.split(",")[0]?.trim() ?? "";
  return head.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseConditionPct(condition: string): number {
  // "256/258" → ~99.2; "0 fnt" → 0; "256/258 brn" → ~99.2
  if (condition.includes("fnt")) return 0;
  const m = condition.match(/(\d+)\/(\d+)/);
  if (!m) return 100;
  const cur = parseInt(m[1], 10);
  const max = parseInt(m[2], 10);
  return max > 0 ? (cur / max) * 100 : 100;
}

function parseConditionStatus(condition: string): string | null {
  for (const s of ["brn", "psn", "tox", "par", "slp", "frz"]) {
    if (condition.includes(s)) return s;
  }
  return null;
}

// Walk the log backwards to find the last switch event for the OTHER
// side, so we can render the foe's current Pokémon.
function lastFoeSwitch(
  log: BattleLogEntry[],
  mySide: "a" | "b",
): { name: string; speciesKey: string; hpPct: number; status: string | null; faint: boolean } | null {
  const foeSide = mySide === "a" ? "b" : "a";
  let currentName: string | null = null;
  let speciesKey: string | null = null;
  let hpPct = 100;
  let status: string | null = null;
  let faint = false;
  for (const entry of log) {
    if ((entry.kind === "switch") && entry.side === foeSide) {
      // Raw line: "|switch|p2a:Bulbasaur|Bulbasaur, L50, M|256/258"
      const parts = entry.raw.split("|");
      const ident = parts[2] ?? "";
      const details = parts[3] ?? "";
      const cond = parts[4] ?? "100/100";
      currentName = cleanName(ident);
      speciesKey = detailsToSpeciesKey(details);
      hpPct = parseConditionPct(cond);
      status = parseConditionStatus(cond);
      faint = cond.includes("fnt");
    }
    // Update HP / status for current foe mon as further events arrive.
    if (currentName && entry.side === foeSide) {
      const parts = entry.raw.split("|");
      if (entry.kind === "damage" || entry.kind === "heal") {
        const cond = parts[3] ?? "";
        hpPct = parseConditionPct(cond);
      }
      if (entry.kind === "status") {
        status = parts[3] ?? null;
      }
      if (entry.kind === "faint") {
        faint = true;
        hpPct = 0;
      }
    }
  }
  return currentName && speciesKey ? { name: currentName, speciesKey, hpPct, status, faint } : null;
}
