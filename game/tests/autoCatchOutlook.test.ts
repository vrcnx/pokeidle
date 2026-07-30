// "Auto-Catch doesn't work at Route 1." (br_6fcb7c411f3c317ccc)
//
// Route 1 is where every new player starts, so this looked like a broken
// funnel. It is not: the reporter's rules are all mode "pokedex_new" ("Not
// registered") and all five Route 1 species are already in her Pokédex, so
// shouldAutoCatch correctly declines every encounter. 560 production saves are
// in that state.
//
// The defect is that the Catch Settings screen printed a green "✓ CATCH" for
// every one of those species — the badge was rendered from `rule.enabled` and
// never consulted the mode — with a tooltip stating auto-catch was ON. 769
// accounts have at least one badge lying this way, across 129,405
// (account, route, species) rows. The engine was right; the one screen that
// exists to explain the engine said the opposite.
//
// Second, independent defect pinned here: "weaken before catching" attacked
// while HP was above 30% of max, with no check that the hit would leave the
// target alive. A Route 1 Pidgey has 15 max HP, so a grown lead one-shot the
// very Pokémon it was supposed to be softening.

import { describe, expect, it } from "vitest";
import {
  autoCatchOutlook, ballForAutoCatch, shouldAutoCatch, shouldWeakenBeforeCatch,
  WEAKEN_HP_THRESHOLD,
} from "../src/utils/catching";
import { maxSingleHitDamage } from "../src/utils/battle";
import { encounters } from "../src/data/encounters";
import { pokemonTable } from "../src/data/pokemon";
import { createPokemon } from "../src/utils/pokemon";
import type { CatchSettings, GameState, Pokemon, StatStages } from "../src/types";
import { makeMon, makeState } from "./helpers";

/** The reporter's verbatim per-species rule: on, "Not registered", weaken on,
 *  three balls enabled, and plenty of stock. */
const HER_RULE: CatchSettings = {
  enabled: true,
  mode: "pokedex_new",
  levelThreshold: 1,
  enabledBalls: ["pokeball", "greatball", "ultraball"],
  weakenFirst: true,
};

const ROUTE1_SPECIES = ["pidgey", "rattata", "caterpie", "weedle", "pikachu"];

/** Her save, reduced to what the decision reads. */
function herState(over: Partial<GameState> = {}): GameState {
  const lead = makeMon({ id: "lead" });
  return makeState({
    party: [lead],
    playerPokemon: lead,
    inventory: { pokeball: 82, greatball: 98, ultraball: 83 },
    pokedexCaught: [...ROUTE1_SPECIES],
    pokedexSeen: [...ROUTE1_SPECIES],
    globalCatchDefaults: HER_RULE,
    catchSettings: {
      route1: Object.fromEntries(ROUTE1_SPECIES.map((s) => [s, HER_RULE])),
    },
    ...over,
  });
}

describe("the report is literally true, and the engine is why", () => {
  it("declines every Route 1 species under her own settings", () => {
    const state = herState();
    for (const speciesKey of ROUTE1_SPECIES) {
      expect(shouldAutoCatch(state, "route1", speciesKey, 3, false)).toBe(false);
    }
  });

  it("uses the real Route 1 encounter table — all five, nothing missed", () => {
    const table = encounters.route1?.encounters.map((e) => e.speciesKey) ?? [];
    expect([...table].sort()).toEqual([...ROUTE1_SPECIES].sort());
  });
});

