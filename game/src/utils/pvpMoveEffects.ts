// Driving the IDLE GAME's move-effect system from PvP narration.
//
// WHY THIS FILE EXISTS AT ALL
//
// A PvP battle had zero animation. The idle game has a complete effect
// system already — 20 archetypes, per-type particles, beams, impact slashes,
// status auras, an Explosion, and a screen shake — and every one of those
// rules in app.css is GLOBALLY scoped:
//
//     .move-anim { position: absolute; inset: 0; … }
//     .fire-particle { … animation: fireParticleFly 600ms …; }
//
// so ANY element that emits `.move-anim move-anim-<archetype> target-<side>`
// with the right children gets the whole visual for free. Nothing needed to be
// added to app.css and nothing needed to be forked. What was missing was the
// DRIVER: MoveAnimation.tsx reads `useGame().state.pendingEvents[0]`, which is
// the suspended idle battle's queue, so the arena cannot mount it — it would
// animate the wrong battle. This module is the PvP-side translation from
// "a narration line arrived" to "which archetype, aimed which way".
//
// THREE TRAPS, all of them found by reading rather than guessing:
//
//  1. MOVE ID CASING. `archetypeFor`'s signature overrides and `SHAKE_MOVES`
//     are keyed on the idle game's own camelCase ids — `hyperBeam`,
//     `solarBeam`, `selfDestruct` — while the PvP protocol speaks Showdown,
//     whose ids are flat lowercase (`hyperbeam`). Looked up naively, Hyper
//     Beam and Self-Destruct would silently lose their signature effect AND
//     their screen shake and fall through to a generic flash. `idleMoveKey`
//     below bridges that, and it is DERIVED from the moves table rather than
//     hardcoded so it cannot drift as moves are added.
//
//  2. NO MOVE ID IN THE NARRATION. `NarrationLine` carries only composed
//     `text`, so the move has to be read back out of the sentence the decoder
//     built (`"Your Espeon used Shadow Ball!"`). state/pvpBattleView.ts is not
//     this task's file to change, so rather than adding a field there, the
//     phrasing is treated as a contract and pinned by a test that feeds real
//     protocol lines through the real `applyLine` and asserts the move comes
//     back out. If the decoder is ever rephrased, that test fails loudly
//     instead of the effects silently stopping.
//
//  3. AIM. A self-buff (Swords Dance, Recover, Reflect, Substitute) must put
//     its aura on the USER, not across the field. The narration does not say
//     who the target was, so the move's own target semantics are read from
//     @pkmn/dex — already a dependency of data/moves.ts, so this costs
//     nothing — instead of guessing from the category.

import { Dex } from "@pkmn/dex";
import { moves as movesTable } from "../data/moves";
import {
  archetypeFor,
  SHAKE_MOVES,
  TYPE_COLOR,
  type EffectArchetype,
} from "./moveEffects";
import type { NarrationLine } from "../state/pvpBattleView";
import type { PokemonType } from "../types";

/** Showdown's id normalisation: the same transform `parseDetails` and the
 *  server's `toShowdownId` apply, so "Shadow Ball" → "shadowball" and
 *  "Self-Destruct" → "selfdestruct". */
export function toMoveId(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Showdown id → the idle game's own key for the same move, when they differ.
 *
 * Built by walking the moves table rather than hand-listed. data/moves.ts ends
 * with a `@pkmn/dex` backfill that inserts every move the hand-authored block
 * missed under its FLAT id, so the table holds both keyings at once: the
 * camelCase `hyperBeam` from the authored block and the flat `flamethrower`
 * from the backfill. Any key whose own id differs from itself is therefore a
 * camelCase authored key, and that is exactly the set `SHAKE_MOVES` and
 * `SIGNATURE_MOVES` are keyed on.
 */
const IDLE_KEY_BY_ID: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const key of Object.keys(movesTable)) {
    const id = toMoveId(key);
    if (id !== key) out[id] = key;
  }
  return out;
})();

