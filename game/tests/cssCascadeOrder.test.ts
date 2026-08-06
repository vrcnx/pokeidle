// A mobile override that loses on source order.
//
// WHY THIS TEST EXISTS
//
// The mobile hub rail shipped broken twice for the same reason. hub.css hid
// the identity button on phones with
//
//     @media (max-width: 760px) { .hub-me-btn { display: none } }
//
// and a thousand lines further down set the button up with
//
//     .hub-me-btn { display: block }
//
// A media query contributes NOTHING to specificity. Both selectors score
// 0-1-0, so the cascade fell through to source order and the later `block`
// won — at every width, phone included. The rule was present, correct in
// isolation, matched by the media query, and completely inert. The button
// stayed a full-width flex item with zero height, which collapsed the nav
// rail beside it to 0px and laid all eleven tabs out at negative x.
//
// It survived review both times because reading the media block alone tells
// you nothing: the bug lives in the DISTANCE between two rules, and neither
// is wrong on its own. That is exactly what a test is for.
//
// WHAT IS CHECKED, AND WHAT IS DELIBERATELY NOT
//
// For every declaration inside a `max-width` block, this looks for a LATER
// rule that applies across a strictly WIDER range, scores at least the same
// specificity, can land on the same element, and sets the same property to a
// DIFFERENT value. All four conditions have earned their place:
//
//  - "wider range", not "top level". The first version only compared against
//    top-level rules and so never saw the tablet rule that was giving the PC
//    and the Auction house a 232px sidebar on a 390px phone. A `min-width`
//    floor is what correctly keeps a tablet rule off phones, so it counts.
//  - "strictly wider". Two rules at the same breakpoint are ordered by the
//    author on purpose; flagging those buries the real ones.
//  - "same element" means an identical key compound, or a BEM base and its
//    own modifier (`.hub-shell` / `.hub-shell--aside` are two classes on ONE
//    element) — but only when the later rule is unconditional or asks for the
//    same ancestors. Ignoring ancestors made the first app.css run almost all
//    noise: `.mobile-content .tab-pane-head` and `.bag-tab .tab-pane-head`
//    share a compound and never meet.
//  - "different value". A later rule setting the same value undoes nothing.
//
// The check stays deliberately conservative, so false negatives are possible
// and false positives should not be. A guard like this is only worth having
// if it stays quiet.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const CSS_DIR = join(__dirname, "..", "src", "components");

interface Rule {
  selectors: string[];
  /** The `max-width` condition this rule sits under, or null at top level. */
  media: string | null;
  props: Map<string, string>;
  /** Source order. */
  index: number;
  line: number;
}

/** Strip comments without disturbing line count, so reports point at source. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/**
 * A flat rule list with each rule's enclosing media condition.
 *
 * Hand-rolled rather than pulled from a parser dependency: the shape needed
 * here is small, and the game's CSS is plain — no nesting, no preprocessor.
 */
function parseRules(css: string): Rule[] {
  const src = stripComments(css);
  const rules: Rule[] = [];
  const stack: string[] = [];
  let buf = "";
  let index = 0;

  const lineAt = (pos: number) => src.slice(0, pos).split("\n").length;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") {
      const prelude = buf.trim();
      buf = "";
      if (prelude.startsWith("@")) {
        stack.push(prelude);
        continue;
      }
      // A declaration block: consume to its matching close.
      const close = src.indexOf("}", i);
      const body = src.slice(i + 1, close === -1 ? src.length : close);
      // Values, not just property names. A later rule that sets the SAME
      // value undoes nothing, and flagging it is noise — `.pvp-hub-pane`
      // and `.pvp-hub-pane--editing` both land on `gap: 12px` at phone
      // width by different routes, which is a coincidence, not a bug.
      const props = new Map<string, string>();
      for (const decl of body.split(";")) {
        const colon = decl.indexOf(":");
        if (colon === -1) continue;
        const prop = decl.slice(0, colon).trim().toLowerCase();
        const value = decl.slice(colon + 1).trim().replace(/\s+/g, " ");
        if (prop) props.set(prop, value);
      }
      const media = stack.find((s) => /^@media/.test(s) && /max-width/.test(s)) ?? null;
      rules.push({
        selectors: prelude.split(",").map((s) => s.trim()).filter(Boolean),
        media,
        props,
        index: index++,
        line: lineAt(i),
      });
      i = close === -1 ? src.length : close;
      continue;
    }
    if (ch === "}") {
      stack.pop();
      buf = "";
      continue;
    }
    buf += ch;
  }
  return rules;
}

