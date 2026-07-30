// The AI seat's brain: two tiers built on @pkmn/sim's own RandomPlayerAI.
//
// THE ONE STRUCTURAL RULE — a brain here NEVER calls start().
//
// BattlePlayer.start() is `for await (const chunk of this.stream)`
// (node_modules/@pkmn/sim/build/cjs/sim/battle-stream.js:328-332), and a
// player stream cannot be consumed twice: getPlayerStreams pushes each side's
// lines into one ObjectReadWriteStream whose next() SHIFTS a single shared
// buffer (@pkmn/streams/build/index.js), so the first `for await` takes
// everything and the second gets nothing. Measured on a live battle: consumer
// A received 2 chunks including the |request|, consumer B received 0. So
// attaching start() to playerStreams.p2 while pvp.ts's pump also reads p2
// produces a SILENTLY MUTE bot — no error anywhere, the battle just sits
// there until the 5-minute AFK watchdog. pvp.ts's pumpBotStream is therefore
// the single consumer and hands chunks in by calling receive(); everything
// below (receive / receiveLine / receiveRequest / receiveError / choose) is
// callable directly and is what we use.
//
// WHAT THE BRAIN IS ALLOWED TO KNOW. Exactly what a human at the same screen
// knows: its own request payload, and whatever the shared protocol has
// revealed about the opponent (the species that has switched in, its HP
// percentage). It never reads room.log, never reads the human's team, and
// never asks the simulator anything. Foe base stats and the type chart come
// from the dex, which is public knowledge any player has.

import { Dex, RandomPlayerAI, toID } from "@pkmn/sim";
import type { Streams } from "@pkmn/sim";

const SIM_BASE_FORMAT_ID = "gen5customgame";
/** Gen-5 dex on purpose: the battle is Gen 5, and the type chart differs
 *  (Steel resists Ghost and Dark here, Fairy does not exist). Scoring against
 *  the modern chart would make the bot misplay its own generation. */
const DEX = Dex.forFormat(SIM_BASE_FORMAT_ID);

export type BotTier = "rookie" | "trainer";

/** The only surface pvp.ts needs. Deliberately narrow so the room holds a
 *  brain it cannot accidentally drive as a stream. */
export interface BotSeat {
  tier: BotTier;
  receive(chunk: string): void;
  /** Last-ditch legal answer, used by pvp.ts when receive() threw. */
  fallback(): void;
}

export interface BotSeatHooks {
  /** Called with every choice the brain submits, BEFORE it reaches the
   *  simulator. pvp.ts uses this to stamp movedAt / lastChoiceAt, which is
   *  what stops the AFK watchdog handing the win to an idle human — see the
   *  movedAt tiebreak in pvp.ts's turn watchdog. */
  onChoose?: (choice: string) => void;
}

// ─── Shared seat plumbing ────────────────────────────────────────────

/** Which protocol slot is which, tracked from the SHARED half of the log.
 *  Keyed by slot token ("p1a" / "p2a") rather than by "me"/"foe" because the
 *  brain does not reliably know its own side id until the first |request|
 *  arrives, and the |switch| lines can land in the same chunk. Resolving at
 *  decision time is order-independent; guessing is not. */
interface SlotState { species: string; hpPct: number; level: number }

class SeatBot extends RandomPlayerAI {
  protected readonly hooks: BotSeatHooks;
  protected readonly slots = new Map<string, SlotState>();
  protected mySideId: "p1" | "p2" | null = null;
  protected lastRequest: BotRequest | null = null;
  readonly tier: BotTier = "rookie";

  constructor(stream: Streams.ObjectReadWriteStream<string>, hooks: BotSeatHooks = {}) {
    super(stream, { move: 1.0, mega: 0 });
    this.hooks = hooks;
  }

  /** Stamp the room's turn accounting on the way past.
   *
   *  Without this the bot's choices never touch applyChoice, so room.b.movedAt
   *  stays undefined, and the watchdog's `aMoved > bMoved` tiebreak declares
   *  the AFK HUMAN the winner of a battle they walked away from. One line, and
   *  it means the watchdog needs no bot special-casing at all. */
  override choose(choice: string): void {
    this.hooks.onChoose?.(choice);
    super.choose(choice);
  }

