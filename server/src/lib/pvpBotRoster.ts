// Server-side bot trainers: who the AI brings, and at what level.
//
// WHY THIS FILE EXISTS AT ALL — the server cannot reach the rosters the
// game already has. game/src/data/regions/kanto/gymLeaders.ts and
// game/src/utils/trainerFactory.ts are CLIENT modules (trainerFactory calls
// createPokemon, which is client-only), and nothing under server/ may import
// from game/. Copying them here would also not be enough: a gym entry is
// literally `{ speciesKey: "geodude", level: 14 }` — no moves, no ability, no
// item — so a copy would be a duplicate that drifts AND still needs a
// moveset source. So the roster is species + flavour only, and the moves are
// derived from @pkmn/sim's own Gen-5 learnsets at the matched level, i.e.
// from the same dex adaptTeamForSimulator validates against.
//
// WHY NOT GENERATE FROM THE WHOLE DEX — measured, not assumed. The Gen-5
// dex has ~650 species; game/src/data/pokemon.ts has 288, and the client
// resolves a foe's sprite through `pokemonTable[speciesKey].id` and its type
// badges through `pokemonTable[mon.speciesKey]?.types`. A species the
// simulator knows and the game does not renders as a blank sprite with no
// type badges — an arena that looks broken. Unfiltered generation also
// produces unplayable sets: Abra's only Gen-5 level-up move at every level
// is Teleport, Metapod's is Harden, Magikarp's is Splash.
//
// WHY NOT MIRROR THE PLAYER'S OWN TEAM — free level match, but the player
// already knows every matchup, learns nothing, and the bot's team becomes a
// function of a client-supplied payload.
//
// ROSTER VERIFICATION (done by execution against both tables before this
// list was frozen — tests/pvpBot.test.ts re-checks ALL of it now, including
// the client half: it reads game/src/data/pokemon.ts off disk with fs, which
// is not an import and so does not break the "server never depends on game/"
// rule, but does turn a hand-verification into a test that fails):
//   * every species below exists in the Gen-5 sim dex;
//   * every species exists in game/src/data/pokemon.ts;
//   * every key is CASE-STABLE — `key.toLowerCase().replace(/[^a-z0-9]/g,"")`
//     equals the key. This is load-bearing: the client rebuilds the foe's
//     speciesKey from the protocol's `details` field via exactly that
//     normalisation (parseDetails in game/src/state/pvpBattleView.ts), so the
//     four game species whose keys do NOT survive it — nidoranF, nidoranM,
//     mrMime, hoOh — are excluded from the roster on purpose. A bot Mr. Mime
//     would arrive as `mrmime`, miss pokemonTable, and render as a hole.
//   * every entry yields at least one WORKING damaging move at each of
//     levels 2, 3, 5, 10, 25, 50, 80, 100.

import { Dex, toID } from "@pkmn/sim";

/** Structurally the same shape pvp.ts's BattleSide.team holds. Declared here
 *  rather than imported so this module has no dependency on pvp.ts at all —
 *  pvp.ts imports us. */
export interface BotPokemon {
  speciesKey: string;
  name: string;
  level: number;
  moves: { id: string }[];
  ability: string | null;
  heldItem: null;
  nature: string;
  isShiny: boolean;
  /** Flat IVs and a matched EV budget, both MATCHED to the human Pokémon in
   *  this slot — see buildBotTeam. Game-shaped field names
   *  (hp/attack/defense/spAttack/spDefense/speed), because pvp.ts's
   *  pokemonToShowdownSet reads them in that shape. */
  ivs: GameEvs;
  evs: GameEvs;
}

const SIM_BASE_FORMAT_ID = "gen5customgame";
/** Gen-5 dex, so the learnset sources we read (`5L`/`5M`/`5T`) and the type
 *  chart we score against are the same generation the battle runs in. */
const DEX = Dex.forFormat(SIM_BASE_FORMAT_ID);

// ─── The trainers ────────────────────────────────────────────────────
// Trainer-class FLAVOUR — which types you have to play around — and not a
// difficulty ladder. That was the intention from the start and it used to be
// false: each trainer was a FIXED list of six early-game species, so a Lv 7
// player who rolled Ace Trainer met level-matched Gyarados / Snorlax / Arcanine
// (base-stat totals 540/540/555) while their own party averaged 299, and a
// Lv 95 player who rolled Bug Catcher met a Lv 95 Kakuna (BST 205). MEASURED
// on 2,309 real production parties with the SAME brain on both sides, so a
// deviation from 50% is the TEAM and nothing else:
//
//   max party level <=10 (71% of accounts) : Ace Trainer 100% · Youngster 88%
//                                            Fire Breather 75% · Bug Catcher 38%
//   max party level 11-40                  : Ace Trainer  94% · Bug Catcher 31%
//   max party level >=60 (12% of accounts) : Ace Trainer  50% · Youngster  0%
//                                            Bug Catcher   6% · Hiker      6%
//
// So the roll decided the battle, which is the opposite of "the only difference
// is which types you play around".
//
// THE FIX: a trainer is now a POOL of (species, minLevel) rather than a fixed
// six, and buildBotTeam picks, per slot, the pool entry whose BUILD PROFILE is
// closest to the HUMAN Pokémon in that slot — offence, bulk and speed, at that
// slot's level, IVs and EV budget (see profileOf; base-stat total alone was
// measured and is not enough). Every pool spans roughly 200-550 BST, so every
// trainer can field a fair team at any point in the game. minLevel is what stops
// the matcher reaching for an evolved form absurdly early — a Lv 5 fight is
// between base forms even if the player's Lv 5 Pokémon is a 600-BST pseudo-
// legendary.
//
// AFTER, same harness, same production parties, and the number that matters is
// the SERVER'S OWN PICK, because that is what the queue offer and the permanent
// PRACTICE slab both use (n=100 per band, so ±10):
//
//   max party level <=10 : 46%      (was 38-100% depending on the roll)
//   max party level 11-40: 59%      (was 31-94%)
//   max party level >=60 : 36%      (was 0-50%)
//
// Explicitly CHOOSING a trainer still varies — 18-84% at <=10, 10-68% at >=60,
// n=50 each — and that is now a labelled choice rather than a hidden die roll:
// the hub's picker marks the recommended opponent and flags the others as a fair
// fight or a type advantage either way (rankTrainers returns both numbers). The
// two persistent outliers are the Swimmer (Water is neutral-or-better into most
// early parties) and the Bug Catcher (Bug is a poor offensive type in Gen 5);
// neither is ever the DEFAULT for a party it would beat up, because pickTrainer
// filters on |edge|.
//
// The residual bias favours the HUMAN at the top of the game (36% at Lv 60+),
// and that is understood rather than mysterious: 625 of 1,538 real party Pokémon
// at that level hold an item and the bot holds none, and their four-move
// coverage sets are chosen by a person.
//
// A pool entry is "what this trainer brings once they are strong enough", which
// is USUALLY an evolution line (geodude → graveler → golem) and deliberately
// not always: a Bug Catcher who has grown up brings a Pinsir, and a Hiker's
// low-level slot may be a Sandshrew rather than a fourth Geodude. Duplicate
// species inside one bot team are avoided by preferring unused entries.
//
// The label is what the player sees, and it is the honesty guarantee: it
// always contains " AI". A space is impossible in a real handle
// (validateUsername in lib/nameChange.ts allows only [A-Za-z0-9_]), so a bot
// label can never be mistaken for — or shadow — a real player's name. That
// also makes pumpOmniLog's `|win|<name>` comparison against
// room.b.username collision-free.
export interface BotPoolEntry {
  key: string;
  /** Lowest human level this entry may be fielded at. Base forms are 1; an
   *  evolved form uses roughly its own evolution level, so the bot's team is
   *  level-PLAUSIBLE as well as power-matched. */
  minLevel: number;
}

