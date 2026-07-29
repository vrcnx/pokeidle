// Tyrogue's three-way split. The regression: the line was flattened to
// `hitmontop` alone, so Hitmonlee and Hitmonchan did not exist; and the
// stream auto-player names the FIRST satisfied trigger, so without
// re-resolution it would ask a wrong-branch evolution by name.

import { describe, expect, it } from "vitest";
import {
  resolveEvolutionTarget,
  levelEvolutionFor,
  levelEvolutionBranches,
  statConditionMet,
} from "../src/utils/evolution";
import { evolutions } from "../src/data/evolutions";
import { reducer } from "../src/state/reducer";
import { makeMon, makeState } from "./helpers";
import type { Pokemon } from "../src/types";

const tyrogue = (attack: number, defense: number, level = 20): Pokemon =>
  makeMon({ speciesKey: "tyrogue", name: "Tyrogue", level, attack, defense });

describe("the branch data itself", () => {
  it("tyrogue has all three canonical targets", () => {
    const targets = (evolutions.tyrogue ?? []).map((t) => t.into).sort();
    expect(targets).toEqual(["hitmonchan", "hitmonlee", "hitmontop"]);
  });
});

describe("gt/lt/eq partition every stat pair", () => {
  it("exactly ONE branch is met for any attack/defense pair", () => {
    // Deterministic sweep across the whole comparison space, including ties.
    for (let atk = 18; atk <= 22; atk++) {
      for (let def = 18; def <= 22; def++) {
        const branches = levelEvolutionBranches(tyrogue(atk, def));
        expect(branches).toHaveLength(3);
        const met = branches.filter((b) => b.met);
        expect(met, `atk=${atk} def=${def}`).toHaveLength(1);
      }
    }
  });

  it("each branch maps to the canonical target", () => {
    expect(levelEvolutionFor(tyrogue(30, 20))!.into).toBe("hitmonlee");  // Atk > Def
    expect(levelEvolutionFor(tyrogue(20, 30))!.into).toBe("hitmonchan"); // Atk < Def
    expect(levelEvolutionFor(tyrogue(25, 25))!.into).toBe("hitmontop");  // Atk = Def
  });

  it("below the level threshold no branch fires at all", () => {
    expect(levelEvolutionFor(tyrogue(30, 20, 19))).toBeNull();
  });
});

describe("resolveEvolutionTarget — the branch belongs to the Pokémon, not the caller", () => {
  it("re-resolves a wrong-branch request to the branch this individual earned", () => {
    // A caller (the stream auto-player) asks for hitmontop; this Tyrogue's
    // Attack is higher, so it becomes a Hitmonlee regardless.
    expect(resolveEvolutionTarget(tyrogue(30, 20), "hitmontop")).toBe("hitmonlee");
    expect(resolveEvolutionTarget(tyrogue(20, 30), "hitmonlee")).toBe("hitmonchan");
    expect(resolveEvolutionTarget(tyrogue(25, 25), "hitmonlee")).toBe("hitmontop");
  });

  it("honours a request the Pokémon actually qualifies for", () => {
    expect(resolveEvolutionTarget(tyrogue(30, 20), "hitmonlee")).toBe("hitmonlee");
  });

  it("passes non-branching targets through untouched", () => {
    const eevee = makeMon({ speciesKey: "eevee", name: "Eevee" });
    expect(resolveEvolutionTarget(eevee, "vaporeon")).toBe("vaporeon");
  });

  it("statConditionMet with no predicate is unconditionally true", () => {
    expect(statConditionMet(makeMon(), undefined)).toBe(true);
  });
});

describe("reducer START_EVOLUTION applies the same re-resolution", () => {
  it("a wrong-branch dispatch lands on the earned branch", () => {
    const mon = tyrogue(30, 20);
    const state = makeState({ party: [mon], playerPokemon: mon });
    const next = reducer(state, {
      type: "START_EVOLUTION",
      payload: { partyIndex: 0, toSpeciesKey: "hitmontop", pokemonId: mon.id },
    });
    expect(next.phase).toBe("evolution");
    expect(next.evolutionState!.toSpeciesKey).toBe("hitmonlee");
  });

  it("a stale id (mon left the party) drops the action instead of evolving a stranger", () => {
    const state = makeState();
    const next = reducer(state, {
      type: "START_EVOLUTION",
      payload: { partyIndex: 0, toSpeciesKey: "hitmontop", pokemonId: "gone123" },
    });
    expect(next).toBe(state);
  });
});
