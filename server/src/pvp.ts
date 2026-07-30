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
//
// This module deliberately imports NOTHING from ./socket.js — socket.ts
// imports this file, so the reverse would be a cycle. Everything that needs a
// transport (grace timers, the AFK watchdog, the rejoin resolvers) takes
// `sendToUser` / GraceDeps as a parameter instead. That is also what makes
// every mechanism below reachable from a test with no socket server, which is
// how the eight facts documented through this file were measured rather than
// argued.

import { BattleStreams, Teams, Dex } from "@pkmn/sim";
import type { Server } from "socket.io";
import { prisma } from "./db.js";
import { recordError } from "./lib/errorReporting.js";
import { createBotSeat, type BotSeat, type BotTier } from "./lib/pvpBotBrain.js";
import {
  simFormatId,
  SIM_BASE_FORMAT_ID,
  normalizeTeamLevel,
  checkTeamLegality,
  type RuleCheckMon,
  type LegalityOptions,
  type LegalityViolation,
} from "./lib/pvpFormat.js";

// ─── Simulator format ────────────────────────────────────────────────
// The RULESET lives in lib/pvpFormat.ts and this file imports it rather than
// spelling it out, because the two halves of a ruleset fail in different places
// and only one of them can live in a format string. See that file's header for
// the split; the parts that matter here are:
//
// Custom Game is the only Showdown format that accepts our teams as-is: no
// tier bans, no species clause, no "you must bring exactly six", any level.
// That part was right, and it is still the base.
//
// What it ALSO ships is Team Preview, and that broke every battle in a
// second way: the first |request| a player gets is
// `{"teamPreview":true,...}` — no `active`, no moves — and the battle
// modal has no team-order picker (players already chose their lead and
// their order in the TeamBuilder before the invite went out). Nobody
// could answer that request, so the battle sat there until the 5-minute
// AFK watchdog forfeited it. Hence simFormatId(FALSE): it appends Showdown's
// own `!Team Preview` removal syntax and the battle opens straight on turn 1
// with each side's chosen lead. Re-probed against the real simulator while
// wiring this: with Team Preview left ON, `|start` never appears and every
// choice comes back `|error|[Invalid choice] Can't move: You need a
// teampreview response`. Do not pass true until a picker exists on BOTH the
// normal and the tournament start paths.
//
// The BATTLE-TIME clauses simFormatId adds (Sleep Clause Mod, Endless Battle
// Clause) were each re-probed one at a time against the real simulator before
// this wiring landed, because an unrecognised rule does not degrade — it throws
// before `|start` and EVERY battle fails to begin. Measured, verbatim: "Sleep
// Clause" → `Unrecognized rule "Sleep Clause"`; "Cancel Mod" → `Rule
// "cancelmod" in "[Gen 5] Custom Game" already exists`. Both would have been
// outages. Both real ids start a battle cleanly.
//
// A THIRD rule, "HP Percentage Mod", was declared here and has been REMOVED.
// The reasoning is in lib/pvpFormat.ts next to the list, but the part that
// matters at this call site: it did not hide foe HP (Custom Game runs
// `debug: true` → reportExactHP, which wins over reportPercentages), and
// declaring a rule makes the simulator publish `|rule|HP Percentage Mod: HP is
// shown in percentages` on both player streams — measured on the shipped format
// in the same battle that then showed `|switch|p2a: BRAVO|Snorlax, L50, F|
// 235/235`. A rule line that contradicts the battle it introduces is worse than
// no rule line, and it was persisted into PvpMatch.battleLog.
//
// What its removal does NOT change is the per-side privacy boundary, and that
// is the reason it was believed unsafe to add in the first place: the claim was
// that it splits the `secret` and `shared` halves of every |split| block, which
// would break tests/pvpRejoinLeak.ts's assertion that the ONLY lines one side
// receives and the other does not are |request| lines. It never did — both
// halves stayed byte-identical, measured across a battle driven to two faints —
// so nothing about the rejoin replay depended on it either way. Hiding foe HP
// properly remains an OPEN item on our side of the stream.
const SIM_FORMAT_ID = simFormatId(false);
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

// ─── Timing ──────────────────────────────────────────────────────────
// Every number here is part of a mechanism that interleaves with another one,
// so they are exported: the tests drive the real timers rather than sleeping,
// and a test that hard-coded 45_000 would silently stop testing anything the
// day this changed.

/** How long a turn may sit unanswered before the AFK watchdog resolves it. */
export const TURN_TIMEOUT_MS = 5 * 60_000;
/** How often that watchdog looks. */
export const WATCHDOG_POLL_MS = 30_000;
/** A practice battle is against software that answers in about a second, so
 *  five minutes of "waiting for the AI" can only ever be a dead room holding a
 *  simulator and the player's single battle slot. Shorter clock, tighter poll —
 *  and the deadline the client renders comes from turnTimeoutFor(), so the
 *  countdown on screen is the one actually being enforced. */
export const BOT_TURN_TIMEOUT_MS = 2 * 60_000;
export const BOT_WATCHDOG_POLL_MS = 15_000;
/** How long a seat is held after its last socket goes away. Matches run several
 *  minutes; a backgrounded phone, a wifi blip, a Cloudflare hiccup or a rolling
 *  deploy used to be an instant RATED loss plus a `forfeits` increment. */
export const RECONNECT_GRACE_MS = 45_000;
/** Total absence, per side per battle, that the grace mechanism will pay for —
 *  both as turn-clock credit AND as watchdog stand-down. It is ONE budget on
 *  purpose: a client that closes its socket for 44.8 s and reopens it for 5 ms
 *  puts every 30 s poll inside an away window, and with an unbounded stand-down
 *  that measured 322 flap cycles / 4 simulated hours / zero PvpMatch rows on a
 *  battle whose turn clock was four hours past a five-minute deadline. */
export const MAX_TURN_CREDIT_MS = 90_000;
/** How long a matchmaking queue slot survives a disconnect. Longer than the
 *  battle grace because losing it costs nothing but a re-queue — but a deploy
 *  emptying the whole queue means everybody re-queues at once, so it is held. */
export const QUEUE_GRACE_MS = 60_000;

const INVITE_TTL_MS = 60_000;
/** The AI's think window. Long enough that the arena animates like a real
 *  opponent's turn, short enough that it never approaches a watchdog poll. */
const BOT_THINK_MIN_MS = 600;
const BOT_THINK_MAX_MS = 1_200;

// ─── Battle room ─────────────────────────────────────────────────────
export interface BattleSide {
  userId: string;
  username: string;
  team: GamePokemonShape[];
  /** Per-player write stream from @pkmn/sim. `null` until battle starts.
   *  For an AI seat this is the SAME object the brain holds by reference,
   *  which is why poisoning it in a test reproduces a dead stream exactly. */
  stream: { write: (data: string) => void } | null;
  /** Last legal request payload for this side (parsed from |request| line),
   *  used by the client to render the move/switch chooser. */
  request: unknown | null;
  /** Connection state. */
  connected: boolean;
  /** Epoch ms of this side's last accepted choice. Undefined until they
   *  move for the first time. This is what lets the AFK watchdog name a
   *  winner instead of writing a winnerless "completed" match. */
  movedAt?: number;