export interface BotTrainer {
  id: string;
  label: string;
  pool: BotPoolEntry[];
}

/** Compact author form: "species:minLevel", or just "species" for minLevel 1. */
function pool(...entries: string[]): BotPoolEntry[] {
  return entries.map((e) => {
    const [key, min] = e.split(":");
    return { key, minLevel: min ? Number(min) : 1 };
  });
}

export const BOT_TRAINERS: BotTrainer[] = [
  {
    id: "youngster", label: "Youngster AI",
    pool: pool(
      "sentret", "pidgey", "rattata", "spearow", "hoothoot", "ekans", "meowth", "sandshrew",
      "furret:15", "pidgeotto:18", "raticate:20", "fearow:20", "noctowl:20",
      "arbok:22", "sandslash:22", "persian:28", "pidgeot:36",
    ),
  },
  {
    id: "bugcatcher", label: "Bug Catcher AI",
    pool: pool(
      "caterpie", "weedle", "spinarak", "ledyba", "paras", "venonat",
      "metapod:7", "kakuna:7", "butterfree:10", "beedrill:10", "ledian:18", "ariados:22",
      "parasect:24", "venomoth:31", "scyther:40", "pinsir:40", "heracross:45",
    ),
  },
  {
    id: "hiker", label: "Hiker AI",
    pool: pool(
      "diglett", "geodude", "sandshrew", "machop", "cubone", "phanpy", "rhyhorn",
      "onix:20", "graveler:25", "dugtrio:26", "machoke:28", "marowak:28",
      "golem:40", "donphan:40", "rhydon:42", "machamp:42", "steelix:45",
    ),
  },
  {
    id: "swimmer", label: "Swimmer AI",
    pool: pool(
      "wooper", "marill", "horsea", "poliwag", "seel", "krabby", "tentacool", "staryu",
      "azumarill:18", "quagsire:20", "poliwhirl:25", "kingler:28", "tentacruel:30",
      "starmie:30", "seadra:32", "dewgong:34", "poliwrath:40", "lapras:45", "kingdra:50",
    ),
  },
  {
    id: "firebreather", label: "Fire Breather AI",
    pool: pool(
      "slugma", "vulpix", "charmander", "cyndaquil", "houndour", "growlithe", "magby", "ponyta",
      "quilava:14", "charmeleon:16", "houndoom:24", "magmar:30", "ninetales:36",
      "charizard:36", "typhlosion:36", "arcanine:36", "magcargo:38", "rapidash:40",
    ),
  },
  {
    id: "psychic", label: "Psychic AI",
    pool: pool(
      "smoochum", "abra", "slowpoke", "natu", "exeggcute", "drowzee",
      "kadabra:16", "xatu:25", "hypno:26", "jynx:30", "espeon:30",
      "exeggutor:32", "alakazam:36", "slowbro:37", "slowking:37",
    ),
  },
  {
    id: "biker", label: "Biker AI",
    pool: pool(
      "zubat", "ekans", "grimer", "magnemite", "voltorb", "koffing", "elekid",
      "arbok:22", "golbat:22", "magneton:30", "electrode:30", "electabuzz:30",
      "weezing:35", "muk:38", "crobat:45",
    ),
  },
  {
    id: "acetrainer", label: "Ace Trainer AI",
    pool: pool(
      "dratini", "poliwag", "larvitar", "machop", "abra", "gastly", "eevee", "growlithe",
      "kadabra:16", "gyarados:20", "haunter:25", "machoke:28", "dragonair:30", "pupitar:30",
      "alakazam:36", "arcanine:36", "gengar:40", "snorlax:40", "machamp:42",
      "dragonite:55", "tyranitar:55",
    ),
  },
];

// ─── Move selection ──────────────────────────────────────────────────

/** Damaging moves whose basePower is 0 because the engine computes it at
 *  runtime. `basePower > 0` alone silently rejects all of these, which is how
 *  the first pass handed Machop a TM instead of its own Low Kick.
 *
 *  Nothing goes on this list without being FIRED IN A REAL BATTLE and its
 *  damage line read. Lv 50 Machamp into a Lv 50 Snorlax, HP lost:
 *    lowkick KO'd it · seismictoss 50 · magnitude 24 · dragonrage 40 ·
 *    sonicboom 20 · superfang 117 · electroball 16 · gyroball 13 ·
 *    grassknot 33 · heavyslam 30 · return 80 · crushgrip 95 · wringout 31.
 *  Night Shade and Psywave needed a different defender to be measured at all —
 *  they are Ghost and Psychic, and Snorlax is Normal, so the first attempt came
 *  back `|-fail|` on a TYPE IMMUNITY that says nothing about the move. Lv 50
 *  Alakazam into a Lv 50 Machamp: nightshade 50 on all five runs, psywave
 *  25–72 with two misses in five (it is 80% accurate).
 *
 *  `return` measuring 80 is also the cross-check on Frustration in the
 *  deny-list below: both read the same happiness value, which defaults to 255. */
const VARIABLE_POWER_ATTACKS = new Set([
  "lowkick", "seismictoss", "magnitude", "nightshade", "dragonrage",
  "sonicboom", "superfang", "electroball", "gyroball", "grassknot",
  "heavyslam", "return", "psywave", "crushgrip", "wringout",
]);
/** Nominal power used to score a VARIABLE_POWER_ATTACKS move, since its own
 *  basePower field reads 0. Deliberately middling: these moves should be
 *  picked when there is nothing better, not preferred over a real STAB. */
