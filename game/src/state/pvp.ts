import { useEffect, useState } from "react";
import { getSocket } from "../net/socket";
import type { Pokemon } from "../types";

// Module-scoped state for an in-flight PvP battle. Mirrors the trade
// store's design — module-level singleton with React subscribers — so
// any component can render off the live battle without prop-drilling
// through the dashboard.

export type BattleFormat = "anything-goes" | "random50" | "tournament";

export interface BattleInvite {
  battleId: string;
  from: { id: string; username: string };
  format: BattleFormat;
  expiresAt: number;
}

export interface QueueState {
  position: number;
  queueSize: number;
  joinedAt: number;
}

export interface BattleRoom {
  battleId: string;
  format: string;
  opponent: { id: string; username: string };
  /** Which seat we are — server ground truth, used to know which
   *  protocol lines to ignore (the OTHER side's privileged info). */
  side: "a" | "b";
  /** Latest Showdown |request| payload. Drives the move/switch picker. */
  request: BattleRequest | null;
  /** Accumulated protocol lines for the battle log. */
  log: BattleLogEntry[];
  /** Final outcome — null while battle is live. */
  result: { winnerId: string | null; loserId: string | null; reason: string } | null;
}

export interface BattleRequest {
  // Showdown's |request| protocol — full shape varies, but for v1 we
  // only render `active[].moves` and `side.pokemon` as the picker.
  active?: Array<{
    moves: Array<{ move: string; id: string; pp: number; maxpp: number; target: string; disabled?: boolean }>;
    canDynamax?: boolean;
    canTera?: boolean;
    forceSwitch?: boolean;
    trapped?: boolean;
  }>;
  forceSwitch?: boolean[];
  side?: {
    name: string;
    id: string;
    pokemon: Array<{
      ident: string; details: string; condition: string;
      active: boolean; stats: Record<string, number>;
      moves: string[]; ability: string; item: string;
      pokeball?: string;
    }>;
  };
  rqid?: number;
  noCancel?: boolean;
  wait?: boolean;
}

export interface BattleLogEntry {
  // Decoded subset — full Showdown protocol has ~80 line types, we only
  // care about a handful for the v1 UI. Rendering falls through to
  // `raw` for anything we haven't translated yet.
  raw: string;
  kind: "move" | "switch" | "faint" | "damage" | "heal" | "status" | "turn" | "win" | "tie" | "text" | "request" | "error" | "other";
  text?: string;
  side?: "a" | "b";
}

interface PvpState {
  invite: BattleInvite | null;
  room: BattleRoom | null;
  queue: QueueState | null;
  cancelMessage: string | null;
}

const _state: PvpState = { invite: null, room: null, queue: null, cancelMessage: null };
const _listeners = new Set<(s: PvpState) => void>();

function emit() {
  const snap = { ..._state };
  for (const fn of _listeners) fn(snap);
}

export function usePvpState(): PvpState {
  const [s, setS] = useState<PvpState>(_state);
  useEffect(() => {
    _listeners.add(setS);
    return () => { _listeners.delete(setS); };
  }, []);
  return s;
}

// ── Public actions ──────────────────────────────────────────────────

export function sendBattleInvite(
  toUserId: string,
  team: Pokemon[],
  format: BattleFormat = "anything-goes",
  ack?: (r: { ok: boolean; error?: string; battleId?: string }) => void,
) {
  getSocket().emit("battle:invite", { toUserId, team, format }, ack);
}

export function joinRandomQueue(
  team: Pokemon[],
  ack?: (r: { ok: boolean; error?: string }) => void,
) {
  getSocket().emit("battle:queue", { team }, ack);
}

export function leaveRandomQueue(ack?: (r: { ok: boolean }) => void) {
  getSocket().emit("battle:dequeue", {}, ack);
}
export function respondToBattleInvite(
  battleId: string,
  accept: boolean,
  team?: Pokemon[],
  ack?: (r: { ok: boolean; error?: string }) => void,
) {
  getSocket().emit("battle:respond", { battleId, accept, team }, ack);
  if (!accept) {
    _state.invite = null;
    emit();
  }
}
export function dismissBattleInvite() {
  _state.invite = null;
  emit();
}
export function chooseBattleAction(
  battleId: string,
  choice: string,
  ack?: (r: { ok: boolean; error?: string }) => void,
) {
  getSocket().emit("battle:choose", { battleId, choice }, ack);
}
export function cancelBattle(battleId: string) {
  getSocket().emit("battle:cancel", { battleId });
}
export function clearBattleRoom() {
  _state.room = null;
  emit();
}
export function clearBattleCancelMessage() {
  _state.cancelMessage = null;
  emit();
}

// ── Socket bindings ─────────────────────────────────────────────────