/** The idle game's key for a Showdown move id (identity when the two agree). */
export function idleMoveKey(showdownId: string): string {
  return IDLE_KEY_BY_ID[showdownId] ?? showdownId;
}

/**
 * Pull the move's display name back out of a decoded move line.
 *
 * `.*` is greedy on purpose: it consumes up to the LAST " used ", so a
 * Pokémon nicknamed "what I used to be" cannot swallow the move name.
 */
export function moveNameFromNarration(text: string): string | null {
  const m = /^.* used (.+)!$/.exec(text.trim());
  const name = m?.[1]?.trim();
  return name ? name : null;
}

/** @pkmn target strings that mean "this lands on my own side of the field". */
const SELF_SIDE_TARGETS: ReadonlySet<string> = new Set([
  "self", "allySide", "adjacentAlly", "adjacentAllyOrSelf", "allies", "allyTeam",
]);

export interface PvpMoveEffect {
  /** Which app.css archetype class to emit. */
  archetype: EffectArchetype;
  /** `.target-player` / `.target-enemy` — app.css reads this to pick the
   *  trajectory. "player" always means the LOCAL player's slot. */
  target: "player" | "enemy";
  /** Adds `.shake-screen`, which pvpArena.css turns into the scene rattle. */
  shake: boolean;
  /** Fed to `--type-color`, which the type-agnostic impact/aura archetypes
   *  read so an Ice Punch reads blue and a Fire Punch orange. */
  typeColor: string;
  moveName: string;
  moveType: PokemonType;
}

/**
 * The effect for one narration line, or null if the line is not a move.
 *
 * `mySide` is the viewer's seat, so a move by the opponent aims at the local
 * player's slot and vice versa. A move whose target is the user's own side
 * lands on the attacker instead, which is what stops Swords Dance putting its
 * aura across the field.
 */
export function effectForNarration(
  line: NarrationLine,
  mySide: "a" | "b",
): PvpMoveEffect | null {
  if (line.kind !== "move") return null;
  const name = moveNameFromNarration(line.text);
  if (!name) return null;
  const id = toMoveId(name);
  const def = movesTable[id];
  if (!def) return null;

  const idleKey = idleMoveKey(id);
  const archetype: EffectArchetype = archetypeFor(idleKey, def.type, def.category);
  const shake = SHAKE_MOVES.has(idleKey);

  // The attacker's slot from the viewer's seat. `line.side` is the attacker;
  // an absent side (a spectator-shaped line) is treated as the foe so an
  // effect still plays rather than vanishing.
  const attackerIsMine = line.side != null && line.side === mySide;
  const dexTarget = Dex.moves.get(id).target;
  const landsOnSelf = SELF_SIDE_TARGETS.has(dexTarget);
  const hitsMine = landsOnSelf ? attackerIsMine : !attackerIsMine;

  return {
    archetype,
    target: hitsMine ? "player" : "enemy",
    shake,
    typeColor: TYPE_COLOR[def.type] ?? "#888",
    moveName: def.name ?? name,
    moveType: def.type,
  };
}

/** Effectiveness / crit banner for a move line, reusing the idle game's own
 *  `.effectiveness-flash effectiveness-<kind>` chrome. Crit wins the headline
 *  over effectiveness, matching BattleScene's EffectivenessFlash exactly. */
export function bannerForNarration(
  line: NarrationLine,
): { kind: "crit" | "se" | "nve"; text: string } | null {
  const tags = line.tags;
  if (!tags || tags.length === 0) return null;
  if (tags.some((t) => t.startsWith("Critical"))) return { kind: "crit", text: "Critical hit!" };
  if (tags.some((t) => t.startsWith("Super"))) return { kind: "se", text: "Super effective!" };
  if (tags.some((t) => t.startsWith("Not very"))) return { kind: "nve", text: "Not very effective" };
  return null;
}