describe("the badge reports the decision, not the checkbox", () => {
  it("says NO MATCH — not CATCH — for her five registered species", () => {
    const state = herState();
    for (const speciesKey of ROUTE1_SPECIES) {
      const outlook = autoCatchOutlook(state, "route1", speciesKey);
      expect(outlook.verdict).toBe("inert");
      expect(outlook).toMatchObject({ reason: "already_registered" });
    }
  });

  it("never claims CATCH for a species the engine will decline", () => {
    // The invariant that was violated. For the two species-static modes the
    // badge and shouldAutoCatch must agree for every encounter, so quantify
    // over levels and shininess rather than asserting one case.
    const modes: CatchSettings["mode"][] = ["pokedex_new", "not_owned"];
    const held = makeMon({ id: "h1", speciesKey: "gastly", name: "Gastly" });
    let checked = 0;
    for (const mode of modes) {
      const state = herState({
        box: [held],
        pokedexCaught: [...ROUTE1_SPECIES, "gastly"],
        globalCatchDefaults: { ...HER_RULE, mode },
        catchSettings: {},
        alwaysCatchShinies: false,
      });
      for (const speciesKey of [...ROUTE1_SPECIES, "gastly", "lapras"]) {
        const outlook = autoCatchOutlook(state, "route1", speciesKey);
        for (const level of [1, 3, 50, 100]) {
          checked++;
          const engine = shouldAutoCatch(state, "route1", speciesKey, level, false);
          if (outlook.verdict === "on") expect(engine).toBe(true);
          else expect(engine).toBe(false);
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it("still says CATCH for a species that is genuinely unregistered", () => {
    const state = herState();
    expect(autoCatchOutlook(state, "route1", "lapras").verdict).toBe("on");
  });

  it("says SKIP only when the per-species toggle is actually off", () => {
    const state = herState({
      catchSettings: { route1: { pidgey: { ...HER_RULE, enabled: false } } },
    });
    expect(autoCatchOutlook(state, "route1", "pidgey").verdict).toBe("off");
  });

  it("keeps the encounter-dependent modes as CATCH — level/shiny are not the species' business", () => {
    for (const mode of ["always", "shiny_only", "level_threshold"] as const) {
      const state = herState({
        globalCatchDefaults: { ...HER_RULE, mode, levelThreshold: 99 },
        catchSettings: {},
      });
      expect(autoCatchOutlook(state, "route1", "pidgey").verdict).toBe("on");
    }
  });

  it("distinguishes an empty ball list from a disabled species", () => {
    // Both throw nothing, but only one of them is fixed by clicking the badge.
    // alwaysCatchShinies is off here so the verdict is the whole story — the
    // shiny half is quantified over in its own describe block below.
    const state = herState({
      globalCatchDefaults: { ...HER_RULE, mode: "always", enabledBalls: [] },
      catchSettings: {},
      alwaysCatchShinies: false,
    });
    expect(autoCatchOutlook(state, "route1", "pidgey")).toEqual({
      verdict: "inert", reason: "no_balls", shinyOverride: false,
    });
  });

  it("reports already_owned for the not_owned mode", () => {
    const held = makeMon({ id: "h2", speciesKey: "pidgey", name: "Pidgey" });
    const state = herState({
      party: [held],
      playerPokemon: held,
      globalCatchDefaults: { ...HER_RULE, mode: "not_owned" },
      catchSettings: {},
      alwaysCatchShinies: false,
    });
    expect(autoCatchOutlook(state, "route1", "pidgey")).toEqual({
      verdict: "inert", reason: "already_owned", shinyOverride: false,
    });
  });
});

// The badge's SECOND lie, in the opposite direction to the first.
//
// The fix above made "⊘ NO MATCH" honest for an ordinary encounter, but
// alwaysCatchShinies is ON by default and its check sits at the very TOP of
// shouldAutoCatch — above `enabled`, above the ball list, above the mode. So for
// a SHINY encounter none of the badge's reasons apply and a ball is thrown every
// time, while the row said nothing would be. The old outlook hardcoded
// isShiny:false into its shouldAutoCatch call, so the override was unreachable.
describe("the badge tells the truth about shinies too", () => {
  it("reports shinyOverride where the engine WILL throw at a shiny", () => {
    const state = herState(); // alwaysCatchShinies defaults ON, bag full of balls
    for (const speciesKey of ROUTE1_SPECIES) {
      const outlook = autoCatchOutlook(state, "route1", speciesKey);
      // Nothing for an ordinary encounter...
      expect(outlook.verdict).toBe("inert");
      expect(shouldAutoCatch(state, "route1", speciesKey, 3, false)).toBe(false);
      // ...but a ball for a shiny one, and the badge now says so.
      expect(shouldAutoCatch(state, "route1", speciesKey, 3, true)).toBe(true);
      expect(outlook.shinyOverride).toBe(true);
    }
  });

  it("reports it for an explicitly DISABLED row, which the override also beats", () => {
    const state = herState({
      catchSettings: { route1: { pidgey: { ...HER_RULE, enabled: false } } },
    });
    const outlook = autoCatchOutlook(state, "route1", "pidgey");
    expect(outlook.verdict).toBe("off");
    expect(outlook.shinyOverride).toBe(true);
    expect(shouldAutoCatch(state, "route1", "pidgey", 3, true)).toBe(true);
  });

  it("reports it with an EMPTY ball list — the shiny search falls back to any ball", () => {
    const state = herState({
      globalCatchDefaults: { ...HER_RULE, enabledBalls: [] },
      catchSettings: {},
    });
    const outlook = autoCatchOutlook(state, "route1", "pidgey");
    expect(outlook).toMatchObject({ verdict: "inert", reason: "no_balls" });
    expect(outlook.shinyOverride).toBe(true);
    expect(ballForAutoCatch(state, "route1", "pidgey", true)).not.toBeNull();
  });

  it("does NOT claim it with an empty BAG — there is no ball to throw", () => {
    const state = herState({ inventory: {} });
    const outlook = autoCatchOutlook(state, "route1", "pidgey");
    expect(outlook.shinyOverride).toBe(false);
    expect(ballForAutoCatch(state, "route1", "pidgey", true)).toBeNull();
  });

  it("does NOT claim it when the player turned the shiny override off", () => {
    const state = herState({ alwaysCatchShinies: false });
    expect(autoCatchOutlook(state, "route1", "pidgey").shinyOverride).toBe(false);
    expect(shouldAutoCatch(state, "route1", "pidgey", 3, true)).toBe(false);
  });

  it("never says 'nothing will be thrown' while the engine throws — quantified", () => {
    // The real invariant, over both flag states and every verdict. If the badge
    // implies silence (off, or inert without shinyOverride) then NO encounter of
    // that species may be caught — shiny or not.
    const MODES: CatchSettings["mode"][] = [
      "always", "shiny_only", "level_threshold", "pokedex_new", "not_owned",
    ];
    let checked = 0;
    for (const alwaysCatchShinies of [true, false]) {
      for (const enabled of [true, false]) {
        for (const mode of MODES) {
          for (const enabledBalls of [["pokeball"], [] as string[]]) {
            for (const inventory of [{ pokeball: 5 }, {}]) {
              const state = herState({
                alwaysCatchShinies,
                inventory,
                globalCatchDefaults: { ...HER_RULE, enabled, mode, enabledBalls },
                catchSettings: {},
              });
              for (const speciesKey of ["pidgey", "lapras"]) {
                const o = autoCatchOutlook(state, "route1", speciesKey);
                const impliesSilence =
                  (o.verdict === "off" || o.verdict === "inert") && !o.shinyOverride;
                for (const isShiny of [true, false]) {
                  for (const level of [1, 100]) {
                    checked++;
                    const engine = shouldAutoCatch(state, "route1", speciesKey, level, isShiny);
                    // A ball still has to exist for the engine's `true` to
                    // actually mean a throw.
                    const ball = ballForAutoCatch(state, "route1", speciesKey, isShiny);
                    if (impliesSilence) expect(engine && ball !== null).toBe(false);
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(600);
  });
});

describe("weaken-before-catch must not kill what it is softening", () => {
  // A real Route 1 Pidgey, built by the game's own factory.
  function route1Pidgey() {
    const p = createPokemon("pidgey", 3, 900);
    expect(p.maxHp).toBeLessThan(20); // ~15 HP: one hit from anything grown
    return p;
  }

  it("throws immediately when the next hit would faint the target", () => {
    const lead = createPokemon("charizard", 100, 901);
    const enemy = route1Pidgey();
    const state = herState({
      party: [lead], playerPokemon: lead,
      globalCatchDefaults: { ...HER_RULE, mode: "always" },
      catchSettings: {},
    });
    // Preconditions: the rule wants weakening and HP is above the window, so
    // the old fraction-only test said "attack".
    expect(state.globalCatchDefaults.weakenFirst).toBe(true);
    expect(enemy.currentHp / enemy.maxHp).toBeGreaterThan(WEAKEN_HP_THRESHOLD);
    expect(maxSingleHitDamage(
      { ...lead, types: pokemonTable[lead.speciesKey].types },
      { ...enemy, types: pokemonTable[enemy.speciesKey].types },
    )).toBeGreaterThanOrEqual(enemy.currentHp);

    expect(shouldWeakenBeforeCatch(state, "route1", lead, enemy)).toBe(false);
  });

  it("still weakens when the hit leaves it alive — the setting keeps working", () => {
    const lead = createPokemon("pidgey", 3, 902);
    const enemy = createPokemon("snorlax", 50, 903);
    const state = herState({
      party: [lead], playerPokemon: lead,
      globalCatchDefaults: { ...HER_RULE, mode: "always" },
      catchSettings: {},
    });
    expect(maxSingleHitDamage(
      { ...lead, types: pokemonTable[lead.speciesKey].types },
      { ...enemy, types: pokemonTable[enemy.speciesKey].types },
    )).toBeLessThan(enemy.currentHp);
    expect(shouldWeakenBeforeCatch(state, "route1", lead, enemy)).toBe(true);
  });

  it("stops once the target is inside the low-HP window", () => {
    const lead = createPokemon("pidgey", 3, 904);
    const snorlax = createPokemon("snorlax", 50, 905);
    const chipped = { ...snorlax, currentHp: Math.floor(snorlax.maxHp * 0.2) };
    const state = herState({
      party: [lead], playerPokemon: lead,
      globalCatchDefaults: { ...HER_RULE, mode: "always" },
      catchSettings: {},
    });
    expect(shouldWeakenBeforeCatch(state, "route1", lead, chipped)).toBe(false);
  });

  it("never weakens a shiny, whatever the numbers say", () => {
    const lead = createPokemon("pidgey", 3, 906);
    const shiny = { ...createPokemon("snorlax", 50, 907, true), isShiny: true };
    const state = herState({
      party: [lead], playerPokemon: lead,
      globalCatchDefaults: { ...HER_RULE, mode: "always" },
      catchSettings: {},
    });
    expect(shouldWeakenBeforeCatch(state, "route1", lead, shiny)).toBe(false);
  });

  it("does nothing at all when the setting is off", () => {
    const lead = createPokemon("pidgey", 3, 908);
    const enemy = createPokemon("snorlax", 50, 909);
    const state = herState({
      party: [lead], playerPokemon: lead,
      globalCatchDefaults: { ...HER_RULE, mode: "always", weakenFirst: false },
      catchSettings: {},
    });
    expect(shouldWeakenBeforeCatch(state, "route1", lead, enemy)).toBe(false);
  });

  it("ignores move slots with no PP left — it cannot pick those", () => {
    const lead = createPokemon("charizard", 100, 910);
    const spent = { ...lead, moves: lead.moves.map((m) => ({ ...m, pp: 0 })) };
    const enemy = createPokemon("snorlax", 50, 911);
    expect(maxSingleHitDamage(
      { ...spent, types: pokemonTable[spent.speciesKey].types },
      { ...enemy, types: pokemonTable[enemy.speciesKey].types },
    )).toBe(0);
  });

  // A zero estimate is NOT a harmless hit, and `0 < currentHp` said it was.
  describe("a zero damage estimate means THROW, not attack", () => {
    function stateFor(lead: Pokemon) {
      return herState({
        party: [lead], playerPokemon: lead,
        globalCatchDefaults: { ...HER_RULE, mode: "always" },
        catchSettings: {},
      });
    }

    it("throws when every slot is spent — the turn would resolve as Struggle", () => {
      // Struggle is typeless and unmodelled by maxSingleHitDamage, so the old
      // predicate kept swinging and could faint the mon it meant to catch.
      const lead = createPokemon("charizard", 100, 920);
      const spent = { ...lead, moves: lead.moves.map((m) => ({ ...m, pp: 0 })) };
      const enemy = createPokemon("snorlax", 50, 921);
      expect(maxSingleHitDamage(
        { ...spent, types: pokemonTable[spent.speciesKey].types },
        { ...enemy, types: pokemonTable[enemy.speciesKey].types },
      )).toBe(0);
      expect(shouldWeakenBeforeCatch(stateFor(spent), "route1", spent, enemy)).toBe(false);
    });

    it("throws for a status-only moveset — HP would never fall at all", () => {
      // The other failure mode: no ball was EVER thrown for the encounter,
      // because the fraction test could not clear.
      const lead = createPokemon("abra", 20, 922);
      const statusOnly = { ...lead, moves: [{ id: "growl", pp: 40, maxPp: 40 }] };
      const enemy = createPokemon("snorlax", 50, 923);
      expect(maxSingleHitDamage(
        { ...statusOnly, types: pokemonTable[statusOnly.speciesKey].types },
        { ...enemy, types: pokemonTable[enemy.speciesKey].types },
      )).toBe(0);
      expect(shouldWeakenBeforeCatch(stateFor(statusOnly), "route1", statusOnly, enemy)).toBe(false);
    });
  });

  // The guard estimated damage at NEUTRAL stat stages while the turn it was
  // clearing resolves at the live ones: EXECUTE_TURN merges state.playerVolatile
  // onto its BattleSide, shouldWeakenBeforeCatch built its own from the plain
  // Pokemon (which has no stages) and so could not see a +4 Attack lead.
  describe("the overkill guard reads the live stat stages", () => {
    const BOOST: StatStages = { attack: 4, defense: 0, spAttack: 4, spDefense: 0, speed: 0 };

    function est(lead: Pokemon, enemy: Pokemon, statStages?: StatStages) {
      return maxSingleHitDamage(
        { ...lead, types: pokemonTable[lead.speciesKey].types, ...(statStages ? { statStages } : {}) },
        { ...enemy, types: pokemonTable[enemy.speciesKey].types },
      );
    }

    function boostedState(lead: Pokemon, stages: StatStages | null) {
      return herState({
        party: [lead], playerPokemon: lead,
        globalCatchDefaults: { ...HER_RULE, mode: "always" },
        catchSettings: {},
        playerVolatile: stages
          ? { statStages: stages, mustRecharge: false, lockedMove: null, lockTurnsRemaining: 0 }
          : null,
      } as Partial<GameState>);
    }

    // A concrete overkill case: 64 HP, 33 damage unboosted (survives), 87
    // boosted (dies). 298 such pairs exist in the grid below.
    const lead = () => createPokemon("machop", 20, 1000);
    const enemy = () => createPokemon("geodude", 30, 2000);

    it("the pair really is an overkill case at +4 and safe at neutral", () => {
      const l = lead(), e = enemy();
      expect(e.currentHp / e.maxHp).toBeGreaterThan(WEAKEN_HP_THRESHOLD);
      expect(est(l, e)).toBeLessThan(e.currentHp);              // neutral: survives
      expect(est(l, e, BOOST)).toBeGreaterThanOrEqual(e.currentHp); // boosted: dies
    });

    it("refuses the attack once the boost is visible", () => {
      const l = lead(), e = enemy();
      // Neutral: weakening is correct and still happens.
      expect(shouldWeakenBeforeCatch(boostedState(l, null), "route1", l, e)).toBe(true);
      // Boosted: the same hit would faint the catch target, so throw instead.
      expect(shouldWeakenBeforeCatch(boostedState(l, BOOST), "route1", l, e)).toBe(false);
    });

    it("never clears a hit that the live stages would make lethal — quantified", () => {
      // The invariant. Over a real grid, if the guard says "attack" then the
      // BOOSTED estimate must leave the target alive.
      let attacks = 0;
      let flipped = 0;
      for (const leadKey of ["machop", "charmander", "pikachu", "squirtle", "pidgey"]) {
        for (const enemyKey of ["geodude", "onix", "snorlax", "lapras", "gyarados"]) {
          for (const lv of [10, 20, 30, 40]) {
            for (const elv of [10, 20, 30, 40]) {
              for (const stages of [null, BOOST]) {
                const l = createPokemon(leadKey, lv, 30_000 + lv * 31 + elv);
                const e = createPokemon(enemyKey, elv, 40_000 + lv * 37 + elv);
                const s = boostedState(l, stages);
                if (shouldWeakenBeforeCatch(s, "route1", l, e)) {
                  attacks++;
                  expect(est(l, e, stages ?? undefined)).toBeLessThan(e.currentHp);
                } else if (stages && shouldWeakenBeforeCatch(boostedState(l, null), "route1", l, e)) {
                  flipped++; // boost is what turned this one into a throw
                }
              }
            }
          }
        }
      }
      expect(attacks).toBeGreaterThan(50);
      // The fix is load-bearing: some rows genuinely change answer.
      expect(flipped).toBeGreaterThan(0);
    });
  });
});