  // ── Per-side replay log ────────────────────────────────────────────
  /** Exactly what pumpPlayerStream forwarded to THIS player, verbatim,
   *  |request| lines included.
   *
   *  room.log cannot be used for a rejoin: it is @pkmn/sim's omniscient
   *  channel (-1), which carries both sides' `secret` |split| halves — so
   *  replaying it hands a participant the opponent's whole team. It is also
   *  INSUFFICIENT: |request| arrives as `sideupdate` and never reaches channel
   *  -1 at all, so a room.log replay cannot even rebuild a chooser. The
   *  security argument for this array is an equality, not an allowlist: every
   *  byte in it was already delivered to this same client, so a replay of it
   *  cannot leak anything whatever the simulator decides to put in it.
   *
   *  Never truncate the head — the client's decoder folds the opening
   *  |player| / |teamsize| / |switch| lines into its board state. */
  log?: string[];
  /** How many |request| payloads this side has been sent. The turn-clock
   *  credit is keyed on it so a client re-sending a choice for a turn the
   *  simulator already answered cannot hold a room open forever. */
  requestSeq?: number;
  /** The requestSeq this side has already been credited for. */
  answeredSeq?: number | null;

  // ── Reconnect grace ────────────────────────────────────────────────
  /** Epoch ms this side's last socket went away, or null while present. */
  awayAt?: number | null;
  /** The pending forfeit for this side's absence. */
  graceTimer?: NodeJS.Timeout | null;
  /** Absence already paid for out of MAX_TURN_CREDIT_MS. Charged with the
   *  REAL absence even when the turn-clock credit was clamped away — the
   *  clamp must not refund the watchdog stand-down or a flapping client buys
   *  unlimited silence again. */
  graceCreditedMs?: number;

  // ── AI seat ────────────────────────────────────────────────────────
  /** True for the server's practice AI. Written in exactly one place
   *  (socket.ts's battle:bot room literal) as a constant, never from a
   *  payload — tests/pvpBot.ts audits src/ to keep that true, because both
   *  rating guards below are only as good as that claim. */
  isBot?: boolean;
  botTier?: BotTier;
  /** The brain. Nulled by endBattle, which is why neither rating guard may
   *  depend on it — see isBotRoom. */
  bot?: BotSeat | null;
  /** Pending think delay. */
  botTimer?: NodeJS.Timeout | null;
  /** Chunks that arrived while the AI was "thinking". */
  botQueue?: string[] | null;
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
  /** OMNISCIENT battle log (channel -1) as Showdown protocol lines.
   *  Persisted on completion so we can rewatch the match, and fanned out to
   *  spectators. NEVER replayed to a participant — see BattleSide.log. */
  log: string[];
  /** The omniscient battle stream. Null until both sides accept. Held so we
   *  can pump it from outside the io callback context. */
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
  /** Set of userIds currently watching as spectators. */
  spectators: Set<string>;
}

export const battleRooms = new Map<string, BattleRoom>();

export function newBattleId(): string {
  return `b_${Math.random().toString(16).slice(2, 11)}`;
}

// ─── Format → level rules ────────────────────────────────────────────
// The simulator accepts any level we hand it; the original Pokémon in
// the user's save aren't touched. So the format's level is just rewriting the
// level field on each PokemonSet before passing it to @pkmn/sim.
//
//   anything-goes : no level, ship the team exactly as it is
//   random50      : every mon NORMALISED to Lv 50 (matchmaking default)
//   tournament    : tournament-specific level on the room (see room.levelCap)
//   bot           : no level — the AI is LEVEL-MATCHED to the player instead
//                   (lib/pvpBotRoster.ts), because 87% of real accounts are
//                   entirely under Lv 50 and normalising a practice battle
//                   would drag the player's own team to 50 as well and
//                   invalidate every level-matched roster decision.
//
// NORMALISE, NOT CAP. This used to only ever LOWER
// (`p.level > cap ? { ...p, level: cap } : p`), which quietly made the rated
// ladder unplayable for almost the whole game: of the 2,299 accounts with a
// party, 87.0% have their ENTIRE party under Lv 50 and 6.7% are mixed, so ~94%
// of players entered a queue advertised as "Lv 50" carrying undersized Pokémon
// against opponents who were normalised DOWN to it. A Lv 9 Caterpie against a
// Lv 50 anything is not a match. lib/pvpFormat.ts's normalizeTeamLevel raises
// AND lowers; the null case still means "leave the team exactly as it is",
// which is what anything-goes and bot rooms rely on.
export type BattleFormat = "anything-goes" | "random50" | "tournament" | "bot";

/** The level every Pokémon is set to in this format, or null for "as-is".
 *  Named `levelCap` throughout the wire protocol and the client, and kept
 *  that way deliberately — renaming it would be a client contract change —
 *  but it is a normalisation target, not a ceiling. */
export function levelCapForFormat(format: BattleFormat, room?: BattleRoom): number | null {
  if (format === "random50") return 50;
  if (format === "tournament") return room?.levelCap ?? null;
  return null;
}

// ─── Team-composition clauses ────────────────────────────────────────
// The clauses that can refuse a TEAM are checked by us, here, and never put in
// the format string — see lib/pvpFormat.ts's header. Putting them in the
// format string would make the simulator refuse the team deep inside its own
// validation, and the player would experience that as a battle that never
// starts, which is precisely the failure mode Team Preview already caused once.
// Owning the check means owning the message.
//
// Scope: the formats where "ranked" is a true statement, which is what every
// message in pvpFormat.ts says. `random50` is the rated ladder and
// `tournament` carries standings. A private friend invite is called
// anything-goes, and a practice battle against our own AI is unrated and
// unrecorded — refusing either of those over a clause would be friction with
// nothing behind it.
//
// Species Clause stays OFF (pvpFormat's default): this is a catching game,
// duplicates are normal, and 19.8% of real accounts would have their current
// party refused. Turning it on needs a team-builder warning first.
const PVP_CLAUSE_OPTIONS: LegalityOptions = { speciesClause: false };

function clausesApplyTo(format: string): boolean {
  return format === "random50" || format === "tournament";
}

/** Check one team against the format's team-composition clauses.
 *
 *  Returns EVERY violation joined into one player-facing string rather than
 *  the first, so somebody fixing a team is told about all of it at once
 *  instead of discovering one more problem per attempt.
 *
 *  Called at intake (socket.ts's acceptPvpTeam, which is the shared choke
 *  point for all four team entry points) so the message arrives when the
 *  player presses Queue, and AGAIN in startBattle as defence in depth —
 *  lib/tournamentRunner.ts's bracket ticker and the admin start-match route
 *  build rooms from saved parties and never pass through intake at all. */
export function checkTeamForFormat(
  team: RuleCheckMon[],
  format: string,
): { ok: true } | { ok: false; error: string; violations: LegalityViolation[] } {
  if (!clausesApplyTo(format)) return { ok: true };
  const res = checkTeamLegality(team, PVP_CLAUSE_OPTIONS);
  if (res.ok) return { ok: true };
  return {
    ok: false,
    error: res.violations.map((v) => v.message).join(" "),
    violations: res.violations,
  };
}

// NOT wired: lib/pvpFormat.ts's clauseSummary(). It exists to label the format
// in the pre-battle UI ("Sleep Clause Mod · Endless Battle Clause · Evasion
// Clause · …"), and there is no server-side consumer for a string that only a
// client renders. Exporting a `clausesForFormat()` here with nothing calling it
// would be scaffolding pretending to be wiring. The client change is the real
// work, and it is not in this file's remit.

// ─── Room predicates ─────────────────────────────────────────────────

/** Is either seat the practice AI?
 *
 *  Reads the DURABLE flag, never `side.bot`: endBattle nulls the brain, and
 *  both rating guards run after that — a `bot != null` test would have let
 *  every finished practice battle write a row. */
export function isBotRoom(room: BattleRoom): boolean {
  return room.a.isBot === true || room.b.isBot === true;
}

export function turnTimeoutFor(room: BattleRoom): number {
  return isBotRoom(room) ? BOT_TURN_TIMEOUT_MS : TURN_TIMEOUT_MS;
}

