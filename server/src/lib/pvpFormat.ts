// Competitive ruleset: clauses, level normalisation, and legality.
//
// The engine is Showdown's real Gen 5 simulator, so every MECHANIC is already
// correct. What was missing is the RULESET around it. gen5customgame is
// Showdown's no-rules sandbox: no tier bans, no species clause, no sleep
// clause, no evasion or OHKO bans, any level. That is the right base for a
// game whose content has drifted from Showdown's dex, but on its own it is
// not a battle simulator a competitive player recognises.
//
// ─── The one design rule in this file ──────────────────────────────────
//
// Clauses are split by WHERE they can fail, not by what they do:
//
//   TEAM-LEGALITY clauses (Species, Evasion, OHKO, Moody) are checked HERE,
//   by us, before a battle is ever created. They are NOT added to the
//   simulator's format string. If they were, the simulator would refuse the
//   team deep inside its own validation and the player would experience it
//   as a battle that never starts — which is precisely the failure that
//   killed PvP once already (Team Preview left every match sitting until the
//   AFK watchdog forfeited it). Owning the check means owning the message.
//
//   BATTLE-TIME clauses (Sleep Clause Mod, Endless Battle Clause) go in the
//   format string, because they constrain play rather than team composition.
//   They cannot refuse a team, so they cannot strand a battle.
//
// ─── Measured against production before choosing ───────────────────────
//
// CORRECTION. This block previously read "Evasion Clause 0 accounts affected /
// OHKO Clause 0 accounts affected … nobody in the game owns one of those
// moves", and concluded the two clauses were free. That measurement counted
// PARTIES ONLY, and the team builder pools party AND BOX
// (game/src/components/TeamBuilderModal.tsx). Re-measured read-only over all
// 2,310 saves — 7,051 party Pokemon and 35,669 BOX Pokemon:
//
//                                                 party    box   accounts
//   Evasion Clause  (Double Team / Minimize)          0      1          1
//   OHKO Clause     (Guillotine / Fissure / …)        0     33         27
//   Moody Clause    (Moody ability)                   0      0          0
//   Species Clause  (duplicate species in party)    462      —        462 (20.0%)
//
// So Evasion and OHKO are NOT a guard for future content — they are live
// against content that ships today, and 28 real accounts hold a Pokemon the
// rated queue and tournaments will refuse the moment they pick it into a team.
// It gets worse on its own: Gligar learns Guillotine at Lv 52 and the Johto
// encounter table spawns it wild at Lv 67-70
// (game/src/data/regions/johto/encounters.ts), so `defaultMoves()` hands every
// freshly-caught one feintattack / slash / screech / GUILLOTINE — all four
// fully functional, because game/src/data/moves.ts backfills any move it does
// not hand-author from @pkmn/dex (Guillotine arrives with pp 5, and real saves
// carry it as pp 5 / maxPp 5).
//
// The clauses are still RIGHT — an OHKO move in a rated ladder is indefensible,
// and the refusal names the Pokemon, names the move and says how to fix it. But
// the honest description of them is "friction for 28 accounts and for anyone
// who catches a Gligar", not "free". What is still missing is a warning in the
// TEAM BUILDER, so a player learns this before pressing Queue rather than from
// a refusal; that is client work (game/) and is not in this module's remit.
// tests/pvpClauseLiveContent.test.ts pins the live-content facts above so this
// paragraph cannot quietly revert to "nobody owns one".
//
// Moody genuinely IS a future guard, and that is measured too rather than
// assumed: Moody exists in game/src/data/abilities.ts only as the HIDDEN
// ability of Remoraid / Octillery / Smeargle, and pickAbility() returns a
// PRIMARY ability and nothing else, so no path in the game can assign it. The
// dex modal is the only thing that reads `hidden`.
//
// Species Clause is different again and is the owner's call, not an engineering
// one: this is a CATCHING game where owning six Rattata is normal, and 1 in 5
// players (462 accounts, 20.0%) would have their current party refused. It is
// therefore configurable and defaults OFF, with the check implemented and
// tested so turning it on is a one-line change plus a team-builder warning.

