// Region journeys.
//
// The design is in docs/region-journeys.md. What is pinned here is the part
// that is easy to get quietly wrong and expensive to discover late: what
// happens to a Pokémon with NO recorded origin.
//
// Every save written before this feature has none, and there is no data to
// backfill it from. The tempting reading is "no origin = unrestricted"; it is
// wrong, and wrong in a way that only shows up when a region ships two years
// from now and every existing box walks in and flattens it. These tests state
// the rule loudly enough that changing it has to be deliberate.

import { describe, expect, it } from "vitest";
import {
  canUseInRegion,
  canUseHere,
  regionCompleted,
  illegalPartyMembers,
  LEGACY_REGIONS,
  journeyLevelOffset,
  applyJourneyOffset,
  regionBonuses,
  regionsCleared,
} from "../src/utils/regionJourney";
import { catchProbability } from "../src/utils/catching";
import { encounters } from "../src/data/encounters";
import { regions } from "../src/data/regions";
import { makeMon, makeState } from "./helpers";

const KANTO_CHAMPION = regions.kanto.champion!.id;
const JOHTO_CHAMPION = regions.johto.champion!.id;

const beaten = (...ids: string[]) => makeState({ defeatedChampions: ids });

describe("completion is the only flag", () => {
  it("reads the region's own champion, not a global 'beat someone' flag", () => {
    const s = beaten(KANTO_CHAMPION);
    expect(regionCompleted("kanto", s)).toBe(true);
    expect(regionCompleted("johto", s)).toBe(false);
  });

  it("treats a region nobody has heard of as NOT complete", () => {
    // This is the branch that makes the legacy rule work. A region that has
    // not shipped yet is not "done" — waving it through on a lookup miss is
    // exactly how every existing box would walk into Hoenn on day one.
    expect(regionCompleted("nosuchregion", makeState())).toBe(false);
  });

  it("every shipped region has a champion, so completion is always decidable", () => {
    // The `known region with no champion` branch is a safety net for data
    // that does not exist today. Asserting that keeps it honest: if a region
    // ever ships without a champion, this fails and somebody decides on
    // purpose rather than discovering it as a lockout.
    for (const [id, r] of Object.entries(regions)) {
      expect(r.champion?.id, `${id} has no champion`).toBeTruthy();
    }
  });
});

describe("FARM MODE — a completed region asks nothing", () => {
  it("lets anything in, whatever its origin", () => {
    const s = beaten(KANTO_CHAMPION, JOHTO_CHAMPION);
    for (const origin of ["kanto", "johto", "hoenn", undefined]) {
      const mon = makeMon({ caughtIn: origin });
      expect(canUseInRegion(mon, "johto", s).ok, String(origin)).toBe(true);
    }
  });

  it("is why an established player's Johto is untouched", () => {
    // The whole reason this design does not move anybody's income: a player
    // who finished Johto keeps it exactly as it is today.
    const s = beaten(KANTO_CHAMPION, JOHTO_CHAMPION);
    const kantoMon = makeMon({ caughtIn: "kanto" });
    expect(canUseInRegion(kantoMon, "johto", s).ok).toBe(true);
  });
});

