// How full the tier bar should look.
//
// The bar has its own number rather than reusing tierProgress(), and this is
// the file that says why. Bronze spans 0–1100 and every account starts at
// 1000, so the TRUE band position of a player who has never battled is 91% —
// a bar reading "nearly promoted" for somebody who has done nothing, followed
// by a demand for another 100 points. The band below the starting rating is
// only reachable by losing, so it is not progress anyone made.
//
// The rule: measure from the start of the band you could actually be in —
// 1000 for Bronze, the tier floor for every tier above it.

import { describe, expect, it } from "vitest";
import { PVP_TIERS, tierFor } from "../src/state/pvpTiers";

const STARTING_RATING = 1000;

/** The same arithmetic TierTrack does, kept here so the rule is testable
 *  without mounting React. */
function bandFill(rating: number): number {
  const here = tierFor(rating);
  const idx = PVP_TIERS.indexOf(here);
  const from = Math.max(here.floor, idx === 0 ? STARTING_RATING : here.floor);
  const span = Math.max(1, here.ceil - from);
  return Math.max(0, Math.min(1, (rating - from) / span));
}

describe("tier bar fill", () => {
  it("reads empty for a brand-new account", () => {
    expect(bandFill(1000)).toBe(0);
  });

  // The production rating that got there by forfeiting one match. Under the
  // raw band position it would show 89% full, which is the specific lie this
  // exists to stop.
  it("reads empty for a rating that has only ever gone down", () => {
    expect(bandFill(984)).toBe(0);
  });

  it("reads half way at the midpoint of the climb out of Bronze", () => {
    expect(bandFill(1050)).toBeCloseTo(0.5, 5);
  });

  it("reads full at the promotion threshold", () => {
    // 1100 IS Silver's floor, so this is the first rating of the next band.
    expect(bandFill(1099)).toBeGreaterThan(0.98);
    expect(tierFor(1100).id).toBe("silver");
  });

  // Above Bronze the tier floor is the honest starting point: you got into
  // Silver by earning it, so Silver's floor is a place you actually stood.
  it("measures from the tier floor above Bronze", () => {
    expect(bandFill(1100)).toBe(0);            // just promoted to Silver
    expect(bandFill(1200)).toBeCloseTo(0.5, 5); // half way through Silver
    expect(bandFill(1300)).toBe(0);            // just promoted to Gold
  });

  it("never leaves 0..1, including below the starting rating", () => {
    for (const r of [0, 500, 900, 999, 1000, 1500, 2999, 5000]) {
      const v = bandFill(r);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("puts the top tier's ceiling out of reach rather than pinned full", () => {
    // Diamond is 1700–3000; a 1750 player is near the bottom of it, not done.
    expect(bandFill(1750)).toBeLessThan(0.1);
  });
});
