// Abilities across evolution.
//
// The rule the game was missing: an ability belongs to a SPECIES, and what
// survives an evolution is the SLOT. A Shed Skin Dratini is a slot-1 Dratini,
// so it becomes a slot-1 Dragonite — Inner Focus. It does not stay Shed Skin,
// because Dragonite does not have Shed Skin.
//
// COMPLETE_EVOLUTION spread the pre-evolution wholesale and changed only the
// species and the stats, so the ability came across verbatim and every fully
// evolved Pokémon was holding its baby form's ability. Reported by Gshow.

import { describe, expect, it } from "vitest";
import { evolutions } from "../src/data/evolutions";
import { abilitiesFor, isLegalAbility, evolvedAbility } from "../src/data/abilities";
import { correctAbility, repairAbilities } from "../src/utils/abilityRepair";
import type { GameState, Pokemon } from "../src/types";

const mon = (speciesKey: string, ability: string | undefined, id = 1): Pokemon =>
  ({ id, speciesKey, name: speciesKey, ability } as unknown as Pokemon);

describe("evolving maps the slot, not the string", () => {
  it("gives Dragonite its own primary instead of Dratini's", () => {
    // The reported case, exactly.
    expect(evolvedAbility("dragonair", "dragonite", "shedSkin")).toBe("innerFocus");
  });

  it("keeps a hidden ability hidden", () => {
    // The reason "hidden" is modelled as its own slot rather than as the last
    // index of `primary`: Marvel Scale is Dratini's HIDDEN ability, and the
    // right answer is Dragonite's hidden one, not its first primary.
    expect(evolvedAbility("dragonair", "dragonite", "marvelScale")).toBe("multiscale");
  });

  it("gives Gyarados Intimidate", () => {
    // The one that actually cost people something: Intimidate is wired into
    // the battle resolver and Swift Swim is not, so a Gyarados evolved before
    // the fix had no working ability at all.
    expect(evolvedAbility("magikarp", "gyarados", "swiftSwim")).toBe("intimidate");
  });

  it("never produces an ability the new species cannot have", () => {
    // The property, over the whole table — 122 edges, 34 of which used to
    // carry something illegal across.
    for (const [from, list] of Object.entries(evolutions)) {
      const src = abilitiesFor(from);
      if (!src) continue;
      for (const ev of list) {
        if (!abilitiesFor(ev.into)) continue;
        for (const a of [...src.primary, ...(src.hidden ? [src.hidden] : [])]) {
          const got = evolvedAbility(from, ev.into, a);
          expect(isLegalAbility(ev.into, got), `${from}->${ev.into} with ${a} gave ${got}`).toBe(true);
        }
      }
    }
  });

  it("leaves an already-correct ability alone", () => {
    expect(evolvedAbility("charmeleon", "charizard", "blaze")).toBe("blaze");
  });
});

describe("repairing Pokémon that already evolved wrong", () => {
  it("fixes a Dragonite still holding Shed Skin", () => {
    expect(correctAbility("dragonite", "shedSkin")).toBe("innerFocus");
  });

  it("recovers the HIDDEN slot from an ancestor rather than defaulting", () => {
    // The reason the repair walks back up the chain. A naive "it's illegal, so
    // use primary[0]" would hand this Dragonite Inner Focus and quietly
    // downgrade a hidden ability to a common one.
    expect(correctAbility("dragonite", "marvelScale")).toBe("multiscale");
  });

  it("walks back more than one step", () => {
    // Butterfree holding Caterpie's ability — two evolutions away, so the slot
    // is only findable by walking past Metapod.
    const got = correctAbility("butterfree", "shieldDust");
    expect(isLegalAbility("butterfree", got)).toBe(true);
  });

  it("leaves a legal ability untouched", () => {
    expect(correctAbility("gyarados", "intimidate")).toBe("intimidate");
    expect(correctAbility("dragonite", "multiscale")).toBe("multiscale");
  });

  it("leaves a species with no ability data completely alone", () => {
    // Blanking an ability because the table has not been filled in for a
    // species would be a regression dressed as a fix.
    expect(correctAbility("__nosuchspecies__", "shedSkin")).toBe("shedSkin");
  });

  it("falls back to a legal ability when nobody in the line claims it", () => {
    const got = correctAbility("dragonite", "levitate");
    expect(isLegalAbility("dragonite", got)).toBe(true);
  });
});

describe("the save-load repair", () => {
  const state = (party: (Pokemon | null)[], box: (Pokemon | null)[] = []): GameState =>
    ({ party, box, playerPokemon: party[0] ?? null, activePlayerPokemonIndex: 0 } as unknown as GameState);

  it("fixes party and box together", () => {
    const s = repairAbilities(state(
      [mon("dragonite", "shedSkin", 1)],
      [mon("gyarados", "swiftSwim", 2)],
    ));
    expect(s.party[0]!.ability).toBe("innerFocus");
    expect(s.box[0]!.ability).toBe("intimidate");
  });

  it("fixes the ACTIVE Pokémon, which is a separate reference", () => {
    // playerPokemon is its own object rather than a lookup into the party, so
    // repairing the party alone would leave whatever is currently in battle
    // still holding the wrong ability until the next switch.
    const s = repairAbilities(state([mon("dragonite", "shedSkin", 1)]));
    expect(s.playerPokemon!.ability).toBe("innerFocus");
  });

  it("returns the SAME object when nothing is wrong", () => {
    // Identity preservation is what makes this safe to run on every load: a
    // healthy save costs one comparison per Pokémon and produces no re-render.
    const before = state([mon("charizard", "blaze", 1)], [mon("gyarados", "intimidate", 2)]);
    expect(repairAbilities(before)).toBe(before);
  });

  it("is idempotent", () => {
    const once = repairAbilities(state([mon("dragonite", "shedSkin", 1)]));
    expect(repairAbilities(once)).toBe(once);
  });

  it("survives holes in the party", () => {
    const s = repairAbilities(state([null, mon("dragonite", "shedSkin", 2)]));
    expect(s.party[1]!.ability).toBe("innerFocus");
  });
});
