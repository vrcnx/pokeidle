// The raid tab has to scroll, and only CSS makes that true.
//
// The Map pane's route branches render inside .route-card-grid, which is
// carrying `flex: 1; min-height: 0; overflow-y: auto` — that class, and
// nothing else, is why the pane scrolls. The raid tab REPLACED that div
// rather than filling it, so it inherited none of the three.
//
// It survived on luck: six tiers in a two-column grid is three rows and fit
// on screen. The Hoenn tier made it seven, the list grew a fourth row, and
// the bottom went under the fold with no way to reach it. Players reported
// it the same day ("are there more than 6 possible raids?") and the only
// workaround anyone found was zooming the entire browser out.
//
// Measured in a real browser against the real stylesheet, before and after:
//   before  overflow-y: visible, scrollHeight 1122 === clientHeight 1122
//   after   overflow-y: auto,    scrollHeight 1126 >   clientHeight  388
//
// jsdom does no layout, so that measurement cannot live in a unit test.
// What CAN be pinned is the two things whose absence caused it: the rule
// exists with all three properties, and the tab actually uses it.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(__dirname, "../src/components/raidTiers.css"), "utf8");
const tsx = readFileSync(join(__dirname, "../src/components/RouteCardList.tsx"), "utf8");

const rule = css.slice(css.indexOf(".raid-tier-scroll"));

describe("the raid tab can be scrolled to the bottom", () => {
  it("defines the scroll container at all", () => {
    expect(css).toContain(".raid-tier-scroll");
  });

  it("carries overflow-y, so there is something to drag", () => {
    expect(rule).toMatch(/overflow-y:\s*auto/);
  });

  it("carries min-height: 0", () => {
    // THE load-bearing one, and the easiest to delete as redundant. Without
    // it a flex child refuses to shrink below its content, so overflow-y has
    // nothing to overflow: the pane silently grows instead of scrolling and
    // the bug comes back looking exactly like a CSS no-op.
    expect(rule).toMatch(/min-height:\s*0/);
  });

  it("carries flex: 1, so it fills the pane rather than the content", () => {
    expect(rule).toMatch(/flex:\s*1/);
  });

  it("is actually applied to the raid branch", () => {
    // A rule nothing uses is the same bug with extra steps.
    expect(tsx).toMatch(/className="raid-tier-scroll"/);
  });

  it("wraps RaidTierList specifically", () => {
    const at = tsx.indexOf('className="raid-tier-scroll"');
    expect(at).toBeGreaterThan(-1);
    expect(tsx.slice(at, at + 200)).toContain("<RaidTierList");
  });
});