let _bound = false;
let _cancelBannerTimer: ReturnType<typeof setTimeout> | null = null;
export function bindPvpSocket() {
  if (_bound) return;
  _bound = true;
  const sock = getSocket();

  sock.on("battle:invite", (payload: BattleInvite) => {
    _state.invite = payload;
    _state.cancelMessage = null;
    emit();
  });

  sock.on(
    "battle:start",
    (payload: { battleId: string; format: string; opponent: { id: string; username: string }; you: "a" | "b" }) => {
      _state.invite = null;
      _state.queue = null;  // matchmaking landed us here
      _state.room = {
        battleId: payload.battleId,
        format: payload.format,
        opponent: payload.opponent,
        side: payload.you,
        request: null,
        log: [],
        result: null,
      };
      _state.cancelMessage = null;
      emit();
    },
  );

  sock.on(
    "battle:state",
    (payload: { battleId: string; side: "a" | "b"; chunk: string; request: BattleRequest | null }) => {
      const room = _state.room;
      if (!room || room.battleId !== payload.battleId) return;
      // The server forwards each side's PRIVATE stream to that side.
      // If we're getting a chunk meant for the other side, ignore it
      // (shouldn't happen in normal flow, but defensive guard).
      if (payload.side !== room.side) return;
      const newEntries: BattleLogEntry[] = [];
      for (const line of payload.chunk.split("\n")) {
        if (!line) continue;
        newEntries.push(decodeProtocolLine(line, room.side));
      }
      _state.room = {
        ...room,
        request: payload.request ?? room.request,
        log: [...room.log, ...newEntries].slice(-200),
      };
      emit();
    },
  );

  sock.on(
    "battle:complete",
    (payload: { battleId: string; winnerId: string | null; loserId: string | null; reason: string }) => {
      const room = _state.room;
      if (!room || room.battleId !== payload.battleId) return;
      _state.room = { ...room, result: payload };
      emit();
    },
  );

  sock.on("battle:queue:joined", (payload: { position: number; queueSize: number }) => {
    _state.queue = {
      position: payload.position,
      queueSize: payload.queueSize,
      joinedAt: Date.now(),
    };
    emit();
  });

  sock.on("battle:queue:left", () => {
    _state.queue = null;
    emit();
  });

  sock.on("battle:cancelled", (payload: { battleId: string; reason: string }) => {
    const affected = _state.invite?.battleId === payload.battleId
      || _state.room?.battleId === payload.battleId;
    if (!affected) return;
    _state.invite = null;
    _state.room = null;
    _state.cancelMessage = payload.reason;
    emit();
    if (_cancelBannerTimer) clearTimeout(_cancelBannerTimer);
    _cancelBannerTimer = setTimeout(() => {
      _cancelBannerTimer = null;
      if (_state.cancelMessage === payload.reason) {
        _state.cancelMessage = null;
        emit();
      }
    }, 5000);
  });
}

// ── Protocol → BattleLogEntry translator ────────────────────────────
// We don't render every Showdown protocol line — most are noise (|t:|,
// |upkeep|, |inactive|...). Translate the meaningful ones into a
// human-readable string the chat-style log can display, and pass the
// rest through as `kind: "other"` so they're available in the raw
// view if needed.
function decodeProtocolLine(line: string, mySide: "a" | "b"): BattleLogEntry {
  // |move|p1a:Pikachu|Thunderbolt|p2a:Bulbasaur
  // |switch|p1a:Pikachu|Pikachu, L50|256/258
  // |-damage|p1a:Pikachu|10/100
  // |-heal|p1a:Pikachu|110/258
  // |-status|p1a:Pikachu|brn
  // |faint|p1a:Pikachu
  // |turn|3
  // |win|trainerName
  // |tie
  const parts = line.split("|");
  if (parts.length < 2) return { raw: line, kind: "text", text: line };
  const tag = parts[1];
  const sideOf = (token: string | undefined): "a" | "b" | undefined => {
    if (!token) return undefined;
    return token.startsWith("p1") ? "a" : token.startsWith("p2") ? "b" : undefined;
  };
  const monName = (token: string | undefined): string => {
    if (!token) return "";
    // "p1a:Pikachu" → "Pikachu"
    const colon = token.indexOf(":");
    return colon >= 0 ? token.slice(colon + 1).trim() : token;
  };
  const yourTheir = (s: "a" | "b" | undefined) =>
    s === mySide ? "Your" : s ? "Foe's" : "";

  switch (tag) {
    case "move": {
      const side = sideOf(parts[2]);
      const mon = monName(parts[2]);
      const move = parts[3] ?? "";
      const tgtMon = monName(parts[4]);
      return {
        raw: line, kind: "move", side,
        text: `${yourTheir(side)} ${mon} used ${move}` + (tgtMon ? ` on ${tgtMon}` : ""),
      };
    }
    case "switch":
    case "drag": {
      const side = sideOf(parts[2]);
      const mon = monName(parts[2]);
      return { raw: line, kind: "switch", side, text: `${yourTheir(side)} sent out ${mon}.` };
    }
    case "-damage": {
      const side = sideOf(parts[2]);
      const mon = monName(parts[2]);
      const cond = parts[3] ?? "";
      return { raw: line, kind: "damage", side, text: `${yourTheir(side)} ${mon}: ${cond}` };
    }
    case "-heal": {
      const side = sideOf(parts[2]);
      const mon = monName(parts[2]);
      const cond = parts[3] ?? "";
      return { raw: line, kind: "heal", side, text: `${yourTheir(side)} ${mon} healed (${cond})` };
    }
    case "-status": {
      const side = sideOf(parts[2]);
      const mon = monName(parts[2]);
      return { raw: line, kind: "status", side, text: `${yourTheir(side)} ${mon} is ${parts[3]}.` };
    }
    case "faint": {
      const side = sideOf(parts[2]);
      const mon = monName(parts[2]);
      return { raw: line, kind: "faint", side, text: `${yourTheir(side)} ${mon} fainted.` };
    }
    case "turn":
      return { raw: line, kind: "turn", text: `── Turn ${parts[2]} ──` };
    case "win":
      return { raw: line, kind: "win", text: `${parts[2]} wins!` };
    case "tie":
      return { raw: line, kind: "tie", text: "It's a tie." };
    case "request":
      return { raw: line, kind: "request" };
    case "error":
      return { raw: line, kind: "error", text: parts.slice(2).join(" | ") };
    default:
      return { raw: line, kind: "other" };
  }
}