  /** `default` is in applyChoice's whitelist and is always legal, so it is the
   *  answer of last resort when the real decision threw. */
  fallback(): void {
    this.choose("default");
  }

  /**
   * BattlePlayer.receiveLine reimplemented, minus one line: it pushes every
   * non-request protocol line onto `this.log` forever and nothing here ever
   * reads it. On a long battle (or a long stall) that array is unbounded
   * growth inside an object the room holds, for no reader. Everything else —
   * the |request| and |error| dispatch — is byte-identical to the parent.
   */
  override receiveLine(line: string): void {
    this.trackLine(line);
    if (!line.startsWith("|")) return;
    const sep = line.indexOf("|", 1);
    const cmd = sep < 0 ? line.slice(1) : line.slice(1, sep);
    const rest = sep < 0 ? "" : line.slice(sep + 1);
    if (cmd === "request") { this.receiveRequest(JSON.parse(rest)); return; }
    if (cmd === "error") { this.receiveError(new Error(rest)); return; }
  }

  /** Bookkeeping first, decision second. Split so a tier overrides only the
   *  decision — a subclass that overrode receiveRequest wholesale would have
   *  to remember to re-do the side-id capture, and a brain that has not
   *  learned its own side id cannot tell which slot the foe is in.
   *
   *  Typed `unknown` and narrowed here on purpose: @pkmn/sim's ChoiceRequest is
   *  a four-way union whose members disagree about which fields exist at all,
   *  and an override that names a narrower shape is a compile error. Widening
   *  to `unknown` keeps the override honest about what the simulator may hand
   *  us; BotRequest below is our reading of it. */
  override receiveRequest(request: unknown): void {
    const req = request as BotRequest;
    this.lastRequest = req;
    const id = req?.side?.id;
    if (id === "p1" || id === "p2") this.mySideId = id;
    this.decide(req);
  }

  /** Default decision: hand it straight to RandomPlayerAI. */
  protected decide(request: BotRequest): void {
    super.receiveRequest(request as never);
  }

  /** Public-information tracking: who is on the field and how hurt they are.
   *  These are the same lines the human's client decodes to draw the arena. */
  private trackLine(line: string): void {
    if (!line.startsWith("|")) return;
    const parts = line.split("|");
    const tag = parts[1];
    const slot = slotToken(parts[2]);
    if (!slot) return;
    switch (tag) {
      case "switch":
      case "drag":
      case "replace":
      case "detailschange": {
        const details = parts[3] ?? "";
        const species = details.split(",")[0]?.trim() ?? "";
        const prev = this.slots.get(slot);
        this.slots.set(slot, {
          species: species || prev?.species || "",
          // A switch-in reveals a fresh condition; a detailschange keeps HP.
          hpPct: tag === "detailschange" ? (prev?.hpPct ?? 100) : hpPctOf(parts[4] ?? ""),
          level: levelOfDetails(details) ?? prev?.level ?? 100,
        });
        return;
      }
      case "-damage":
      case "-heal":
      case "-sethp": {
        const prev = this.slots.get(slot);
        if (prev) prev.hpPct = hpPctOf(parts[3] ?? "");
        return;
      }
      case "faint": {
        const prev = this.slots.get(slot);
        if (prev) prev.hpPct = 0;
        return;
      }
      default:
        return;
    }
  }

  /** The opponent's active slot, resolved against whichever side we are. */
  protected foeSlot(): SlotState | null {
    if (!this.mySideId) return null;
    return this.slots.get(this.mySideId === "p1" ? "p2a" : "p1a") ?? null;
  }

  protected foeTypes(): string[] {
    const foe = this.foeSlot();
    if (!foe?.species) return [];
    const sp = DEX.species.get(toID(foe.species));
    return sp.exists ? sp.types : [];
  }
}

/** Tier 1: @pkmn/sim's uniform-random player, level-matched, with nothing but
 *  the seat plumbing above added. Kept as a real tier rather than deleted
 *  because it is the honest "very easy" setting AND the control the heuristic
 *  tier's win rate is measured against. */
class RookieBot extends SeatBot {
  override readonly tier: BotTier = "rookie";
}

