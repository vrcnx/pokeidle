import { useEffect, useState } from "react";
import { getSocket } from "../net/socket";
import type { Pokemon } from "../types";
import {
  initialBattleView,
  applyChunk,
  type BattleView,
  type NarrationLine,
} from "./pvpBattleView";

// Module-scoped state for an in-flight PvP battle. Mirrors the trade
// store's design — module-level singleton with React subscribers — so
// any component can render off the live battle without prop-drilling
// through the dashboard.

// Mirrors server/src/pvp.ts's BattleFormat. "bot" is an AI practice battle:
// never rated, never written to match history, and level-matched to the
// player's own team rather than capped.
export type BattleFormat = "anything-goes" | "random50" | "tournament" | "bot";

/** Is this an AI practice battle?
 *
 *  Derived from the format rather than carried as a second boolean on the room,
 *  deliberately. `format` already arrives on battle:start AND on the
 *  battle:rejoin snapshot, so a reloaded page gets the right answer for free;
 *  a separate `bot` flag would be a second source of truth that only one of
 *  those two paths populated, and the failure mode is the arena telling a
 *  player their practice battle was rated. */
export function isBotBattle(room: { format: string } | null | undefined): boolean {
  return room?.format === "bot";
}

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
  /** Complete decoded battle state — both actives with HP/status/boosts/
   *  volatiles, both benches, hazards, screens, weather, field. This is
   *  what the arena renders; `log` above is the old 11-tag decoder kept
   *  only until PvpBattleModal is retired. */
  view: BattleView;
  /** Human-readable narration produced by the full decoder. */
  narration: NarrationLine[];
  /** Set while the opponent's last socket is gone but their reconnect
   *  grace has not expired. The surviving player must be told something —
   *  otherwise a disconnect looks like the battle hanging. */
  opponentAway: { username: string; graceEndsAt: number } | null;
  /** Set when a server restart voided the battle. The rooms live in an
   *  in-process Map, so a deploy evaporates them: there is nothing to
   *  recover and the honest move is to say so rather than leave a
   *  live-looking screen whose turn timer counts toward a deadline
   *  nobody is enforcing. */
  voided: boolean;
  /** Server-supplied per-turn deadline. The simulator resets this
   *  whenever a fresh |request| arrives; the watchdog forfeits the
   *  side that misses it. UI uses this for a countdown badge. */
  turnDeadlineAt: number | null;
  /** Final outcome — null while battle is live. */
  result: {
    winnerId: string | null;
    loserId: string | null;
    reason: string;
    /** ELO delta when this was a rated match (random50 only). null
     *  for casual / tournament / cancelled matches. The deltas are
     *  signed for the winner (positive) and loser (negative), so the
     *  client can render "+12" / "-12". */
    ratingDelta: { aDelta: number; bDelta: number; aRating: number; bRating: number } | null;
  } | null;
  /** Server-side level cap on the team (only set for matchmaking /
   *  tournament rooms). Used by the client to flag "Lv 50" in the
   *  battle title. */
  levelCap?: number | null;
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

/** Spectated battle — read-only view of an in-progress battle the
 *  user joined as an observer. Distinct from `room` (the player's
 *  own battle) so both can coexist (you can be a participant in one
 *  battle and a spectator on another, in theory; in practice the UI
 *  doesn't expose that). */
export interface SpectateRoom {
  battleId: string;
  format: string;
  a: { userId: string; username: string };
  b: { userId: string; username: string };
  tournamentId: string | null;
  /** Cumulative omniscient log lines. */
  log: BattleLogEntry[];
  /** Set when the battle ends server-side. */
  result: { winnerId: string | null; reason: string } | null;
}

interface PvpState {
  invite: BattleInvite | null;
  room: BattleRoom | null;
  queue: QueueState | null;
  spectate: SpectateRoom | null;
  cancelMessage: string | null;
}

