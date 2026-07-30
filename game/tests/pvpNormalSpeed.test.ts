// PvP runs at NORMAL SPEED, always — whatever the idle game's speed setting is.
//
// ─── The requirement, and why it needs a test rather than a comment ───────
//
// The idle game has a 1× / 2× / 5× speed setting and it is a grind control:
// `tickIntervalFor` turns it into the simulation tick, and every presentation
// timing in the idle battle is scaled against it — BattleScene's Typewriter
// (`charMs = speed >= 5 ? 7 : speed >= 2 ? 16 : 30`), MoveAnimation's auto-clear
// (`600 / 420 / 280`), BattleJuice's dwell, the trainer intro, all of it.
//
// PvP is not a grind. It is a competitive match against a person, with a turn
// clock running and a five-minute AFK forfeit watchdog, and it is READ AND
// REACTED TO. A player who cranked the idle game to 5× to farm levels must not
// discover that their ranked battle now flashes past — the setting they touched
// was about how fast their own farming loop ticks, and they never opted into a
// faster opponent.
//
// The arena satisfies this by CONSTRUCTION rather than by clamping: it never
// reads the speed setting at all. Its message pacing is `utils/pvpNarrationPacer
// .ts`, whose holds are absolute milliseconds; its move-effect layer is
// `MoveEffectVisual` driven by CSS keyframes and a fixed `animKey`; and neither
// it nor `PvpArena.tsx` imports `utils/battleTiming.ts` or touches
// `state.speed`.
//
// CONSTRUCTION IS EXACTLY WHAT A REFACTOR SILENTLY UNDOES. "The arena reuses the
// idle battle's message box" is already true (`.scene-status` is shared), so
// somebody reaching for the idle Typewriter, or hoisting the two speed ternaries
// into a shared hook "since both battle scenes need them", would recouple this
// in one plausible-looking commit and nothing would fail. Hence a ratchet.
//
// ─── Measured, in a browser, before this file was written ────────────────
//
// A real PvP battle driven through the client's own socket decoder at 1280×800,
// with the same narration burst replayed at each speed setting:
//
//   speed 1×  beats 9  dwells 200/479/321/136/457/272/457/271/361  total 2942ms
//   speed 2×  beats 9  dwells 200/480/320/136/464/264/464/263/361  total 2977ms
//   speed 5×  beats 9  dwells 200/480/319/129/464/272/456/272/360  total 2929ms
//
// and the move-effect layer's node lifetimes over the same burst:
//
//   1×  464 464 1409 1409 464 464
//   2×  464 464 1412 1412 464 464
//   5×  465 465 1408 1408 482 482
//
// i.e. identical beat for beat, inside timer jitter. The IDLE game over the same
// run still scaled exactly as before — typewriter dwell 30ms → 16ms → 8ms and
// MoveAnimation 607ms → 432ms at 1×/2×, against a 30/16/7 and 600/420 spec — so
// nothing was pinned that should not have been.
//
// The tests below are the parts of that a CI run can re-check: the arithmetic
// the idle game uses (so the two ternaries stay honest), the pacer's
// independence from any speed input (driven, not read), and a source ratchet
// over every module on the PvP presentation path.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  NarrationPacer,
  MIN_HOLD_MS,
  LAG_BUDGET_MS,
  holdForKind,
  paceHolds,
} from "../src/utils/pvpNarrationPacer";
import { battleSpeedScale, tickIntervalFor, trainerIntroMs } from "../src/utils/battleTiming";
import type { NarrationLine } from "../src/state/pvpBattleView";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (...p: string[]) => readFileSync(join(srcDir, ...p), "utf8");