describe("JOURNEY MODE — an uncompleted region wants its own team", () => {
  const s = beaten(KANTO_CHAMPION); // Johto not finished

  it("accepts a Pokémon caught there", () => {
    expect(canUseInRegion(makeMon({ caughtIn: "johto" }), "johto", s).ok).toBe(true);
  });

  it("refuses one caught somewhere else, and names both regions", () => {
    const v = canUseInRegion(makeMon({ caughtIn: "kanto" }), "johto", s);
    expect(v.ok).toBe(false);
    expect((v as { reason: string }).reason).toContain("Kanto");
    expect((v as { reason: string }).reason).toContain("Johto");
  });

  it("closes the Exp. Share round trip in the same predicate", () => {
    // The mirror rule — a Pokémon caught in an uncompleted region cannot be
    // taken OUT of it — needs no second rule. It is this predicate evaluated
    // against the destination. A Johto-caught mon cannot be walked back to
    // Kanto to be levelled cheaply while Johto is unfinished.
    const johtoMon = makeMon({ caughtIn: "johto" });
    expect(canUseInRegion(johtoMon, "kanto", beaten()).ok).toBe(false);
  });

  it("stops refusing the moment the region is beaten", () => {
    const mon = makeMon({ caughtIn: "kanto" });
    expect(canUseInRegion(mon, "johto", beaten(KANTO_CHAMPION)).ok).toBe(false);
    expect(canUseInRegion(mon, "johto", beaten(KANTO_CHAMPION, JOHTO_CHAMPION)).ok).toBe(true);
  });
});

describe("THE LEGACY RULE — the decision the feature rests on", () => {
  const legacy = () => makeMon({ caughtIn: undefined });

  it("grandfathers a legacy Pokémon into the regions that already existed", () => {
    // Nobody loses access to anything they own. An existing player's Kanto
    // and Johto behave exactly as they do today.
    for (const r of LEGACY_REGIONS) {
      expect(canUseInRegion(legacy(), r, beaten()).ok, r).toBe(true);
    }
  });

  it("does NOT grandfather it into a region added later", () => {
    // The whole point. If this ever returns true, every existing box walks
    // into Hoenn and the feature has quietly undone itself.
    const v = canUseInRegion(legacy(), "hoenn", beaten());
    expect(v.ok).toBe(false);
    expect((v as { reason: string }).reason).toMatch(/fresh start/i);
  });

  it("keeps LEGACY_REGIONS frozen to the two that shipped with it", () => {
    // Adding to this set is how the feature gets undone by accident, so the
    // membership is asserted rather than assumed. A new region belongs in
    // `regions`, never here.
    expect([...LEGACY_REGIONS].sort()).toEqual(["johto", "kanto"]);
  });
});

describe("nothing is refused on a lookup miss", () => {
  it("allows a location that belongs to no region", () => {
    // Raid Island, and anything the region map has not heard of. Refusing on
    // an unknown is how a feature locks people out of content it was never
    // meant to touch.
    expect(canUseInRegion(makeMon({ caughtIn: "kanto" }), undefined, beaten()).ok).toBe(true);
  });

  it("allows a raid, which belongs to no region's journey", () => {
    const s = makeState({ currentLocation: "raidIsland", defeatedChampions: [] });
    expect(canUseHere(makeMon({ caughtIn: "johto" }), s).ok).toBe(true);
  });
});

describe("the party check names names", () => {
  it("returns the offending members with a reason each, not a boolean", () => {
    // Every caller has to SAY what blocked it. A blocked action that will not
    // explain itself is the failure mode this codebase keeps rediscovering.
    const s = makeState({
      currentLocation: "route29",           // Johto
      defeatedChampions: [KANTO_CHAMPION],  // Johto unfinished
      party: [
        makeMon({ caughtIn: "johto", name: "Native" }),
        makeMon({ caughtIn: "kanto", name: "Import" }),
      ],
    });
    const bad = illegalPartyMembers(s);
    expect(bad).toHaveLength(1);
    expect(bad[0].mon.name).toBe("Import");
    expect(bad[0].reason).toBeTruthy();
  });

  it("finds nothing once the region is complete", () => {
    const s = makeState({
      currentLocation: "route29",
      defeatedChampions: [KANTO_CHAMPION, JOHTO_CHAMPION],
      party: [makeMon({ caughtIn: "kanto" })],
    });
    expect(illegalPartyMembers(s)).toHaveLength(0);
  });
});

