// The What's New modal keys off CURRENT_VERSION, and the file's own header
// says to bump it "and add a matching entry at the TOP". Those are two edits
// that have to happen together, and the failure is silent in both directions:
// bump without an entry and returning players get an empty modal, add an entry
// without bumping and nobody is ever shown it.
//
// Also pins the release-note claims that are checkable against the code. A
// patch note is a promise, and 0.9.5 shipped "5× speed is retired" for four
// days while every player was using 5× — the gate went in and came back out
// the same day and the note was never corrected. That one at least was
// visible; a note describing a restriction that is not enforced would not be.

import { describe, expect, it } from "vitest";
import { CURRENT_VERSION, changelog, changesSince, compareVersions } from "../src/data/changelog";
import { REGION_CLEAR_BONUS } from "../src/utils/regionJourney";

describe("the version and the notes move together", () => {
  it("has an entry for the version the client reports", () => {
    expect(changelog[0].version).toBe(CURRENT_VERSION);
  });

  it("shows a player on the previous release exactly the new entry", () => {
    const previous = changelog[1].version;
    const shown = changesSince(previous);
    expect(shown.map((e) => e.version)).toEqual([CURRENT_VERSION]);
  });

  it("shows a brand-new player nothing", () => {
    // A wall of release notes is a terrible first thing to see in a game you
    // have not played yet.
    expect(changesSince(null)).toEqual([]);
  });

  it("stays newest-first, so `changelog[0]` is always the current entry", () => {
    for (let i = 1; i < changelog.length; i++) {
      expect(
        compareVersions(changelog[i - 1].version, changelog[i].version),
        `${changelog[i - 1].version} should be newer than ${changelog[i].version}`,
      ).toBeGreaterThan(0);
    }
  });

  it("gives every entry a subtitle and at least one item", () => {
    for (const e of changelog) {
      expect(e.subtitle, e.version).toBeTruthy();
      expect(e.sections.length, e.version).toBeGreaterThan(0);
      for (const s of e.sections) {
        expect(s.heading, e.version).toBeTruthy();
        expect(s.items.length, `${e.version} / ${s.heading}`).toBeGreaterThan(0);
      }
      // The three oldest entries (0.2–0.4) predate the field and are left
      // alone — back-dating them would be inventing history. Anything that
      // HAS a date has to have a real one.
      if (e.date !== undefined) expect(e.date, e.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("dates the current entry, whatever the old ones do", () => {
    expect(changelog[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("what the current notes claim is what the code does", () => {
  const items = changelog[0].sections.flatMap((s) => s.items).join("\n");

  it("quotes the region-clear bonus the code actually applies", () => {
    // Printed as percentages in the note; asserted against the constants so a
    // balance change cannot leave the notes quoting the old numbers.
    expect(items).toContain(`+${Math.round(REGION_CLEAR_BONUS.exp * 100)}% EXP`);
    expect(items).toContain(`+${Math.round(REGION_CLEAR_BONUS.money * 100)}% prize money`);
    expect(items).toContain(`+${Math.round(REGION_CLEAR_BONUS.catch * 100)}% catch rate`);
  });

  it("does NOT claim a team restriction, because none is enforced yet", () => {
    // regionJourney exports canUseInRegion / illegalPartyMembers, but nothing
    // in the UI calls them — only the journey LEVELS and the clear BONUS are
    // live. Announcing region-locked teams would describe a rule that does not
    // exist, which is the 0.9.5 mistake in the other direction.
    expect(items).not.toMatch(/can(not| ?'?t) (use|bring|take).{0,30}(caught|region)/i);
    expect(items).toMatch(/Nothing restricts you yet/i);
  });

  it("does not claim 5× speed is gone", () => {
    // The exact wording that was wrong for four days.
    const everything = changelog.flatMap((e) => e.sections.flatMap((s) => s.items)).join("\n");
    expect(everything).not.toMatch(/5× speed is retired/);
  });
});
