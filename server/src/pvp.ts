// PvP battle plumbing — mirrors the trade flow's "rooms in memory +
// thin socket events" design, but the heavy lifting (turn resolution,
// damage, status, switching, every Gen-3+ rules edge case) is delegated
// to @pkmn/sim, which runs Showdown's exact simulator code on the
// server. Clients are pure spectators that send move/switch choices.
//
// Why server-authoritative: PvP cheating is the single biggest reason
// to NOT trust the client. With @pkmn/sim running here, the only
// vector left is choice tampering — and even that's bounded because
// the server only accepts choices the simulator says are legal.
//
// Lifecycle:
//   "invited"   — sender pinged receiver, awaiting accept/decline
//   "active"    — both players in, simulator running, awaiting choices
//   "completed" — winner decided + PvpMatch row written
//   "cancelled" — either side cancelled / disconnected mid-battle

import { BattleStreams, Teams } from "@pkmn/sim";
import type { Server } from "socket.io";
import { prisma } from "./db.js";

// ─── Pokémon → Showdown PokemonSet adapter ──────────────────────────
// Maps the game's internal Pokémon shape to the format @pkmn/sim
// expects. Field-by-field: many things rename (speciesKey → species,
// heldItem → item, isShiny → shiny), and the simulator wants stat
// objects keyed by Showdown abbreviations (hp/atk/def/spa/spd/spe).

interface GamePokemonShape {
  speciesKey: string;
  name?: string;
  nickname?: string | null;
  level: number;
  ivs?: { hp: number; attack: number; defense: number; spAttack: number; spDefense: number; speed: number };
  evs?: { hp: number; attack: number; defense: number; spAttack: number; spDefense: number; speed: number };
  nature?: string | null;
  ability?: string | null;
  heldItem?: string | null;
  moves?: { id: string }[];
  isShiny?: boolean;
}

export function pokemonToShowdownSet(p: GamePokemonShape): {
  name: string;
  species: string;
  item: string;
  ability: string;
  moves: string[];
  nature: string;
  evs: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number };
  ivs: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number };
  level: number;
  shiny: boolean;
  gender: string;
} {
  // Showdown move ids are de-hyphenated lowercase ids ("u-turn" → "uturn").
  // Our move ids match, so we just pass them through. Empty moveset
  // (admin-granted mons) gets a Tackle fallback so the simulator
  // doesn't reject the team for "no moves".
  const moveIds = (p.moves ?? []).map((m) => m.id).filter(Boolean);
  const moves = moveIds.length > 0 ? moveIds : ["tackle"];

  return {
    name: p.nickname ?? p.name ?? p.speciesKey,
    species: p.speciesKey,
    item: p.heldItem ?? "",
    ability: p.ability ?? "",
    moves,
    nature: p.nature ?? "Hardy",
    evs: {
      hp:  p.evs?.hp ?? 0,
      atk: p.evs?.attack ?? 0,
      def: p.evs?.defense ?? 0,
      spa: p.evs?.spAttack ?? 0,
      spd: p.evs?.spDefense ?? 0,
      spe: p.evs?.speed ?? 0,
    },
    ivs: {
      hp:  p.ivs?.hp ?? 31,
      atk: p.ivs?.attack ?? 31,
      def: p.ivs?.defense ?? 31,
      spa: p.ivs?.spAttack ?? 31,
      spd: p.ivs?.spDefense ?? 31,
      spe: p.ivs?.speed ?? 31,
    },
    level: p.level,
    shiny: !!p.isShiny,
    gender: "",
  };
}

// ─── Battle room ─────────────────────────────────────────────────────
export interface BattleSide {
  userId: string;
  username: string;
  team: GamePokemonShape[];
  /** Per-player write stream from @pkmn/sim. `null` until battle starts. */
  stream: { write: (data: string) => void } | null;
  /** Last legal request payload for this side (parsed from |request| line),
   *  used by the client to render the move/switch chooser. */
  request: unknown | null;
  /** Connection state — disconnect → forfeit. */
  connected: boolean;
}

