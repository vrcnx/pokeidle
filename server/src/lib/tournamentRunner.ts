// Tournament round runner — the thing that makes a bracket actually run.
//
// ─── Why this exists ────────────────────────────────────────────────
//
// The bracket scaffolding shipped as a set of admin buttons: generate a
// bracket, click "Start match" on each pairing, click "Advance bracket".
// That works for a hand-run showmatch and for nothing else, because it
// assumes both players in a pairing are online at the same moment that
// an operator is watching the dashboard.
//
// This game has ~2,300 accounts, ~34 of them online in any given hour
// and ~74 across a whole day. A synchronous 16-player single-elim draw
// needs 16 specific people in the same 20 minutes. That is roughly half
// of everyone who will be online all hour, all of whom have to be the
// RIGHT half. It will not happen, and when it half-happens the bracket
// freezes on the one pairing whose second player went to bed.
//
// So the format is asynchronous:
//
//   * A round is a WINDOW, not a moment. Tournament.roundWindowMinutes
//     (default 24h) is how long every pairing in the current round has
//     to get played.
//   * Inside the window the runner watches for co-presence. The instant
//     both players of a pairing are online, have a party, and are not
//     already in a battle, it spawns the match and both clients drop
//     straight into the existing PvP battle UI (`battle:start`). Nobody
//     coordinates anything; you just have to log in some time today.
//   * At the deadline, unplayed pairings are DECIDED rather than left to
//     rot — see decideNoShow(). The bracket always makes forward
//     progress on wall-clock time.
//   * Seeding is by ELO (assigned at generate-bracket time), so the
//     no-show tie-break "higher seed advances" is a real ordering
//     rather than a coin flip on cuid ordering.
//
// ─── Every stall this closes ────────────────────────────────────────
//
// A bracket match is a dead end whenever it holds a battleId but will
// never produce a winner. Before this file, every one of these froze a
// tournament forever (the match can't be restarted — start-bracket-match
// 409s on `battleId` — and can't be advanced — there's no winner):
//
//   * turn timeout with nobody moving   → PvpMatch completed, winner null
//   * a tie (mutual KO)                 → PvpMatch completed, winner null
//   * either player cancels the invite  → PvpMatch cancelled
//   * server restart mid-battle         → no PvpMatch row at all, and the
//                                         in-memory room is gone
//
// reapDeadBattles() detects all four and hands the match back to the
// scheduler, up to MAX_BATTLE_ATTEMPTS; after that the match is decided
// the same way a no-show is.

import { prisma } from "../db.js";
import {
  advanceBracket,
  championOf,
  currentRoundIndex,
  openMatches,
  participants,
  MAX_BATTLE_ATTEMPTS,
  type Bracket,
  type BracketMatch,
  type MatchResult,
} from "./bracket.js";
import {
  battleRooms,
  newBattleId,
  startBattle,
  type BattleRoom,
} from "../pvp.js";
import { getIo, isOnline, sendToUserGlobal } from "../socket.js";
import { enqueuePrizeGrant } from "./prizeGrant.js";
import { parsePrizes, describePrizes } from "./giveaway.js";
import { recordError } from "./errorReporting.js";
import { audit } from "./audit.js";

/** How often the runner sweeps. Short enough that two players who are
 *  briefly online together get paired before one of them wanders off,
 *  long enough that it is invisible next to everything else the server
 *  does per tick. */
const TICK_MS = 15_000;

/** A battle spawned by the runner that has produced no PvpMatch row and
 *  is no longer in memory after this long is presumed lost to a restart,
 *  and its bracket match is handed back to the scheduler. */
const ORPHAN_BATTLE_MS = 20 * 60_000;

/** How long a reaped pairing waits before the runner spawns another
 *  battle for it. Without this, a pairing that dies instantly (engine
 *  refusal, a client that connects and immediately drops) burns every
 *  attempt inside two ticks and then just waits for the deadline — the
 *  players never get a real chance even though they were both there. */
const RETRY_BACKOFF_MS = 3 * 60_000;

/** Hard ceiling on a single battle. @pkmn/sim's own per-turn watchdog
 *  (5 minutes, see pvp.ts) already bounds a real game far below this;
 *  anything still "pending" an hour after it was spawned is a room that
 *  is never going to report, and it is the last way a bracket could sit
 *  still forever. Reap it and let the normal deadline logic decide. */