// ─── Tier 2: the heuristic ───────────────────────────────────────────

/** Status moves are a LAST RESORT, not a plan — and that has to be STRUCTURAL,
 *  not a threshold.
 *
 *  This was a flat `STATUS_SCORE = 8` compared against `power * eff * acc *
 *  stab * (atk / def)`, and that product is not in any fixed unit: it scales
 *  with the attacker's level, because `atk` is a COMPUTED stat. MEASURED, with
 *  the shipped brain answering real |request| payloads at matched levels:
 *
 *    beedrill vs weedle      L3/L5/L7 → Harden      · L10+ → Fury Attack
 *    kakuna   vs charmander  L3..L10  → Harden      · L15+ → Poison Sting
 *    ekans    vs pidgey      L3/L5    → Leer        · L7+  → Poison Sting
 *    poliwag  vs squirtle    L3..L20  → Water Sport · L30+ → Bubble
 *
 *  and over 100 full battles per level with the same trainer on both sides,
 *  the share of the bot's move decisions that spent the turn on a status move
 *  while a damaging move was legal and not immune:
 *
 *    Lv 5 → 49.7%   Lv 7 → 31.6%   Lv 25 / 50 / 95 → 0.0%
 *
 *  288 of the Lv-5 cases were made at or below 25% of its own HP. The
 *  production median party level is 5 and p25 is 4, so the MODAL bot battle
 *  was the one where the bot passed half its turns using Harden — which reads
 *  as broken software, not as an easy opponent.
 *
 *  So there is no constant any more. A status move is taken only when nothing
 *  that deals damage would do anything at all (every attack is type-immune, or
 *  there is no attack in the moveset). That is what the previous comment here
 *  already claimed the constant achieved, expressed so it cannot drift with
 *  level, power scale, or a future re-tune of the damage term. */
/** Fallback power for a damaging move the dex reports as 0 BP and that is not
 *  a known variable-power move — rare, and better than treating it as free. */
const UNKNOWN_POWER = 40;
const VARIABLE_POWER = new Map<string, number>([
  ["lowkick", 55], ["seismictoss", 60], ["magnitude", 71], ["nightshade", 60],
  ["dragonrage", 50], ["sonicboom", 40], ["superfang", 60], ["electroball", 70],
  ["gyroball", 70], ["grassknot", 55], ["heavyslam", 70], ["return", 102],
  ["psywave", 50], ["crushgrip", 80], ["wringout", 80],
]);
/** Switch out below this. Chosen, not tuned — I measured that voluntary
 *  switching at 30% is already net-negative against a competent opponent (see
 *  the note on voluntarySwitch), and did NOT sweep other thresholds, so do not
 *  read this number as optimised. Its job is to keep the bot from standing at
 *  4% HP taking hits in front of the player. */
const SWITCH_HP_THRESHOLD = 30;

class HeuristicBot extends SeatBot {
  override readonly tier: BotTier = "trainer";

  /**
   * One thing the parent cannot do at all: switch out voluntarily.
   * RandomPlayerAI's switch branch requires `this.prng.random() > this.move`
   * and `this.move` defaults to 1.0 while random() returns [0,1) — so with
   * default options it is unreachable. This decides deterministically instead,
   * and only when there is something to gain: our active is nearly dead, we
   * are not trapped, and a benched Pokémon ACTUALLY resists what is killing us.
   *
   * HONEST NOTE, next to the code rather than in a report nobody re-reads:
   * this layer measurably makes the bot slightly WEAKER. Head-to-head against
   * the identical brain with only this method disabled, n=100 per level, sides
   * swapped every other battle: 47% at Lv 5, 41% at Lv 25, 45% at Lv 50 —
   * 133/300 overall, about two standard errors below even. The mechanism is
   * obvious once you see it: a switch spends a turn, and a competent opponent
   * simply re-picks its best move against whatever came in, so the resistance
   * gained is worth less than the free hit given away. (Against a RANDOM
   * opponent it does help, which is why measuring only against
   * RandomPlayerAI would have flattered it.)
   *
   * It is kept anyway, deliberately, for one reason and not the other: a bot
   * that stands at 4% HP taking hits reads as broken to the human watching it,
   * and this is what the feature was asked for. It is NOT kept because it is
   * stronger. Do not let anyone turn it into a difficulty claim.
   */
  protected override decide(request: BotRequest): void {
    const voluntary = this.voluntarySwitch(request);
    if (voluntary != null) { this.choose(`switch ${voluntary}`); return; }
    super.decide(request);
  }