export interface BattleRoom {
  id: string;
  status: "invited" | "active" | "completed" | "cancelled";
  format: string;
  createdAt: number;
  /** Last activity — used by the AFK / timeout watchdog. */
  lastChoiceAt: number;
  a: BattleSide;
  b: BattleSide;
  /** Battle log accumulated as Showdown protocol lines. Persisted on
   *  completion so we can rewatch the match. */
  log: string[];
  /** The omniscient battle stream (sees both sides + spectator output).
   *  Null until both sides accept. Held so we can pump it from outside
   *  the io callback context. */
  stream: { write: (data: string) => void; destroy: () => void } | null;
  /** Watchdog timer for invite TTL / per-turn timeout. */
  expiryTimer: NodeJS.Timeout | null;
  /** Final outcome, set when status === "completed". */
  winnerId?: string;
  loserId?: string;
  endReason?: "ko" | "forfeit" | "timeout" | "cancelled";
  /** Optional tournament linkage — set by the bracket runner when the
   *  match was created from a tournament round. */
  tournamentId?: string;
  /** Tournament-format level cap. Ignored for anything-goes / random50
   *  (those use the format default). Only meaningful when format ===
   *  "tournament" and a cap was set on the source Tournament row. */
  levelCap?: number;
}

export const battleRooms = new Map<string, BattleRoom>();
const INVITE_TTL_MS = 60_000;
const TURN_TIMEOUT_MS = 5 * 60_000;

export function newBattleId(): string {
  return `b_${Math.random().toString(16).slice(2, 11)}`;
}

// ─── Format → level-cap rules ────────────────────────────────────────
// The simulator accepts any level we hand it; the original Pokémon in
// the user's save aren't touched. So a "level cap" is just clamping the
// level field on each PokemonSet before passing it to @pkmn/sim.
//
//   anything-goes : no cap, ship the team as-is
//   random50      : every mon clamped to Lv 50 (matchmaking default)
//   tournament    : tournament-specific cap on the room (see room.levelCap)
export type BattleFormat = "anything-goes" | "random50" | "tournament";

export function levelCapForFormat(format: BattleFormat, room?: BattleRoom): number | null {
  if (format === "random50") return 50;
  if (format === "tournament") return room?.levelCap ?? null;
  return null;
}

function applyLevelCap(team: GamePokemonShape[], cap: number | null): GamePokemonShape[] {
  if (cap == null) return team;
  return team.map((p) => p.level > cap ? { ...p, level: cap } : p);
}

// ─── Start a battle: spin up the simulator ──────────────────────────
//
// Wires up a @pkmn/sim BattleStream + per-player streams, packs both
// teams, and pushes the start commands. Once started, the stream emits
// protocol lines on each `read()` — we forward those to both clients.
//
// The "anything-goes" format is a no-restrictions free-for-all that
// accepts any species, item, move, ability. v1 deliberately doesn't
// gate on a tier system because the game's not balanced for one yet.
export async function startBattle(
  io: Server,
  room: BattleRoom,
  sendToUser: (userId: string, event: string, payload: unknown) => void,
): Promise<void> {
  if (room.status !== "invited") return;
  room.status = "active";
  if (room.expiryTimer) clearTimeout(room.expiryTimer);

  // Apply the format's level cap before adapting to PokemonSet — the
  // adapter just passes `level` through, and @pkmn/sim re-derives stats
  // internally from base + IVs + EVs + level, so capping here means
  // every battle mechanic uses the capped level.
  const cap = levelCapForFormat(room.format as BattleFormat, room);
  const teamA = applyLevelCap(room.a.team, cap).map(pokemonToShowdownSet);
  const teamB = applyLevelCap(room.b.team, cap).map(pokemonToShowdownSet);
  const packedA = Teams.pack(teamA as never);
  const packedB = Teams.pack(teamB as never);

  // Build the simulator stream + per-player views. The omniscient
  // stream sees both sides; player streams are scoped to "what would
  // p1/p2 actually see" — used to sync the |request| (action chooser)
  // payload privately to each player.
  const omni = new BattleStreams.BattleStream();
  const playerStreams = BattleStreams.getPlayerStreams(omni);
  room.stream = omni;
  room.a.stream = playerStreams.p1;
  room.b.stream = playerStreams.p2;

  // Pump player-private output → that player's socket. We leave the
  // omniscient `playerStreams.spectator` unused; if we ever add
  // spectators we'd subscribe to that one.
  pumpPlayerStream(playerStreams.p1, room, "a", sendToUser);
  pumpPlayerStream(playerStreams.p2, room, "b", sendToUser);
  pumpOmniLog(playerStreams.omniscient, room);

  const startCmd = [
    `>start {"formatid":"gen5customgame"}`,
    `>player p1 {"name":${JSON.stringify(room.a.username)},"team":${JSON.stringify(packedA)}}`,
    `>player p2 {"name":${JSON.stringify(room.b.username)},"team":${JSON.stringify(packedB)}}`,
  ].join("\n");
  omni.write(startCmd);

  // Per-turn timeout watchdog.
  room.lastChoiceAt = Date.now();
  room.expiryTimer = setInterval(() => {
    if (Date.now() - room.lastChoiceAt > TURN_TIMEOUT_MS) {
      // Whoever hasn't chosen forfeits. We don't know which side it
      // is from here, so flag a generic timeout — endBattle figures
      // out the surviving side from the simulator's last `request`s.
      void endBattle(room, sendToUser, "timeout");
    }
  }, 30_000);
}