const BATTLE_MAX_MS = 60 * 60_000;

/** Sanity floor/ceiling on the round window, applied when reading the
 *  column so a bad value can't produce a zero-length round (every match
 *  instantly a no-show) or an infinite one. */
const MIN_ROUND_MINUTES = 5;
const MAX_ROUND_MINUTES = 60 * 24 * 14; // two weeks

export interface RunnerAction {
  kind: "started" | "advanced" | "walkover" | "reaped" | "completed" | "deadline-armed";
  tournamentId: string;
  matchId?: string;
  detail?: string;
}

// ─── Presence + readiness ───────────────────────────────────────────
// Injected so the harness can drive the whole runner without a socket
// server, and so tests can script "who is online" per tick.

export interface RunnerEnv {
  /** Is this user connected right now? */
  isOnline(userId: string): boolean;
  /** Epoch ms this user was last seen, or null if never. */
  lastSeenAt(userId: string): Promise<number | null>;
  /** Spawn a real battle for this pairing. Returns the battleId, or a
   *  reason it could not start. */
  startMatch(
    t: TournamentRow,
    match: BracketMatch,
  ): Promise<{ ok: true; battleId: string } | { ok: false; reason: string }>;
  /** Outcome of a previously-spawned battle. `startedAt` is when the
   *  runner spawned it, so an implementation can tell "not finished yet"
   *  from "this was lost to a restart". */
  battleOutcome(battleId: string, startedAt: number | null): Promise<BattleOutcome>;
  now(): number;
}

export type BattleOutcome =
  /** Still running (or still an unaccepted invite). */
  | { state: "pending" }
  /** Finished with a winner. */
  | { state: "won"; winnerId: string }
  /** Finished with NO winner — tie, double timeout, cancellation — or
   *  vanished entirely (restart). The match must be handed back. */
  | { state: "dead"; reason: string };

export interface TournamentRow {
  id: string;
  name: string;
  status: string;
  levelCap: number | null;
  roundWindowMinutes: number;
  bracket: string | null;
}

// ─── The sweep ──────────────────────────────────────────────────────

/**
 * Drive one tournament forward by one tick. Pure orchestration: reads
 * the bracket, asks the env about presence and battle outcomes, writes
 * the bracket back. Safe to call as often as you like — every step is
 * idempotent, and a step that has nothing to do costs one JSON parse.
 *
 * Returns the actions taken, which the caller logs and the harness
 * asserts on.
 */