const VARIABLE_POWER_NOMINAL = 55;

/** Moves a greedy bot must never be handed, in four groups. Every claim below
 *  was measured the same way as the allow-list above (Lv 50 attacker, Lv 50
 *  Snorlax, no item, no prior condition, the foe using Splash) — and the
 *  measurement is the reason the groups are not all one group, because three
 *  of my original "dead on arrival" entries turned out to work fine.
 *
 *  MEASURED `-fail`, every time: fling (no item), naturalgift (no Berry),
 *  snore (needs sleep), dreameater (needs a sleeping target), lastresort
 *  (needs every other move used), counter / mirrorcoat / metalburst (need to
 *  be hit first), spitup (needs Stockpile), teleport (fails outright in a
 *  trainer battle, which is exactly why Abra is not on the roster).
 *
 *  MEASURED USELESS RATHER THAN FAILED: frustration deals 1 DAMAGE — happiness
 *  defaults to 255 — and the first pass was cheerfully selecting it as this
 *  bot's best attack. bide produces no effect line at all on the turn it is
 *  used.
 *
 *  MEASURED TO WORK, DENIED ANYWAY, because they work by accident: trumpcard
 *  11, present 33, beatup 12 — feeble and erratic, and their real power is a
 *  function of state the bot does not reason about. focuspunch is the sharpest
 *  case: it KO'd Snorlax outright in the probe, because Snorlax used Splash.
 *  Any actual attack breaks it, so a bot that scores it on raw power (150) is
 *  wrong nearly every turn a human is playing properly.
 *
 *  SELF-DESTRUCTIVE — a bot that scores by raw power picks Explosion on turn
 *  one and hands the player the match. Flail/Reversal/Endeavor are the
 *  inverse trap: enormous scores exactly when the bot is about to faint.
 *
 *  RECHARGE — Hyper Beam and friends read as the best move every single
 *  turn, so a greedy bot alternates attack/recharge and gives away half the
 *  battle. */
const DENIED_MOVES = new Set([
  // measured -fail
  "fling", "naturalgift", "snore", "dreameater", "lastresort",
  "counter", "mirrorcoat", "metalburst", "spitup", "teleport",
  // measured useless
  "frustration", "bide",
  // measured working, denied for depending on state the bot cannot read
  "focuspunch", "trumpcard", "present", "beatup",
  // self-destructive
  "flail", "reversal", "endeavor", "memento", "healingwish", "lunardance",
  "explosion", "selfdestruct",
  // recharge
  "hyperbeam", "gigaimpact", "blastburn", "hydrocannon", "frenzyplant",
  "rockwrecker", "roaroftime",
]);

interface MoveFacts {
  id: string;
  power: number;
  accuracy: number;
  type: string;
  status: boolean;
}

/** Level-appropriate base power. A Lv 5 bot with an 80-power TM is not a
 *  battle, it is an execution — and the real player distribution is the
 *  argument: of 7,014 party Pokémon in production, 582 know exactly ONE move
 *  and 1,624 know two. */
function targetPowerFor(level: number): number {
  if (level <= 10) return 40;
  if (level <= 30) return 60;
  return 80;
}

function moveFacts(id: string): MoveFacts | null {
  const m = DEX.moves.get(id);
  if (!m.exists) return null;
  const accuracy = m.accuracy === true ? 100 : Number(m.accuracy) || 100;
  const status = m.category === "Status";
  let power = Number(m.basePower) || 0;
  if (power === 0 && !status && VARIABLE_POWER_ATTACKS.has(m.id)) {
    power = VARIABLE_POWER_NOMINAL;
  }
  return { id: m.id, power, accuracy, type: m.type, status };
}

/** Every move this species (or any of its pre-evolutions) can learn by
 *  levelling up at or below `level` in Gen 5.
 *
 *  The prevo walk is not optional. Showdown's learnsets are per-species and a
 *  Graveler's own list starts at the level it evolves, so a Lv 25 Graveler
 *  read straight off its own learnset knows almost nothing — while in the
 *  actual game it still knows Geodude's Tackle. Thresholds from a prevo are
 *  applied as-is, which is what the mainline games do too. */
function levelUpPool(speciesId: string, level: number): string[] {
  const out: string[] = [];
  for (const [moveId, at] of levelPairs(speciesId)) {
    if (at <= level) out.push(moveId);
  }
  return out;
}

/** Every (move, earliest level-up level) pair this species or any of its
 *  pre-evolutions has in Gen 5, computed ONCE per species.
 *
 *  The walk itself is the expensive part of this module - a regex per learnset
 *  source entry, over every move of every stage - and the power matcher calls
 *  movesFor for every pool entry of every trainer. Measured before caching: 355
 *  ms of synchronous work to build one six-Pokemon bot team from cold, inside a
 *  socket handler. Caching by species (rather than by species AND level) makes
 *  every level after the first nearly free. */
const levelPairsCache = new Map<string, [string, number][]>();
function levelPairs(speciesId: string): [string, number][] {
  const hit = levelPairsCache.get(speciesId);
  if (hit) return hit;
  const best = new Map<string, number>();
  let cur = DEX.species.get(speciesId);
  const seen = new Set<string>();
  while (cur.exists && !seen.has(cur.id)) {
    seen.add(cur.id);
    const learnset = DEX.species.getLearnsetData(cur.id as never).learnset ?? {};
    for (const [moveId, sources] of Object.entries(learnset)) {
      for (const src of sources as string[]) {
        const m = /^5L(\d+)$/.exec(src);
        if (!m) continue;
        const at = Number(m[1]);
        const prev = best.get(moveId);
        if (prev === undefined || at < prev) best.set(moveId, at);
      }
    }
    if (!cur.prevo) break;
    cur = DEX.species.get(cur.prevo);
  }
  const out = [...best.entries()];
  levelPairsCache.set(speciesId, out);
  return out;
}

/** Gen-5 TM / tutor moves, used only to top up a species that levelling up
 *  gave no attack at all. */
const machineCache = new Map<string, string[]>();
function machinePool(speciesId: string): string[] {
  const hit = machineCache.get(speciesId);
  if (hit) return hit;
  const out = new Set<string>();
  let cur = DEX.species.get(speciesId);
  const seen = new Set<string>();
  while (cur.exists && !seen.has(cur.id)) {
    seen.add(cur.id);
    const learnset = DEX.species.getLearnsetData(cur.id as never).learnset ?? {};
    for (const [moveId, sources] of Object.entries(learnset)) {
      for (const src of sources as string[]) {
        if (src === "5M" || src === "5T") { out.add(moveId); break; }
      }
    }
    if (!cur.prevo) break;
    cur = DEX.species.get(cur.prevo);
  }
  const list = [...out];
  machineCache.set(speciesId, list);
  return list;
}

