// Team Preview: the pure half.
//
// Everything in this file is a plain function over strings and plain objects,
// with NO import of @pkmn/sim and no import of pvp.ts. That is deliberate:
// the stateful half (the auto-lock timer, the per-side lock sweep) lives in
// pvp.ts because it needs the live BattleStream, and the parts that decide
// what a player is ALLOWED TO SEE belong somewhere a unit test can drive them
// directly with no simulator, no sockets and no database.
//
// ─── WHY TEAM PREVIEW WAS OFF, AND WHAT CHANGED ────────────────────────
//
// Custom Game ships Team Preview ON, and with it the FIRST |request| a player
// receives is `{"teamPreview":true,"side":{…}}` — no `active`, no moves. A
// client with no team-order picker cannot answer that, so every battle sat
// there until the 5-minute AFK watchdog forfeited it. That was measured, and
// it is why simFormatId() has taken a boolean since the day it was written.
//
// Three things had to exist before the flag could be flipped, and all three
// now do:
//
//   1. A PICKER on the client (game/src/components/PvpArena.tsx renders it in
//      the arena's own centre window, not a modal).
//   2. An AUTO-LOCK on the server, so a player who never answers cannot stall
//      a battle. It lives in pvp.ts's startBattle, which is the single choke
//      point all FOUR room builders pass through — matchmaking, friend invite,
//      the tournament bracket ticker and the admin start-match route — so no
//      caller can forget it and none of them needed a line of their own.
//   3. Proof, by execution, that the auto-lock cannot CLOBBER a choice that was
//      already made. See pvp.ts's resolveTeamPreviewLock for the mechanism and
//      tests/pvpTeamPreview.test.ts for the negative control.
//
// ─── THE PROTOCOL, MEASURED RATHER THAN REMEMBERED ─────────────────────
//
// Captured verbatim off a real @pkmn/sim battle on the shipped format string
// (`gen5customgame@@@Sleep Clause Mod,Endless Battle Clause`), both player
// streams, three Pokémon a side:
//
//     |clearpoke
//     |poke|p1|Pikachu, L50, F|item
//     |poke|p1|Snorlax, L50, M|
//     |poke|p1|Gengar, L50, M|
//     |poke|p2|Charizard, L50, M|
//     |poke|p2|Blastoise, L50, F|
//     |poke|p2|Venusaur, L50, M|
//     |teampreview
//     |request|{"teamPreview":true,"side":{"name":"AAA","id":"p1","pokemon":[…]}}
//
// then, once BOTH sides answer:
//
//     |teamsize|p1|3
//     |teamsize|p2|3
//     |start
//     |switch|p1a: ALPHA|Pikachu, L50, F|110/110
//     |switch|p2a: ZULU|Venusaur, L50, M|155/155
//     |turn|1
//
// THE CHOICE FORMAT is `>pN team <order>`. Every one of these was accepted by
// the real simulator, on a six-Pokémon team, one fresh battle per case:
//
//     team 1          → lead slot 1, rest keep their order
//     team 3          → lead slot 3; final order [3,1,2,4,5,6]
//     team 231456     → full order, no separators
//     team 2, 3, 1    → full order, comma-separated; identical result
//     default         → identity order [1,2,3,4,5,6]
//
// and every one of these was REFUSED, verbatim:
//
//     team 7      → [Invalid choice] Can't choose for Team Preview: You do not
//                   have a Pokémon in slot 7
//     team 0      → …slot 0
//     team 1,1,2  → …The Pokémon in slot 1 can only switch in once
//     move 1      → [Invalid choice] Can't move: You need a teampreview response
//     switch 2    → [Invalid choice] Can't switch: You need a teampreview response
//     pass        → [Invalid choice] Can't pass: Not a move or switch request
//
// A second `team N` before both sides have locked OVERWRITES the first (no
// `undo` needed) — also measured, and it is why the client is free to let a
// player change their mind right up to the lock.
//
// ─── WHAT A SIDE MAY LEARN ABOUT THE OTHER, AND WHAT IT MAY NOT ────────
//
// The |request| payload is ENTIRELY one-sided. Measured on a battle where p1's
// lead was a shiny nicknamed "SECRETNAME" Pikachu holding Leftovers with Static
// and Thunderbolt: p2's teamPreview request contains the substring "p1" ZERO
// times, and none of SECRETNAME / leftovers / static / thunderbolt appear in it
// at all. So no nickname, no move, no ability, no item, no EV/IV, no stat and
// no HP crosses. The only channel that carries anything about the opponent is
// the `|poke|` lines, and each of those is exactly:
//
//     |poke|<side>|<Species>, L<level>, <gender>|<item flag>
//
// SPECIES, LEVEL and GENDER are inherent to the phase — Team Preview without
// the species is not Team Preview — and the level is normalised to the
// format's own (Lv 50 on the rated ladder) so it reveals nothing about the
// player's progress either.
//
// THE ITEM FLAG IS NOT, and it is stripped here. `|poke|p1|Pikachu, L50, F|item`
// says "this Pokémon is holding something" — a real competitive signal (a Choice
// item, a Focus Sash, Leftovers on a wall) that the phase is not supposed to
// hand over, and one the player never opted into. It is stripped SYMMETRICALLY,
// from both sides' lines on both player streams, rather than only from the
// opponent's:
//
//   * asymmetric stripping would make `|poke|` a SIDE-EXCLUSIVE line, and
//     tests/pvpRejoinLeak.test.ts's core invariant is that |request| is the
//     ONLY line one participant receives and the other does not. That invariant
//     is what makes replaying a side's own delivered log on rejoin provably
//     safe, and it is worth far more than showing a player an item marker on a
//     team they already own;
//   * a player learns nothing from their own flag anyway — it is their team.
//
// The OMNISCIENT stream IS redacted too — see pumpOmniLog, which is the
// authority, and note that this paragraph used to claim the exact opposite.
// The tempting argument for leaving it alone is that the spectator channel and
// the persisted replay are omniscient by design (GET /pvp/match/:id/replay
// already serves both teams' full JSON), so a `|poke|` line is not news. That
// holds for a COMPLETED match and fails for a VOIDED one: a cancelled row
// deliberately blanks both teams (`userATeam: "[]"`) precisely because the
// bracket reads it as dead and RE-RUNS the pairing, and room.log would then be
// the one surviving place a re-matched opponent could read which of their
// Pokemon are holding something. Spectators are the same argument by another
// door — an observer relaying to a participant is a real channel.
//
// So the rule has no exceptions to reason about: the item flag never leaves the
// simulator. Measured on every channel — both player wires, both per-side
// replay logs, room.log, the spectator fan-out and the rejoin snapshot — every
// `|poke|` line arrives with an empty fourth field. If you are here to delete
// the redactPreviewItems call in pumpOmniLog because a comment told you it was
// redundant, that comment was this one, and it was wrong.

