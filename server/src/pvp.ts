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

import { BattleStreams, Teams, Dex } from "@pkmn/sim";
import type { Server } from "socket.io";
import { prisma } from "./db.js";
import { recordError } from "./lib/errorReporting.js";

// ─── Simulator format ────────────────────────────────────────────────
// Custom Game is the only Showdown format that accepts our teams as-is:
// no tier bans, no species clause, no "you must bring exactly six", any
// level. That part was right.
//
// What it ALSO ships is Team Preview, and that broke every battle in a
// second way: the first |request| a player gets is
// `{"teamPreview":true,...}` — no `active`, no moves — and the battle
// modal has no team-order picker (players already chose their lead and
// their order in the TeamBuilder before the invite went out). Nobody
// could answer that request, so the battle sat there until the 5-minute
// AFK watchdog forfeited it. `!Team Preview` is Showdown's own custom-
// rule syntax for dropping a clause; with it the battle opens straight
// on turn 1 with each side's chosen lead.
const SIM_BASE_FORMAT_ID = "gen5customgame";
const SIM_FORMAT_ID = `${SIM_BASE_FORMAT_ID}@@@!Team Preview`;
/** Dex used to validate ids before we hand a team to the simulator. */
const SIM_DEX = Dex.forFormat(SIM_BASE_FORMAT_ID);

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