// ── JOURNEY LEVELS ────────────────────────────────────────────────────────
describe("journey levels", () => {
  const KANTO = regions.kanto.champion!.id;
  const JOHTO = regions.johto.champion!.id;

  it("hands Johto back its real Gold/Silver curve while it is unfinished", () => {
    // The offset was measured, not guessed: subtracting 38 reproduces canon
    // across all 34 areas. These are the load-bearing samples.
    const fresh = makeState({ defeatedChampions: [] });
    const band = (route: string) => {
      const e = encounters[route].encounters[0];
      const a = applyJourneyOffset(e, journeyLevelOffset(route, fresh));
      return `${a.minLevel}-${a.maxLevel}`;
    };
    expect(band("route29")).toBe("2-4");        // canon Sentret / Pidgey
    expect(band("unionCave")).toBe("8-11");
    expect(band("nationalPark")).toBe("14-17");
    expect(band("mtSilver")).toBe("37-42");
  });

  it("leaves Johto EXACTLY as it is today once it is beaten", () => {
    // The promise that nobody's income moves. If this ever drifts, every
    // established player's farm has been quietly nerfed.
    const done = makeState({ defeatedChampions: [KANTO, JOHTO] });
    for (const route of ["route29", "unionCave", "mtSilver"]) {
      const e = encounters[route].encounters[0];
      const a = applyJourneyOffset(e, journeyLevelOffset(route, done));
      expect(a.minLevel, route).toBe(e.minLevel);
      expect(a.maxLevel, route).toBe(e.maxLevel);
    }
  });

  it("never touches Kanto, which was never inflated", () => {
    for (const s of [makeState({ defeatedChampions: [] }), makeState({ defeatedChampions: [KANTO] })]) {
      expect(journeyLevelOffset("route1", s)).toBe(0);
    }
  });

  it("never rolls below level 2, whatever the arithmetic says", () => {
    expect(applyJourneyOffset({ minLevel: 3, maxLevel: 5 }, 99)).toEqual({ minLevel: 2, maxLevel: 2 });
  });

  it("leaves raids alone — they belong to no journey", () => {
    expect(journeyLevelOffset("raidIsland", makeState({ defeatedChampions: [] }))).toBe(0);
  });
});

// ── THE OTHER SIDE OF THE LEDGER ──────────────────────────────────────────
describe("clearing a region pays out", () => {
  const KANTO = regions.kanto.champion!.id;
  const JOHTO = regions.johto.champion!.id;

  it("pays nothing before you have cleared anything", () => {
    const b = regionBonuses(makeState({ defeatedChampions: [] }));
    expect(b).toMatchObject({ cleared: 0, exp: 1, money: 1, catch: 1 });
  });

  it("is cumulative, and additive rather than multiplicative", () => {
    // Three regions is +30% EXP, not triple. A reason to finish a region,
    // not a reason to rush one.
    const one = regionBonuses(makeState({ defeatedChampions: [KANTO] }));
    const two = regionBonuses(makeState({ defeatedChampions: [KANTO, JOHTO] }));
    expect(one.exp).toBeCloseTo(1.1);
    expect(two.exp).toBeCloseTo(1.2);
    expect(two.money).toBeCloseTo(1.2);
  });

  it("keeps the catch bonus smaller than the others, on purpose", () => {
    // Catch rate compounds with every ball thrown, and a big number here
    // trivialises the Pokédex the journey rules exist to protect.
    const b = regionBonuses(makeState({ defeatedChampions: [KANTO, JOHTO] }));
    expect(b.catch).toBeLessThan(b.exp);
    expect(b.catch).toBeCloseTo(1.1);
  });

  it("counts regions, not champions beaten", () => {
    // Beating the same champion twice must not pay twice.
    const dup = makeState({ defeatedChampions: [KANTO, KANTO] });
    expect(regionsCleared(dup)).toBe(1);
  });

  it("never lets the catch bonus push a probability past certainty", () => {
    // A 100%-catch species with a big bonus must still be a probability.
    expect(catchProbability("caterpie", "masterball", 1, 99)).toBeLessThanOrEqual(1);
  });
});