/** CSS specificity as a single comparable number. Good enough at these scales:
 *  no selector in this codebase carries 10+ classes on one compound. */
export function specificity(selector: string): number {
  // `:not(...)` / `:is(...)` take the specificity of their strongest argument,
  // and the wrapper itself adds none.
  const unwrapped = selector.replace(/:(?:not|is|has)\(([^()]*)\)/g, " $1 ");
  const ids = (unwrapped.match(/#[\w-]+/g) ?? []).length;
  const classes =
    (unwrapped.match(/\.[\w-]+/g) ?? []).length +
    (unwrapped.match(/\[[^\]]+\]/g) ?? []).length +
    (unwrapped.match(/:(?!:)[\w-]+/g) ?? []).length;
  const elements =
    (unwrapped.match(/(?:^|[\s>+~])([a-z][\w-]*)/gi) ?? []).length +
    (unwrapped.match(/::[\w-]+/g) ?? []).length;
  return ids * 10000 + classes * 100 + elements;
}

/** The rightmost compound selector — the part that decides which element the
 *  rule actually lands on. `.hub-side .hub-me-btn` → `.hub-me-btn`. */
export function keyCompound(selector: string): string {
  const parts = selector.trim().split(/[\s>+~]+/).filter(Boolean);
  return parts[parts.length - 1] ?? selector.trim();
}

/** The px in a `max-width` condition, or null if the query is not one. */
export function maxWidthOf(condition: string): number | null {
  const m = /max-width:\s*(\d+)px/.exec(condition);
  return m ? Number(m[1]) : null;
}

/** The px floor in a `min-width` condition; 0 when the query has none. A
 *  rule floored above the breakpoint under test cannot compete with it —
 *  which is exactly how the tablet Aside rule is kept off phones. */
export function minWidthOf(condition: string | null): number {
  if (!condition) return 0;
  const m = /min-width:\s*(\d+)px/.exec(condition);
  return m ? Number(m[1]) : 0;
}

/**
 * Can these two key compounds land on the same element?
 *
 * Identical, obviously — but also a BEM base and its modifier. This codebase
 * writes `.hub-shell` / `.hub-shell--aside`, `.hub-pane` / `.hub-pane--fill`,
 * and the modifier is a SECOND class on the same element, not a different
 * one. That is how the phone layout was lost: the mobile block collapsed
 * `.hub-shell` to one column and a later, wider rule gave `.hub-shell--aside`
 * two back. Comparing only identical compounds could never see it.
 */
export function sameTarget(a: string, b: string): boolean {
  if (a === b) return true;
  const base = (s: string) => s.split("--")[0];
  return base(a) === base(b) && (a === base(a) || b === base(b));
}

/** Everything to the LEFT of the key compound — the context the rule needs. */
function ancestors(selector: string): string {
  const parts = selector.trim().split(/[\s>+~]+/).filter(Boolean);
  return parts.slice(0, -1).join(" ");
}

/**
 * Could the later rule actually land on the elements the earlier one styles?
 *
 * Matching key compounds alone is NOT enough, and assuming otherwise made the
 * first run against app.css almost all noise: `.mobile-content .tab-pane-head`
 * and `.bag-tab .tab-pane-head` share a key compound and score the same, but
 * they are headers in different screens and neither touches the other.
 *
 * A later rule is only a threat when it is unconditional — a bare compound,
 * which matches wherever that class appears — or when it asks for exactly the
 * same context. Anything else is a different element until proven otherwise,
 * and this test is only worth having if it stays quiet.
 */
function canOverride(earlier: string, later: string): boolean {
  const laterCtx = ancestors(later);
  return laterCtx === "" || laterCtx === ancestors(earlier);
}

describe("mobile overrides are not undone by source order", () => {
  // app.css too, and it matters most there: it is by far the longest sheet,
  // so the distance between a mobile rule and the base rule that outranks it
  // is greatest, and the chat block sits ~1,700 lines above the last
  // `.g-chat-*` rule it has to beat.
  const files = [
    ...readdirSync(CSS_DIR).filter((f) => f.endsWith(".css")).map((f) => join(CSS_DIR, f)),
    join(CSS_DIR, "..", "app.css"),
  ];

  it("has css to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  /**
   * app.css carries a backlog of these, and it is not this test's job to
   * hold the mobile hub work hostage to it.
   *
   * The component sheets are clean and stay clean — those assert zero. app.css
   * had 76 conflicting pairs the first time it was measured, all pre-existing:
   * `.modal-overlay`, `.g-modal`, `.game-window` and friends are each declared
   * again, later, after their own mobile block. Some of those are live bugs and
   * some are harmless, and telling them apart means opening each one at a real
   * viewport. That is worth doing and it is a separate piece of work.
   *
   * So this ratchets instead: the number may fall, never rise. A new mobile
   * rule that loses its cascade fight fails the build the day it is written,
   * which is the point, without demanding the history be cleaned first.
   */
  const APP_CSS_BASELINE = 76;

  for (const file of files) {
    // basename — the path separator is a backslash on Windows.
    const label = file.split(/[\\/]/).pop() ?? file;
    it(`${label}: every max-width rule outranks the later rules it must beat`, () => {
      const rules = parseRules(readFileSync(file, "utf8"));
      const problems: string[] = [];

      for (const rule of rules) {
        if (!rule.media) continue;
        const width = maxWidthOf(rule.media);
        if (width === null) continue;
        for (const sel of rule.selectors) {
          const key = keyCompound(sel);
          const spec = specificity(sel);
          for (const later of rules) {
            if (later.index <= rule.index) continue;
            // A later rule only competes if it applies across a STRICTLY
            // WIDER range than the one being protected. That is the whole
            // invariant: a rule written for a narrow breakpoint must not be
            // undone by one meant for bigger screens.
            //
            // Strictly wider, not "wider or equal", on purpose. Two rules at
            // the SAME breakpoint are ordered by the author deliberately —
            // a modifier overriding its base inside one block is ordinary
            // BEM, not a mistake — and flagging those buries the real ones.
            //
            // The first version looked only at top-level rules, so it never
            // saw the tablet rule that was flattening the PC and the Auction
            // house on a phone. A `min-width` floor above this breakpoint is
            // what correctly keeps such a rule out, so it is honoured here.
            const laterWidth = later.media === null ? Infinity : maxWidthOf(later.media);
            if (laterWidth === null || laterWidth <= width) continue;
            if (minWidthOf(later.media) > width) continue;
            for (const otherSel of later.selectors) {
              if (!sameTarget(keyCompound(otherSel), key)) continue;
              if (!canOverride(sel, otherSel)) continue;
              if (specificity(otherSel) < spec) continue;
              // Only properties whose VALUE actually changes.
              const shared = [...rule.props.keys()].filter(
                (p) => later.props.has(p) && later.props.get(p) !== rule.props.get(p),
              );
              if (shared.length === 0) continue;
              problems.push(
                `  ${label}:${rule.line} "${sel}" under ${rule.media}\n` +
                  `    is overridden by ${label}:${later.line} "${otherSel}" (same or higher specificity, later in the file)\n` +
                  `    for: ${shared.join(", ")}`,
              );
            }
          }
        }
      }

      const advice =
        `A media query adds no specificity, so these mobile rules never apply.\n` +
        `Scope the mobile selector through a parent (\`.hub-side .hub-me-btn\`)\n` +
        `rather than moving it further down the file.\n\n${problems.join("\n")}`;

      if (label === "app.css") {
        expect(
          problems.length,
          problems.length > APP_CSS_BASELINE
            ? `app.css went from ${APP_CSS_BASELINE} cascade conflicts to ${problems.length}.\n` +
                `The new one is in this list — the baseline is a ratchet, not permission.\n\n${advice}`
            : undefined,
        ).toBeLessThanOrEqual(APP_CSS_BASELINE);
        return;
      }

      expect(problems.join("\n"), problems.length ? advice : undefined).toBe("");
    });
  }
});