/**
 * How long both sides have to answer Team Preview before the server locks in
 * whatever they have.
 *
 * SHORT ON PURPOSE. Team Preview is the reason PvP was broken once already, and
 * the population is thin (~34 active players an hour), so a long picker sitting
 * in front of the rarest event in the game is a real cost — the opponent you
 * finally matched with is staring at a countdown too. Twenty seconds is enough
 * to read six species and pick a lead, and it is one FIFTEENTH of the 5-minute
 * turn clock, so the phase can never come close to the AFK watchdog that used
 * to eat these battles.
 *
 * The auto-lock is also a SAFE failure rather than a punishment: `default` is
 * the identity order, i.e. exactly the lead the player already chose in the
 * Team Builder, which is the battle they would have got before this feature
 * existed. Nobody loses anything by not answering.
 */
export const TEAM_PREVIEW_LOCK_MS = 20_000;

/**
 * Is this |request| payload the Team Preview one?
 *
 * Structural rather than `as` — the request is parsed from the wire and the
 * simulator's own ChoiceRequest is a four-way union, so narrowing it here once
 * keeps every caller from repeating an unchecked cast.
 */
export function isTeamPreviewRequest(request: unknown): boolean {
  return (
    typeof request === "object"
    && request !== null
    && (request as { teamPreview?: unknown }).teamPreview === true
  );
}

/** One `|poke|` line, split. Returns null for anything that is not one. */
export function parsePokeLine(
  line: string,
): { side: string; details: string; item: string } | null {
  if (!line.startsWith("|poke|")) return null;
  // |poke|p1|Pikachu, L50, F|item  →  ["", "poke", "p1", "Pikachu, L50, F", "item"]
  const parts = line.split("|");
  if (parts.length < 4) return null;
  return { side: parts[2] ?? "", details: parts[3] ?? "", item: parts[4] ?? "" };
}

/**
 * Strip the held-item flag from every `|poke|` line in a chunk.
 *
 * Applied to BOTH player streams identically — see the header for why symmetry
 * is the security property and not just tidiness. Every other line is returned
 * byte-for-byte, including the trailing empty segment shape of a `|poke|` line
 * that had no item to begin with, so a chunk with nothing to redact comes back
 * `===` equal to its input and the common path allocates nothing.
 *
 * The line keeps its trailing `|` (i.e. `|poke|p1|Pikachu, L50, F|`), which is
 * the exact shape the simulator already emits for an item-less Pokémon — so a
 * redacted line is indistinguishable from an honestly-empty one rather than
 * being a new fourth shape no client has seen.
 */
export function redactPreviewItems(chunk: string): string {
  if (!chunk.includes("|poke|")) return chunk;
  let changed = false;
  const lines = chunk.split("\n").map((line) => {
    const poke = parsePokeLine(line);
    if (!poke || poke.item === "") return line;
    changed = true;
    return `|poke|${poke.side}|${poke.details}|`;
  });
  return changed ? lines.join("\n") : chunk;
}