export async function tickTournament(
  t: TournamentRow,
  env: RunnerEnv,
  persist: (patch: {
    bracket: string;
    status?: string;
    finishedAt?: Date;
    championId?: string;
    championUsername?: string;
  }) => Promise<void>,
  markEliminated: (userIds: string[]) => Promise<void>,
): Promise<RunnerAction[]> {
  const actions: RunnerAction[] = [];
  if (t.status !== "live" || !t.bracket) return actions;

  let bracket: Bracket;
  try {
    bracket = JSON.parse(t.bracket) as Bracket;
  } catch {
    void recordError({
      kind: "server",
      message: "tournament_bracket_corrupt",
      source: "tournamentRunner.tick",
      meta: { tournamentId: t.id },
    });
    return actions;
  }
  if (!Array.isArray(bracket.rounds) || bracket.rounds.length === 0) return actions;

  const now = env.now();
  const results: Record<string, MatchResult> = {};
  let dirty = false;

  // 1. Collect results from every battle we have in flight, and reap the
  //    ones that died without producing a winner.
  for (const round of bracket.rounds) {
    for (const m of round.matches) {
      if (m.winnerId || !m.battleId) continue;
      const outcome = await env.battleOutcome(m.battleId, m.battleStartedAt ?? null);
      let reason: string | null = null;
      if (outcome.state === "won") {
        results[m.id] = { winnerId: outcome.winnerId, by: "battle" };
        continue;
      }
      if (outcome.state === "dead") {
        reason = outcome.reason;
      } else if (m.battleStartedAt != null && now - m.battleStartedAt > BATTLE_MAX_MS) {
        // Still "pending" an hour in. A real game cannot last this long
        // under a 5-minute per-turn watchdog, so this room is never
        // going to report. Left alone it blocks the deadline branch
        // below (which refuses to decide a match with a live battle)
        // and the round never ends.
        reason = "battle never reported an outcome";
      }
      if (reason == null) continue;
      // Dead battle. Hand the match back so it can be replayed, after a
      // short cool-off, unless we've already burned our attempts on it.
      m.battleId = null;
      m.battleStartedAt = null;
      m.attempts = (m.attempts ?? 0) + 1;
      m.retryAfter = now + RETRY_BACKOFF_MS;
      m.note = `attempt ${m.attempts} ended without a winner (${reason})`;
      dirty = true;
      actions.push({ kind: "reaped", tournamentId: t.id, matchId: m.id, detail: reason });
    }
  }

  // 2. Apply whatever we collected. Do this BEFORE arming deadlines so a
  //    round that just finished hands over to the next one on the same
  //    tick rather than a tick later.
  if (Object.keys(results).length > 0) {
    const adv = advanceBracket(bracket, results);
    bracket = adv.bracket;
    dirty = true;
    if (adv.eliminatedUserIds.length > 0) await markEliminated(adv.eliminatedUserIds);
    actions.push({
      kind: "advanced",
      tournamentId: t.id,
      detail: `${Object.keys(results).length} result(s), ${adv.eliminatedUserIds.length} eliminated`,
    });
  }

  // 3. Arm the current round's deadline if it hasn't been armed yet. A
  //    round's clock starts when the round OPENS (i.e. when every match
  //    feeding it has resolved), not when the tournament started —
  //    otherwise round 3 of a 24h-per-round event would already be
  //    overdue the moment it opened.
  const windowMs = clampRoundMinutes(t.roundWindowMinutes) * 60_000;
  for (const m of openMatches(bracket)) {
    if (m.deadlineAt == null && participants(m)) {
      m.deadlineAt = now + windowMs;
      dirty = true;
      actions.push({
        kind: "deadline-armed",
        tournamentId: t.id,
        matchId: m.id,
        detail: new Date(m.deadlineAt).toISOString(),
      });
    }
  }

  // 4. Start any pairing whose players are BOTH online right now.
  for (const m of openMatches(bracket)) {
    if (m.battleId || m.winnerId) continue;
    const p = participants(m);
    if (!p) continue;
    if ((m.attempts ?? 0) >= MAX_BATTLE_ATTEMPTS) continue; // decided at the deadline instead
    if (m.retryAfter != null && now < m.retryAfter) continue; // cooling off after a dead battle
    if (!env.isOnline(p.a.userId) || !env.isOnline(p.b.userId)) continue;
    const started = await env.startMatch(t, m);
    if (started.ok) {
      m.battleId = started.battleId;
      m.battleStartedAt = now;
      dirty = true;
      actions.push({ kind: "started", tournamentId: t.id, matchId: m.id, detail: started.battleId });
    } else {
      // Not fatal — most reasons are transient (already in a friend
      // battle, empty party, engine hiccup). We retry next tick, and the
      // deadline is the backstop if it never resolves.
      //
      // Only mark the bracket dirty when the note actually changes: a
      // player parked in a long friend battle would otherwise rewrite
      // the same string to the database every 15 seconds for hours.
      const note = `could not start: ${started.reason}`;
      if (m.note !== note) {
        m.note = note;
        dirty = true;
      }
    }
  }

  // 5. Enforce the deadline. Anything still unresolved past it is decided
  //    rather than left to freeze the event.
  const overdue: Record<string, MatchResult> = {};
  for (const m of openMatches(bracket)) {
    if (m.winnerId) continue;
    if (m.deadlineAt == null || now < m.deadlineAt) continue;
    if (m.battleId) continue; // a battle is genuinely in flight — let it finish
    const p = participants(m);
    if (!p) continue;
    const decision = await decideNoShow(m, p.a, p.b, env, windowMs);
    overdue[m.id] = { winnerId: decision.winnerId, by: "walkover", note: decision.reason };
    actions.push({
      kind: "walkover",
      tournamentId: t.id,
      matchId: m.id,
      detail: `${decision.winnerId} — ${decision.reason}`,
    });
  }
  if (Object.keys(overdue).length > 0) {
    const adv = advanceBracket(bracket, overdue);
    bracket = adv.bracket;
    dirty = true;
    if (adv.eliminatedUserIds.length > 0) await markEliminated(adv.eliminatedUserIds);
  }

  // 6. Champion?
  const champion = championOf(bracket);
  if (champion) {
    const championUsername = usernameOf(bracket, champion);
    await persist({
      bracket: JSON.stringify(bracket),
      status: "completed",
      finishedAt: new Date(now),
      championId: champion,
      championUsername,
    });
    actions.push({ kind: "completed", tournamentId: t.id, detail: `${championUsername} (${champion})` });
    return actions;
  }

  if (dirty) await persist({ bracket: JSON.stringify(bracket) });
  return actions;
}