/**
 * Derive a Gen-5-plausible moveset for `speciesId` at `level`.
 *
 * Deliberately weak at low levels: the pool is what the species could have
 * learnt by levelling to here, nothing more, so a Lv 5 bot brings two or
 * three moves exactly like a Lv 5 player's Pokémon does. The TM top-up fires
 * only when the level-up pool contains ZERO usable attacks (Abra, Metapod,
 * Magikarp and friends) — requiring one attack rather than two is also
 * measured: an earlier version required two and produced
 * `Snorlax → Incinerate` and `Spearow → Echoed Voice`, mechanically fine,
 * flavour-wrong, and stronger than the player.
 *
 * `matchPower` is the human Pokémon's OWN best move power, and it opens the
 * TM/tutor pool as far as that number and no further. Without it the bot is
 * capped at what levelling up teaches, and MEASURED over 1,538 real party
 * Pokémon at max party level >=60 the human's best move averages 100 BP — TMs
 * they went and taught it — against a level-up pool that mostly tops out in the
 * 70s. That gap is most of why every trainer won 0-25% of high-level battles
 * even with species power matched. A player who taught their Pokémon a TM meets
 * a trainer whose Pokémon also knows one; a player who did not, does not.
 */
export function movesFor(speciesKey: string, level: number, matchPower?: number): string[] {
  const speciesId = toID(speciesKey);
  const species = DEX.species.get(speciesId);
  const ownTypes = species.exists ? species.types : [];
  const pool = levelUpPool(speciesId, level)
    .filter((id) => !DENIED_MOVES.has(id))
    .map(moveFacts)
    .filter((m): m is MoveFacts => m !== null);

  const stab = (m: MoveFacts) => (ownTypes.includes(m.type) ? 1.5 : 1);
  const score = (m: MoveFacts) => m.power * (m.accuracy / 100) * stab(m);

  let attacks = pool.filter((m) => !m.status && m.power > 0).sort((a, b) => score(b) - score(a));
  const statuses = pool.filter((m) => m.status);

  if (attacks.length === 0) {
    // Nothing to hit with. Reach for a TM/tutor move of the species' own type
    // first (flavour), then whichever is closest to a level-appropriate
    // power (fairness) — never simply the strongest available.
    const target = matchPower && matchPower > 0 ? matchPower : targetPowerFor(level);
    const candidates = machinePool(speciesId)
      .filter((id) => !DENIED_MOVES.has(id))
      .map(moveFacts)
      .filter((m): m is MoveFacts => m !== null && !m.status && m.power > 0 && m.power <= target)
      .sort((a, b) => {
        const own = (ownTypes.includes(b.type) ? 1 : 0) - (ownTypes.includes(a.type) ? 1 : 0);
        if (own !== 0) return own;
        return Math.abs(a.power - target) - Math.abs(b.power - target);
      });
    if (candidates.length > 0) attacks = [candidates[0]];
  } else if (matchPower && matchPower > 0) {
    // The level-up pool CAN hit, but not as hard as the Pokémon it is standing
    // in front of. Top up from TM/tutor moves, capped at the human's own best
    // power so this can only ever close the gap, never open one the other way.
    const bestOwn = attacks[0].power;
    if (bestOwn < matchPower) {
      const upgrades = machinePool(speciesId)
        .filter((id) => !DENIED_MOVES.has(id))
        .map(moveFacts)
        .filter((m): m is MoveFacts =>
          m !== null && !m.status && m.power > bestOwn && m.power <= matchPower)
        .sort((a, b) => score(b) - score(a));
      if (upgrades.length > 0) {
        // Keep the level-up moves too and let the picker below sort it out on
        // score with the same type-diversity rule.
        const seen = new Set(attacks.map((m) => m.id));
        attacks = [...attacks, ...upgrades.filter((m) => !seen.has(m.id))]
          .sort((a, b) => score(b) - score(a));
      }
    }
  }

  // Up to three attacks with a type-diversity preference — two Normal moves
  // is a worse bot than one Normal and one Rock, and coverage is the whole
  // reason the brain's type scoring has anything to choose between.
  const picked: MoveFacts[] = [];
  const usedTypes = new Set<string>();
  for (const m of attacks) {
    if (picked.length >= 3) break;
    if (usedTypes.has(m.type)) continue;
    picked.push(m);
    usedTypes.add(m.type);
  }
  for (const m of attacks) {
    if (picked.length >= 3) break;
    if (!picked.includes(m)) picked.push(m);
  }
  // Fourth slot from the level-up status pool, best-known-first, so the bot
  // has something that isn't damage without ever being handed a fourth
  // attack it could not have learnt.
  for (const m of statuses) {
    if (picked.length >= 4) break;
    if (!picked.includes(m)) picked.push(m);
  }

  // Never return an empty moveset: adaptTeamForSimulator would substitute
  // Tackle and note it as content drift, which would be a lie — this is our
  // own generator failing, and there is nothing to drift from.
  return picked.length > 0 ? picked.map((m) => m.id) : ["tackle"];
}

// ─── Team assembly + level matching ──────────────────────────────────

export type BotTier = "rookie" | "trainer";

export interface BotTeamPlan {
  trainerId: string;
  label: string;
  team: BotPokemon[];
}

/** What buildBotTeam needs to know about one human Pokémon. Everything is
 *  optional except the level, because three of the four callers (and every
 *  existing test) legitimately have less than a full party row. */
export interface BotMatchTarget {
  level: number;
  speciesKey?: string;
  /** The human's own IVs, in GAME field names. Used to give the bot the SAME
   *  build quality — see buildBotTeam. */
  ivs?: { hp?: number; attack?: number; defense?: number; spAttack?: number; spDefense?: number; speed?: number } | null;
  /** The human's own moveset. Scored, never copied: a Pokémon that knows one
   *  40-power move is not the same threat as the same species with four. */
  moves?: { id?: unknown }[] | null;
  /** The human's own EVs, in GAME field names. The bot gets the same BUDGET,
   *  spent its own way — see evSpreadFor. */
  evs?: { hp?: number; attack?: number; defense?: number; spAttack?: number; spDefense?: number; speed?: number } | null;
}

/** Base-stat total. Kept as a coarse species-power label (it is what the
 *  roster comment above is measured in, and it is what a reader recognises),
 *  but it is NOT what the matcher sorts on — see profileOf. 0 for a species the
 *  dex does not know, which can only happen for a human's mon and is handled by
 *  falling back to the party mean. */