const _state: PvpState = {
  invite: null, room: null, queue: null, spectate: null, cancelMessage: null,
};
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

// ── AI practice ─────────────────────────────────────────────────────
// The matchmaking queue is pure FIFO and needs two people in it at the same
// instant, so "nobody is there" is the ordinary outcome rather than the edge
// case. This is the answer to an empty queue, NOT a replacement for it: the
// real queue stays exactly as it was, and the offer only appears once the
// player is demonstrably alone (see PvpHubModal).
//
// The server picks the trainer and level-matches its team to yours. It answers
// with the label it will show, which always contains " AI" — the player must
// never be able to mistake this for a human.
export interface BotBattleAck {
  ok: boolean;
  error?: string;
  battleId?: string;
  opponent?: string;
  tier?: BotTier;
}
export type BotTier = "rookie" | "trainer";

export function startBotBattle(
  team: Pokemon[],
  opts: { tier?: BotTier; trainer?: string } = {},
  ack?: (r: BotBattleAck) => void,
) {
  getSocket().emit("battle:bot", { team, tier: opts.tier, trainer: opts.trainer }, ack);
}

/** One entry of the AI opponent list.
 *
 *  `fit` and `matched` come from the SERVER's matcher, which is the only thing
 *  that knows how a trainer's pool would be filled against this party — the
 *  same code path battle:bot runs. `fit` is a mean per-slot build distance
 *  (smaller = better matched) and `edge` is type advantage in log2 steps,
 *  positive towards the AI. They exist so the picker can be honest about which
 *  opponents are a fair fight instead of presenting eight identical-looking
 *  choices, one of which used to be unwinnable. */
export interface BotTrainerOption {
  id: string;
  label: string;
  fit?: number;
  edge?: number;
  matched?: boolean;
}

/** `mons` is levels + species only, and only so the server can RANK the
 *  trainers for this party. The real team goes with startBotBattle and is
 *  bounds-validated there. */
export function listBotTrainers(
  mons: { level: number; speciesKey: string }[] | undefined,
  ack: (r: { ok: boolean; trainers?: BotTrainerOption[]; recommended?: string | null }) => void,
) {
  getSocket().emit("battle:bot:trainers", mons && mons.length > 0 ? { mons } : {}, ack);
}

// ── Spectator helpers ──────────────────────────────────────────────
export interface LiveBattleSummary {
  battleId: string;
  format: string;
  a: { userId: string; username: string };
  b: { userId: string; username: string };
  spectatorCount: number;
  startedAt: number;
  tournamentId: string | null;
}

export function listLiveBattles(
  ack: (r: { ok: boolean; battles?: LiveBattleSummary[] }) => void,
) {
  getSocket().emit("battle:list", {}, ack);
}

export function joinSpectator(
  battleId: string,
  ack?: (r: { ok: boolean; error?: string }) => void,
) {
  getSocket().emit("battle:spectate:join", { battleId }, ack);
}

export function leaveSpectator(
  battleId: string,
  ack?: (r: { ok: boolean }) => void,
) {
  getSocket().emit("battle:spectate:leave", { battleId }, ack);
}

export function clearSpectator() {
  _state.spectate = null;
  emit();
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
  // Drop any half-narrated move with the room it belonged to.
  _scratch = { pendingMove: null };
  emit();
}

/** True while a PvP battle owns the screen. Derived from the room rather
 *  than tracked in a second flag: two owners of one boolean with no
 *  idempotent setter is how `paused` became hazardous. */
export function useIsPvpBattle(): boolean {
  return usePvpState().room !== null;
}
export function clearBattleCancelMessage() {
  _state.cancelMessage = null;
  emit();
}

// ── Socket bindings ─────────────────────────────────────────────────

let _bound = false;
let _cancelBannerTimer: ReturnType<typeof setTimeout> | null = null;