/**
 * Decide an unplayed pairing whose round window has expired.
 *
 * The ranking is deliberately "who actually turned up", because that is
 * the behaviour we want to reward in an asynchronous event, and only
 * falls back to seed when presence cannot separate them:
 *
 *   +4  online right now
 *   +2  seen at all during this round's window
 *
 * Ties (both showed, neither showed, both online but never coincided —
 * which really does happen when someone is stuck in a long friend
 * battle) go to the better ELO seed. A no-show is never a coin flip and
 * never a stall.
 */
export async function decideNoShow(
  m: BracketMatch,
  a: { userId: string; username: string; seed: number },
  b: { userId: string; username: string; seed: number },
  env: RunnerEnv,
  windowMs: number,
): Promise<{ winnerId: string; reason: string }> {
  const windowStart = (m.deadlineAt ?? env.now()) - windowMs;
  const [aSeen, bSeen] = await Promise.all([env.lastSeenAt(a.userId), env.lastSeenAt(b.userId)]);
  const score = (userId: string, seen: number | null) =>
    (env.isOnline(userId) ? 4 : 0) + (seen != null && seen >= windowStart ? 2 : 0);
  const aScore = score(a.userId, aSeen);
  const bScore = score(b.userId, bSeen);

  if (aScore !== bScore) {
    const win = aScore > bScore ? a : b;
    const lose = aScore > bScore ? b : a;
    return {
      winnerId: win.userId,
      reason: `no-show: ${lose.username} did not appear inside the round window; ${win.username} advances`,
    };
  }
  const win = a.seed <= b.seed ? a : b;
  const lose = a.seed <= b.seed ? b : a;
  return {
    winnerId: win.userId,
    reason: aScore === 0
      ? `double no-show: neither player appeared; higher seed (#${win.seed} ${win.username}) advances over #${lose.seed} ${lose.username}`
      : `round window expired without a battle; higher seed (#${win.seed} ${win.username}) advances over #${lose.seed} ${lose.username}`,
  };
}

export function clampRoundMinutes(n: number): number {
  if (!Number.isFinite(n)) return 1440;
  return Math.min(MAX_ROUND_MINUTES, Math.max(MIN_ROUND_MINUTES, Math.floor(n)));
}

export function usernameOf(bracket: Bracket, userId: string): string {
  for (const r of bracket.rounds) {
    for (const m of r.matches) {
      for (const s of [m.a, m.b]) {
        if (s.kind === "player" && s.userId === userId && s.username) return s.username;
      }
    }
  }
  return userId;
}

// ─── Production environment ─────────────────────────────────────────

