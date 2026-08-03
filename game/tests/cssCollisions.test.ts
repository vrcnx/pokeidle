// Scoped stylesheets must not silently re-use a class name app.css already
// owns.
//
// ── WHY THIS IS A TEST AND NOT A CONVENTION ─────────────────────────
// app.css is 20,000 lines. Component stylesheets are loaded after it, but
// "after" only wins at EQUAL specificity — and app.css is full of two-class
// selectors and !important. So a name collision does not fail loudly. It
// produces a component that is subtly wrong somewhere else in the app, and
// the symptom appears nowhere near the cause.
//
// This has happened repeatedly:
//
//   `.player-card`  — app.css had used it since long before for the battle
//     scene's HP card (`position: absolute; bottom: 18%`). A new component
//     took the same name and its rules landed on the battle HUD: a panel of
//     shortcut buttons absolutely positioned across the middle of the game.
//
//   `.pc-party`     — dead rules from a two-pane PC layout nothing had
//     rendered in years, including a `h3` rule that restyled a live
//     component's heading from four thousand lines away.
//
//   `.route-card`   — app.css places that card's children with explicit
//     `grid-column`. A redesign wrapped them in a new div, which removed
//     them from the grid rather than restyling them: the Map shipped with
//     no sprites and no travel buttons.
//
// Each of those was found by grepping by hand, and each was found AFTER it
// shipped. The grep is the test now.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "src");

/** Every class name a stylesheet DEFINES (appears in a selector). */
function classesIn(css: string): Set<string> {
  const out = new Set<string>();
  // Strip comments first — this codebase writes a lot of prose in CSS
  // comments and it mentions class names constantly.
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of bare.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) out.add(m[1]);
  return out;
}

function read(rel: string) {
  return readFileSync(join(SRC, rel), "utf8");
}

/**
 * Names a scoped sheet may share with app.css.
 *
 * Every entry is a DELIBERATE re-use — the component is styling the same
 * element app.css already styles, on purpose, and the two are meant to
 * compose. Adding to this list is the escape hatch; doing it without a
 * reason is how the bugs above happen.
 */
const ALLOWED = new Map<string, string>([
  ["mart-info", "the same info affordance, reused by the Bag's cards"],
  ["mart-tab", "the pane's own class, which app.css also scopes to"],
  ["bag-tab", "same"],
  ["pc-tab", "same"],
  ["dim", "a global utility, used everywhere by design"],
  ["small", "a global utility"],
  ["g-modal", "the shared modal shell — scoped sheets size it, app.css builds it"],
  ["g-modal-head", "same shell"],
  ["g-modal-close", "same shell"],
  ["g-modal-body", "same shell"],
  ["g-modal-foot", "same shell"],
  ["g-card", "the shared card"],
  ["g-card-full", "the shared card"],
  ["g-grid", "the shared grid"],
  ["g-tab", "the shared segmented control"],
  ["g-tabs", "the shared segmented control"],
  ["g-tab-small", "the shared segmented control"],
  ["g-help", "shared help text"],
  ["g-error", "shared error chip"],
  ["g-btn-primary", "shared button"],
  ["g-btn-small", "shared button"],
  ["g-btn-ghost", "shared button"],
  ["modal-overlay", "the shared overlay; scoped sheets only set z-index on it"],
  ["party-row", "the PC's party column renders the app's own party rows"],
  ["party-list", "same"],
  ["party-card", "same"],
  ["party-heal-btn", "same"],
  ["party-column", "same"],
  ["ctx-section", "shared section card"],
  // The auction board's base styles live in app.css; auctionBoard.css adds
  // PAGE-level layout to the same elements, scoped under its own
  // `.auction-page` wrapper. Deliberate co-styling of one element by two
  // sheets, which is the safe form — as opposed to two sheets that both
  // think they own a name.
  ["auction-board-list", "page layout over app.css's base board styles"],
  ["auction-list-form", "same"],
  ["auction-picker-grid", "same"],
  ["active", "a state class, not a component"],
  ["is-active", "a state class"],
  ["locked", "a state class"],
  ["current", "a state class"],
  ["seen", "a state class"],
  ["caught", "a state class"],
  ["done", "a state class"],
  ["paused", "a state class"],
  ["empty", "a state class"],
  ["filled", "a state class"],
  ["selected", "a state class"],
  ["unknown", "a state class"],
]);