export function bstOf(speciesKey: string): number {
  const f = factsOf(speciesKey);
  if (!f) return 0;
  const s = f.base;
  return s.hp + s.atk + s.def + s.spa + s.spd + s.spe;
}

// ─── Battle power at a level ─────────────────────────────────────────
// Matching on base-stat total ALONE was measured and it is not enough. With
// BST matched to within a few points at every level (bot 292 vs human 299 at
// max level <=10) and the same brain on both sides, the win rate still ran from
// 13% (Youngster) to 100% (Psychic): at low levels what decides a fight is the
// best move the species can actually have LEARNT by then against the stat it
// applies to, and a 40-power Tackle off a Rattata's attack is not the same
// battle as a 50-power Confusion off a Drowzee's special attack, whatever the
// two base-stat totals say.
//
// So the matcher sorts on this instead: offence (the best real move × the stat
// that moves it) geometrically averaged with bulk (HP × mean defence), at the
// slot's actual level and IVs. It is a proxy, not a damage calculation — no
// type matchup, no speed, no items — and it is validated the only way that
// means anything, by measuring win rates after matching on it.

interface StatSpread { hp: number; atk: number; def: number; spa: number; spd: number; spe: number }

/** Base stats + types + first ability for a species key, resolved ONCE.
 *  The matcher's inner loop runs (8 trainers x up to 17 pool entries x 6 slots)
 *  times per team build, and `DEX.species.get(toID(key))` in that loop measured
 *  as most of the 13 ms it took. */
interface SpeciesFacts { name: string; base: StatSpread; types: readonly string[]; ability: string | null }
const factsCache = new Map<string, SpeciesFacts | null>();
function factsOf(speciesKey: string): SpeciesFacts | null {
  const hit = factsCache.get(speciesKey);
  if (hit !== undefined) return hit;
  const sp = DEX.species.get(toID(speciesKey));
  const out: SpeciesFacts | null = sp.exists
    ? {
      name: sp.name,
      base: sp.baseStats as StatSpread,
      types: sp.types,
      ability: sp.abilities?.[0] ?? null,
    }
    : null;
  factsCache.set(speciesKey, out);
  return out;
}

/** The GAME's EV field names, which is what pokemonToShowdownSet reads. */
export interface GameEvs {
  hp: number; attack: number; defense: number; spAttack: number; spDefense: number; speed: number;
}

/** Gen-3+ stat formula, neutral nature. */
function statsAt(base: StatSpread, level: number, iv: number, evs: GameEvs): StatSpread {
  const other = (b: number, ev: number) =>
    Math.floor(((2 * b + iv + Math.floor(ev / 4)) * level) / 100) + 5;
  return {
    hp: Math.floor(((2 * base.hp + iv + Math.floor(evs.hp / 4)) * level) / 100) + level + 10,
    atk: other(base.atk, evs.attack), def: other(base.def, evs.defense),
    spa: other(base.spa, evs.spAttack), spd: other(base.spd, evs.spDefense),
    spe: other(base.spe, evs.speed),
  };
}

const NO_EVS: GameEvs = { hp: 0, attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0 };

/**
 * Spend an EV budget the way a player who trains one Pokémon does: its better
 * attacking stat first, then speed, then HP, 252 to a stat (the useful cap in
 * Gen 5 — the 253rd point buys nothing).
 *
 * The BUDGET is the human's own total in that slot, never more. MEASURED over
 * production: the mean EV total is 1 at max party level <=10, 83 at 11-40 and
 * 422 at >=60 (of a 510 maximum), so a flat-0 bot was fighting a fully trained
 * team at the top of the game — worth roughly +40 in two stats, which is most
 * of a Pokémon.
 */
function evSpreadFor(base: StatSpread, total: number): GameEvs {
  const budget = Math.max(0, Math.min(510, Math.round(total)));
  if (budget === 0) return NO_EVS;
  const out: GameEvs = { ...NO_EVS };
  const order: (keyof GameEvs)[] = base.spa > base.atk
    ? ["spAttack", "speed", "hp"]
    : ["attack", "speed", "hp"];
  let left = budget;
  for (const stat of order) {
    const give = Math.min(252, left);
    out[stat] = give;
    left -= give;
    if (left <= 0) break;
  }
  return out;
}

/** movesFor is a learnset walk with a regex per source entry, and the matcher
 *  calls it for every pool entry of every trainer. Memoised on
 *  (species, level, matchPower) — all bounded and the answer is pure. */
const movesCache = new Map<string, string[]>();
function movesForCached(speciesKey: string, level: number, matchPower: number): string[] {
  const k = `${speciesKey}|${level}|${matchPower}`;
  const hit = movesCache.get(k);
  if (hit) return hit;
  const out = movesFor(speciesKey, level, matchPower > 0 ? matchPower : undefined);
  movesCache.set(k, out);
  return out;
}

/** What the bot's build in a slot must mirror: level, IV quality, EV budget and
 *  the power of the best move the human Pokemon actually knows. */
export interface BuildMatch {
  level: number;
  iv: number;
  evTotal: number;
  /** 0 when unknown - then nothing is topped up and the level-up pool stands. */
  matchPower: number;
}

/** Three numbers, not one. See profileOf. */
export interface BuildProfile {
  /** Best real move x the stat that moves it. */
  off: number;
  /** HP x mean defence. */
  bulk: number;
  /** Speed stat. */
  spe: number;
}

/**
 * "What KIND of fight is this Pokemon, at this level, with this build."
 *
 * A single scalar was not enough, and the failure was concrete. Matching on
 * sqrt(offence x bulk) alone, a Lv 5 SLUGMA (speed 20, special attack 70) came
 * out as the closest match for a Lv 5 CHARMANDER (speed 65) - the products agree
 * to within 1% - and then lost four battles in five, because at Lv 5 a battle is
 * two or three hits long and the Charmander took every one of them first. Speed
 * does not trade against bulk on that timescale.
 *
 * So a build is a POINT, matching is a DISTANCE, and the axes are the three a
 * player reads off a Pokemon at a glance: how hard it hits, how much it takes,
 * how fast it is.
 *
 * `moves` is the mon's OWN moveset when we know it (the human's, straight off
 * the team payload - 587 of 7,035 real party Pokemon know exactly one move and
 * that has to count against them) and the generator's otherwise (every bot
 * candidate, which does not exist yet).
 *
 * Deliberately NOT a damage calculation: no type matchup (that is `edge`, a
 * separate axis handled by rankTrainers), no held item, no ability.
 */