// Forward a player-scoped stream's lines to that player's socket.
async function pumpPlayerStream(
  stream: AsyncIterable<string>,
  room: BattleRoom,
  side: "a" | "b",
  sendToUser: (userId: string, event: string, payload: unknown) => void,
): Promise<void> {
  const which = side === "a" ? room.a : room.b;
  try {
    for await (const chunk of stream) {
      // Each chunk is one or more `|`-delimited protocol lines. Split
      // them so the client gets discrete events. We also peek at
      // |request| so we can stash it for the chooser UI.
      for (const line of chunk.split("\n")) {
        if (!line) continue;
        if (line.startsWith("|request|")) {
          try {
            const payload = JSON.parse(line.slice("|request|".length));
            which.request = payload;
          } catch { /* malformed request line — skip */ }
        }
      }
      sendToUser(which.userId, "battle:state", {
        battleId: room.id,
        side,
        chunk,
        request: which.request,
      });
    }
  } catch (e) {
    console.error("[pvp] player stream error", { battleId: room.id, side, err: String(e) });
  }
}

// Forward the omniscient stream's log into the room's persisted log.
async function pumpOmniLog(stream: AsyncIterable<string>, room: BattleRoom): Promise<void> {
  try {
    for await (const chunk of stream) {
      for (const line of chunk.split("\n")) {
        if (line) room.log.push(line);
        // Detect end-of-battle protocol lines so we can finalize.
        if (line.startsWith("|win|") || line.startsWith("|tie")) {
          // Parse the winner name out of `|win|<name>`. Match by
          // username (we set the player names from a/b.username at
          // startBattle).
          if (line.startsWith("|win|")) {
            const name = line.slice("|win|".length);
            if (name === room.a.username) {
              room.winnerId = room.a.userId;
              room.loserId = room.b.userId;
            } else if (name === room.b.username) {
              room.winnerId = room.b.userId;
              room.loserId = room.a.userId;
            }
            room.endReason = "ko";
          }
          // Don't await — endBattle is async but we want the log
          // pump to keep draining whatever else the stream emits.
          void endBattle(room, undefined, room.endReason ?? "ko");
        }
      }
    }
  } catch (e) {
    console.error("[pvp] omni stream error", { battleId: room.id, err: String(e) });
  }
}

// ─── Choice handling ─────────────────────────────────────────────────
// Player sends `>p1 move 1` / `>p2 switch 3` / `>p1 default` etc.
// We trust @pkmn/sim's own validation — illegal choices come back as
// `|error|` lines on the player's stream which the client surfaces.
export function applyChoice(
  room: BattleRoom,
  userId: string,
  choice: string,
): { ok: boolean; error?: string } {
  if (room.status !== "active") return { ok: false, error: "battle not active" };
  if (typeof choice !== "string" || choice.length > 100) {
    return { ok: false, error: "invalid choice" };
  }
  const which = userId === room.a.userId ? "p1" : userId === room.b.userId ? "p2" : null;
  if (!which) return { ok: false, error: "not in battle" };
  if (!room.stream) return { ok: false, error: "battle not started" };
  // Whitelist allowed choice prefixes — prevents clients from
  // injecting other commands like `>start` into the simulator.
  const safe = /^(move\s|switch\s|team\s|default$|undo$|pass$)/.test(choice);
  if (!safe) return { ok: false, error: "invalid choice format" };
  room.stream.write(`>${which} ${choice}`);
  room.lastChoiceAt = Date.now();
  return { ok: true };
}

