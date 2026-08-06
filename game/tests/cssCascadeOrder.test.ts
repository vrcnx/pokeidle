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
// For every declaration inside a `max-width` media block, this looks for a
// LATER top-level rule that sets the same property with an equal-or-greater
// specificity and a matching key compound (the rightmost compound selector —
// the part that decides which element the rule lands on). Matching key
// compounds is a deliberately narrow proxy for "can address the same
// element": it catches the real failure without inventing a selector engine,
// and it cannot fire on two rules that target genuinely different elements.
//
// A narrower check means false negatives are possible and false positives
// are not, which is the correct trade for a guard that has to stay quiet to
// stay useful.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const CSS_DIR = join(__dirname, "..", "src", "components");

interface Rule {
  selectors: string[];
  /** The `max-width` condition this rule sits under, or null at top level. */
  media: string | null;
  props: Set<string>;
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
      const props = new Set<string>();
      for (const decl of body.split(";")) {
        const prop = decl.split(":")[0]?.trim().toLowerCase();
        if (prop) props.add(prop);
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

describe("mobile overrides are not undone by source order", () => {
  const files = readdirSync(CSS_DIR).filter((f) => f.endsWith(".css"));

  it("has css to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file}: every max-width rule outranks the later rules it must beat`, () => {
      const rules = parseRules(readFileSync(join(CSS_DIR, file), "utf8"));
      const topLevel = rules.filter((r) => r.media === null);
      const problems: string[] = [];

      for (const rule of rules) {
        if (!rule.media) continue;
        for (const sel of rule.selectors) {
          const key = keyCompound(sel);
          const spec = specificity(sel);
          for (const later of topLevel) {
            if (later.index <= rule.index) continue;
            for (const otherSel of later.selectors) {
              if (keyCompound(otherSel) !== key) continue;
              if (specificity(otherSel) < spec) continue;
              const shared = [...rule.props].filter((p) => later.props.has(p));
              if (shared.length === 0) continue;
              problems.push(
                `  ${file}:${rule.line} "${sel}" under ${rule.media}\n` +
                  `    is overridden by ${file}:${later.line} "${otherSel}" (same or higher specificity, later in the file)\n` +
                  `    for: ${shared.join(", ")}`,
              );
            }
          }
        }
      }

      expect(
        problems.join("\n"),
        problems.length
          ? `A media query adds no specificity, so these mobile rules never apply.\n` +
              `Scope the mobile selector through a parent (\`.hub-side .hub-me-btn\`)\n` +
              `rather than moving it further down the file.\n\n${problems.join("\n")}`
          : undefined,
      ).toBe("");
    });
  }
});