// Convert any of our internal slugs (camelCase species like `mrMime`,
// camelCase move ids like `shadowBall`, dashed item ids like
// `master-ball`) to Showdown's canonical id format: lowercase, ASCII
// alphanumerics only. Showdown internally normalizes the same way for
// lookups, but @pkmn/sim's `Teams.pack` and `>player` payloads expect
// us to hand it ids in this form — without this, every team comes out
// as "(Unknown Pokémon)" and the simulator crashes on the first
// `>start`. This was the root cause of PvP battles silently failing
// to start in production.
function toShowdownId(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface ShowdownSet {
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
}

export function pokemonToShowdownSet(p: GamePokemonShape): ShowdownSet {
  // Normalize every id to Showdown format. Empty moveset (admin-
  // granted mons, or a Pokémon that hasn't learned anything yet) gets
  // a Tackle fallback so the simulator doesn't reject the team for
  // "no moves" — better to ship a degraded battle than no battle.
  const moveIds = (p.moves ?? [])
    .map((m) => toShowdownId(m.id))
    .filter(Boolean);
  const moves = moveIds.length > 0 ? moveIds : ["tackle"];

  return {
    name: p.nickname ?? p.name ?? p.speciesKey,
    species: toShowdownId(p.speciesKey),
    item: p.heldItem ? toShowdownId(p.heldItem) : "",
    ability: p.ability ? toShowdownId(p.ability) : "",
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

// ─── Make a team the simulator can actually accept ──────────────────
// The game keeps adding content, and not all of it exists in Showdown's
// dex (a fan move, a species we added early, an item that never shipped
// to PS). The simulator does NOT validate a team when you hand it to
// `>player` — it builds the Pokémon and throws deep inside the stream
// pump, where the failure is both fatal and hard to attribute.
//
// So we check the ids ourselves first, and DEGRADE rather than refuse:
// an unknown move is dropped, an unknown ability or item is cleared
// (the simulator then falls back to the species' own default), and only
// a Pokémon whose *species* is unknown has to be skipped — there is
// nothing sane to substitute for it. Refusing the whole matchup because
// one mon knows one unrecognised move is exactly the failure mode this
// report is about; losing one move is not.
//
// Everything we change is returned in `notes` so the caller can log it
// — a silent substitution is how content drift stays invisible.
export function adaptTeamForSimulator(
  team: GamePokemonShape[],
): { sets: ShowdownSet[]; notes: string[] } {
  const notes: string[] = [];
  const sets: ShowdownSet[] = [];
  for (const mon of team) {
    let set: ShowdownSet;
    try {
      set = pokemonToShowdownSet(mon);
    } catch (e) {
      notes.push(`skipped a Pokémon we could not read (${String(e)})`);
      continue;
    }
    const label = set.species || set.name || "?";
    if (!SIM_DEX.species.get(set.species).exists) {
      notes.push(`dropped ${label}: species unknown to the simulator`);
      continue;
    }
    if (set.ability && !SIM_DEX.abilities.get(set.ability).exists) {
      notes.push(`${label}: cleared unknown ability "${set.ability}"`);
      set.ability = "";
    }
    if (set.item && !SIM_DEX.items.get(set.item).exists) {
      notes.push(`${label}: cleared unknown item "${set.item}"`);
      set.item = "";
    }
    const keptMoves = set.moves.filter((m) => {
      if (SIM_DEX.moves.get(m).exists) return true;
      notes.push(`${label}: dropped unknown move "${m}"`);
      return false;
    });
    // Never ship a moveless Pokémon — it would be stuck on Struggle
    // forever. Same Tackle fallback the adapter uses for empty movesets.
    set.moves = keptMoves.length > 0 ? keptMoves : ["tackle"];
    if (keptMoves.length === 0) notes.push(`${label}: no usable moves left, fell back to Tackle`);
    sets.push(set);
  }
  return { sets, notes };
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
  /** Epoch ms of this side's last accepted choice. Undefined until they
   *  move for the first time. This is what lets the AFK watchdog name a
   *  winner instead of writing a winnerless "completed" match — see the
   *  timeout branch in startBattle(). */
  movedAt?: number;
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
  endReason?: "ko" | "tie" | "forfeit" | "timeout" | "cancelled";
  /** Optional tournament linkage — set by the bracket runner when the
   *  match was created from a tournament round. */
  tournamentId?: string;
  /** Tournament-format level cap. Ignored for anything-goes / random50
   *  (those use the format default). Only meaningful when format ===
   *  "tournament" and a cap was set on the source Tournament row. */
  levelCap?: number;
  /** Set of userIds currently watching as spectators. Tracked so we
   *  can broadcast the omniscient log + state events to them on every
   *  turn, and clean up on disconnect. */
  spectators: Set<string>;
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
//
// `onReady` exists so the "tell the players a battle is happening" step
// can sit at exactly the right point in this sequence, and callers can't
// get it wrong. Everything that can refuse the matchup runs before it;
// nothing that produces battle state runs until after it. Callers used
// to emit "battle:start" themselves before calling in, which opened the
// screen on a matchup that might still be rejected — and they can't
// simply emit it afterwards either, because by then the first turn has
// already been pumped to a client that has no room to put it in.
export async function startBattle(
  io: Server,
  room: BattleRoom,
  sendToUser: (userId: string, event: string, payload: unknown) => void,
  onReady?: () => void,
): Promise<void> {
  // Every caller creates the room "invited" immediately above, so this
  // is unreachable — but it returns without ever calling onReady, which
  // would leave the caller believing a battle started. Don't let that be
  // silent either.
  if (room.status !== "invited") {
    void recordError({
      kind: "server",
      message: "pvp_start_battle_bad_state",
      source: "pvp.startBattle",
      meta: { battleId: room.id, format: room.format, status: room.status },
    });
    return;
  }
  room.status = "active";
  if (room.expiryTimer) clearTimeout(room.expiryTimer);

  // Apply the format's level cap before adapting to PokemonSet — the
  // adapter just passes `level` through, and @pkmn/sim re-derives stats
  // internally from base + IVs + EVs + level, so capping here means
  // every battle mechanic uses the capped level.
  const cap = levelCapForFormat(room.format as BattleFormat, room);
  const adaptedA = adaptTeamForSimulator(applyLevelCap(room.a.team, cap));
  const adaptedB = adaptTeamForSimulator(applyLevelCap(room.b.team, cap));
  const teamA = adaptedA.sets;
  const teamB = adaptedB.sets;
  // A substitution is not an error — the battle goes ahead — but it IS
  // a signal that live content has drifted away from Showdown's dex, so
  // it goes on the record rather than into a console nobody reads.
  if (adaptedA.notes.length > 0 || adaptedB.notes.length > 0) {
    void recordError({
      kind: "server",
      level: "warn",
      message: "pvp_team_adapted",
      source: "pvp.startBattle",
      meta: {
        battleId: room.id,
        format: room.format,
        aUserId: room.a.userId, aUsername: room.a.username, aNotes: adaptedA.notes,
        bUserId: room.b.userId, bUsername: room.b.username, bNotes: adaptedB.notes,
      },
    });
  }
  // Degrading can only ever take a team to zero if literally none of
  // their Pokémon exist in the dex. That is the one case worth refusing,
  // and the caller now turns it into a real message for the player.
  if (teamA.length === 0 || teamB.length === 0) {
    const who = teamA.length === 0 ? room.a.username : room.b.username;
    throw new Error(`${who} has no Pokémon the battle simulator recognises`);
  }
  // Teams.pack throws if any PokemonSet has an unknown species / move /
  // item id — we want that error to surface (rather than crash inside
  // the stream pump where it's harder to debug). Logging the team on
  // failure lets us see exactly which entry the dex rejected.
  let packedA: string;
  let packedB: string;
  try {
    packedA = Teams.pack(teamA as never);
    packedB = Teams.pack(teamB as never);
  } catch (e) {
    console.error("[pvp] Teams.pack failed", {
      battleId: room.id,
      err: String(e),
      teamA: JSON.stringify(teamA),
      teamB: JSON.stringify(teamB),
    });
    throw new Error(`team validation failed: ${String(e)}`);
  }

  // Build the simulator stream + per-player views. The omniscient
  // stream sees both sides; player streams are scoped to "what would
  // p1/p2 actually see" — used to sync the |request| (action chooser)
  // payload privately to each player.
  const omni = new BattleStreams.BattleStream();
  const playerStreams = BattleStreams.getPlayerStreams(omni);
  room.stream = omni;
  room.a.stream = playerStreams.p1;
  room.b.stream = playerStreams.p2;

  // Last point at which we can still refuse cleanly. Announce now.
  onReady?.();

  // Pump player-private output → that player's socket. We leave the
  // omniscient `playerStreams.spectator` unused; if we ever add
  // spectators we'd subscribe to that one.
  pumpPlayerStream(playerStreams.p1, room, "a", sendToUser);
  pumpPlayerStream(playerStreams.p2, room, "b", sendToUser);
  pumpOmniLog(playerStreams.omniscient, room, sendToUser);

  const startCmd = [
    `>start {"formatid":${JSON.stringify(SIM_FORMAT_ID)}}`,
    `>player p1 {"name":${JSON.stringify(room.a.username)},"team":${JSON.stringify(packedA)}}`,
    `>player p2 {"name":${JSON.stringify(room.b.username)},"team":${JSON.stringify(packedB)}}`,
  ].join("\n");
  omni.write(startCmd);
  console.log("[pvp] battle started", {
    battleId: room.id,
    format: room.format,
    a: room.a.username,
    b: room.b.username,
    teamSize: { a: teamA.length, b: teamB.length },
  });

  // Per-turn timeout watchdog.
  room.lastChoiceAt = Date.now();
  room.expiryTimer = setInterval(() => {
    if (Date.now() - room.lastChoiceAt > TURN_TIMEOUT_MS) {
      // Whoever hasn't chosen forfeits. endBattle does NOT work this
      // out for us — it only persists room.winnerId — so name the
      // survivor here. A timeout that resolves to `winnerId: null`
      // writes a "completed" PvpMatch with no winner, which the
      // bracket runner can never advance past: the match keeps its
      // battleId (so it can't be restarted) and has no result (so it
      // can't be advanced). One AFK player used to freeze an entire
      // tournament permanently.
      //
      // The side that moved most recently wins. `movedAt` is stamped by
      // applyChoice, so "never moved" (undefined → 0) loses to anyone
      // who moved at all. If NEITHER side ever moved we deliberately
      // leave winnerId unset: that is a genuine double no-show, and the
      // tournament runner decides it by seed rather than the simulator
      // inventing a winner.
      const aMoved = room.a.movedAt ?? 0;
      const bMoved = room.b.movedAt ?? 0;
      if (aMoved !== bMoved) {
        const aWins = aMoved > bMoved;
        room.winnerId = aWins ? room.a.userId : room.b.userId;
        room.loserId = aWins ? room.b.userId : room.a.userId;
      }
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
      let sawRequest = false;
      // Each chunk is one or more `|`-delimited protocol lines. Split
      // them so the client gets discrete events. We also peek at
      // |request| so we can stash it for the chooser UI.
      for (const line of chunk.split("\n")) {
        if (!line) continue;
        if (line.startsWith("|request|")) {
          sawRequest = true;
          try {
            const payload = JSON.parse(line.slice("|request|".length));
            which.request = payload;
          } catch { /* malformed request line — skip */ }
        }
      }
      // When a new request comes in we reset the per-turn clock —
      // the watchdog uses lastChoiceAt to enforce timeout, so we
      // anchor the deadline relative to the request arrival.
      if (sawRequest) {
        room.lastChoiceAt = Date.now();
      }
      sendToUser(which.userId, "battle:state", {
        battleId: room.id,
        side,
        chunk,
        request: which.request,
        turnDeadlineAt: room.lastChoiceAt + TURN_TIMEOUT_MS,
      });
    }
  } catch (e) {
    // A throw here is not cosmetic: @pkmn/sim does not validate a team
    // when you hand it to `>player`, it builds the Pokémon and pushes a
    // FATAL error onto the streams — so "the simulator rejected this
    // matchup" surfaces here, not out of startBattle. A console.error
    // meant the battle just stopped producing turns with nothing in the
    // admin error panel to explain it.
    reportBattleFailure(room, `pvp.pumpPlayerStream:${side}`, e);
  }
}

/** One place for "the simulator gave up on this battle". Records to the
 *  same ErrorLog the rest of the server writes to, with both user ids,
 *  the format and the simulator's own message, then ends the room so
 *  the players get a result instead of a frozen screen. */
function reportBattleFailure(room: BattleRoom, source: string, e: unknown): void {
  const message = e instanceof Error ? e.message : String(e);
  void recordError({
    kind: "server",
    message: "pvp_simulator_stream_failed",
    source,
    stack: e instanceof Error ? e.stack ?? null : null,
    meta: {
      battleId: room.id,
      format: room.format,
      simulatorError: message,
      aUserId: room.a.userId, aUsername: room.a.username, aTeamSize: room.a.team.length,
      bUserId: room.b.userId, bUsername: room.b.username, bTeamSize: room.b.team.length,
    },
  });
}

// Forward the omniscient stream's log into the room's persisted log.
// Also fans the chunk out to every spectator currently subscribed —
// they see everything (omniscient = both sides), unlike the
// participants who only see their own |request| payload.
//
// Takes an optional sendToUser hook so we can broadcast to spectators
// from this same function (we don't have access to the io instance
// directly here). Caller passes it once at startBattle time.
async function pumpOmniLog(
  stream: AsyncIterable<string>,
  room: BattleRoom,
  sendToUser?: (userId: string, event: string, payload: unknown) => void,
): Promise<void> {
  try {
    for await (const chunk of stream) {
      for (const line of chunk.split("\n")) {
        if (line) room.log.push(line);
        // Detect end-of-battle protocol lines so we can finalize.
        //
        // These two tests have to be EXACT. `startsWith("|tie")` — no
        // trailing pipe — also matches `|tier|[Gen 5] Custom Game`,
        // which Showdown emits six lines into the preamble of every
        // single battle, before turn 1. That one missing character
        // ended every PvP match the instant it began: endBattle fired
        // with reason "tie", tore the simulator down, and sent both
        // players a winnerless `battle:complete` — a battle screen that
        // opened, showed no turns, auto-closed, and never touched Elo.
        // The real tie line is exactly `|tie`.
        const isWin = line.startsWith("|win|");
        const isTie = line === "|tie" || line.startsWith("|tie|");
        if (isWin || isTie) {
          // Parse the winner name out of `|win|<name>`. Match by
          // username (we set the player names from a/b.username at
          // startBattle).
          if (isWin) {
            const name = line.slice("|win|".length);
            if (name === room.a.username) {
              room.winnerId = room.a.userId;
              room.loserId = room.b.userId;
            } else if (name === room.b.username) {
              room.winnerId = room.b.userId;
              room.loserId = room.a.userId;
            } else {
              // We named both sides ourselves at startBattle, so this
              // cannot happen — and if it ever does, the match would be
              // silently recorded as a winnerless "completed" row and
              // no rating would move. Say so out loud instead.
              void recordError({
                kind: "server",
                message: "pvp_win_line_unmatched",
                source: "pvp.pumpOmniLog",
                meta: {
                  battleId: room.id, format: room.format, line,
                  aUserId: room.a.userId, aUsername: room.a.username,
                  bUserId: room.b.userId, bUsername: room.b.username,
                },
              });
            }
            room.endReason = "ko";
          } else {
            // |tie line — both sides simultaneously fainted (mutual
            // KO via Explosion, recoil, Struggle, etc.). winnerId /
            // loserId stay unset; endBattle's ELO guard already
            // skips rating updates when either is missing, so the
            // only thing left to do is label the reason correctly
            // for match history.
            room.endReason = "tie";
          }
          // Don't await — endBattle is async but we want the log
          // pump to keep draining whatever else the stream emits.
          void endBattle(room, sendToUser, room.endReason ?? "ko");
        }
      }
      // Spectator broadcast: replay the full chunk to every observer.
      // Spectators get the omniscient view (both sides' switches +
      // damage), but never the |request| payloads — those are private
      // to the active players.
      if (sendToUser && room.spectators.size > 0) {
        for (const specId of room.spectators) {
          sendToUser(specId, "battle:spectate:state", {
            battleId: room.id,
            chunk,
          });
        }
      }
    }
  } catch (e) {
    reportBattleFailure(room, "pvp.pumpOmniLog", e);
    // The simulator is gone; without this the room would sit "active"
    // until the AFK watchdog forfeited somebody for a fault that was
    // never theirs.
    void endBattle(room, sendToUser, "cancelled");
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
  const now = Date.now();
  room.lastChoiceAt = now;
  (which === "p1" ? room.a : room.b).movedAt = now;
  return { ok: true };
}

// ─── End the battle: persist + clean up + apply rating ─────────────
export async function endBattle(
  room: BattleRoom,
  sendToUser:
    | ((userId: string, event: string, payload: unknown) => void)
    | undefined,
  reason: "ko" | "tie" | "forfeit" | "timeout" | "cancelled",
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
      // "I won and my rating didn't move" is a player-visible bug, so
      // it belongs in the error log, not just this process's stdout.
      void recordError({
        kind: "server",
        message: "pvp_elo_update_failed",
        source: "pvp.endBattle",
        meta: {
          battleId: room.id, format: room.format, reason,
          winnerId: room.winnerId, loserId: room.loserId,
          error: String(e),
        },
      });
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
      // A dropped row means the match vanishes from both players'
      // history and from every replay link. Record it.
      void recordError({
        kind: "server",
        message: "pvp_match_persist_failed",
        source: "pvp.endBattle",
        meta: {
          battleId: room.id, format: room.format, reason,
          aUserId: room.a.userId, bUserId: room.b.userId,
          error: String(e),
        },
      });
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
    // Notify every spectator that the battle they were watching has
    // ended. They get the same outcome payload (rating delta is fine
    // to leak — leaderboard is public).
    for (const specId of room.spectators) {
      sendToUser(specId, "battle:spectate:end", { battleId: room.id, reason, winnerId: room.winnerId ?? null });
    }
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

// Defense-in-depth: a periodic ticker that re-attempts pairing every
// few seconds. Catches cases the only-on-join trigger might miss —
// e.g., a queue:join handler that early-returned before reaching
// popQueuePair, or a transient socket hiccup that suppressed the
// trigger. Idempotent; if no pair is found, no-op.
//
// The pairing logic itself lives in socket.ts (it needs access to
// the io instance for sendToUser, plus the room-spawn boilerplate).
// startMatchmakingTicker takes a callback so we don't pull socket
// dependencies into this module.
let _matchmakingInterval: NodeJS.Timeout | null = null;
export function startMatchmakingTicker(onTick: () => void, intervalMs = 3_000): void {
  if (_matchmakingInterval) return;
  _matchmakingInterval = setInterval(onTick, intervalMs);
}
export function stopMatchmakingTicker(): void {
  if (_matchmakingInterval) {
    clearInterval(_matchmakingInterval);
    _matchmakingInterval = null;
  }
}