  private voluntarySwitch(request: BotRequest): number | null {
    if (!request?.active || request.wait) return null;
    if (request.forceSwitch?.some(Boolean)) return null;   // the parent handles forced switches
    const active = request.active[0];
    if (!active || active.trapped) return null;
    const mons = request.side?.pokemon ?? [];
    const me = mons.find((p) => p.active);
    if (!me || hpPctOf(me.condition) >= SWITCH_HP_THRESHOLD) return null;
    const foeTypes = this.foeTypes();
    if (foeTypes.length === 0) return null;
    const myIncoming = worstIncoming(foeTypes, typesOf(me.details));
    let best: { slot: number; score: number } | null = null;
    for (let i = 0; i < mons.length; i++) {
      const p = mons[i];
      if (p.active || isFainted(p.condition)) continue;
      const candTypes = typesOf(p.details);
      // "Actually resists" is the whole point. A sideways switch donates a free
      // turn for nothing, and since the GATED version already measures net-
      // negative (see above), an ungated one can only be worse — so this is the
      // narrowest form of the behaviour that still does the legibility job.
      if (worstIncoming(foeTypes, candTypes) >= myIncoming) continue;
      const score = this.switchScore(p, candTypes, foeTypes);
      if (!best || score > best.score) best = { slot: i + 1, score };
    }
    return best?.slot ?? null;
  }

  /** Post-KO forced switch. Same scoring as the voluntary one, replacing the
   *  parent's `prng.sample(switches).slot`.
   *
   *  Measured NEUTRAL, not positive: 55% / 43% / 48% at Lv 5 / 25 / 50 against
   *  the same brain switching at random (146/300, half a standard error from
   *  even). Unlike the voluntary switch above it cannot cost a turn — the
   *  switch is happening either way — so a coin-flip result is a free win on
   *  legibility: the bot never sends a Water type into a Grass attacker in
   *  front of the player. */
  protected override chooseSwitch(
    _active: unknown,
    switches: { slot: number; pokemon: unknown }[],
  ): number {
    const foeTypes = this.foeTypes();
    let best: { slot: number; score: number } | null = null;
    for (const s of switches) {
      const mon = s.pokemon as BotSidePokemon;
      const candTypes = typesOf(mon?.details ?? "");
      const score = this.switchScore(mon, candTypes, foeTypes);
      if (!best || score > best.score) best = { slot: s.slot, score };
    }
    return best?.slot ?? switches[0]?.slot ?? 1;
  }

  private switchScore(p: BotSidePokemon, candTypes: string[], foeTypes: string[]): number {
    // Offence: the best type multiplier any of this Pokémon's known moves gets
    // on the foe. `p.moves` in a request payload is a plain list of move ids,
    // i.e. our own information, not the opponent's.
    let offence = 0.5;
    for (const id of p.moves ?? []) {
      const md = DEX.moves.get(id);
      if (!md.exists || md.category === "Status") continue;
      offence = Math.max(offence, effectiveness(md.type, foeTypes));
    }
    // Defence: what the foe's own typing does to us, inverted.
    const incoming = foeTypes.length > 0 ? worstIncoming(foeTypes, candTypes) : 1;
    const defence = incoming > 0 ? 1 / incoming : 4;
    const hp = Math.max(0, Math.min(100, hpPctOf(p.condition))) / 100;
    return offence * defence * (0.4 + 0.6 * hp);
  }