// ─── End the battle: persist + clean up + apply rating ─────────────
export async function endBattle(
  room: BattleRoom,
  sendToUser:
    | ((userId: string, event: string, payload: unknown) => void)
    | undefined,
  reason: "ko" | "forfeit" | "timeout" | "cancelled",
): Promise<void> {
  if (room.status === "completed" || room.status === "cancelled") return;
  room.status = reason === "cancelled" ? "cancelled" : "completed";
  room.endReason = reason;
  if (room.expiryTimer) clearInterval(room.expiryTimer);
  if (room.stream) {
    try { room.stream.destroy(); } catch { /* */ }
    room.stream = null;
  }

  // Apply rating BEFORE persisting the match so the post-match payload
  // can include the rating delta. We only rate matchmaking battles
  // (random50) and only when the result is decisive (ko / forfeit /
  // timeout — i.e. someone won). Cancellations don't count toward W/L
  // and don't move the needle.
  let ratingDelta: { aDelta: number; bDelta: number; aRating: number; bRating: number } | null = null;
  if (
    room.format === "random50"
    && room.status === "completed"
    && room.winnerId
    && room.loserId
    && reason !== "cancelled"
  ) {
    try {
      ratingDelta = await applyEloUpdate(
        room.winnerId,
        room.loserId,
        reason === "forfeit" || reason === "timeout" ? "forfeit" : "ko",
      );
    } catch (e) {
      console.error("[pvp] failed to apply ELO", { battleId: room.id, err: String(e) });
    }
  }

  // Persist the match. Fire-and-forget — the swap result already
  // shipped to the clients, a DB hiccup mustn't block them.
  prisma.pvpMatch
    .create({
      data: {
        id: room.id,
        format: room.format,
        status: room.status,
        userAId: room.a.userId,
        userAUsername: room.a.username,
        userATeam: JSON.stringify(room.a.team),
        userBId: room.b.userId,
        userBUsername: room.b.username,
        userBTeam: JSON.stringify(room.b.team),
        winnerId: room.winnerId ?? null,
        loserId: room.loserId ?? null,
        endReason: reason,
        battleLog: room.log.join("\n"),
        finishedAt: new Date(),
        tournamentId: room.tournamentId ?? null,
      },
    })
    .catch((e) => {
      console.error("[pvp] failed to persist match", { battleId: room.id, err: String(e) });
    });

  if (sendToUser) {
    const payload = {
      battleId: room.id,
      winnerId: room.winnerId ?? null,
      loserId: room.loserId ?? null,
      reason,
      ratingDelta,
    };
    sendToUser(room.a.userId, "battle:complete", payload);
    sendToUser(room.b.userId, "battle:complete", payload);
  }

  // Drop after a beat so any in-flight state events are delivered.
  setTimeout(() => battleRooms.delete(room.id), 5_000);
}

// ─── ELO rating ─────────────────────────────────────────────────────
// Standard chess Elo with K=32 and base rating 1000.
//
//   expected = 1 / (1 + 10^((opp - me) / 400))
//   delta    = round(K * (actual - expected))
//
// Atomicity: we read both ratings in one transaction, compute deltas,
// and write both back. If either read or write fails we abort with no
// partial update. Because each player can only be in one battle at a
// time (room guards in socket.ts enforce it), there's no concurrent
// double-update risk for the same user — but we still serialise via
// a transaction for safety.
const K_FACTOR = 32;
const STARTING_RATING = 1000;