export const liveEnv: RunnerEnv = {
  isOnline,
  now: () => Date.now(),

  async lastSeenAt(userId) {
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: { lastSeenAt: true },
    });
    return u?.lastSeenAt ? u.lastSeenAt.getTime() : null;
  },

  async battleOutcome(battleId, startedAt) {
    // The in-memory room is the live truth and must be consulted first,
    // INCLUDING when it has already finished.
    //
    // endBattle() writes the PvpMatch row fire-and-forget and only drops
    // the room from memory five seconds later. A tick landing inside
    // that window sees a finished room and a row that has not committed
    // yet. Falling straight through to the DB there would read "no such
    // match", call it a vanished battle, and replay a pairing that had
    // in fact just been won.
    const room = battleRooms.get(battleId);
    if (room) {
      if (room.status === "active" || room.status === "invited") return { state: "pending" };
      if (room.winnerId) return { state: "won", winnerId: room.winnerId };
      return { state: "dead", reason: room.endReason ?? room.status };
    }

    const pm = await prisma.pvpMatch.findUnique({
      where: { id: battleId },
      select: { winnerId: true, status: true, endReason: true },
    });
    if (pm) {
      if (pm.status === "completed" && pm.winnerId) {
        return { state: "won", winnerId: pm.winnerId };
      }
      // Completed-with-no-winner (tie, double timeout) or cancelled.
      // Both used to freeze the bracket permanently; both are now
      // reaped and replayed by the caller.
      return { state: "dead", reason: pm.endReason ?? pm.status };
    }

    // No row and no room. Either the row is still in flight, or the
    // process restarted and took the room with it. Wait out the grace
    // period rather than reaping early — reaping early would spawn a
    // second battle for a pairing that is still being played.
    if (startedAt != null && Date.now() - startedAt > ORPHAN_BATTLE_MS) {
      return { state: "dead", reason: "battle vanished (server restart?)" };
    }
    return { state: "pending" };
  },

  async startMatch(t, match) {
    return startTournamentBattle(t, match);
  },
};

/**
 * Spawn a real, server-authoritative tournament battle for a bracket
 * pairing. Shared by the runner and the admin "Start match" button so
 * there is exactly one place that knows the preconditions.
 *
 * Refuses (rather than creating a doomed room) when either player is
 * offline. The old admin route documented "both participants must be
 * online" and then never checked — starting a match against an offline
 * player burned the pairing: it got a battleId (so it could not be
 * restarted) and timed out with no winner (so it could not be
 * advanced).
 */
export async function startTournamentBattle(
  t: { id: string; levelCap: number | null },
  match: BracketMatch,
): Promise<{ ok: true; battleId: string } | { ok: false; reason: string }> {
  const p = participants(match);
  if (!p) return { ok: false, reason: "match still has unresolved placeholders" };
  if (match.battleId) return { ok: false, reason: "match already has a battle" };
  if (match.winnerId) return { ok: false, reason: "match already resolved" };
  if (!isOnline(p.a.userId)) return { ok: false, reason: `${p.a.username} is offline` };
  if (!isOnline(p.b.userId)) return { ok: false, reason: `${p.b.username} is offline` };

  const [aUser, bUser] = await Promise.all([
    prisma.user.findUnique({ where: { id: p.a.userId }, select: { id: true, username: true, saveData: true } }),
    prisma.user.findUnique({ where: { id: p.b.userId }, select: { id: true, username: true, saveData: true } }),
  ]);
  if (!aUser || !bUser) return { ok: false, reason: "participant account missing" };

  const teamA = partyOf(aUser.saveData);
  const teamB = partyOf(bUser.saveData);
  if (teamA.length < 1) return { ok: false, reason: `${aUser.username} has no party` };
  if (teamB.length < 1) return { ok: false, reason: `${bUser.username} has no party` };

  for (const room of battleRooms.values()) {
    if (room.status !== "active" && room.status !== "invited") continue;
    if (
      room.a.userId === aUser.id || room.b.userId === aUser.id
      || room.a.userId === bUser.id || room.b.userId === bUser.id
    ) {
      return { ok: false, reason: "one or both participants are already in a battle" };
    }
  }

  const io = getIo();
  if (!io) return { ok: false, reason: "socket server not ready" };

  const battleId = newBattleId();
  const room: BattleRoom = {
    id: battleId,
    status: "invited",
    format: "tournament",
    createdAt: Date.now(),
    lastChoiceAt: Date.now(),
    a: { userId: aUser.id, username: aUser.username, team: teamA as never, stream: null, request: null, connected: true },
    b: { userId: bUser.id, username: bUser.username, team: teamB as never, stream: null, request: null, connected: true },
    log: [],
    stream: null,
    expiryTimer: null,
    spectators: new Set(),
    tournamentId: t.id,
    levelCap: t.levelCap ?? undefined,
  };
  battleRooms.set(battleId, room);

  // "battle:start" is what opens the battle screen, so it only fires
  // once startBattle has accepted the matchup — see the onReady note in
  // pvp.ts. Announcing first meant a refusal showed both players a
  // window that opened and vanished.
  try {
    await startBattle(io, room, sendToUserGlobal, () => {
      sendToUserGlobal(aUser.id, "battle:start", {
        battleId, format: room.format, opponent: { id: bUser.id, username: bUser.username }, you: "a",
        levelCap: t.levelCap ?? null, tournamentId: t.id, bracketMatchId: match.id,
      });
      sendToUserGlobal(bUser.id, "battle:start", {
        battleId, format: room.format, opponent: { id: aUser.id, username: aUser.username }, you: "b",
        levelCap: t.levelCap ?? null, tournamentId: t.id, bracketMatchId: match.id,
      });
    });
    return { ok: true, battleId };
  } catch (e) {
    room.status = "cancelled";
    const detail = e instanceof Error ? e.message : String(e);
    const reason = `Couldn't start the battle: ${detail}`;
    sendToUserGlobal(aUser.id, "battle:cancelled", { battleId, reason });
    sendToUserGlobal(bUser.id, "battle:cancelled", { battleId, reason });
    battleRooms.delete(battleId);
    void recordError({
      kind: "server",
      message: "pvp_start_battle_failed",
      source: "tournamentRunner.startBracketMatch",
      stack: e instanceof Error ? e.stack ?? null : null,
      meta: {
        battleId,
        format: room.format,
        simulatorError: detail,
        tournamentId: t.id,
        bracketMatchId: match.id,
        aUserId: aUser.id, aUsername: aUser.username, aTeamSize: teamA.length,
        bUserId: bUser.id, bUsername: bUser.username, bTeamSize: teamB.length,
      },
    });
    return { ok: false, reason: `engine refused: ${detail}` };
  }
}