  /**
   * Pick a damaging move, preferring super-effective, respecting the
   * physical / special split, and reaching for priority to finish a nearly
   * dead foe.
   *
   * THIS LAYER IS WHERE ALL OF THE MEASURED STRENGTH IS. Against
   * RandomPlayerAI, n=100 per level, sides swapped every other battle and the
   * same trainer on both sides: 69% at Lv 5, 95% at Lv 25, 80% at Lv 50. So
   * shipping RandomPlayerAI unmodified would lose three or four games in five
   * to a bot that merely picks its best damaging move — which is the
   * "insulting difficulty" this whole class exists to avoid.
   *
   * Lv 5 is the number that matters most and it is the weakest: the
   * production median party level IS 5, and a Lv 5 Pokémon knows one or two
   * moves, so there is barely a decision to make. Skill can only express
   * itself once movepools open up around Lv 25 — and then narrows again by
   * Lv 50, where even a random pick usually finds something that hurts.
   */
  protected override chooseMove(
    activeRaw: unknown,
    moves: { choice: string; move: unknown }[],
  ): string {
    const active = activeRaw as BotActive | undefined;
    const req = this.lastRequest;
    const me = req?.side?.pokemon?.find((p) => p.active);
    const myTypes = typesOf(me?.details ?? "");
    const myStats = me?.stats ?? {};
    const foeTypes = this.foeTypes();
    const foeSp = this.foeSlot()?.species
      ? DEX.species.get(toID(this.foeSlot()!.species))
      : null;
    const foeBase = foeSp?.exists ? foeSp.baseStats : null;
    const foeHp = this.foeSlot()?.hpPct ?? 100;

    const foeLevel = this.foeSlot()?.level ?? 100;

    // Two buckets, so "status is a last resort" is a structural fact rather
    // than a threshold that has to be calibrated against a unitless product.
    let best: string | null = null;
    let bestScore = 0;
    let fallbackStatus: string | null = null;
    for (const cand of moves) {
      // The request payload carries the canonical id in `active.moves[slot-1]`;
      // `cand.move.move` is only the display name. Prefer the id.
      const slotted = cand.move as { slot?: number; move?: string } | undefined;
      const id = active?.moves?.[(slotted?.slot ?? 0) - 1]?.id ?? toID(slotted?.move ?? "");
      const md = DEX.moves.get(id);
      if (md.exists && md.category === "Status") {
        fallbackStatus ??= cand.choice;
        continue;
      }
      let score: number;
      if (!md.exists) {
        // Unknown to this dex — assume it does something, but rank it below
        // anything we can actually reason about.
        score = 0.5;
      } else {
        const eff = effectiveness(md.type, foeTypes);
        const power = md.basePower > 0
          ? md.basePower
          : (VARIABLE_POWER.get(md.id) ?? UNKNOWN_POWER);
        const acc = md.accuracy === true ? 100 : Number(md.accuracy) || 100;
        const stab = myTypes.includes(md.type) ? 1.5 : 1;
        const atk = md.category === "Physical" ? Number(myStats.atk) : Number(myStats.spa);
        // BOTH SIDES OF THIS RATIO MUST BE THE SAME KIND OF NUMBER. `atk` is a
        // COMPUTED stat off our own request payload; `foeBase.def` is the
        // species' BASE stat. Dividing one by the other was the unit bug behind
        // the status-move measurements above: at Lv 5 a computed attack stat is
        // ~15 against a base defence of ~30, so `ratio` came out around 0.5 and
        // dragged every attack under the old flat status score, while at Lv 95 a
        // computed ~200 over the same ~30 inflated it ~7x. Scaling the foe's
        // base stat to its own level (31 IV / 0 EV / neutral — the shape every
        // team in this game has, and the same assumption a human makes when they
        // eyeball a matchup) makes the term an actual attack/defence ratio.
        const foeDefBase = md.category === "Physical" ? foeBase?.def : foeBase?.spd;
        const def = foeDefBase && foeDefBase > 0 ? statAtLevel(foeDefBase, foeLevel) : 0;
        const ratio = atk > 0 && def > 0 ? atk / def : 1;
        score = power * eff * (acc / 100) * stab * ratio;
        // Finish it. A priority move on a foe under a quarter HP is the one
        // read this bot makes that looks like a plan.
        if (md.priority > 0 && foeHp < 25) score *= 1.4;
      }
      if (score > bestScore) { bestScore = score; best = cand.choice; }
    }
    // A damaging move that scores 0 is type-immune and does literally nothing,
    // so a status move genuinely is better. Only then.
    if (bestScore > 0 && best) return best;
    return fallbackStatus ?? best ?? moves[0]?.choice ?? "default";
  }
}