export async function applyEloUpdate(
  winnerId: string,
  loserId: string,
  endKind: "ko" | "forfeit",
): Promise<{ aDelta: number; bDelta: number; aRating: number; bRating: number }> {
  return prisma.$transaction(async (tx) => {
    // Upsert both rows so missing rows default to STARTING_RATING.
    // We do two upserts (rather than findMany + create-each-missing)
    // because Prisma's upsert is single-statement and avoids races
    // with another transaction that might also be initialising the
    // same row. Within a transaction these still serialise.
    const winnerRow = await tx.playerRating.upsert({
      where: { userId: winnerId },
      update: {},
      create: { userId: winnerId, rating: STARTING_RATING, peakRating: STARTING_RATING },
    });
    const loserRow = await tx.playerRating.upsert({
      where: { userId: loserId },
      update: {},
      create: { userId: loserId, rating: STARTING_RATING, peakRating: STARTING_RATING },
    });

    const expectedWinner = 1 / (1 + Math.pow(10, (loserRow.rating - winnerRow.rating) / 400));
    const winnerDelta = Math.round(K_FACTOR * (1 - expectedWinner));
    const loserDelta = -winnerDelta;
    const newWinnerRating = winnerRow.rating + winnerDelta;
    const newLoserRating = Math.max(0, loserRow.rating + loserDelta);  // never negative

    // Winner always gets a `wins` credit regardless of how the loss
    // came about (KO vs. forfeit). Loser gets `losses` for a KO or
    // `forfeits` for a disconnect / quit / timeout — the latter is
    // tracked separately so a player's W/L history can distinguish
    // genuine losses from rage-quits.
    await tx.playerRating.update({
      where: { userId: winnerId },
      data: {
        rating: newWinnerRating,
        peakRating: Math.max(winnerRow.peakRating, newWinnerRating),
        matchesPlayed: { increment: 1 },
        wins: { increment: 1 },
        lastMatchAt: new Date(),
      },
    });
    await tx.playerRating.update({
      where: { userId: loserId },
      data: {
        rating: newLoserRating,
        matchesPlayed: { increment: 1 },
        ...(endKind === "forfeit"
          ? { forfeits: { increment: 1 } }
          : { losses: { increment: 1 } }),
        lastMatchAt: new Date(),
      },
    });

    return {
      aDelta: winnerDelta,
      bDelta: loserDelta,
      aRating: newWinnerRating,
      bRating: newLoserRating,
    };
  });
}

// ─── Invite TTL ──────────────────────────────────────────────────────
export function startInviteExpiry(room: BattleRoom, onExpire: () => void): void {
  if (room.expiryTimer) clearTimeout(room.expiryTimer);
  room.expiryTimer = setTimeout(() => {
    if (room.status === "invited") onExpire();
  }, INVITE_TTL_MS);
}

// ─── Random matchmaking queue ────────────────────────────────────────
// Tiny FIFO queue of (userId, username, team) entries waiting for a
// random opponent. When the queue has at least 2 entries we pop the
// oldest two and spawn an "active" room with format: "random50" so
// the level cap kicks in. Memory-only — disconnects flush a user out
// of the queue (see socket.ts disconnect handler).

export interface QueueEntry {
  userId: string;
  username: string;
  team: GamePokemonShape[];
  joinedAt: number;
}

export const matchmakingQueue: QueueEntry[] = [];

/** Returns the index in the queue, or -1 if not queued. */
export function queueIndexOf(userId: string): number {
  return matchmakingQueue.findIndex((e) => e.userId === userId);
}

export function leaveQueue(userId: string): boolean {
  const i = queueIndexOf(userId);
  if (i < 0) return false;
  matchmakingQueue.splice(i, 1);
  return true;
}

/** Drop in a queue entry. Returns true if added, false if the same
 *  user was already queued (we keep the original to prevent silent
 *  team switching while waiting). */
export function joinQueue(entry: QueueEntry): boolean {
  if (queueIndexOf(entry.userId) >= 0) return false;
  matchmakingQueue.push(entry);
  return true;
}

/** If at least two players are queued, pop the oldest two and return
 *  them in [a, b] order so the caller can spin up a room. */
export function popQueuePair(): [QueueEntry, QueueEntry] | null {
  if (matchmakingQueue.length < 2) return null;
  const a = matchmakingQueue.shift()!;
  const b = matchmakingQueue.shift()!;
  return [a, b];
}