/**
 * The subset of a game Pokemon this module needs. Declared structurally
 * rather than imported from pvp.ts: that keeps the module standalone and
 * unit-testable with no import of the simulator, and avoids coupling the
 * ruleset to a type that isn't exported.
 */
export interface RuleCheckMon {
  speciesKey: string;
  name?: string;
  nickname?: string | null;
  level: number;
  ability?: string | null;
  moves?: { id: string }[];
}

// ─── Format strings ────────────────────────────────────────────────────

const BASE = "gen5customgame";

/**
 * Battle-time clauses only. Each one constrains PLAY, so none of them can
 * reject a team at validation time.
 *
 *   Sleep Clause Mod      — you may not put a second foe to sleep while one
 *                           is already sleeping. The single most important
 *                           competitive rule after tiering; without it,
 *                           spamming Spore/Hypnosis is a strategy.
 *   Endless Battle Clause — ends provably-unwinnable stall loops instead of
 *                           letting them run to the turn watchdog, which
 *                           would otherwise forfeit an innocent player.
 *
 * ─── "HP Percentage Mod" was here and was REMOVED ───────────────────────
 *
 * It was declared, accepted by the simulator, and measured to do NOTHING in
 * this format: Custom Game runs debug:true → reportExactHP, and reportExactHP
 * wins over reportPercentages, so p1 still receives
 * `|switch|p2a: BRAVO|Snorlax, L50, F|235/235`. It was kept anyway on the
 * grounds that declaring it was "harmless and correct".
 *
 * It is not harmless, and it is not correct. Declaring a rule makes the
 * simulator put a rule line on BOTH player streams, verbatim:
 *
 *     |rule|HP Percentage Mod: HP is shown in percentages
 *
 * measured on a real battle on the shipped format string, in the same run that
 * measured exact 235/235 foe HP three lines later. That is a false statement
 * about the battle the player is in, published on the wire and persisted into
 * PvpMatch.battleLog next to the exact HP that contradicts it, and it costs a
 * rule this format does not honour. So it is gone: two clauses, both of which
 * were measured to change play.
 *
 * (Where it does NOT currently surface is the player's log — the client decoder
 * lists `case "rule":` among its deliberately-silent tags, executed and
 * confirmed: the three-rule preamble yields exactly one narration line,
 * "Turn 1". A previous review claimed the text reached the UI through the
 * decoder's `default` branch; it does not, and that is why this is a
 * correctness-of-the-wire fix rather than a player-visible bug.)
 *
 * Hiding foe HP is still a real OPEN item — knowing a wall is on 271 rather
 * than "53%" decides whether a KO is guaranteed — and it needs doing on our
 * side of the stream, not by a format flag. pvpBattleView already parses both
 * shapes and flags which it got via hpKnownExact, so the client is ready for
 * either. Do not re-add this rule to fake it:
 * tests/pvpFormatClauseHonesty.test.ts fails if the shipped format declares a
 * rule whose own |rule| line the battle then contradicts.
 */
// EVERY NAME HERE WAS PROBED AGAINST THE REAL SIMULATOR, one at a time,
// because an unrecognised rule does not degrade — it throws before `|start`
// and EVERY battle fails to begin. My first attempt at this list used
// "Sleep Clause", which is what the competitive community calls it and what
// Showdown's own UI displays; the simulator rejects it with
//   Error: Unrecognized rule "Sleep Clause"
// The real id is "Sleep Clause Mod" (confirmed: it is what [Gen 5] Random
// Battle carries in its ruleset). "Cancel Mod" also fails here, with
//   Rule "cancelmod" ... already exists
// because Custom Game's own ruleset already includes it. Shipping either
// would have killed PvP outright — the same class of outage as the |tier|
// prefix bug. Re-probe before adding anything to this list.
const BATTLE_CLAUSES = [
  "Sleep Clause Mod",
  "Endless Battle Clause",
] as const;

