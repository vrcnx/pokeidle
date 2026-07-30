// The PvP arena on a phone.
//
// THE BUG THIS SUITE EXISTS FOR: at 390×760 with a live battle in the pvp
// store, `.pvp2-center` and `.pvp2-scene` were ABSENT and the phone rendered
// the (frozen) idle battle scene instead. MobileShell was byte-identical to the
// commit before the arena shipped — it simply never routed to it. A player on a
// phone could read the transcript and both teams (PartyColumn swaps itself for
// PvpRail, so the rail leaked in under the "Party" tab) and could not pick a
// move, could not switch, could not forfeit, and never saw the result dialog.
//
// The game suite is node-env with no DOM, so this is split the way the fixes
// are: the navigation rule is pure and is tested by execution, and the two
// layout facts that were MEASURED broken are asserted against the stylesheet
// and the component source. That is weaker than rendering — but both of those
// were regressions caused by an edit that looked complete, and both are one
// careless edit from silently coming back.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { nextPvpMobileView, NO_PVP, PVP_MOBILE_VIEWS, type PvpNavSignals } from "../src/utils/pvpMobileNav";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Comments stripped first, and it matters here more than usual: every fix
 *  below is documented in a comment that names the very selector or prop being
 *  asserted about, so matching raw text would pass on the prose. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const arenaCss = stripComments(readFileSync(join(srcDir, "pvpArena.css"), "utf8"));
const appCss = stripComments(readFileSync(join(srcDir, "app.css"), "utf8"));
const shell = stripComments(readFileSync(join(srcDir, "components", "MobileShell.tsx"), "utf8"));

/** The declaration block for a selector, anywhere in the sheet — including
 *  inside an `@media` / `@container` block, hence `[{}]` rather than `\}` as
 *  the opener (the first rule in an at-block is preceded by `{`). */