function watchdogPollFor(room: BattleRoom): number {
  return isBotRoom(room) ? BOT_WATCHDOG_POLL_MS : WATCHDOG_POLL_MS;
}

/** Which side is this userId, or null.
 *
 *  An AI seat is deliberately NOT a participant here, so every caller —
 *  applyChoice, the grace machinery, resolveRejoin, resolveSync,
 *  snapshotForSide — refuses `bot:<battleId>` for free. Unreachable in
 *  production (a userId comes only from auth.api.getSession and a cuid has no
 *  colon), but the asymmetry when only applyChoice had the guard WAS the
 *  defect: resolveRejoin("bot:…") returned the AI's own |request| payload. */
function sideOf(room: BattleRoom, userId: string): "a" | "b" | null {
  if (room.a.userId === userId && room.a.isBot !== true) return "a";
  if (room.b.userId === userId && room.b.isBot !== true) return "b";
  return null;
}

function sideAt(room: BattleRoom, side: "a" | "b"): BattleSide {
  return side === "a" ? room.a : room.b;
}
function foeAt(room: BattleRoom, side: "a" | "b"): BattleSide {
  return side === "a" ? room.b : room.a;
}

/** "Does this seat have somebody behind it?" The AI always does — it has no
 *  socket, so deps.isPresent can only ever answer false for it, and treating
 *  that as absence would stand the watchdog down for a side that can never
 *  come back. A hang is worse than a bad loss. */
function sidePresent(side: BattleSide, deps: GraceDeps): boolean {
  return side.isBot === true || deps.isPresent(side.userId);
}

// ─── Shutdown drain latch ────────────────────────────────────────────
// battleRooms is an in-process Map and the simulator streams hang off the room,
// so a restart evaporates every live battle. socket.ts's drain voids what is
// running; this latch stops new battles from being started into a process that
// is already exiting.
//
// It lives HERE rather than in socket.ts because socket.ts can only guard its
// own four handlers, while lib/tournamentRunner.ts's bracket ticker and the
// admin start-match route call startBattle directly and cannot import that
// module at all. startBattle is the one place all four callers pass through.
let _draining = false;
export function beginDrain(): void { _draining = true; }
export function isDraining(): boolean { return _draining; }
/** Tests only: drainForShutdown() ends in process.exit(0) and so can never be
 *  called from vitest, which means the latch has to be resettable. */
export function resetDrainForTests(): void { _draining = false; }

// ─── Start a battle: spin up the simulator ──────────────────────────
//
// Wires up a @pkmn/sim BattleStream + per-player streams, packs both
// teams, and pushes the start commands. Once started, the stream emits
// protocol lines on each `read()` — we forward those to both clients.
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
  // Refuse FIRST, before anything is mutated: the caller's catch deletes an
  // "invited" room, so a refusal has to leave the room exactly as it was
  // handed to us — no onReady (so no battle:start reached a client), no
  // simulator, no watchdog interval.
  if (isDraining()) {
    throw new Error("the server is restarting — a new battle can't be started right now");
  }
  // Clause check BEFORE the state change too, for the same reason: every
  // caller's catch expects an untouched "invited" room on a refusal. Intake
  // already ran this for the socket paths; the bracket ticker and the admin
  // start-match route build rooms straight from saved parties, so this is the
  // only place those two can be refused. Both sides are named, because a
  // one-sided message would leave the other player wondering.
  for (const seat of [room.a, room.b]) {
    const legal = checkTeamForFormat(seat.team, room.format);
    if (!legal.ok) {
      throw new Error(`${seat.username}'s team isn't legal for this format — ${legal.error}`);
    }
  }
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
  room.expiryTimer = null;

  // Normalise to the format's level before adapting to PokemonSet — the
  // adapter just passes `level` through, and @pkmn/sim re-derives stats
  // internally from base + IVs + EVs + level, so doing it here means every
  // battle mechanic uses the normalised level and a raised mon gets genuinely
  // correct Lv 50 stats rather than a scaled approximation. What this
  // deliberately does NOT equalise is movepool, EVs, IVs, nature and held
  // item, so progress still decides matches — through what you have invested
  // rather than through a raw stat gap nobody can play around.
  const cap = levelCapForFormat(room.format as BattleFormat, room);
  const adaptedA = adaptTeamForSimulator(normalizeTeamLevel(room.a.team, cap));
  const adaptedB = adaptTeamForSimulator(normalizeTeamLevel(room.b.team, cap));
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
  room.a.log ??= [];
  room.b.log ??= [];

  // Last point at which we can still refuse cleanly. Announce now.
  onReady?.();

  // ONE consumer per player stream, structurally.
  //
  // getPlayerStreams pushes each side's lines into an ObjectReadWriteStream
  // whose next() SHIFTS a single shared buffer, so two `for await` loops on
  // the same stream do NOT both see the data — the first takes everything.
  // Measured on a live battle: consumer A got 4 chunks including the
  // |request|, consumer B got 0. So attaching RandomPlayerAI.start() to
  // playerStreams.p2 while the room's own pump also read p2 produced a
  // SILENTLY MUTE bot: nothing logged anywhere, the battle simply never
  // advanced past turn 1 and died to the AFK watchdog five minutes later.
  // pumpBotStream is therefore the single consumer for an AI seat and hands
  // chunks to the brain by calling receive().
  for (const side of ["a", "b"] as const) {
    const which = sideAt(room, side);
    const ps = side === "a" ? playerStreams.p1 : playerStreams.p2;
    if (which.isBot === true) {
      which.botQueue = [];
      which.bot = createBotSeat(ps, which.botTier ?? "trainer", {
        // Stamp the room's turn accounting from the brain's own choose().
        //
        // The bot never passes through applyChoice, so without this
        // room.b.movedAt stays undefined and the watchdog's `aMoved > bMoved`
        // tiebreak declares the AFK HUMAN the winner of a battle they walked
        // away from. Stamping here means the watchdog needs no bot branch at
        // all — the existing generic logic resolves correctly with no
        // bot-awareness.
        onChoose: () => { creditChoice(room, which); },
      });
      void pumpBotStream(ps, room, side, sendToUser);
    } else {
      void pumpPlayerStream(ps, room, side, sendToUser);
    }
  }
  void pumpOmniLog(playerStreams.omniscient, room, sendToUser);

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
    runTurnWatchdog(room, sendToUser);
  }, watchdogPollFor(room));
}