export function profileOf(
  speciesKey: string,
  match: BuildMatch,
  moves?: string[],
): BuildProfile {
  const level = clampLevel(match.level);
  const facts = factsOf(speciesKey);
  if (!facts) return { off: 1, bulk: 1, spe: 1 };
  const base = facts.base;
  const st = statsAt(base, level, match.iv, evSpreadFor(base, match.evTotal));
  // Only the MOVE half is cached, and only for a generated set. The stat half is
  // arithmetic, and caching it too would key the cache on the human's IV and EV
  // totals - which differ per account, so it would almost never be hit twice.
  const power = moves === undefined
    ? bestPowersCached(speciesKey, level, match.matchPower)
    : bestPowersOf(facts.types, moves);
  return {
    // A mon with nothing that damages is still a body in the way, not a zero.
    off: Math.max(power.phys * st.atk, power.spec * st.spa, 1),
    bulk: Math.max(1, st.hp * ((st.def + st.spd) / 2)),
    spe: Math.max(1, st.spe),
  };
}

interface BestPowers { phys: number; spec: number }

/** Best effective (power x accuracy x STAB) among these moves, per category. */
function bestPowersOf(ownTypes: readonly string[], ids: string[]): BestPowers {
  let phys = 0;
  let spec = 0;
  for (const id of ids) {
    const f = moveFacts(id);
    if (!f || f.status || f.power <= 0) continue;
    const eff = f.power * (f.accuracy / 100) * (ownTypes.includes(f.type) ? 1.5 : 1);
    if (DEX.moves.get(id).category === "Special") spec = Math.max(spec, eff);
    else phys = Math.max(phys, eff);
  }
  return { phys, spec };
}

const powerCache = new Map<string, BestPowers>();
function bestPowersCached(speciesKey: string, level: number, matchPower: number): BestPowers {
  const ck = `${speciesKey}|${level}|${matchPower}`;
  const hit = powerCache.get(ck);
  if (hit) return hit;
  const out = bestPowersOf(
    factsOf(speciesKey)?.types ?? [],
    movesForCached(speciesKey, level, matchPower),
  );
  powerCache.set(ck, out);
  return out;
}

/** Offence and bulk trade against each other, so they carry equal weight;
 *  speed carries less, because a speed gap only decides the turns it flips.
 *  0.6 is a judgement, not a fit - what is measured is the win rate after
 *  matching on it. */
const W_OFF = 1;
const W_BULK = 1;
const W_SPE = 0.6;

/** Distance between two builds, in log space so it is scale-free: the same
 *  number means the same proportional mismatch at Lv 5 and at Lv 100. */
export function matchDistance(a: BuildProfile, b: BuildProfile): number {
  return W_OFF * Math.abs(Math.log(a.off / b.off))
    + W_BULK * Math.abs(Math.log(a.bulk / b.bulk))
    + W_SPE * Math.abs(Math.log(a.spe / b.spe));
}

/** The species a slot is matched against when the human's own is unknown or
 *  unrecognised: a production-median-ish Pokémon, so the fallback is a real
 *  build profile at the right level rather than a magic number. */
const DEFAULT_TARGET_SPECIES = "bulbasaur";
/** How far above the best-fitting trainer another trainer may be and still count
 *  as "fits". Match distances are log-space and scale-free, so this is ONE
 *  number for the whole game: 0.2 is roughly "20% out on one axis". It buys
 *  variety - usually several trainers qualify - without reopening the lottery
 *  that made a Lv 7 player fight an Arcanine. */
export const FIT_SLACK = 0.2;
/** How much type advantage an OFFERED matchup may carry, in log2 steps, in
 *  either direction. Half a step is about "neither side has a clean
 *  super-effective answer the other lacks". An explicitly REQUESTED trainer is
 *  exempt: if the player picks the Swimmer with a Fire party that is their call,
 *  and the picker says so. */
export const MAX_TYPE_EDGE = 0.5;

function findTrainer(id: string | undefined): BotTrainer | null {
  if (!id) return null;
  return BOT_TRAINERS.find((t) => t.id === id) ?? null;
}

/**
 * Every trainer, best fit first: `fit` is the mean per-slot build-profile error their
 * pool can achieve against this party, and `edge` is the type advantage their
 * assigned team would hold over it, in log2 steps (+1 = one full "super
 * effective" step in the bot's favour, -1 in the player's).
 *
 * `edge` exists because power matching alone did not settle the low-level
 * numbers. Measured with build, IVs, EVs and move power all matched, at max
 * party level <=10 and n=16, Swimmer still won 100% while Hiker won 6% — and
 * that is not a mystery, it is Pokémon: 53.6% of accounts have a ONE-Pokémon
 * party, and one Water type against one Fire starter is decided before the
 * first turn. What a fair OFFER can do is not put that matchup in front of the
 * player, which is what ranking on |edge| does.
 *
 * Deterministic — the caller adds any variety it wants — so the hub can NAME
 * the opponent it is about to offer and the server will field that one.
 */
export interface TrainerFit { trainer: BotTrainer; fit: number; edge: number }

export function rankTrainers(humanTeam: BotMatchTarget[]): TrainerFit[] {
  const slots = slotTargets(humanTeam);
  const humanTypes = humanTeam
    .slice(0, slots.length)
    .map((m) => typesOf(m?.speciesKey))
    .filter((t) => t.length > 0);
  const scored = BOT_TRAINERS.map((trainer) => {
    const picks = assign(trainer, slots);
    const err = picks.reduce(
      (a, p, i) => a + matchDistance(profileOf(p.key, slots[i]), slots[i].profile),
      0,
    );
    return {
      trainer,
      fit: Number((err / Math.max(1, picks.length)).toFixed(3)),
      edge: typeEdge(picks.map((p) => typesOf(p.key)), humanTypes),
    };
  });
  // Power first, then type neutrality among the trainers that fit. Two stages
  // rather than one weighted score, because the two terms are in different
  // units and a weight nobody can justify is worse than an explicit order.
  const best = Math.min(...scored.map((s) => s.fit));
  return scored.sort((a, b) => {
    const aFits = a.fit <= best + FIT_SLACK;
    const bFits = b.fit <= best + FIT_SLACK;
    if (aFits !== bFits) return aFits ? -1 : 1;
    if (aFits && bFits) return Math.abs(a.edge) - Math.abs(b.edge);
    return a.fit - b.fit;
  });
}

/** Mean type advantage of one team's typing over another's, in log2 steps.
 *  Uses each side's own TYPES as the stand-in for its moves — the same read the
 *  brain's worstIncoming makes, and the same one a player makes on sight. */