function partyOf(saveJson: string | null): unknown[] {
  if (!saveJson) return [];
  try {
    const s = JSON.parse(saveJson);
    return Array.isArray(s?.party) ? s.party : [];
  } catch {
    return [];
  }
}

// ─── DB-backed sweep + loop ─────────────────────────────────────────

type LiveRow = TournamentRow & { ownerId: string };

const LIVE_SELECT = {
  id: true, name: true, status: true, levelCap: true,
  roundWindowMinutes: true, bracket: true, ownerId: true,
} as const;

/** Thrown when a concurrent writer advanced the bracket under us. Not an
 *  error condition — the next tick simply re-reads. */
class BracketRace extends Error {}

async function runOne(t: LiveRow, env: RunnerEnv): Promise<RunnerAction[]> {
  // The bracket is a read-modify-write over one JSON blob with an awaited
  // startMatch in the middle, and five callers can sit in that window at once:
  // the 15s sweep, "Run now", "Advance bracket", "Start bracket match" and
  // "Resolve match". An unconditional update let the loser of that race drop
  // its battleId — the battle was real and live, but the bracket no longer
  // pointed at it, so its result was never read, no attempt counter moved, and
  // the next tick spawned a FRESH battle for a pairing that had already been
  // played. Measured under two overlapping sweeps: 141 orphaned battles, 112
  // committed results discarded, 43 replayed pairings, and once a champion
  // rendered as eliminated.
  //
  // Compare-and-swap on the exact bracket JSON we read. Losing means someone
  // else advanced the same bracket, and their view is newer than ours, so the
  // right move is to drop this tick's conclusions entirely rather than merge
  // them — the next tick re-reads and re-decides from the winner's state.
  let lostRace = false;
  let actions: RunnerAction[];
  try {
  actions = await tickTournament(
    t,
    env,
    async (patch) => {
      const claimed = await prisma.tournament.updateMany({
        where: { id: t.id, bracket: t.bracket },
        data: patch,
      });
      if (claimed.count === 0) {
        lostRace = true;
        throw new BracketRace();
      }
    },
    async (userIds) => {
      await prisma.tournamentEntry.updateMany({
        where: { tournamentId: t.id, userId: { in: userIds } },
        data: { eliminated: true },
      });
    },
  );
  } catch (e) {
    if (e instanceof BracketRace || lostRace) return [];
    throw e;
  }
  for (const a of actions) {
    if (a.kind === "walkover" || a.kind === "completed" || a.kind === "reaped") {
      void audit(t.ownerId, `tournament.${a.kind}`, t.id, { matchId: a.matchId, detail: a.detail });
    }
  }
  if (actions.some((a) => a.kind === "completed")) await onTournamentComplete(t.id);
  return actions;
}