// ─── The AFK / timeout watchdog ──────────────────────────────────────
// endBattle does NOT work out who won — it only persists whatever the room
// says — so every exit here has to name the survivor itself. A timeout that
// resolves to `winnerId: null` writes a "completed" PvpMatch with no winner,
// which the bracket runner can never advance past: the match keeps its
// battleId (so it can't be restarted) and has no result (so it can't be
// advanced). One AFK player used to freeze an entire tournament permanently.
function runTurnWatchdog(
  room: BattleRoom,
  sendToUser: (userId: string, event: string, payload: unknown) => void,
): void {
  if (room.status !== "active") return;
  // Stand down while a side is inside its reconnect window, or the grace is
  // decorative: the poll is phase-anchored to startBattle and the turn clock
  // does not advance while a side is away, so a disconnect late in a turn got
  // timeout-forfeited by the OTHER mechanism — the exact outcome the grace
  // exists to prevent, reached through a different door.
  if (graceSuppressesWatchdog(room)) return;
  if (Date.now() - room.lastChoiceAt <= turnTimeoutFor(room)) return;

  const aAway = room.a.awayAt != null;
  const bAway = room.b.awayAt != null;
  // Nobody left to hand it to. Naming a winner would give a rated win to
  // whichever connection happened to close a millisecond later, and "cancelled"
  // reads as dead to the bracket so the pairing is re-run rather than advanced
  // with a phantom winner.
  if (aAway && bAway) {
    void endBattle(room, sendToUser, "cancelled");
    return;
  }
  // Absence beats the movedAt tiebreak. Without this an away player whose last
  // choice happens to be the most recent one WINS the timeout — and the
  // tiebreak reads the PREVIOUS turn on a turn nobody has answered yet, so it
  // is a coin flip in exactly the case where absence is the known fact.
  if (aAway || bAway) {
    const loser = aAway ? room.a : room.b;
    const winner = aAway ? room.b : room.a;
    room.winnerId = winner.userId;
    room.loserId = loser.userId;
    void endBattle(room, sendToUser, "forfeit");
    return;
  }
  // The side that moved most recently wins. `movedAt` is stamped by
  // creditChoice — for the human through applyChoice, for the AI through its
  // brain's choose() — so "never moved" (undefined → 0) loses to anyone who
  // moved at all. If NEITHER side ever moved we deliberately leave winnerId
  // unset: that is a genuine double no-show, and the tournament runner decides
  // it by seed rather than the simulator inventing a winner.
  const aMoved = room.a.movedAt ?? 0;
  const bMoved = room.b.movedAt ?? 0;
  if (aMoved !== bMoved) {
    const aWins = aMoved > bMoved;
    room.winnerId = aWins ? room.a.userId : room.b.userId;
    room.loserId = aWins ? room.b.userId : room.a.userId;
  }
  void endBattle(room, sendToUser, "timeout");
}

// ─── Stream pumps ────────────────────────────────────────────────────

/** Record one chunk against a side: its private replay log, its |request|
 *  payload, and the per-turn clock anchor. Shared by the human pump and the
 *  AI pump so the AI seat's request bookkeeping cannot drift from the human's
 *  — its requestSeq is what the credit-once-per-request rule keys on. */
function recordSideChunk(room: BattleRoom, which: BattleSide, chunk: string): void {
  const log = (which.log ??= []);
  let sawRequest = false;
  for (const line of chunk.split("\n")) {
    if (!line) continue;
    // Verbatim, |request| lines included. This array IS the transport's own
    // delivery record for this user, which is the only reason replaying it on
    // rejoin is safe — see BattleSide.log.
    log.push(line);
    if (line.startsWith("|request|")) {
      sawRequest = true;
      try {
        which.request = JSON.parse(line.slice("|request|".length));
      } catch { /* malformed request line — skip */ }
    }
  }
  // A new request opens a new turn: re-anchor the deadline the watchdog
  // enforces and the one the client renders, and re-open the credit so the
  // next choice for THIS request is the one that counts.
  if (sawRequest) {
    which.requestSeq = (which.requestSeq ?? 0) + 1;
    room.lastChoiceAt = Date.now();
  }
}