function typeEdge(botTeam: string[][], humanTeam: string[][]): number {
  if (botTeam.length === 0 || humanTeam.length === 0) return 0;
  let sum = 0;
  let n = 0;
  for (const bot of botTeam) {
    for (const human of humanTeam) {
      sum += Math.log2(Math.max(0.25, bestEffectiveness(bot, human)))
        - Math.log2(Math.max(0.25, bestEffectiveness(human, bot)));
      n++;
    }
  }
  return n > 0 ? Number((sum / n).toFixed(3)) : 0;
}

function typesOf(speciesKey: string | undefined): string[] {
  if (!speciesKey) return [];
  return [...(factsOf(speciesKey)?.types ?? [])];
}

/** The best multiplier any of `atkTypes` gets on `defTypes`. Two dex calls,
 *  because getEffectiveness returns a log2 EXPONENT and knows nothing about
 *  immunity. */
function bestEffectiveness(atkTypes: string[], defTypes: string[]): number {
  if (atkTypes.length === 0 || defTypes.length === 0) return 1;
  let best = 0;
  for (const t of atkTypes) {
    const mult = DEX.getImmunity(t, defTypes)
      ? Math.pow(2, DEX.getEffectiveness(t, defTypes))
      : 0;
    if (mult > best) best = mult;
  }
  return best;
}

/** Pick a trainer for a party. `preferred` always wins when it names a real
 *  trainer — the hub tells the player who they are about to fight, and
 *  silently substituting someone else would make that offer a lie. Anything
 *  unknown falls through to the recommendation rather than erroring, because
 *  refusing a practice battle over a bad string is worse than fighting a Hiker.
 *
 *  With no preference, choose at random among the trainers that FIT (within
 *  FIT_TOLERANCE of the best). That keeps some variety in who turns up while
 *  making the old "1-in-8 chance of an unwinnable fight" impossible. */
function pickTrainer(humanTeam: BotMatchTarget[], preferred?: string): BotTrainer {
  const named = findTrainer(preferred);
  if (named) return named;
  const ranked = rankTrainers(humanTeam);
  // Variety, bounded: any trainer that both fits on power and is within half a
  // type step of neutral. There is usually more than one, so the same party does
  // not always meet the same opponent; when there is not, the best-ranked one is
  // taken rather than reopening the lottery.
  const best = Math.min(...ranked.map((r) => r.fit));
  const fair = ranked.filter((r) => r.fit <= best + FIT_SLACK && Math.abs(r.edge) <= MAX_TYPE_EDGE);
  const good = fair.length > 0 ? fair : [ranked[0]];
  return good[Math.floor(Math.random() * good.length)].trainer;
}

/**
 * Build the bot's side against a specific human team.
 *
 * LEVEL MATCHING is the hard requirement, and it is slot-for-slot rather
 * than one flat level. Measured against production (2,301 accounts with a
 * party, 7,014 party Pokémon): median party level 5, p25 4, p75 25, p90 81,
 * and 2,001 of 2,301 accounts — 87.0% — have their ENTIRE party under Lv 50.
 * A fixed Lv 50 bot would be a non-battle for seven players in eight, in
 * either direction.
 *
 * `lib/pvpFormat.ts`'s normalizeTeamLevel is the same idea (it raises AND
 * lowers, which is exactly the property needed) and is where the hint came
 * from, but it is deliberately NOT wired in here: it is imported by nothing
 * and wiring it is a separate job. The mirroring lives here instead, and
 * because levelCapForFormat returns null for format "bot" the HUMAN's real
 * levels are left untouched — the bot comes to the player, not the reverse.
 *
 * LEVELS ARE MIRRORED IN PARTY ORDER, slot i against slot i. This used to sort
 * both sides descending "so the bot's lead matches the player's strongest
 * Pokémon", which is the wrong target: SIM_FORMAT_ID disables Team Preview, so
 * the human cannot choose their lead — turn 1 is always their party slot 1
 * against the bot's slot 1. Sorting descending therefore pointed the bot's
 * highest-level Pokémon at whatever the player happens to keep in front.
 *
 * MEASURED over all 1,069 production parties with two or more Pokémon: sorting
 * gave 201 of them (18.8%) a bot lead at least 10 levels above their own lead,
 * 84 (7.9%) at least 25 levels, and 20 (1.9%) at least 50 — worst real case a
 * party led by a Lv 14 Bellsprout opening against a Lv 100 bot, i.e. a
 * guaranteed one-shot on turn 1 of a "practice" battle. The multiset of levels
 * is identical either way, so the "same total power" property the sort was
 * reaching for is unaffected; only the opening matchup changes, and in party
 * order it is the one the player actually chose.
 *
 * POWER MATCHING is the second half, and level matching alone was not enough —
 * see the measurements above BOT_TRAINERS. Per slot, the bot brings the pool
 * entry whose BUILD PROFILE (offence, bulk, speed — see profileOf) is closest to
 * the HUMAN Pokémon in that slot, among the entries whose minLevel that slot's
 * level allows. Ties go to the WEAKER species: this is practice, and the player
 * should be the one with the small edge.
 *
 * IV MATCHING is the third half, and it is the one nobody had noticed. The bot
 * shipped flat 31 IVs "so it has no gear advantage" — but the real population
 * mean is 15.7 (measured over 7,035 production party Pokémon), i.e. the bot had
 * roughly a tenth of every stat in hand over the average real Pokémon, which at
 * low levels is most of a turn. Isolated by execution at max party level <=10,
 * same brain both sides, n=30: Youngster 70% → 53% with IVs matched, and 47%
 * with IVs and moveslot count both matched. So the bot's IVs are now this
 * slot's human Pokémon's own mean IV, flat across the six stats: a player with
 * a perfect 31-IV team still fights a 31-IV bot, and a player with a wild-caught
 * average team fights an average bot.
 *
 * MOVESLOT COUNT is deliberately NOT matched. Measured in the same run and it
 * is nearly free (Youngster 70% → 77%, Bug Catcher 40% → 43% — noise at
 * n=30), and clipping the bot to one move would remove the type coverage that
 * makes its move choice legible to the player watching it.
 *
 * NO HELD ITEM either way for the bot, while 637 of 7,035 real party Pokémon
 * hold one — an asymmetry left running in the HUMAN's favour on purpose.
 */