/** Drive ONE tournament forward now. The admin "Run now" button; same
 *  code path as the timer so the two can never diverge. */
export async function tickOneTournament(
  tournamentId: string,
  env: RunnerEnv = liveEnv,
): Promise<RunnerAction[]> {
  const t = await prisma.tournament.findUnique({ where: { id: tournamentId }, select: LIVE_SELECT });
  if (!t) return [];
  return runOne(t, env);
}

/** Run one sweep across every live, auto-run tournament. */
export async function sweepTournaments(env: RunnerEnv = liveEnv): Promise<RunnerAction[]> {
  const live = await prisma.tournament.findMany({
    where: { status: "live", autoRun: true },
    select: LIVE_SELECT,
    take: 20,
  });
  const all: RunnerAction[] = [];
  for (const t of live) {
    try {
      all.push(...await runOne(t, env));
    } catch (e) {
      void recordError({
        kind: "server",
        message: "tournament_tick_failed",
        source: "tournamentRunner.sweep",
        meta: { tournamentId: t.id, error: String((e as Error)?.message ?? e) },
      });
    }
  }
  return all;
}

/**
 * Post-completion side effects: tell the world who won and pay the
 * champion's prize, if one was configured.
 *
 * The prize goes through enqueuePrizeGrant — the same durable inbox
 * giveaways use — and never touches saveData directly. `prizeGrantedAt`
 * is set by a compare-and-swap so a repeated sweep, a retry or two
 * server processes can't pay twice.
 */
export async function onTournamentComplete(tournamentId: string): Promise<void> {
  const t = await prisma.tournament.findUnique({ where: { id: tournamentId } });
  if (!t || !t.championId) return;

  try {
    sendToUserGlobal(t.championId, "tournament:won", {
      tournamentId: t.id,
      name: t.name,
    });
  } catch { /* socket layer optional */ }

  if (!t.prizes || t.prizeGrantedAt) return;
  const prizes = parsePrizes(t.prizes);
  if (prizes.length === 0) return;

  // CAS: only the caller that flips prizeGrantedAt from null gets to pay.
  const claimed = await prisma.tournament.updateMany({
    where: { id: t.id, prizeGrantedAt: null },
    data: { prizeGrantedAt: new Date() },
  });
  if (claimed.count === 0) return;

  try {
    await enqueuePrizeGrant(t.championId, prizes, { source: "tournament", sourceId: t.id });
    void audit(t.ownerId, "tournament.prize_granted", t.id, {
      championId: t.championId,
      summary: describePrizes(prizes),
    });
  } catch (e) {
    // Release the claim so a later sweep (or an operator) can retry.
    await prisma.tournament.updateMany({ where: { id: t.id }, data: { prizeGrantedAt: null } });
    void recordError({
      kind: "server",
      message: "tournament_prize_grant_failed",
      source: "tournamentRunner.onTournamentComplete",
      meta: { tournamentId: t.id, error: String((e as Error)?.message ?? e) },
    });
  }
}

let started = false;
export function startTournamentRunner(): void {
  if (started) return;
  started = true;
  // Returns the promise. It used to swallow it, which is why the interval
  // could overlap itself: an in-flight guard that awaits a void call releases
  // immediately and guards nothing.
  const tick = () => {
    return sweepTournaments().catch((e) => {
      void recordError({
        kind: "server",
        message: "tournament_sweep_failed",
        source: "tournamentRunner.tick",
        meta: { error: String((e as Error)?.message ?? e) },
      });
    });
  };
  // The sweep costs one DB round trip per live event and measured 1.5-7.6s at
  // 20 events, so an un-guarded interval overlapped ITSELF and became one more
  // racer against the bracket write. Skip a beat rather than stacking.
  let inFlight = false;
  const guarded = async () => {
    if (inFlight) return;
    inFlight = true;
    try { await tick(); } finally { inFlight = false; }
  };
  void guarded();
  setInterval(() => { void guarded(); }, TICK_MS);
}

export const __testing = {
  TICK_MS, ORPHAN_BATTLE_MS, RETRY_BACKOFF_MS, BATTLE_MAX_MS,
  MIN_ROUND_MINUTES, MAX_ROUND_MINUTES,
};
