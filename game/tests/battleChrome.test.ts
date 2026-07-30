// Two presentation bugs whose fix is entirely in CSS/markup. The game suite is
// node-env with no DOM, so these read the stylesheet and the component source
// and assert the properties that were actually violated. Weaker than rendering,
// but the alternative is no executable check at all on two fixes that are one
// careless edit away from silently coming back — both of these bugs WERE
// regressions introduced by edits that looked complete.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { TRAINER_INTRO_POKEMON_DELAY_BASE_MS } from "../src/utils/battleTiming";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const routeCard = readFileSync(join(srcDir, "components", "RouteCardList.tsx"), "utf8");

// Comments stripped first, and this matters: both fixes are documented in
// comments that name the very properties and selectors being asserted about
// (`animation-fill-mode`, `.route-card-mon-tip`). Matching raw text would pass
// on the prose and tell us nothing about the declarations.
const css = readFileSync(join(srcDir, "app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declaration block for a selector, or null. Matches the selector as a
 *  whole rule head so `.a::after` never matches `.a::before`. */
function ruleBody(selector: string): string | null {
  const head = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\})\\s*${head}\\s*\\{([^}]*)\\}`, "m").exec(css);
  return m ? m[1] : null;
}

describe("br_ff2d76689ef6c5281d — the shadow must not paint before the Pokémon", () => {
  // The trainer-intro rework delayed the sprite (.enemy-sprite) and the pokeball
  // flash (::before) but not the floor shadow (::after), which runs
  // `shadowPulse ... infinite` from mount. Result: a shadow on empty ground for
  // the whole intro, and again on every send-next, since the slot's React key is
  // the enemy id.
  const shadow = ruleBody(".sprite-slot.trainer-delayed::after");

  it("delays the shadow at all", () => {
    expect(shadow).not.toBeNull();
    expect(shadow!).toMatch(/animation-delay:/);
  });

  it("hides it during the delay", () => {
    // shadowPulse's own 0% keyframe is opacity 0.85, so without an explicit
    // opacity the shadow is fully painted while the sprite is still off-screen.
    expect(shadow!).toMatch(/opacity:\s*0\s*;/);
  });

  it("must NOT use animation-fill-mode: backwards, unlike the other two", () => {
    // This is the trap. `backwards` is correct for the sprite (pokeballEnter
    // starts at opacity 0) and wrong here: it would hold shadowPulse's 0%
    // keyframe, which is opacity 0.85 — i.e. hold the shadow VISIBLE for the
    // entire delay and change nothing at all.
    expect(shadow!).not.toMatch(/animation-fill-mode/);
  });

  it("reads the same custom property as the sprite and the flash", () => {
    // Three hardcoded copies of this timing in two languages is what
    // br_7362030de4444c8da8 was; utils/battleTiming.ts is the single source and
    // BattleScene publishes it. A literal here would drift at every game speed.
    for (const sel of [
      ".sprite-slot.trainer-delayed .enemy-sprite",
      ".sprite-slot.trainer-delayed::before",
      ".sprite-slot.trainer-delayed::after",
    ]) {
      expect(ruleBody(sel)).toMatch(/animation-delay:\s*var\(--trainer-intro-delay,/);
    }
  });

  it("uses the ×1 value from battleTiming as its fallback", () => {
    expect(shadow!).toContain(`var(--trainer-intro-delay, ${TRAINER_INTRO_POKEMON_DELAY_BASE_MS}ms)`);
  });
});

describe("br_a3f10a15331c5ff80c / br_5406e95a33f579a605 — the clipped map tooltip", () => {
  it("no longer renders a custom tooltip inside the sprite cell", () => {
    // It was absolutely positioned + nowrap inside a 26px flex cell, so a
    // ~130px label overhung ~52px each side and was clipped by two scrollers.
    expect(routeCard).not.toContain("route-card-mon-tip");
    expect(css).not.toContain("route-card-mon-tip");
  });

  it("still shows the same text via the native title, which cannot be clipped", () => {
    expect(routeCard).toMatch(/className="route-card-mon" title=\{label\}/);
  });

  it("leaves the clipping ancestors untouched", () => {
    // The other repair was to open up .route-card-grid / .bottom-tab-body. Both
    // clip on purpose — the grid scrolls, the tab body is the panel boundary —
    // so this records that the tooltip was removed instead of the scrollers
    // being loosened underneath everything else in those containers.
    expect(ruleBody(".route-card-grid")).toMatch(/overflow-y:\s*auto/);
  });
});