// ─── Factory ─────────────────────────────────────────────────────────

/** Build the seat for a tier. Called from startBattle, where the p2 stream
 *  finally exists. */
export function createBotSeat(
  stream: Streams.ObjectReadWriteStream<string>,
  tier: BotTier,
  hooks: BotSeatHooks = {},
): BotSeat {
  return tier === "rookie" ? new RookieBot(stream, hooks) : new HeuristicBot(stream, hooks);
}

// ─── Protocol / dex helpers ──────────────────────────────────────────

interface BotSidePokemon {
  ident: string;
  details: string;
  condition: string;
  active: boolean;
  stats?: Record<string, number>;
  moves?: string[];
}
interface BotActive {
  moves?: { move: string; id: string; pp: number; maxpp: number; target: string; disabled?: boolean }[];
  trapped?: boolean;
}
interface BotRequest {
  active?: BotActive[];
  forceSwitch?: boolean[];
  wait?: boolean;
  side?: { id?: string; name?: string; pokemon?: BotSidePokemon[] };
}

/** "p2a: Bob's Rattata" → "p2a". Anything that isn't a slot token → null. */
function slotToken(token: string | undefined): string | null {
  if (!token) return null;
  const m = /^(p[1-4][a-c])\b/.exec(token);
  return m ? m[1] : null;
}

/** "54/100 brn" | "0 fnt" | "" → percentage. */
function hpPctOf(condition: string): number {
  if (!condition) return 100;
  if (/\bfnt\b/.test(condition)) return 0;
  const m = /(\d+)\s*\/\s*(\d+)/.exec(condition);
  if (!m) return 100;
  const max = Number(m[2]);
  return max > 0 ? (Number(m[1]) / max) * 100 : 0;
}

function isFainted(condition: string): boolean {
  return /\bfnt\b/.test(condition ?? "");
}

/** "Rattata, L25, M" → 25. Showdown OMITS the level token at Lv 100, so a
 *  missing `L` means 100 rather than "unknown". */
function levelOfDetails(details: string): number | null {
  if (!details) return null;
  const m = /,\s*L(\d+)/.exec(details);
  if (m) return Number(m[1]);
  return details.includes(",") || details.trim().length > 0 ? 100 : null;
}

/** A 31-IV / 0-EV / neutral-nature non-HP stat at `level`.
 *
 *  Used to put the foe's defence in the same units as our own computed attack
 *  stat — see the ratio term in chooseMove. It is an ESTIMATE (we cannot see the
 *  foe's EVs or nature), which is exactly the estimate a human makes; the point
 *  is that it scales with level, which a base stat does not. */
function statAtLevel(base: number, level: number): number {
  const lv = Math.max(1, Math.min(100, level));
  return Math.floor(((2 * base + 31) * lv) / 100) + 5;
}

/** "Rattata, L25, M" → the species' Gen-5 types. */
function typesOf(details: string): string[] {
  const name = (details ?? "").split(",")[0]?.trim() ?? "";
  if (!name) return [];
  const sp = DEX.species.get(toID(name));
  return sp.exists ? sp.types : [];
}

/** Type multiplier of `moveType` against `defTypes`.
 *
 *  Two dex calls, not one, and both are needed: getEffectiveness returns a
 *  log2 EXPONENT (1 for 2×, -1 for ½×) and knows nothing about immunity, so
 *  Electric on Ground would come back 1× without the getImmunity check. */
function effectiveness(moveType: string, defTypes: string[]): number {
  if (defTypes.length === 0) return 1;
  if (!DEX.getImmunity(moveType, defTypes)) return 0;
  return Math.pow(2, DEX.getEffectiveness(moveType, defTypes));
}

/** The worst multiplier `defTypes` takes from any of `atkTypes` — the proxy
 *  for "how badly does this matchup go for us". Using the foe's own typing as
 *  a stand-in for its moves is the same read a human makes before seeing the
 *  moveset. */
function worstIncoming(atkTypes: string[], defTypes: string[]): number {
  let worst = 0;
  for (const t of atkTypes) worst = Math.max(worst, effectiveness(t, defTypes));
  return worst;
}