export function buildBotTeam(
  humanTeam: BotMatchTarget[],
  preferredTrainer?: string,
): BotTeamPlan {
  const trainer = pickTrainer(humanTeam, preferredTrainer);
  const slots = slotTargets(humanTeam);
  const picks = assign(trainer, slots);
  const team: BotPokemon[] = picks.map((entry, i) => {
    const slot = slots[i];
    const species = factsOf(entry.key);
    const iv = slot.iv;
    const base = species?.base ?? null;
    return {
      speciesKey: entry.key,
      name: species?.name ?? entry.key,
      level: slot.level,
      moves: movesForCached(entry.key, slot.level, slot.matchPower).map((id) => ({ id })),
      // The species' own first ability, NO held item, neutral nature, and IVs
      // and an EV budget matched to the human Pokémon in this slot — see the
      // note above. The only thing that differentiates the bot is what its
      // level lets it know, exactly like the human.
      ability: species?.ability ?? null,
      heldItem: null,
      nature: "Hardy",
      isShiny: false,
      ivs: { hp: iv, attack: iv, defense: iv, spAttack: iv, spDefense: iv, speed: iv },
      evs: base ? evSpreadFor(base, slot.evTotal) : { ...NO_EVS },
    };
  });
  return { trainerId: trainer.id, label: trainer.label, team };
}

interface SlotTarget extends BuildMatch { profile: BuildProfile }

/** One entry per bot Pokémon to build: what level to be, what power to match,
 *  and how well built to be. Clamped hard, because this is derived from a
 *  client-supplied team (bounds-validated by lib/pvpTeamValidation.ts, but a
 *  matcher fed a NaN would produce a team the simulator rejects).
 *
 *  A slot whose species the dex does not know — the one case adaptTeamForSimulator
 *  DROPS, so the human will be a Pokémon short — is matched against a stand-in at
 *  the same level rather than against 0, because the alternative is handing that
 *  slot the feeblest thing in the pool. */
function slotTargets(humanTeam: BotMatchTarget[]): SlotTarget[] {
  const size = Math.max(1, Math.min(6, humanTeam.length));
  const mons = humanTeam.slice(0, size);
  const out: SlotTarget[] = [];
  for (let i = 0; i < size; i++) {
    const m = mons[i];
    const level = clampLevel(m?.level ?? 5);
    const moves = ownMoveIds(m);
    const match: BuildMatch = {
      level,
      iv: ivMeanOf(m),
      evTotal: evTotalOf(m),
      matchPower: bestMovePowerOf(moves),
    };
    const known = m?.speciesKey && bstOf(m.speciesKey) > 0;
    out.push({
      ...match,
      profile: known
        ? profileOf(m!.speciesKey!, match, moves)
        : profileOf(DEFAULT_TARGET_SPECIES, match),
    });
  }
  return out;
}

/** The human Pokémon's own EV total, 0..510. Absent EVs read as 0, which is
 *  what an untrained Pokémon has and what 3,501 of them really do have. */
function evTotalOf(m: BotMatchTarget | undefined): number {
  const evs = m?.evs;
  if (!evs) return 0;
  const nums = [evs.hp, evs.attack, evs.defense, evs.spAttack, evs.spDefense, evs.speed]
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n >= 0);
  const total = nums.reduce((a, b) => a + b, 0);
  return Math.max(0, Math.min(510, Math.round(total)));
}

/** The best base power among the human Pokémon's own damaging moves. 0 when we
 *  were not given a moveset, which leaves the bot on its level-up pool. */
function bestMovePowerOf(moveIds: string[] | undefined): number {
  if (!moveIds) return 0;
  let best = 0;
  for (const id of moveIds) {
    const f = moveFacts(id);
    if (!f || f.status) continue;
    if (f.power > best) best = f.power;
  }
  return Math.min(250, best);
}

/** The human Pokémon's own move ids, or undefined when the caller did not pass
 *  a moveset (every existing test, and the tournament/queue paths that never
 *  build a bot team). Undefined means "score them on what the species could
 *  know at this level", which is the fairer default than assuming one move. */
function ownMoveIds(m: BotMatchTarget | undefined): string[] | undefined {
  const moves = m?.moves;
  if (!Array.isArray(moves) || moves.length === 0) return undefined;
  const ids = moves
    .map((mv) => (mv && typeof mv.id === "string" ? toID(mv.id) : ""))
    .filter((id) => id.length > 0);
  return ids.length > 0 ? ids : undefined;
}

/** The human Pokémon's own average IV, 0..31. Missing/garbage IVs read as 31,
 *  which is what every existing caller and test passes and is the safe
 *  direction: it can only make the bot's build equal to a perfect one, never
 *  better than it. */
function ivMeanOf(m: BotMatchTarget | undefined): number {
  const ivs = m?.ivs;
  if (!ivs) return 31;
  const nums = [ivs.hp, ivs.attack, ivs.defense, ivs.spAttack, ivs.spDefense, ivs.speed]
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 31);
  if (nums.length === 0) return 31;
  return Math.max(0, Math.min(31, Math.round(nums.reduce((a, b) => a + b, 0) / nums.length)));
}

/** Choose one pool entry per slot: level-legal, closest in build profile to that
 *  slot's target, unused if possible, weaker on a tie.
 *
 *  Greedy in party order rather than a global optimum. A global assignment
 *  would buy a fraction of a profile step and cost the property that matters
 *  more: slot 1 — the lead, which the player cannot choose because this format
 *  disables Team Preview — always gets the best available match. */
function assign(trainer: BotTrainer, slots: SlotTarget[]): BotPoolEntry[] {
  const used = new Set<string>();
  const out: BotPoolEntry[] = [];
  for (const slot of slots) {
    const legal = trainer.pool.filter((e) => e.minLevel <= slot.level);
    // Nothing gated this low (impossible with the shipped pools, since every
    // one has minLevel-1 entries) — fall back to the lowest-gated entry rather
    // than fielding nothing.
    const candidates = legal.length > 0
      ? legal
      : [[...trainer.pool].sort((a, b) => a.minLevel - b.minLevel)[0]];
    const fresh = candidates.filter((e) => !used.has(e.key));
    const from = fresh.length > 0 ? fresh : candidates;
    const best = from.reduce((a, b) => {
      const pa = profileOf(a.key, slot);
      const pb = profileOf(b.key, slot);
      const da = matchDistance(pa, slot.profile);
      const dbb = matchDistance(pb, slot.profile);
      if (da !== dbb) return da < dbb ? a : b;
      // Tie: the weaker one, because this is practice.
      return pa.off * pa.bulk <= pb.off * pb.bulk ? a : b;
    });
    used.add(best.key);
    out.push(best);
  }
  return out;
}

function clampLevel(level: number): number {
  if (!Number.isFinite(level)) return 5;
  return Math.max(1, Math.min(100, Math.round(level)));
}