// Decoder scratch. A move line is HELD rather than emitted so that the
// |-crit| / |-supereffective| / |-miss| lines that follow it can decorate
// it instead of arriving as separate log entries. That hold has to survive
// across `battle:state` chunks, because the socket splits the stream
// wherever it likes and a move can easily land in a different chunk from
// its own modifiers. Module-scoped for exactly that reason, and reset on
// every battle:start so a new battle can never inherit a half-narrated
// move from the last one.
let _scratch: { pendingMove: NarrationLine | null } = { pendingMove: null };
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
      _scratch = { pendingMove: null };
      _state.room = {
        battleId: payload.battleId,
        format: payload.format,
        opponent: payload.opponent,
        side: payload.you,
        request: null,
        log: [],
        view: initialBattleView("You", payload.opponent.username),
        narration: [],
        opponentAway: null,
        voided: false,
        turnDeadlineAt: null,
        result: null,
      };
      _state.cancelMessage = null;
      emit();
    },
  );

  sock.on(
    "battle:state",
    (payload: {
      battleId: string;
      side: "a" | "b";
      chunk: string;
      request: BattleRequest | null;
      turnDeadlineAt?: number | null;
    }) => {
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
      const decoded = applyChunk(room.view, payload.chunk, room.side, _scratch);
      _state.room = {
        ...room,
        request: payload.request ?? room.request,
        log: [...room.log, ...newEntries].slice(-200),
        view: decoded.view,
        narration: [...room.narration, ...decoded.lines].slice(-300),
        turnDeadlineAt: payload.turnDeadlineAt ?? room.turnDeadlineAt,
      };
      emit();
    },
  );

  sock.on(
    "battle:complete",
    (payload: {
      battleId: string;
      winnerId: string | null;
      loserId: string | null;
      reason: string;
      ratingDelta?: { aDelta: number; bDelta: number; aRating: number; bRating: number } | null;
    }) => {
      const room = _state.room;
      if (!room || room.battleId !== payload.battleId) return;
      _state.room = {
        ...room,
        result: {
          winnerId: payload.winnerId,
          loserId: payload.loserId,
          reason: payload.reason,
          ratingDelta: payload.ratingDelta ?? null,
        },
      };
      emit();
    },
  );

  // ── Opponent connectivity ─────────────────────────────────────
  // A disconnect used to be an instant rated loss. It now opens a grace
  // window, and the surviving player is told — without this they stare at
  // a frozen turn timer, which is a worse experience than the bad loss it
  // replaced.
  sock.on(
    "battle:opponent-away",
    (payload: { battleId: string; username: string; graceEndsAt: number }) => {
      const room = _state.room;
      if (!room || room.battleId !== payload.battleId) return;
      _state.room = {
        ...room,
        opponentAway: { username: payload.username, graceEndsAt: payload.graceEndsAt },
      };
      emit();
    },
  );

  sock.on("battle:opponent-back", (payload: { battleId: string }) => {
    const room = _state.room;
    if (!room || room.battleId !== payload.battleId) return;
    _state.room = { ...room, opponentAway: null };
    emit();
  });

  // Broadcast on every join/leave. The old client rendered "You're alone in
  // the queue" off a one-shot `battle:queue:joined` snapshot, so it stayed
  // wrong for the rest of the wait.
  sock.on("battle:queue:update", (payload: { queueSize: number }) => {
    const q = _state.queue;
    if (!q) return;
    _state.queue = { ...q, queueSize: payload.queueSize };
    emit();
  });

  // ── Reconnect recovery ────────────────────────────────────────
  // Battle rooms are an in-process Map on the server, so there are exactly
  // two possibilities after our socket comes back: the room is still there
  // (a wifi blip — rejoin and carry on) or the process restarted and it is
  // gone forever (a deploy — nothing to recover, say so plainly). Asking is
  // the only way to tell the two apart, and NOT asking is what left players
  // on a live-looking screen whose choices silently no-op.
  sock.on("connect", () => {
    const room = _state.room;
    if (!room || room.result) return;
    sock.emit(
      "battle:rejoin",
      { battleId: room.battleId },
      (r: {
        ok: boolean;
        reason?: string;
        snapshot?: {
          battleId: string; format: string; side: "a" | "b";
          opponent: { id: string; username: string };
          levelCap: number | null;
          request: BattleRequest | null;
          log: string[];
          turnDeadlineAt: number | null;
        };
      }) => {
        const cur = _state.room;
        if (!cur || cur.battleId !== room.battleId) return;
        if (!r?.ok || !r.snapshot) {
          // The battle did not survive. Mark it voided rather than
          // clearing it outright — the player deserves to be told why the
          // screen they were on has gone, and that it was not rated.
          _state.room = { ...cur, voided: true };
          emit();
          return;
        }
        const s = r.snapshot;
        // Rebuild the view from the side-filtered log the server kept.
        // Deliberately NOT the omniscient log: that one carries the
        // opponent's whole team.
        _scratch = { pendingMove: null };
        const rebuilt = applyChunk(
          initialBattleView("You", s.opponent.username),
          s.log.join("\n"),
          s.side,
          _scratch,
        );
        _state.room = {
          ...cur,
          format: s.format,
          side: s.side,
          opponent: s.opponent,
          levelCap: s.levelCap,
          request: s.request,
          view: rebuilt.view,
          narration: rebuilt.lines.slice(-300),
          turnDeadlineAt: s.turnDeadlineAt,
          opponentAway: null,
          voided: false,
        };
        emit();
      },
    );
  });

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

  // ── Spectator events ──────────────────────────────────────────
  sock.on(
    "battle:spectate:start",
    (payload: {
      battleId: string;
      format: string;
      a: { userId: string; username: string };
      b: { userId: string; username: string };
      tournamentId: string | null;
    }) => {
      _state.spectate = {
        battleId: payload.battleId,
        format: payload.format,
        a: payload.a,
        b: payload.b,
        tournamentId: payload.tournamentId,
        log: [],
        result: null,
      };
      emit();
    },
  );

  sock.on(
    "battle:spectate:state",
    (payload: { battleId: string; chunk: string }) => {
      const s = _state.spectate;
      if (!s || s.battleId !== payload.battleId) return;
      const entries: BattleLogEntry[] = [];
      for (const line of payload.chunk.split("\n")) {
        if (!line) continue;
        // Decode using "a" as the user's anchor — spectators don't
        // have a side, so "a" gives a neutral-but-consistent
        // "your/their" framing in the log strings. The fighter
        // cards in the spectator UI use absolute side names.
        entries.push(decodeProtocolLine(line, "a"));
      }
      _state.spectate = {
        ...s,
        log: [...s.log, ...entries].slice(-400),
      };
      emit();
    },
  );

  sock.on(
    "battle:spectate:end",
    (payload: { battleId: string; reason?: string; winnerId?: string | null }) => {
      const s = _state.spectate;
      if (!s || s.battleId !== payload.battleId) return;
      _state.spectate = {
        ...s,
        result: {
          winnerId: payload.winnerId ?? null,
          reason: payload.reason ?? "ended",
        },
      };
      emit();
    },
  );

  sock.on("battle:cancelled", (payload: { battleId: string; reason: string }) => {
    // The server only ever sends this to the two participants, so an id
    // we don't recognise still concerns us — and in the most important
    // case it always is one. The player who SENT a challenge holds no
    // `invite` (they aren't the one being invited) and no `room` yet, so
    // the old "ignore anything I can't match" guard threw away exactly
    // the message that explains why their battle never happened. Clear
    // whatever we do recognise, and always show the reason.
    if (_state.invite?.battleId === payload.battleId) _state.invite = null;
    if (_state.room?.battleId === payload.battleId) _state.room = null;
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
