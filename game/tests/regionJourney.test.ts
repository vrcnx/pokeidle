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
} from "../src/utils/regionJourney";
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
