// Adapter that pulls canonical move stats (power / accuracy / pp /
// type / category / priority) from Pokémon Showdown's data layer
// (`@pkmn/dex`) and translates them into our local `MoveDef` shape.
//
// Why: hand-typing the moves table is brittle — one missed entry or
// off-by-one accuracy and the move silently misbehaves. Showdown's
// data is the canonical source for every Gen 1-9 move.
//
// What we DON'T touch:
//   - Manual `effect: {...}` blocks in data/moves.ts. Those are
//     wired into our battle engine and shouldn't be auto-overwritten.
//   - Local balance tweaks (a power bump on Splash for fun, etc).
//
// Usage:
//   const m = canonicalMove("flamethrower");
//   m.power     // 90
//   m.accuracy  // 100
//   m.pp        // 15
//   m.type      // "Fire"
//   m.category  // "special"
//   m.priority  // 0

import { Dex } from "@pkmn/dex";
import type { MoveDef, PokemonType, MoveCategory } from "../types";

// Showdown stores types capitalised ("Fire"); ours match. Categories
// are capitalised in @pkmn ("Physical") and lowercased in ours.
function normaliseCategory(c: string): MoveCategory {
  const s = c.toLowerCase();
  if (s === "physical" || s === "special" || s === "status") return s;
  return "physical";
}

function normaliseType(t: string): PokemonType {
  // Cast guarded by the fact every TypeName from @pkmn matches one
  // of our PokemonType values (we cover Gen 1-7 types).
  return t as PokemonType;
}

/** Look up canonical stats for a move id. Returns null if @pkmn
 *  doesn't know the move (truly fake / typoed id). */
export function canonicalMove(id: string): MoveDef | null {
  const m = Dex.moves.get(id);
  if (!m || !m.exists) return null;
  return {
    name: m.name,
    type: normaliseType(m.type),
    category: normaliseCategory(m.category),
    power: m.basePower ?? 0,
    // @pkmn uses `true` for "always hits" — clamp to 100 for our
    // numeric accuracy field. Engine treats 100 the same way.
    accuracy: m.accuracy === true ? 100 : (m.accuracy as number),
    pp: m.pp,
    priority: m.priority ?? 0,
  };
}

/** Merge canonical stats into a partial move def. Anything explicitly
 *  set in `local` wins (so manual balance tweaks survive); anything
 *  missing falls back to the canonical value. The `effect` field is
 *  always preserved from `local` since @pkmn/dex's effects don't map
 *  to our local resolver. */
export function mergeWithCanonical(id: string, local: Partial<MoveDef>): MoveDef | null {
  const canon = canonicalMove(id);
  if (!canon) {
    // No canonical entry — assume `local` is the full definition.
    return local as MoveDef;
  }
  return {
    ...canon,
    ...local,
  };
}

/** Returns the diff between a local move def and its canonical
 *  counterpart, for the verification script. Empty array = no
 *  differences. */
export function diffAgainstCanonical(
  id: string,
  local: MoveDef,
): Array<{ field: keyof MoveDef; local: unknown; canonical: unknown }> {
  const canon = canonicalMove(id);
  if (!canon) return [];
  const diffs: Array<{ field: keyof MoveDef; local: unknown; canonical: unknown }> = [];
  const fields: (keyof MoveDef)[] = ["name", "type", "category", "power", "accuracy", "pp", "priority"];
  for (const f of fields) {
    if (local[f] !== canon[f]) {
      diffs.push({ field: f, local: local[f], canonical: canon[f] });
    }
  }
  return diffs;
}