/** Comments stripped, and it matters more here than anywhere: this whole file
 *  is about the word "speed", and the header above uses it forty times. A raw
 *  text match would pass on the prose of the very modules it is guarding. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const SPEEDS = [1, 2, 5] as const;

// ══ 1 · the idle game still scales, so nothing was over-pinned ════════════

describe("the idle game's speed setting still means something", () => {
  it("scales the simulation tick and every presentation timing derived from it", () => {
    expect(SPEEDS.map(tickIntervalFor)).toEqual([1000, 500, 200]);
    expect(SPEEDS.map(battleSpeedScale)).toEqual([1, 0.5, 0.2]);
    // Strictly monotonic, which is the property a player actually feels.
    const intros = SPEEDS.map(trainerIntroMs);
    expect(intros[0]).toBeGreaterThan(intros[1]);
    expect(intros[1]).toBeGreaterThan(intros[2]);
  });

  it("still drives the idle battle scene's own two speed ternaries", () => {
    // Asserted against the source because these are inline expressions with no
    // export to import. If either ever stops referencing `state.speed`, the
    // idle game silently stopped scaling — the opposite failure to the one this
    // file is mainly about, and just as much a regression.
    const scene = stripComments(read("components", "BattleScene.tsx"));
    expect(scene).toMatch(/charMs\s*=\s*state\.speed\s*>=\s*5\s*\?\s*7\s*:\s*state\.speed\s*>=\s*2\s*\?\s*16\s*:\s*30/);
    const anim = stripComments(read("components", "MoveAnimation.tsx"));
    expect(anim).toMatch(/speed\s*>=\s*5\s*\?\s*280\s*:\s*speed\s*>=\s*2\s*\?\s*420\s*:\s*600/);
  });
});

// ══ 2 · the pacer has no speed input to be scaled by ══════════════════════

describe("the PvP narration pacer paces in absolute milliseconds", () => {
  const line = (kind: NarrationLine["kind"], text = kind): NarrationLine => ({ kind, text });

  it("holds every line kind at a fixed duration with no scaling parameter", () => {
    // `holdForKind` is unary. A speed-scaled pacer would have to take a second
    // argument or read a module-level setting; this asserts it does neither, by
    // calling it and by its arity.
    expect(holdForKind.length).toBe(1);
    const kinds: NarrationLine["kind"][] = ["move", "damage", "faint", "turn", "info"];
    const once = kinds.map((k) => holdForKind(k));
    const twice = kinds.map((k) => holdForKind(k));
    expect(once).toEqual(twice);
    for (const ms of once) expect(ms).toBeGreaterThanOrEqual(MIN_HOLD_MS);
  });

  it("gives the same beat schedule no matter what the rest of the app is doing", () => {
    // Driven three times with an identical burst and an identical virtual
    // clock. The pacer takes `now` as an argument and holds no other time
    // source, so three runs must agree exactly — this is the assertion that
    // fails the moment somebody threads a speed multiplier through it.
    const burst = (): NarrationLine[] => [
      line("move", "Your Darkrai used Dark Pulse!"),
      line("damage", "Foe's Espeon lost 66% HP."),
      line("move", "Foe's Espeon used Psychic!"),
      line("damage", "Your Darkrai lost 60% HP."),
      line("info", "Your Darkrai was poisoned!"),
      line("turn", "Turn 2"),
    ];
    const runSchedule = () => {
      const p = new NarrationPacer();
      let t = 1_000_000;
      p.observe(burst(), t);
      const seen: string[] = [];
      // Step the virtual clock in 10ms units and record when each beat lands.
      for (let i = 0; i < 600; i++) {
        t += 10;
        if (p.tick(t)) seen.push(`${t - 1_000_000}:${p.current?.line?.text ?? ""}`);
      }
      return seen;
    };
    const a = runSchedule();
    const b = runSchedule();
    const c = runSchedule();
    expect(a.length).toBeGreaterThan(3);   // the run is not vacuous
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    // And the whole burst plays out inside the lag budget, at the ONE pace
    // there is — no faster variant exists to fall back to.
    const total = paceHolds(burst().map((l) => holdForKind(l.kind)), LAG_BUDGET_MS)
      .reduce((x, y) => x + y, 0);
    expect(total).toBeLessThanOrEqual(LAG_BUDGET_MS);
    expect(total).toBeGreaterThan(MIN_HOLD_MS * 2);
  });
});

// ══ 3 · the ratchet: nothing on the PvP path may read the speed setting ═══

describe("no module on the PvP presentation path reads the game speed", () => {
  /** Everything that renders or times the arena. If a file joins this path it
   *  belongs in this list; if it leaves, the positive control below still
   *  proves the check has teeth. */
  const PVP_PATH: readonly string[][] = [
    ["components", "PvpArena.tsx"],
    ["components", "MoveEffectVisual.tsx"],
    ["components", "PvpResultDialog.tsx"],
    ["utils", "pvpNarrationPacer.ts"],
    ["utils", "pvpMoveEffects.ts"],
    ["utils", "pvpNarrationText.ts"],
    ["state", "pvp.ts"],
    ["state", "pvpBattleView.ts"],
  ];

  it.each(PVP_PATH.map((p) => [p.join("/"), p] as const))(
    "%s never reads state.speed",
    (_name, parts) => {
      const src = stripComments(read(...parts));
      expect(src).not.toMatch(/\bstate\.speed\b/);
      expect(src).not.toMatch(/\bspeed\s*>=\s*\d/);
      expect(src).not.toMatch(/\bSET_SPEED\b/);
    },
  );

  it.each(PVP_PATH.map((p) => [p.join("/"), p] as const))(
    "%s never imports the idle game's speed-scaled timing module",
    (_name, parts) => {
      const src = stripComments(read(...parts));
      expect(src).not.toMatch(/from\s+["'][^"']*battleTiming["']/);
      expect(src).not.toMatch(/\bbattleSpeedScale\b|\btickIntervalFor\b|\btrainerIntroMs\b/);
    },
  );

  it("POSITIVE CONTROL: the idle path DOES read both, so the checks are not vacuous", () => {
    // If the two `it.each` blocks above passed because the patterns match
    // nothing anywhere, these would pass too — and they do not.
    const scene = stripComments(read("components", "BattleScene.tsx"));
    expect(scene).toMatch(/\bstate\.speed\b/);
    expect(scene).toMatch(/from\s+["'][^"']*battleTiming["']/);
    expect(scene).toMatch(/\btrainerIntroMs\b/);
    const loop = stripComments(read("hooks", "useBattleLoop.ts"));
    expect(loop).toMatch(/\btickIntervalFor\b/);
  });

  it("the arena's message box reuses the idle BOX but not the idle typewriter", () => {
    // `.scene-status` is deliberately shared — the PvP box IS the idle box, and
    // that reuse is what makes the arena look like the game. What must not
    // follow it across is BattleScene's `Typewriter`, whose per-character rate
    // is the single most speed-coupled thing in the app.
    const arena = stripComments(read("components", "PvpArena.tsx"));
    expect(arena).toMatch(/scene-status/);            // the box is reused…
    expect(arena).not.toMatch(/\bTypewriter\b/);      // …the typewriter is not
    expect(arena).toMatch(/NarrationPacer/);          // this is what paces it
  });
});