/**
 * Collisions that already existed when this test was written.
 *
 * A hard "zero collisions" rule fails on six files today — mostly sheets
 * that were EXTRACTED from app.css, or that deliberately co-style an element
 * app.css also styles (pvpArena.css and `.battle-scene`, hub.css and the
 * panes it hosts). Demanding they all be cleaned up first would mean the
 * rule gets switched off, and a switched-off rule protects nothing.
 *
 * So this records the debt and the test fails only on ADDITIONS. New work
 * starts clean — mart.css, useItem.css, trainerCorner.css, raidTiers.css and
 * pcParty.css are all absent from this list, which is the standard.
 *
 * Entries are deleted as they are fixed; "the baseline only shrinks" below
 * fails if one goes stale, so this cannot silently re-permit a name.
 */
const BASELINE: Record<string, string[]> = {
  "components/auctionBoard.css": [
    "auction-board", "auction-board-tab", "auction-card", "auction-card-bidlink",
  ],
  "components/giveaways.css": [
    "giveaway-card", "giveaway-enter", "giveaway-fair", "gw-more", "gw-past-youwon",
    "gw-rail-label", "gw-rail-pill", "is-won", "mini-chat", "mini-chat-input",
    "mini-chat-list", "mobile-content", "mobile-tabbar", "promo-cta", "promo-done",
    "rw-tab-badge",
  ],
  "components/hub.css": [
    "g-profile-hero", "giveaway-card", "giveaway-card-foot", "hub-brand-text",
    "hub-head-slot", "hub-nav-head", "hub-tab", "hub-tab-badge", "is-shiny",
    "pvp-hero-trainer-card", "pvp-mode-chips", "pvp-slab", "pvp-slab-secondary",
    "pvp-slab-sub", "pvp-tour-icon", "pvp2-empty", "pvp2-identity", "pvp2-panel",
    "pvp2-podium-row", "pvp2-podium-you", "pvp2-portrait-wrap", "pvp2-team-row",
    "team-builder-empty", "team-builder-pool-grid", "team-builder-slot",
    "team-builder-strip-item", "team-builder-strip-list",
  ],
  "components/pcParty.css": ["drop-target-active"],
  "components/releaseControls.css": [
    "on", "pc-bulk-bar", "pc-search", "pc-search-clear", "pc-tool", "pc-tool-icon",
    "pc-toolbar", "pokemon-detail-v2",
  ],
  "pvpArena.css": [
    "battle-bg", "battle-scene", "center-column", "dashboard-wide", "down",
    "enemy-card-stack", "fainted", "low", "mine", "mobile-arena", "mobile-content",
    "mobile-header", "mobile-shell", "mobile-tabbar", "move-anim", "move-slot", "ok",
    "player-card", "pvp2-moves", "pvp2-team-row", "scene-content", "scene-status",
    "shake-screen", "sprite-missing", "up", "urgent", "warn", "win",
  ],
};

const APP = classesIn(read("app.css"));

const SCOPED = [
  ...readdirSync(join(SRC, "components"))
    .filter((f) => f.endsWith(".css"))
    .map((f) => `components/${f}`),
  "pvpArena.css",
];

describe("scoped stylesheets do not collide with app.css", () => {
  it("has stylesheets to check", () => {
    // Guards the guard: a glob that silently matches nothing is a test that
    // passes forever while checking nothing.
    expect(SCOPED.length).toBeGreaterThan(5);
    expect(APP.size).toBeGreaterThan(500);
  });

  for (const rel of SCOPED) {
    it(`${rel} introduces no NEW name app.css already owns`, () => {
      const mine = classesIn(read(rel));
      const clashes = [...mine].filter((c) => APP.has(c) && !ALLOWED.has(c)).sort();
      const known = BASELINE[rel] ?? [];
      const added = clashes.filter((c) => !known.includes(c));
      // The names are the whole diagnosis: the fix is a rename, or an
      // ALLOWED entry saying why the re-use is deliberate.
      expect(added).toEqual([]);
    });
  }

  it("the baseline only shrinks", () => {
    // Fixing an old collision should DELETE its baseline entry, not leave a
    // stale one that quietly re-permits the name later.
    const stale: string[] = [];
    for (const [rel, names] of Object.entries(BASELINE)) {
      const mine = classesIn(read(rel));
      for (const n of names) if (!mine.has(n)) stale.push(`${rel}: ${n}`);
    }
    expect(stale).toEqual([]);
  });
});