function ruleBody(css: string, selector: string): string | null {
  const head = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|[{}])\\s*${head}\\s*\\{([^}]*)\\}`, "m").exec(css);
  return m ? m[1] : null;
}

/** Class-selector count — the tiebreak this stylesheet lives or dies on. */
function classCount(selector: string): number {
  return (selector.match(/\.[a-zA-Z0-9_-]+/g) ?? []).length;
}

// ─── The navigation rule ────────────────────────────────────────────

describe("nextPvpMobileView — the phone's four surfaces are one at a time", () => {
  const live = (over = { forceSwitch: false, over: false }): PvpNavSignals =>
    ({ battleId: "b1", ...over });

  it("leaves the view alone when no battle is live", () => {
    expect(nextPvpMobileView("log", null, NO_PVP)).toBe("log");
    expect(nextPvpMobileView("chat", live(), NO_PVP)).toBe("chat");
  });

  it("opens a new battle on the console", () => {
    // Not the log, not whatever tab the last battle ended on.
    expect(nextPvpMobileView("log", null, live())).toBe("battle");
  });

  it("opens a REMATCH on the console too", () => {
    // A rematch replaces the room underneath the result dialog, so the only
    // signal that anything happened is the battle id.
    const prev: PvpNavSignals = { battleId: "b1", forceSwitch: false, over: true };
    const next: PvpNavSignals = { battleId: "b2", forceSwitch: false, over: false };
    expect(nextPvpMobileView("log", prev, next)).toBe("battle");
  });

  it("pulls the player to the console when a faint forces a switch", () => {
    // The battle cannot continue until they answer, and the AFK watchdog is
    // running. This is the single most expensive tab to be on the wrong one.
    const prev = live();
    const next = { battleId: "b1", forceSwitch: true, over: false };
    expect(nextPvpMobileView("team", prev, next)).toBe("battle");
  });

  it("does NOT hold them there — the override is edge-triggered", () => {
    // Checking the opponent's team while deciding who to send out is a
    // perfectly reasonable thing to do. A level-triggered rule would yank the
    // view back on every socket frame until they answered.
    const prev = { battleId: "b1", forceSwitch: true, over: false };
    const next = { battleId: "b1", forceSwitch: true, over: false };
    expect(nextPvpMobileView("team", prev, next)).toBe("team");
  });

  it("pulls the player to the console when the battle ends", () => {
    // The result dialog, the rematch and the only control that clears the room
    // all live on that tab.
    const prev = live();
    const next = { battleId: "b1", forceSwitch: false, over: true };
    expect(nextPvpMobileView("log", prev, next)).toBe("battle");
  });

  it("leaves a deliberate tab choice alone through a normal turn", () => {
    const prev = live();
    const next = live();
    for (const v of PVP_MOBILE_VIEWS) {
      expect(nextPvpMobileView(v, prev, next)).toBe(v);
    }
  });
});

// ─── The routing itself ─────────────────────────────────────────────

describe("MobileShell routes a live battle to the arena", () => {
  it("mounts the arena's own two mobile surfaces", () => {
    expect(shell).toMatch(/import \{[^}]*\bPvpMobileStage\b[^}]*\} from "\.\/PvpArena"/);
    expect(shell).toMatch(/import \{[^}]*\bPvpMobilePanel\b[^}]*\} from "\.\/PvpArena"/);
    expect(shell).toMatch(/<PvpMobileStage\s*\/>/);
    expect(shell).toMatch(/<PvpMobilePanel\s/);
  });

  it("gates on the pvp store, not on a local guess", () => {
    expect(shell).toMatch(/usePvpState\(\)/);
    expect(shell).toMatch(/const pvpLive = pvpRoom != null/);
  });

  it("derives the nav signals through the arena rather than re-reading the request", () => {
    // `forceSwitch` is a two-source expression (`request.forceSwitch[]` OR
    // `active[0].forceSwitch`). A second copy here is a second thing that can
    // disagree with the console about whether the player must act.
    expect(shell).toMatch(/pvpBattleSignals\(pvpRoom\)/);
    expect(shell).not.toMatch(/request\?\.forceSwitch/);
  });

  it("gives PvP its own bottom bar", () => {
    expect(shell).toMatch(/mobile-tabbar pvp-tabbar/);
    for (const label of ["battle", "team", "log", "chat"]) {
      expect(shell).toMatch(new RegExp(`id: "${label}"`));
    }
  });

  it("keeps every idle tab body OFF while a battle is live", () => {
    // Both bodies rendering at once would stack the idle PartyColumn (which
    // swaps itself for PvpRail) under the PvP panel in the same scroll area.
    for (const tab of ["party", "mart", "bag", "pc", "chat"]) {
      expect(shell).toMatch(new RegExp(`!pvpLive && tab === "${tab}"`));
    }
  });

  it("does NOT unmount the idle battle scene during a battle", () => {
    // BattleScene owns WhiteoutOverlay and HealOverlay, the only components
    // that can dispatch out of `phase: "healing"`. A PvP battle accepted while
    // a heal is playing would otherwise park the idle game there for the rest
    // of the session. It is hidden by CSS instead — asserted below.
    expect(shell).toMatch(/<BattleScene \/>/);
    expect(shell).not.toMatch(/!pvpLive && <BattleScene/);
    expect(shell).not.toMatch(/pvpLive \? <PvpMobileStage \/> : <BattleScene/);
  });
});

// ─── The two layout facts that were measured broken ─────────────────

describe("the move grid survives the mobile shell's own display:none", () => {
  // The arena's move grid reuses the idle game's `.moves-panel` class so a PvP
  // tile is visually the same object as an idle one. app.css hides that class
  // outright on every mobile tab but "world" — and a PvP shell has no
  // `tab-world` class, so on the first build of this layout all four tiles
  // measured 0×0: the one control the whole battle turns on was display:none.
  //
  // THE FIRST FIX WAS `display: grid !important` in pvpArena.css, because the
  // hider carries `!important` and per the cascade nothing else can beat one.
  // That worked and was the wrong shape: it left two !important rules pointed
  // at each other, so the only way to override either of them later is a third.
  // The exemption now lives on the hider — `:not(.pvp2-moves)` — and the PvP
  // grid is simply never hidden, which is why the assertions below are about
  // what pvpArena.css does NOT say.
  const HIDER = /\.mobile-shell:not\(\.tab-world\)\s+\.moves-panel:not\(\.pvp2-moves\)/;

  it("app.css exempts the PvP grid from its own hider", () => {
    expect(appCss).toMatch(HIDER);
    // …and the hider is still a hider for everything else, or the idle tabs
    // just got their moves panel back.
    expect(appCss).toMatch(
      /\.mobile-shell:not\(\.tab-world\)\s+\.moves-panel:not\(\.pvp2-moves\)\s*\{[^}]*display:\s*none\s*!important/,
    );
  });

  it("leans on .moves-panel's own display, so nothing has to declare it back", () => {
    // The base rule is `display: grid`. With the exemption in place that is
    // what a PvP tab computes, which is why pvpArena.css can say nothing at all
    // about the panel's display. Verified in a browser across all six idle
    // tabs at 390×760: `grid` on World, `none` on Party/Mart/Bag/PC/Chat.
    expect(appCss).toMatch(/(?:^|[{}])\s*\.moves-panel\s*\{[^}]*display:\s*grid/m);
    expect(arenaCss).not.toMatch(/\.pvp2-moves[^{]*\{[^}]*display:/);
  });

  it("adds no !important of its own", () => {
    // The lens constraint on this change, and the reason the fix moved. Note
    // `arenaCss` is comment-stripped, so the prose above (which quotes the
    // app.css rule verbatim, `!important` and all) cannot satisfy this.
    expect(arenaCss).not.toMatch(/!important/);
  });
});

describe("a forced switch fits the phone", () => {
  // MEASURED before the fix: console 374×1023 inside a 391px tab body — a 632px
  // scroll, six switch cards at 185×150 one per row. That is the one moment a
  // battle is blocked on the player, so a control below the fold there is a
  // lost match.
  //
  // The cause was a specificity collision the existing container query could
  // not win: it collapses `.pvp2-console-body` (ONE class) to a single column,
  // and `.pvp2-console.mode-forced .pvp2-console-body` (THREE) beats it at
  // every width.
  const NARROW = "@container pvp2console (max-width: 520px)";

  function containerBlock(): string {
    // Every `@container pvp2console (max-width: 520px)` block in the file,
    // concatenated — the fix deliberately adds a second one rather than editing
    // the shared block, so both must be considered.
    const parts: string[] = [];
    const head = NARROW.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`${head}\\s*\\{`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(arenaCss))) {
      let depth = 1;
      let i = m.index + m[0].length;
      const start = i;
      while (i < arenaCss.length && depth > 0) {
        if (arenaCss[i] === "{") depth++;
        else if (arenaCss[i] === "}") depth--;
        i++;
      }
      parts.push(arenaCss.slice(start, i - 1));
    }
    return parts.join("\n");
  }

  const narrow = containerBlock();

  it("has a narrow-console block at all", () => {
    expect(narrow.length).toBeGreaterThan(0);
  });

  it("collapses the FORCED body to one column too, at the forced rule's specificity", () => {
    const body = ruleBody(narrow, ".pvp2-console.mode-forced .pvp2-console-body");
    expect(body).not.toBeNull();
    expect(body!).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/);
  });

  it("gives the forced bench the same auto-fill shape the always-on bench uses", () => {
    const grid = ruleBody(narrow, ".pvp2-console.mode-forced .pvp2-switch-grid.as-wide");
    expect(grid).not.toBeNull();
    expect(grid!).toMatch(/grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(\d+px,\s*1fr\)\)/);
    // Capped rows. Uncapped, six cards at the desktop 150px floor is 930px of
    // grid in a 325px body.
    expect(grid!).toMatch(/grid-auto-rows:\s*minmax\(\d+px,\s*\d+px\)/);
  });
});

describe("touch targets and the surfaces that had to grow for a thumb", () => {
  it("hides the idle scene rather than unmounting it", () => {
    const body = ruleBody(arenaCss, ".mobile-arena.is-pvp > .battle-scene");
    expect(body).not.toBeNull();
    expect(body!).toMatch(/display:\s*none/);
  });

  it("floors forfeit at 40px on a phone while leaving desktop quiet", () => {
    // Forfeit is 24px tall on desktop and that is correct there — it is quiet
    // by weight and position. Quiet has to stop meaning SMALL once the pointer
    // is a thumb, so the mobile rule is scoped to `.mobile-shell` and the
    // desktop rule is deliberately left alone.
    const mobile = ruleBody(arenaCss, ".mobile-shell .pvp2-forfeit-btn");
    expect(mobile).not.toBeNull();
    expect(mobile!).toMatch(/min-height:\s*40px/);
    const base = ruleBody(arenaCss, ".pvp2-forfeit-btn");
    expect(base).not.toBeNull();
    expect(base!).not.toMatch(/min-height/);
  });

  it("floors both forfeit-confirm buttons at 40px", () => {
    const body = ruleBody(arenaCss, ".mobile-shell .pvp2-forfeit-confirm button");
    expect(body).not.toBeNull();
    expect(body!).toMatch(/min-height:\s*40px/);
  });

  it("stacks the result dialog's four actions on a phone", () => {
    // MEASURED: all four on one 378px row at 77px each, with "Find another
    // opponent" overflowing its own 40px box (scrollHeight 50). A dialog whose
    // buttons you cannot read is not reachable.
    const foot = ruleBody(arenaCss, ".g-modal.pvp2-result-dialog .pvp2-result-foot");
    expect(foot).not.toBeNull();
    expect(foot!).toMatch(/flex-direction:\s*column-reverse/);
  });

  it("does NOT declare a wrap rule that would reach desktop", () => {
    // This assertion is the INVERSE of the one it replaces, and the inversion
    // is the finding.
    //
    // `.pvp2-result-foot { flex-wrap: wrap-reverse }` had TIED with app.css's
    // `.g-modal-foot` and lost the source-order coin flip — it had never once
    // applied. Winning the tie with `.g-modal-foot.pvp2-result-foot` did not
    // fix a phone (the `column-reverse` block above owns the phone and
    // overrides any wrap), it only changed DESKTOP, where the dialog is a fixed
    // 520px at every viewport: the footer went from one 65px row to two rows
    // and 111px.
    //
    // MEASURED at 1280×800 and 1900×1000 on a completed battle with the rule
    // gone: one row, four buttons at 100/132/105/129px, every one of them
    // `scrollWidth === clientWidth` and `scrollHeight 38 <= clientHeight 38`.
    // Nothing compressed, nothing clipped — so the wrap bought nothing and cost
    // 46px of dialog nobody asked for.
    expect(arenaCss).not.toMatch(/flex-wrap:\s*wrap-reverse/);
    // The phone's own answer is still there and is still the stronger one.
    expect(arenaCss).toMatch(
      /\.g-modal\.pvp2-result-dialog\s+\.pvp2-result-foot\s*\{[^}]*flex-direction:\s*column-reverse/,
    );
  });

  it("gives the PvP bar four columns, not the idle bar's six", () => {
    const bar = ruleBody(arenaCss, ".mobile-shell .mobile-tabbar.pvp-tabbar");
    expect(bar).not.toBeNull();
    expect(bar!).toMatch(/grid-template-columns:\s*repeat\(4,\s*1fr\)/);
    expect(classCount(".mobile-shell .mobile-tabbar.pvp-tabbar"))
      .toBeGreaterThan(classCount(".mobile-tabbar"));
  });

  it("makes the opponent's name a control again, with a thumb-sized target", () => {
    // MEASURED before this: `getComputedStyle(.pvp2-name-link).pointerEvents`
    // was "none", inherited from `.trainer-tag` (which app.css declares
    // `pointer-events: none` so the idle battle's name plate cannot swallow
    // clicks aimed at the scene). `elementFromPoint` at the link's own centre
    // returned an unrelated element and a full pointer/mouse/click sequence
    // fired its handler ZERO times. It was the only dead control in the PvP
    // shell, on desktop as well as on a phone.
    const link = ruleBody(arenaCss, ".pvp2-name-link");
    expect(link).not.toBeNull();
    expect(link!).toMatch(/pointer-events:\s*auto/);
    // The parent must KEEP `none` — re-enabling the whole plate would give it
    // back the ability to eat taps meant for the scene.
    const tag = ruleBody(appCss, ".trainer-tag");
    expect(tag).not.toBeNull();
    expect(tag!).toMatch(/pointer-events:\s*none/);

    // The text run is 63×15 at 390px, so the HIT AREA is grown by a
    // pseudo-element rather than the box, which would shove the name plate into
    // the HP card above it. 15 + 13 + 13 = 41px, over the audit's 40px floor.
    // Verified in a browser: elementFromPoint resolves to the link at the text
    // centre AND at ±17px, and a tap dispatched at −17px fires its handler.
    const after = ruleBody(arenaCss, ".pvp2-name-link::after");
    expect(after).not.toBeNull();
    expect(after!).toMatch(/position:\s*absolute/);
    const inset = /top:\s*-(\d+)px[\s\S]*bottom:\s*-(\d+)px/.exec(after!);
    expect(inset).not.toBeNull();
    expect(15 + Number(inset![1]) + Number(inset![2])).toBeGreaterThanOrEqual(40);
    // A pseudo-element only hit-tests if its host does, so the two halves of
    // this fix are not independent — `position: relative` anchors it.
    expect(link!).toMatch(/position:\s*relative/);
  });
});

// ─── The two viewports that were unusable ───────────────────────────

describe("a short phone can still reach the whole forced switch", () => {
  // MEASURED at 360×640 with `forceSwitch: [true]`: console 383px inside a
  // 289px tab body, six 101×104 cards in two rows at y=447 and y=557 — the
  // second row ending at 661 in a 640-tall viewport. Three of six were
  // offscreen AND failed hit-testing. Recoverable by scrolling, but this is
  // the one moment the battle is blocked on the player with the clock running.
  //
  // After: six 104×74 cards, all six `inView` and hit-testable, console 288 in
  // a 289 body with `scrollHeight === clientHeight` — zero scroll — and a tap
  // on the last card emitted `battle:choose {"choice":"switch 6"}`.
  function shortBlock(): string {
    // Every `@media (max-height: 700px)` block, brace-matched.
    const parts: string[] = [];
    const re = /@media\s*\(max-height:\s*700px\)\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(arenaCss))) {
      let depth = 1;
      let i = m.index + m[0].length;
      const start = i;
      while (i < arenaCss.length && depth > 0) {
        if (arenaCss[i] === "{") depth++;
        else if (arenaCss[i] === "}") depth--;
        i++;
      }
      parts.push(arenaCss.slice(start, i - 1));
    }
    return parts.join("\n");
  }
  const short = shortBlock();

  it("has a short-viewport block at all", () => {
    expect(short.length).toBeGreaterThan(0);
    // The rule that was already there — the move tiles' cap — must survive.
    expect(ruleBody(short, ".mobile-shell .pvp2-moves")).toMatch(/grid-auto-rows:\s*minmax\(56px,\s*64px\)/);
  });

  it("caps the forced bench rows, above the card's own 68px thumb floor", () => {
    const grid = ruleBody(short, ".mobile-shell .pvp2-console.mode-forced .pvp2-switch-grid.as-wide");
    expect(grid).not.toBeNull();
    const cap = /grid-auto-rows:\s*minmax\((\d+)px,\s*(\d+)px\)/.exec(grid!);
    expect(cap).not.toBeNull();
    const [min, max] = [Number(cap![1]), Number(cap![2])];
    expect(min).toBeGreaterThanOrEqual(68);   // the declared thumb floor
    expect(max).toBeLessThan(104);            // the height that put a row off-screen
    expect(max).toBeGreaterThanOrEqual(min);
  });

  it("beats the container query's own forced-bench rule rather than tying with it", () => {
    // `@container pvp2console (max-width: 520px)` already sets
    // `.pvp2-console.mode-forced .pvp2-switch-grid.as-wide` (four classes) to
    // `minmax(68px, 104px)`. At-rules contribute nothing to specificity, so the
    // cap has to out-class it — hence the `.mobile-shell` prefix.
    expect(classCount(".mobile-shell .pvp2-console.mode-forced .pvp2-switch-grid.as-wide"))
      .toBeGreaterThan(classCount(".pvp2-console.mode-forced .pvp2-switch-grid.as-wide"));
  });

  it("drops the forced notice's restatement, not its headline", () => {
    // The `<span>` is the fourth place the same instruction appears on this
    // screen (console title, status strip, bench heading, message box), and it
    // is 45px of two wrapped lines. The `<strong>` stays, so nothing is
    // unexplained.
    expect(short).toMatch(/\.pvp2-forced-notice\s*>\s*span\s*\{\s*display:\s*none/);
    expect(short).not.toMatch(/\.pvp2-forced-notice\s*>\s*strong\s*\{\s*display:\s*none/);
  });
});

describe("landscape is two columns, because one column cannot work", () => {
  // MEASURED at 667×375 with a live battle, before this block: `.pvp2-scene`
  // 651×366 (16:9 off the VIEWPORT WIDTH), `.mobile-content` squeezed to 651×1,
  // `.mobile-tabbar` at y=440…496 — entirely below a 375px fold — with
  // `.mobile-shell` at `overflow: hidden` and the document not scrolling. Every
  // control below the scene was offscreen AND failed hit-testing: all four
  // tabs, forfeit, all four moves, all six bench cards. Same at 740×360 and
  // 844×390. PvP has a turn clock and a 5-minute AFK forfeit watchdog, so that
  // is a lost match rather than a degraded view.
  //
  // After, at 667×375: scene 286×161 (16:9 intact in a 44% track), content
  // 365×252 beside it, tab bar 651×56 fully in view, forfeit and all four moves
  // hit-testable, and in the FORCED-switch state all six bench cards
  // hit-testable without scrolling.
  function landscapeBlock(): string {
    const re = /@media\s*\(min-width:\s*(\d+)px\)\s*and\s*\(max-height:\s*(\d+)px\)\s*\{/g;
    const m = re.exec(arenaCss);
    if (!m) return "";
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < arenaCss.length && depth > 0) {
      if (arenaCss[i] === "{") depth++;
      else if (arenaCss[i] === "}") depth--;
      i++;
    }
    return arenaCss.slice(start, i - 1);
  }
  const land = landscapeBlock();

  it("is keyed on width AND height, not on `orientation`", () => {
    // A 320×480 phone is portrait but matches a bare `max-height`, and two
    // 160px columns is worse than one bad one. The min-width is the guard.
    const q = /@media\s*\(min-width:\s*(\d+)px\)\s*and\s*\(max-height:\s*(\d+)px\)/.exec(arenaCss);
    expect(q).not.toBeNull();
    expect(Number(q![1])).toBeGreaterThanOrEqual(600);
    expect(Number(q![2])).toBeLessThanOrEqual(560);
    // …and the band must actually contain the phones that were broken.
    expect(667).toBeGreaterThanOrEqual(Number(q![1]));
    expect(375).toBeLessThanOrEqual(Number(q![2]));
    expect(844).toBeGreaterThanOrEqual(Number(q![1]));
    expect(390).toBeLessThanOrEqual(Number(q![2]));
  });

  it("re-tracks the shell into two columns", () => {
    const shellRule = ruleBody(land, ".mobile-shell.pvp-live");
    expect(shellRule).not.toBeNull();
    expect(shellRule!).toMatch(/grid-template-columns:\s*minmax\(0,\s*\d+%\)\s+minmax\(0,\s*1fr\)/);
    expect(shellRule!).toMatch(/grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)\s+auto/);
    // Two classes, so it beats app.css's single-class `.mobile-shell`.
    expect(classCount(".mobile-shell.pvp-live")).toBeGreaterThan(classCount(".mobile-shell"));
  });

  it("places every child explicitly, so nothing depends on source order", () => {
    for (const [child, col] of [
      [".mobile-header", "1 / -1"],
      [".mobile-arena", "1"],
      [".mobile-content", "2"],
      [".mobile-tabbar", "1 / -1"],
    ] as const) {
      const body = ruleBody(land, `.mobile-shell.pvp-live > ${child}`);
      expect(body, `${child} is not placed`).not.toBeNull();
      expect(body!).toMatch(new RegExp(`grid-column:\\s*${col.replace(/\//g, "\\/")}`));
    }
  });

  it("lets the 1fr row actually cap the arena", () => {
    // A grid item's automatic minimum size is its CONTENT, which is exactly how
    // a 16:9 scene pushed the tab bar off the bottom. Without min-height:0 the
    // two-column layout would reproduce the bug it exists to fix.
    const arena = ruleBody(land, ".mobile-shell.pvp-live > .mobile-arena");
    expect(arena!).toMatch(/min-height:\s*0/);
    expect(arena!).toMatch(/overflow:\s*hidden/);
    const content = ruleBody(land, ".mobile-shell.pvp-live > .mobile-content");
    expect(content!).toMatch(/min-height:\s*0/);
  });

  it("is scoped to a live PvP battle and leaves the idle shell alone", () => {
    // The idle shell fails identically at these sizes and that is app-wide
    // pre-existing geometry, not something the arena introduced. Re-laying-out
    // six idle tabs is a product change with no failing consequence behind it;
    // PvP's turn clock is the consequence that makes this one urgent. Verified
    // in a browser: at 667×375 with no battle the idle shell still measures
    // `.mobile-content` at 1px, i.e. this block did not reach it.
    for (const line of land.split("\n")) {
      const sel = line.split("{")[0].trim();
      if (!sel || !sel.startsWith(".")) continue;
      expect(sel, `landscape rule not scoped to .pvp-live: ${sel}`).toContain(".pvp-live");
    }
  });
});