/**
 * Build the simulator format id.
 *
 * @param teamPreview whether the pre-battle Team Preview phase is on. Passing
 *   false appends Showdown's own `!Team Preview` removal syntax.
 *
 * PRODUCTION PASSES TRUE. Custom Game ships Team Preview ON, and with it the
 * first request a player receives is `{"teamPreview":true}` — no active slot,
 * no moves. That is why this parameter exists at all: a client with no
 * team-order picker could not answer it, so every battle sat until the
 * five-minute AFK watchdog forfeited it, and `false` was the shipped value for
 * the whole life of PvP.
 *
 * The two things that had to exist before it could be flipped both do now, and
 * neither of them lives in this file:
 *
 *   * a PICKER, in the arena's own centre window (game/src/components/
 *     PvpArena.tsx), reachable on desktop and on a phone through the one
 *     console seam both layouts share;
 *   * an AUTO-LOCK, armed inside pvp.ts's startBattle — the single choke point
 *     that matchmaking, friend invites, the tournament bracket ticker and the
 *     admin start-match route all pass through, so no start path can be missing
 *     it. After 20 seconds the server writes `default` for any side that has
 *     not answered, and ONLY for those sides.
 *
 * The false branch is kept rather than deleted: tests/pvpFormatWiring.test.ts
 * measures both, and "what happens with the phase off" is the control that
 * makes the on-case's assertions mean something.
 */
export function simFormatId(teamPreview: boolean): string {
  const rules = [...BATTLE_CLAUSES];
  if (!teamPreview) rules.push("!Team Preview" as never);
  return `${BASE}@@@${rules.join(",")}`;
}

/** The base format, used for dex lookups where custom rules are irrelevant. */
export const SIM_BASE_FORMAT_ID = BASE;

// ─── Level normalisation ───────────────────────────────────────────────

/**
 * Set every Pokemon to exactly `level`.
 *
 * This replaces a cap that only ever LOWERED (`p.level > cap ? cap : level`),
 * which quietly made the rated ladder unplayable for almost the whole game:
 * of the 2,299 accounts with a party, 87.0% have their ENTIRE party under
 * Lv50 and 6.7% are mixed, so ~94% of players entered a queue advertised as
 * "Lv 50" carrying undersized Pokemon against opponents who were normalised
 * DOWN to 50. A Lv9 Caterpie against a Lv50 anything is not a match.
 *
 * The simulator re-derives stats from base + IVs + EVs + level, so raising a
 * mon here gives it genuinely correct Lv50 stats rather than a scaled
 * approximation.
 *
 * What normalising deliberately does NOT equalise: movepool, EVs, IVs,
 * nature and held item. That is the intended shape of the thing — a Lv7 mon
 * pulled up to 50 still only knows the moves it has learned (measured: 582
 * of 7,004 party Pokemon know just ONE move, and 1,618 know two). So
 * progress still decides matches; it just decides them through what you have
 * invested rather than through a raw stat gap nobody can play around. That is
 * also how real competitive Pokemon works: everyone is at the format's level
 * and the differentiation is in the building.
 */
export function normalizeTeamLevel<T extends { level: number }>(
  team: T[],
  level: number | null,
): T[] {
  if (level == null) return team;
  return team.map((p) => (p.level === level ? p : { ...p, level }));
}

// ─── Team legality ─────────────────────────────────────────────────────

/** Moves banned by Evasion Clause. Showdown ids (lowercase alphanumeric). */
const EVASION_MOVES = new Set(["doubleteam", "minimize"]);

/** Moves banned by OHKO Clause — these ignore damage calculation entirely. */
const OHKO_MOVES = new Set(["fissure", "sheercold", "guillotine", "horndrill"]);

/**
 * Abilities banned by Moody Clause. Moody randomly boosts one stat by two
 * stages and drops another each turn, which turns a match into a coin flip
 * that rewards stalling rather than play.
 */
const MOODY_ABILITIES = new Set(["moody"]);

export interface LegalityOptions {
  /**
   * Refuse a team containing two of the same species. Standard in every
   * competitive format, but OFF by default here: this is a catching game,
   * duplicates are a normal way to own Pokemon, and 19.8% of real accounts
   * would have their current party refused. Turning it on REQUIRES a
   * team-builder warning first — see the note at the top of this file.
   */
  speciesClause?: boolean;
}