/** Forward a player-scoped stream's lines to that player's socket. */
async function pumpPlayerStream(
  stream: AsyncIterable<string>,
  room: BattleRoom,
  side: "a" | "b",
  sendToUser: (userId: string, event: string, payload: unknown) => void,
): Promise<void> {
  const which = sideAt(room, side);
  try {
    for await (const chunk of stream) {
      recordSideChunk(room, which, chunk);
      sendToUser(which.userId, "battle:state", {
        battleId: room.id,
        side,
        chunk,
        request: which.request,
        turnDeadlineAt: room.lastChoiceAt + turnTimeoutFor(room),
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

/** The AI seat's pump. Same bookkeeping as a human's, but the chunk goes to a
 *  think queue instead of a socket — the seat has no socket, and sendToUser
 *  would swallow it silently, which is precisely how a bug on this side
 *  produces no error line anywhere. */
async function pumpBotStream(
  stream: AsyncIterable<string>,
  room: BattleRoom,
  side: "a" | "b",
  sendToUser: (userId: string, event: string, payload: unknown) => void,
): Promise<void> {
  const which = sideAt(room, side);
  try {
    for await (const chunk of stream) {
      recordSideChunk(room, which, chunk);
      (which.botQueue ??= []).push(chunk);
      scheduleBotTurn(room, which, sendToUser);
    }
  } catch (e) {
    reportBattleFailure(room, `pvp.pumpBotStream:${side}`, e);
  }
}

function scheduleBotTurn(
  room: BattleRoom,
  which: BattleSide,
  sendToUser: (userId: string, event: string, payload: unknown) => void,
): void {
  if (which.botTimer) return;
  if (!which.bot || room.status !== "active" || !room.stream) return;
  const think = BOT_THINK_MIN_MS + Math.floor(Math.random() * (BOT_THINK_MAX_MS - BOT_THINK_MIN_MS));
  which.botTimer = setTimeout(() => {
    which.botTimer = null;
    runBotTurn(room, which, sendToUser);
  }, think);
}

/** Hand the queued chunks to the brain and let it answer.
 *
 *  THE HAZARD THIS IS BUILT AROUND: endBattle destroys the stream, and a later
 *  write throws SYNCHRONOUSLY ("Push after end of read stream"). Out of a bare
 *  setTimeout callback that is an uncaught exception, i.e. process death,
 *  taking every other live battle with it. Hence the guards in front (the same
 *  ones applyChoice has, plus the brain itself), and hence the fact that
 *  nothing in here is allowed to throw.
 *
 *  RandomPlayerAI.receiveError also RETHROWS anything that is not
 *  "[Unavailable choice]", and receiveRequest itself throws when it can find no
 *  legal choice — an escaped throw leaves the bot mute. So a failed decision
 *  falls back to `default`, which is always legal; and a fallback that cannot
 *  even write `default` is proof the stream is gone, in which case the battle
 *  is ENDED rather than left standing. It used to be left standing: measured,
 *  the room stayed "active" with no further chunk able to arrive, the human sat
 *  in front of a live-looking board, and only the AFK watchdog resolved it —
 *  minutes later, with the AI as the winner. */
function runBotTurn(
  room: BattleRoom,
  which: BattleSide,
  sendToUser: (userId: string, event: string, payload: unknown) => void,
): void {
  const queued = which.botQueue ?? [];
  which.botQueue = [];
  const bot = which.bot;
  if (!bot || room.status !== "active" || !room.stream || !which.stream) return;
  for (const chunk of queued) {
    try {
      bot.receive(chunk);
    } catch (e) {
      try {
        bot.fallback();
      } catch (fallbackError) {
        void recordError({
          kind: "server",
          message: "pvp_bot_seat_mute",
          source: "pvp.runBotTurn",
          stack: fallbackError instanceof Error ? fallbackError.stack ?? null : null,
          meta: {
            battleId: room.id, format: room.format, tier: which.botTier ?? null,
            decisionError: String(e), fallbackError: String(fallbackError),
          },
        });
        // Nothing further can help: no chunk can arrive to arm another think
        // timer, so there is no strike counter that could ever reach a second
        // strike. End it, unrated and with no winner — the human did not lose
        // this, our AI did.
        void endBattle(room, sendToUser, "cancelled");
        return;
      }
    }
  }
}

/** One place for "the simulator gave up on this battle". Records to the
 *  same ErrorLog the rest of the server writes to, with both user ids,
 *  the format and the simulator's own message. */
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

// ─── Battle-end protocol line classification ─────────────────────────
// Exact-match rules, extracted so the regression that killed PvP can be
// pinned by a unit test:
//
// `startsWith("|tie")` — no trailing pipe — also matches
// `|tier|[Gen 5] Custom Game`, which Showdown emits six lines into the
// preamble of EVERY battle, before turn 1. That one missing character
// ended every PvP match the instant it began. The real tie line is
// exactly `|tie` (argumentless), so it must be an exact match or a
// `|tie|`-prefixed match — never a bare `|tie` prefix.
export function battleEndFromLine(line: string): "win" | "tie" | null {
  if (line.startsWith("|win|")) return "win";
  if (line === "|tie" || line.startsWith("|tie|")) return "tie";
  return null;
}

// Forward the omniscient stream's log into the room's persisted log.
// Also fans the chunk out to every spectator currently subscribed —
// they see everything (omniscient = both sides), unlike the
// participants who only see their own |request| payload.
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
        // The matching rules live in battleEndFromLine (exported, unit-
        // tested) because they have to be EXACT: a bare `|tie` prefix
        // match also caught `|tier|[Gen 5] Custom Game` from the preamble
        // of every battle. That one missing character ended every PvP
        // match the instant it began.
        const end = battleEndFromLine(line);
        if (!end) continue;
        // A BUFFERED WIN MAY NOT RENAME A FINISHED BATTLE.
        //
        // winnerId / loserId / endReason are written by CALLERS, not by
        // endBattle — endBattle only persists whatever the room says — and
        // tournamentRunner reads room.winnerId off the finished room for the
        // five seconds before deletion. So a chunk drained after some other
        // end path completed used to RENAME the winner on a completed room,
        // after the PvpMatch row and the ELO had already gone out naming the
        // other player. The only thing standing in the way was
        // room.stream.destroy() killing the pump first — and endBattle
        // deliberately SWALLOWS a throw from destroy(). Reproduced with
        // exactly that: row said uB, room said uA.
        if (room.status !== "active") continue;
        if (end === "win") {
          // Parse the winner name out of `|win|<name>`. Match by
          // username (we set the player names from a/b.username at
          // startBattle). An AI seat's label always contains a space, and
          // validateUsername allows only [A-Za-z0-9_], so this comparison
          // cannot be confused by a practice battle either.
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
        // pump to keep draining whatever else the stream emits. It
        // snapshots room.log synchronously, so the |win| line pushed above
        // is in the persisted battleLog.
        void endBattle(room, sendToUser, end === "win" ? "ko" : "tie");
      }
      // Spectator broadcast: replay the full chunk to every observer.
      // Spectators get the omniscient view (both sides' switches +
      // damage), but never the |request| payloads — those never reach
      // channel -1 at all.
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
  const side = sideOf(room, userId);
  if (!side) return { ok: false, error: "not in battle" };
  if (!room.stream) return { ok: false, error: "battle not started" };
  // Whitelist allowed choice prefixes — prevents clients from
  // injecting other commands like `>start` into the simulator.
  const safe = /^(move\s|switch\s|team\s|default$|undo$|pass$)/.test(choice);
  if (!safe) return { ok: false, error: "invalid choice format" };
  // The two checks above are NOT sufficient: a destroyed-but-not-nulled
  // stream passes both `status === "active"` and `room.stream != null`, and
  // the write then throws "Push after end of read stream" straight out of a
  // socket.io event handler — an uncaught exception that takes every other
  // live battle down with the process. Measured.
  try {
    room.stream.write(`>${side === "a" ? "p1" : "p2"} ${choice}`);
  } catch (e) {
    void recordError({
      kind: "server",
      message: "pvp_choice_write_failed",
      source: "pvp.applyChoice",
      userId,
      meta: { battleId: room.id, format: room.format, error: String(e) },
    });
    return { ok: false, error: "battle stream closed" };
  }
  creditChoice(room, sideAt(room, side));
  return { ok: true };
}

/** Stamp the turn clock for a choice that actually landed — ONCE per request.
 *
 *  Every accepted write used to re-stamp lastChoiceAt, including a duplicate
 *  for a turn the simulator had already answered. Measured: the duplicate
 *  acked ok and pushed the clock forward by the full 5,399 ms gap, and 30
 *  simulated minutes of re-sent choices into a frozen board left the room
 *  "active" — holding a simulator and both players' battle slot forever. A
 *  re-send is still accepted (the client is allowed to retry) but it buys no
 *  time, so the watchdog still reclaims a board nothing can advance. */
function creditChoice(room: BattleRoom, side: BattleSide): void {
  const seq = side.requestSeq ?? 0;
  if ((side.answeredSeq ?? -1) === seq) return;
  side.answeredSeq = seq;
  const now = Date.now();
  room.lastChoiceAt = now;
  side.movedAt = now;
}

// ─── Reconnect grace ─────────────────────────────────────────────────
// A disconnect used to be an INSTANT rated loss: socket.ts's disconnect
// handler named the opponent winner and forfeited with zero grace, for every
// active room the user was in. Matches run several minutes, so a backgrounded
// phone, a wifi blip, a Cloudflare hiccup, a rolling deploy, or the player
// pressing Reload on the update prompt each produced a rated loss and a
// `forfeits` increment.
//
// The transport and the presence predicate are parameters, not imports:
// pvp.ts must not import socket.ts (cycle), and it also means every branch
// below is reachable from a test with no socket server.

export interface GraceDeps {
  /** Reaches every live socket of a user. Optional because a grace timer can
   *  fire long after the socket that triggered it stopped existing, and
   *  because some callers genuinely have nobody to tell. */
  sendToUser?: (userId: string, event: string, payload: unknown) => void;
  /** THE authority on "are they back". `online` in socket.ts. A missed resume
   *  hook must not cost a rated loss, so the grace resolution re-asks this
   *  rather than trusting that somebody called endDisconnectGrace. */
  isPresent: (userId: string) => boolean;
  /** A queue hold that expired. The caller emits battle:queue:left and
   *  re-broadcasts the size — a silent drop is what left the client's
   *  "Searching for opponent… 14m 32s" toast ticking forever. */
  onQueueDropped?: (userId: string) => void;
}

/** Is a side inside a reconnect window it still has budget for?
 *
 *  Budget is the whole point. `awayAt != null` restarts from scratch on every
 *  fresh disconnect, so a client that closes its socket for 44.8 s and reopens
 *  it for 5 ms puts every poll inside an away window and the turn-timeout
 *  check never runs again. Measured before the bound: 322 flap cycles, 4
 *  simulated hours, turn clock ~4 h past a 5-minute deadline, room still
 *  "active", zero PvpMatch rows — while the identical battle with nobody
 *  flapping timed out normally. A losing player could stall a match forever,
 *  pin the simulator in memory, freeze a tournament bracket, and (once the
 *  honest opponent gave up and closed their tab) convert the loss into an
 *  UNRATED cancel, which the bracket reads as dead and replays. */
function graceSuppressesWatchdog(room: BattleRoom): boolean {
  return sideHasLiveGrace(room.a) || sideHasLiveGrace(room.b);
}
function sideHasLiveGrace(side: BattleSide): boolean {
  return side.awayAt != null && (side.graceCreditedMs ?? 0) < MAX_TURN_CREDIT_MS;
}

/** Hold one side of one battle. Returns whether this room is now holding a
 *  seat for that side (true also when it already was). */
export function beginReconnectGrace(room: BattleRoom, side: "a" | "b", deps: GraceDeps): boolean {
  if (room.status !== "active") return false;
  const me = sideAt(room, side);
  const foe = foeAt(room, side);
  // The AI is never away. If it ever were, the watchdog would stand down for
  // a side that can never come back: a permanent HANG, which is worse than a
  // bad loss. Unreachable today — defence in depth.
  if (me.isBot === true) return false;

  if (me.awayAt == null) {
    me.awayAt = Date.now();
    me.graceTimer = setTimeout(() => {
      me.graceTimer = null;
      resolveReconnectGrace(room.id, side, deps);
    }, RECONNECT_GRACE_MS);
  }
  // Re-announce on a repeat (a second tab closing) but do NOT restart the
  // window: a flapping client must not be able to extend it indefinitely, and
  // the deadline the survivor is rendering must not jump.
  if (foe.isBot !== true) {
    deps.sendToUser?.(foe.userId, "battle:opponent-away", {
      battleId: room.id,
      username: me.username,
      graceEndsAt: (me.awayAt ?? Date.now()) + RECONNECT_GRACE_MS,
    });
  }
  return true;
}

/** They're back. Returns whether there was actually a hold to release. */
export function cancelReconnectGrace(room: BattleRoom, side: "a" | "b", deps: GraceDeps): boolean {
  const me = sideAt(room, side);
  const foe = foeAt(room, side);
  if (me.graceTimer) { clearTimeout(me.graceTimer); me.graceTimer = null; }
  if (me.awayAt == null) return false;
  const now = Date.now();
  const awayMs = Math.max(0, now - me.awayAt);
  me.awayAt = null;

  // Two quantities, deliberately different.
  //
  // The METER is charged the REAL absence (capped at the ceiling), because it
  // is what graceSuppressesWatchdog spends. The CLOCK CREDIT is what is left
  // of the same budget, and it is additionally clamped so lastChoiceAt can
  // never land in the future: the earlier version's comment claimed it could
  // not, but the invariant assumed lastChoiceAt <= awayAt, and the OPPONENT
  // keeps playing during the away window with every choice and every
  // |request| re-stamping the clock to now. Measured at +10 s with a single
  // opponent choice mid-window — a turnDeadlineAt shipped to both clients 10 s
  // later than anything the server intended to enforce. Clamping the credit
  // must NOT clamp the meter, or a flapper whose opponent keeps re-stamping
  // the clock gets unlimited watchdog silence for free.
  const spent = me.graceCreditedMs ?? 0;
  const allowance = Math.max(0, MAX_TURN_CREDIT_MS - spent);
  me.graceCreditedMs = Math.min(MAX_TURN_CREDIT_MS, spent + awayMs);
  const credit = Math.min(awayMs, allowance);
  if (credit > 0) room.lastChoiceAt = Math.min(room.lastChoiceAt + credit, now);

  if (foe.isBot !== true) {
    deps.sendToUser?.(foe.userId, "battle:opponent-back", {
      battleId: room.id,
      username: me.username,
    });
  }
  return true;
}

/** The grace window came due. Exported because it is also the exact body a
 *  timer that escaped a teardown would run, and that is worth testing
 *  directly — a stale resolution landing on a finished room would leave rows
 *  and ratings correct and still advance the LOSER through the bracket. */
export function resolveReconnectGrace(battleId: string, side: "a" | "b", deps: GraceDeps): void {
  const room = battleRooms.get(battleId);
  if (!room || room.status !== "active") return;
  const me = sideAt(room, side);
  const foe = foeAt(room, side);
  if (me.awayAt == null) return;
  // Presence is the authority, re-asked here on purpose: a missed connection
  // hook must not cost a rated loss.
  if (sidePresent(me, deps)) {
    cancelReconnectGrace(room, side, deps);
    return;
  }
  if (foe.awayAt != null && !sidePresent(foe, deps)) {
    // The rolling-deploy case. Nobody to hand it to, and naming a winner
    // would hand a rated win to whichever connection closed a millisecond
    // later. "cancelled" still writes a row, moves no ELO, sends both clients
    // a real battle:complete, and reads as dead to the bracket.
    void endBattle(room, deps.sendToUser, "cancelled");
    return;
  }
  room.winnerId = foe.userId;
  room.loserId = me.userId;
  void endBattle(room, deps.sendToUser, "forfeit");
}

/** "This user's last socket went away." Holds every seat they occupy plus
 *  their matchmaking slot.
 *
 *  Pending INVITES are deliberately not held — that is the caller's job and it
 *  cancels them outright: an invite is unrated, writes no row and costs one
 *  click to re-send, whereas holding it would let the receiver accept an
 *  invite from an absent player and land them straight in forfeit territory. */
export function beginDisconnectGrace(
  userId: string,
  deps: GraceDeps,
): { battleIds: string[]; queueHeld: boolean } {
  const battleIds: string[] = [];
  for (const room of Array.from(battleRooms.values())) {
    if (room.status !== "active") continue;
    const side = sideOf(room, userId);
    if (!side) continue;
    if (beginReconnectGrace(room, side, deps)) battleIds.push(room.id);
  }
  const queueHeld = beginQueueGrace(userId, deps);
  return { battleIds, queueHeld };
}

/** "This user has a socket again." Idempotent — socket.ts calls it on EVERY
 *  connect, not just ones where the client bothers to emit battle:rejoin, so
 *  an old client build still can't be forfeited for coming back. */
export function endDisconnectGrace(
  userId: string,
  deps: GraceDeps,
): { battleIds: string[]; queueHeld: boolean } {
  const battleIds: string[] = [];
  for (const room of Array.from(battleRooms.values())) {
    if (room.status !== "active") continue;
    const side = sideOf(room, userId);
    if (!side) continue;
    if (cancelReconnectGrace(room, side, deps)) battleIds.push(room.id);
  }
  const queueHeld = cancelQueueGrace(userId);
  return { battleIds, queueHeld };
}

// ─── Rejoin / sync ───────────────────────────────────────────────────
// Two probes, deliberately different in what they can say. Both resolvers live
// here rather than in socket.ts because their ack shapes are a fixed contract
// with game/src/state/pvp.ts, and no test may import the socket module.

export interface BattleSnapshot {
  battleId: string;
  format: string;
  side: "a" | "b";
  opponent: { id: string; username: string };
  levelCap: number | null;
  request: unknown | null;
  log: string[];
  turnDeadlineAt: number;
}

export type RejoinAck =
  | { ok: true; snapshot: BattleSnapshot }
  | { ok: false; reason: "gone" | "not_in_battle" };

export type SyncAck =
  | { ok: true; battleId: string }
  | { ok: false; reason: "gone" };

/** Everything one participant may be handed about their own live battle.
 *
 *  There is no `team` field and no room.log, and that is the point: `team` is
 *  the un-adapted game object carrying IVs / EVs / nature / moves for all six,
 *  and room.log is the omniscient channel. What ships is this side's own
 *  delivered byte stream plus its own request — a replay equal to what the
 *  client already had cannot leak anything. */
export function snapshotForSide(room: BattleRoom, userId: string): BattleSnapshot | null {
  const side = sideOf(room, userId);
  if (!side) return null;
  const me = sideAt(room, side);
  const foe = foeAt(room, side);
  return {
    battleId: room.id,
    format: room.format,
    side,
    opponent: { id: foe.userId, username: foe.username },
    levelCap: levelCapForFormat(room.format as BattleFormat, room),
    request: me.request,
    log: [...(me.log ?? [])],
    turnDeadlineAt: room.lastChoiceAt + turnTimeoutFor(room),
  };
}

/** The ONLY client-supplied input either resolver takes (`side` is derived from
 *  the authenticated userId via sideOf). Anything that is not a non-empty
 *  string is narrowed away, so an object with a toString, an array or a number
 *  falls through to the discovery branch instead of being coerced into a
 *  lookup key. */
function asBattleId(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

// ── Remembered outcomes ───────────────────────────────────────────────
// The hard tail of the grace forfeit: a player forfeited WHILE AWAY has no
// sockets, so their battle:complete was dropped, and the room is deleted five
// seconds later. If "gone" were the whole answer they would be told the match
// was voided and unrated when in fact they lost and their rating moved. So the
// outcome outlives the room, and only a participant is ever handed it.
interface RememberedOutcome {
  aUserId: string;
  bUserId: string;
  payload: {
    battleId: string;
    winnerId: string | null;
    loserId: string | null;
    reason: string;
    ratingDelta: RatingDelta | null;
  };
}
/** Bounded: this is a leak otherwise, and a few hundred is far more than the
 *  5-second room tail plus a reconnect storm can need. */
const MAX_REMEMBERED_OUTCOMES = 500;
const recentOutcomes = new Map<string, RememberedOutcome>();

function rememberOutcome(room: BattleRoom, payload: RememberedOutcome["payload"]): void {
  if (recentOutcomes.size >= MAX_REMEMBERED_OUTCOMES) {
    const oldest = recentOutcomes.keys().next();
    if (!oldest.done) recentOutcomes.delete(oldest.value);
  }
  recentOutcomes.set(room.id, {
    aUserId: room.a.userId,
    bUserId: room.b.userId,
    payload,
  });
}

/** Re-send a remembered result, and only to somebody who was in it. The
 *  participation check lives here rather than in the callers so a third party
 *  cannot be handed someone else's result by any route. */
function replayOutcome(userId: string, battleId: string, deps?: GraceDeps): void {
  const mem = recentOutcomes.get(battleId);
  if (!mem || !deps?.sendToUser) return;
  if (mem.aUserId !== userId && mem.bUserId !== userId) return;
  deps.sendToUser(userId, "battle:complete", mem.payload);
}

/** Rebuild a battle the client lost (page reload, tab resume, new socket).
 *
 *  "gone" and "not_in_battle" are NOT interchangeable: the client renders any
 *  ok:false as "Battle ended by a server restart — not rated" and removes the
 *  action bar, so a fresh page load with no battleId must answer
 *  "not_in_battle" or every battle-free reload shows the voided banner. */
export function resolveRejoin(userId: string, battleId?: unknown, deps?: GraceDeps): RejoinAck {
  const id = asBattleId(battleId);
  if (id) {
    const room = battleRooms.get(id);
    if (!room) {
      // A battle the server does not have → the restart case, which is the
      // only recovery available: battleRooms is in-process and the simulator
      // streams die with it.
      replayOutcome(userId, id, deps);
      return { ok: false, reason: "gone" };
    }
    // A real battle you are not in — and we don't confirm the id exists
    // beyond saying you're not in it.
    if (!sideOf(room, userId)) return { ok: false, reason: "not_in_battle" };
    if (room.status !== "active") {
      replayOutcome(userId, id, deps);
      return { ok: false, reason: "gone" };
    }
    return { ok: true, snapshot: snapshotForSide(room, userId)! };
  }
  // No battleId: the client lost it too. Discover their own live battle.
  for (const room of battleRooms.values()) {
    if (room.status !== "active") continue;
    if (!sideOf(room, userId)) continue;
    return { ok: true, snapshot: snapshotForSide(room, userId)! };
  }
  return { ok: false, reason: "not_in_battle" };
}

/** The cheap probe: "is my battle still real?" Refuses every non-string id
 *  rather than guessing, and never distinguishes "not yours" from "not there"
 *  — a stranger must not be able to use it as an existence oracle. */
export function resolveSync(userId: string, battleId?: unknown, deps?: GraceDeps): SyncAck {
  const id = asBattleId(battleId);
  if (!id) return { ok: false, reason: "gone" };
  const room = battleRooms.get(id);
  if (room && room.status === "active" && sideOf(room, userId)) {
    return { ok: true, battleId: id };
  }
  replayOutcome(userId, id, deps);
  return { ok: false, reason: "gone" };
}

// ─── End the battle: persist + clean up + apply rating ─────────────

export interface RatingDelta { aDelta: number; bDelta: number; aRating: number; bRating: number }

// endBattle's row insert is fire-and-forget: the result already shipped to both
// clients and a DB hiccup mustn't block them. That leaves the shutdown drain
// with a problem — it ends every live battle and then exits, which without a
// wait means not one row commits. So the in-flight inserts are tracked.
const pendingPersists = new Set<Promise<unknown>>();
function trackPersist(p: Promise<unknown>): void {
  pendingPersists.add(p);
  void p.then(
    () => pendingPersists.delete(p),
    () => pendingPersists.delete(p),
  );
}

/** Wait for every in-flight PvpMatch insert. Returns false on timeout so the
 *  caller can record that rows were lost rather than assume they weren't. */
export async function flushPvpPersists(timeoutMs = 2_000): Promise<boolean> {
  if (pendingPersists.size === 0) return true;
  let timer: NodeJS.Timeout | null = null;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const settled = Promise.allSettled(Array.from(pendingPersists)).then(() => true);
  const ok = await Promise.race([settled, timedOut]);
  if (timer) clearTimeout(timer);
  return ok;
}

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
  room.expiryTimer = null;
  // Nothing may outlive the room: a grace timer would resolve a finished
  // battle, and a think timer would write into a destroyed stream and kill the
  // process. Both sides unconditionally, including a seat whose isBot flag was
  // never set.
  for (const side of [room.a, room.b]) {
    if (side.graceTimer) { clearTimeout(side.graceTimer); side.graceTimer = null; }
    side.awayAt = null;
    if (side.botTimer) { clearTimeout(side.botTimer); side.botTimer = null; }
    side.bot = null;
    side.botQueue = null;
  }
  if (room.stream) {
    try { room.stream.destroy(); } catch { /* swallowed: see pumpOmniLog's status guard */ }
    room.stream = null;
  }

  // FREEZE THE OUTCOME BEFORE THE AWAIT.
  //
  // The double-end gate above stops a second endBattle but NOT a caller that
  // writes room.status / winnerId / loserId and is then turned away by it —
  // socket.ts's battle:cancel, reached by the surviving player's "Yes,
  // forfeit" button, sets status = "cancelled" on a non-active room. Landing
  // that inside the ELO window of a grace forfeit used to move both ratings
  // while persisting the row as "cancelled": history loses a win whose rating
  // already moved, and tournamentRunner reads a non-completed row as dead and
  // REPLAYS a decided pairing.
  const outcome = {
    status: room.status,
    winnerId: room.winnerId ?? null,
    loserId: room.loserId ?? null,
    battleLog: room.log.join("\n"),
    tournamentId: room.tournamentId ?? null,
  };
  // A voided battle publishes NO teams. The drain and the both-sides-away
  // branch write a "cancelled" row, and the row used to carry the raw team
  // JSON — species, nickname, item, ability, moves, IVs, EVs, including
  // Pokémon that never took the field — which GET /pvp/match/:id/replay hands
  // to either participant. A cancelled row is read as dead by the bracket, so
  // the pairing is RE-RUN: the same two players meet again with one side's
  // team known, in a format that deliberately disables Team Preview. The LOG
  // is kept: every line in it was already delivered to both players live, and
  // it is the only diagnostic a void leaves behind.
  const voided = outcome.status === "cancelled";

  // TWO INDEPENDENT KEYS, on both guards.
  //
  // A practice battle is never rated and never recorded, and neither guard may
  // be defeatable on its own: `isBot` gone with the format still "bot" used to
  // write a row — measured — and GET /pvp/me/history selects on participation
  // with no format clause, so it would have entered the hub's LAST 10 pip tape
  // and computeStreak with wins over an AI.
  const botMatch = isBotRoom(room);

  // Apply rating BEFORE persisting the match so the post-match payload
  // can include the rating delta. We only rate matchmaking battles
  // (random50) and only when the result is decisive (ko / forfeit /
  // timeout — i.e. someone won). Cancellations don't count toward W/L
  // and don't move the needle.
  let ratingDelta: RatingDelta | null = null;
  if (
    !botMatch
    && room.format === "random50"
    && outcome.status === "completed"
    && outcome.winnerId
    && outcome.loserId
    && reason !== "cancelled"
  ) {
    try {
      ratingDelta = await applyEloUpdate(
        outcome.winnerId,
        outcome.loserId,
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
          winnerId: outcome.winnerId, loserId: outcome.loserId,
          error: String(e),
        },
      });
    }
  }

  if (!botMatch && room.format !== "bot") {
    const persist = prisma.pvpMatch
      .create({
        data: {
          id: room.id,
          format: room.format,
          status: outcome.status,
          userAId: room.a.userId,
          userAUsername: room.a.username,
          userATeam: voided ? "[]" : JSON.stringify(room.a.team),
          userBId: room.b.userId,
          userBUsername: room.b.username,
          userBTeam: voided ? "[]" : JSON.stringify(room.b.team),
          winnerId: outcome.winnerId,
          loserId: outcome.loserId,
          endReason: reason,
          battleLog: outcome.battleLog,
          finishedAt: new Date(),
          tournamentId: outcome.tournamentId,
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
    trackPersist(persist);
  }

  const payload = {
    battleId: room.id,
    winnerId: outcome.winnerId,
    loserId: outcome.loserId,
    reason,
    ratingDelta,
  };
  // Remembered even when nobody could be told, which is the whole point: the
  // forfeited-while-away player has no socket right now.
  rememberOutcome(room, payload);
  if (sendToUser) {
    // Skip the AI seat EXPLICITLY. sendToUser is a silent no-op for a
    // socket-less user (three implementations of it in socket.ts, all three
    // no-op), which is convenient and must never be relied on — "it happens to
    // do nothing" is not the same claim as "we do not address it".
    for (const side of [room.a, room.b]) {
      if (side.isBot === true) continue;
      sendToUser(side.userId, "battle:complete", payload);
    }
    // Notify every spectator that the battle they were watching has
    // ended. They get the same outcome payload (rating delta is fine
    // to leak — leaderboard is public).
    for (const specId of room.spectators) {
      sendToUser(specId, "battle:spectate:end", {
        battleId: room.id, reason, winnerId: outcome.winnerId,
      });
    }
  }

  // Drop after a beat so any in-flight state events are delivered.
  setTimeout(() => battleRooms.delete(room.id), 5_000);
}

/** End every PRACTICE battle this user is in, as a no-result cancel.
 *
 *  "Already in a battle" is checked against battleRooms, so an abandoned
 *  practice battle used to bench its player from the rated queue, from invites
 *  and from tournament pairings — measured at 345,000 ms when a second tab kept
 *  them present so no reconnect grace ever started. Wanting a real opponent is
 *  the clearest possible statement that the AI fight is over, so it ends: they
 *  LEFT a practice battle, they did not lose one, hence no winner. */
export function releaseBotBattlesFor(
  userId: string,
  sendToUser?: (userId: string, event: string, payload: unknown) => void,
): string[] {
  const ended: string[] = [];
  for (const room of Array.from(battleRooms.values())) {
    if (!isBotRoom(room)) continue;
    if (room.status !== "active" && room.status !== "invited") continue;
    if (room.a.userId !== userId && room.b.userId !== userId) continue;
    ended.push(room.id);
    void endBattle(room, sendToUser, "cancelled");
  }
  return ended;
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
): Promise<RatingDelta> {
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
// random opponent. When the queue has at least 2 PRESENT entries we pop the
// oldest two and spawn an "active" room with format: "random50" so
// the level cap kicks in. Memory-only.

export interface QueueEntry {
  userId: string;
  username: string;
  team: GamePokemonShape[];
  joinedAt: number;
  /** Epoch ms this entry's owner went away, or null while present. A held
   *  entry keeps its FIFO position and is INVISIBLE to pairing. */
  awayAt?: number | null;
  graceTimer?: NodeJS.Timeout | null;
}

export const matchmakingQueue: QueueEntry[] = [];

/** Returns the index in the queue, or -1 if not queued. */
export function queueIndexOf(userId: string): number {
  return matchmakingQueue.findIndex((e) => e.userId === userId);
}

/** Everyone currently holding a slot, held or not — the audience for a queue
 *  size broadcast, and the list the drain has to tell. */
export function queuedUserIds(): string[] {
  return matchmakingQueue.map((e) => e.userId);
}

export function leaveQueue(userId: string): boolean {
  const i = queueIndexOf(userId);
  if (i < 0) return false;
  const [entry] = matchmakingQueue.splice(i, 1);
  if (entry.graceTimer) { clearTimeout(entry.graceTimer); entry.graceTimer = null; }
  entry.awayAt = null;
  return true;
}

/** Drop in a queue entry. Returns true if added, false if the same
 *  user was already queued (we keep the original to prevent silent
 *  team switching while waiting) — but a re-queue always clears a stale
 *  disconnect hold, or a later expiry dequeues a player who is demonstrably
 *  back and asking. */
export function joinQueue(entry: QueueEntry): boolean {
  if (queueIndexOf(entry.userId) >= 0) {
    cancelQueueGrace(entry.userId);
    return false;
  }
  entry.awayAt = null;
  entry.graceTimer = null;
  matchmakingQueue.push(entry);
  return true;
}

/** If at least two PRESENT players are queued, pop the oldest two and return
 *  them in [a, b] order so the caller can spin up a room.
 *
 *  Skipping held entries is what makes the disconnect hold real. Popping an
 *  absent player is how the 3-second matchmaking ticker used to defeat the
 *  hold within one tick: the caller finds them offline and drops the entry
 *  permanently, emitting nothing, and the client's search toast ticks on. */
export function popQueuePair(): [QueueEntry, QueueEntry] | null {
  const free: number[] = [];
  for (let i = 0; i < matchmakingQueue.length && free.length < 2; i++) {
    if (matchmakingQueue[i].awayAt == null) free.push(i);
  }
  if (free.length < 2) return null;
  const [i, j] = free;
  // Higher index first so the lower one doesn't shift under us.
  const b = matchmakingQueue.splice(j, 1)[0];
  const a = matchmakingQueue.splice(i, 1)[0];
  for (const e of [a, b]) {
    if (e.graceTimer) { clearTimeout(e.graceTimer); e.graceTimer = null; }
  }
  return [a, b];
}

/** Hold a queue slot through a disconnect. Returns whether there is a slot
 *  being held (true also when one already was). */
export function beginQueueGrace(userId: string, deps: GraceDeps): boolean {
  const i = queueIndexOf(userId);
  if (i < 0) return false;
  const entry = matchmakingQueue[i];
  if (entry.awayAt != null) return true;
  entry.awayAt = Date.now();
  entry.graceTimer = setTimeout(() => {
    entry.graceTimer = null;
    const idx = queueIndexOf(userId);
    // Identity, not just membership: a timer that outlived its entry must not
    // dequeue a LATER re-queue by the same user.
    if (idx < 0 || matchmakingQueue[idx] !== entry) return;
    if (entry.awayAt == null) return;
    if (deps.isPresent(userId)) { entry.awayAt = null; return; }
    matchmakingQueue.splice(idx, 1);
    // The caller emits battle:queue:left and re-broadcasts the size. Dropping
    // silently is the original defect: the client's "Searching for opponent…
    // 14m 32s" toast ticked forever on a player who was no longer queued.
    deps.onQueueDropped?.(userId);
  }, QUEUE_GRACE_MS);
  return true;
}

/** Release a queue hold. Returns whether one was actually held, so the caller
 *  knows whether to claim a resume. */
export function cancelQueueGrace(userId: string): boolean {
  const i = queueIndexOf(userId);
  if (i < 0) return false;
  const entry = matchmakingQueue[i];
  const held = entry.awayAt != null;
  if (entry.graceTimer) { clearTimeout(entry.graceTimer); entry.graceTimer = null; }
  entry.awayAt = null;
  return held;
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