export interface LegalityViolation {
  /** Stable code for tests and telemetry. */
  code: "species" | "evasion" | "ohko" | "moody";
  /** Shown to the player, before the battle. Must name the Pokemon. */
  message: string;
}

/** Normalise any of our slugs to a Showdown-style id for set membership. */
function slug(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Display names for the banned move ids.
 *
 * The message used to interpolate the raw id, which reads as a typo for the
 * ids that arrive lowercase-concatenated from the game's own level-up tables:
 * "GLIDER can't bring doubleteam to a ranked battle." Hardcoded rather than
 * looked up because this module deliberately imports no simulator (see the
 * header) — and it is six entries that change never.
 */
const BANNED_MOVE_LABELS: Record<string, string> = {
  doubleteam: "Double Team",
  minimize: "Minimize",
  fissure: "Fissure",
  sheercold: "Sheer Cold",
  guillotine: "Guillotine",
  horndrill: "Horn Drill",
};

/** The remedy, in the words of the UI that performs it. A refusal that does
 *  not say what to do is a wall; the move can be dropped from the Pokemon's
 *  four without releasing anything (game/src/components/ManageMovesModal.tsx),
 *  and this matters because a wild Gligar arrives already knowing Guillotine —
 *  the player did not choose it. */
const MOVE_REMEDY = "Forget it in Manage Moves, or bring a different Pokémon.";

function moveLabel(id: string): string {
  return BANNED_MOVE_LABELS[slug(id)] ?? id;
}

function displayName(p: RuleCheckMon): string {
  return p.nickname || p.name || p.speciesKey;
}

/**
 * Check a team against the team-composition clauses.
 *
 * Returns EVERY violation rather than the first, so a player fixing their
 * team is told about all of it at once instead of discovering one more
 * problem per attempt.
 *
 * Deliberately reports rather than mutates. Silently stripping a banned move
 * would be worse than refusing: the player would take a legal-looking team
 * into a rated match and lose turns to a move that is not there.
 */
export function checkTeamLegality(
  team: RuleCheckMon[],
  opts: LegalityOptions = {},
): { ok: true } | { ok: false; violations: LegalityViolation[] } {
  const violations: LegalityViolation[] = [];

  if (opts.speciesClause) {
    // Slot numbers, not names: duplicates usually share a display name, so
    // naming them produced "Remove Rattata or Rattata" — technically true
    // and completely useless for acting on.
    const seen = new Map<string, number>();
    team.forEach((p, i) => {
      const key = slug(p.speciesKey);
      const priorSlot = seen.get(key);
      if (priorSlot !== undefined) {
        violations.push({
          code: "species",
          message: `Species Clause: only one ${p.name || p.speciesKey} per team — drop slot ${i + 1} or slot ${priorSlot + 1}.`,
        });
      } else {
        seen.set(key, i);
      }
    });
  }

  for (const p of team) {
    for (const mv of p.moves ?? []) {
      const id = slug(mv.id);
      if (EVASION_MOVES.has(id)) {
        violations.push({
          code: "evasion",
          message: `Evasion Clause: ${displayName(p)} can't bring ${moveLabel(mv.id)} to a ranked battle. ${MOVE_REMEDY}`,
        });
      }
      if (OHKO_MOVES.has(id)) {
        violations.push({
          code: "ohko",
          message: `OHKO Clause: ${displayName(p)} can't bring ${moveLabel(mv.id)} to a ranked battle. ${MOVE_REMEDY}`,
        });
      }
    }
    if (MOODY_ABILITIES.has(slug(p.ability))) {
      violations.push({
        code: "moody",
        message: `Moody Clause: ${displayName(p)}'s Moody ability isn't allowed in ranked battles.`,
      });
    }
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

/** Human-readable clause list for the pre-battle format label. */
export function clauseSummary(opts: LegalityOptions = {}): string[] {
  const out = [...BATTLE_CLAUSES, "Evasion Clause", "OHKO Clause", "Moody Clause"];
  if (opts.speciesClause) out.push("Species Clause");
  return out;
}
