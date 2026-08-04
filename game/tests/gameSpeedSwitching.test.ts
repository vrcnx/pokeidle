// Two reports from pani about the game-speed control, which turned out to be
// one root cause and one omission:
//
//   1. "Changing game speed reloads the scene status text, and you can stall
//      the game by switching repeatedly."
//   2. "Attack animations aren't affected by game speed."
//
// (1) Four separate timers — the event driver, the three floating flashes, the
// move-effect layer and the battle loop itself — were armed inside effects that
// listed `state.speed` as a dependency. Every change tore the effect down and
// re-armed the timer from zero, so the window never elapsed while you kept
// clicking. Because nothing in the game advances while `pendingEvents` is
// draining, that is a real freeze and not just a cosmetic one. The status text
// was the visible symptom of the same thing: the typewriter's cursor was an
// effect-local `let`, so restarting the effect retyped the line from its first
// character.
//
// The fix is one shared idea — `remainingMs` — so these tests pin the property
// rather than the four call sites: a window is anchored to when it OPENED, so
// re-asking part-way through can only shorten it.
//
// (2) The unmount timer already scaled; the ~40 keyframe rules in app.css are
// hardcoded literals, so at ×5 an effect was TRUNCATED rather than sped up.
// `moveAnimRate` is the number that makes the stylesheet obey, and the point of
// the tests below is that it is derived from the same ladder as the lifetime.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  MOVE_ANIM_BASE_MS,
  eventDurationMs,
  flashMs,
  moveAnimMs,
  moveAnimRate,
  remainingMs,
  tickIntervalFor,
  typewriterCharMs,
} from "../src/utils/battleTiming";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (...p: string[]) => readFileSync(join(srcDir, ...p), "utf8");
/** Comments stripped: every one of these fixes is documented in prose that
 *  names the very identifiers being asserted about, so matching raw text would
 *  pass on the comment and tell us nothing about the code. */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const SPEEDS = [1, 2, 5];

describe("a window is anchored to when it opened", () => {
  it("shortens when re-asked part-way through, and never extends", () => {
    // The whole bug in one assertion. Opening at t=0 for 1000ms and re-asking
    // at t=400 must leave 600ms — not another full 1000.
    expect(remainingMs(0, 1000, 400)).toBe(600);
    expect(remainingMs(0, 1000, 900)).toBe(100);
  });

  it("clamps to zero rather than going negative", () => {
    // Switching to a FASTER speed mid-window can put the deadline in the past.
    // That has to mean "finish now", not a negative delay (which setTimeout
    // silently treats as 0 anyway, but only by accident).
    expect(remainingMs(0, 1000, 5000)).toBe(0);
  });

  it("makes repeated switching converge instead of restarting", () => {
    // Fifteen speed changes during one 1000ms event. Under the old code each
    // one re-armed a full window and the event never landed; here the deadline
    // is fixed by the stamp, so the remaining time only falls.
    const openedAt = 0;
    let last = Infinity;
    for (let now = 0; now <= 1100; now += 66) {
      const left = remainingMs(openedAt, 1000, now);
      expect(left).toBeLessThanOrEqual(last);
      last = left;
    }
    expect(last).toBe(0);
  });

  it("holds even when the total changes underneath it", () => {
    // The realistic case: the player switches ×1 → ×5 400ms into a damage
    // event. The total shrinks, so the event finishes SOONER than it would
    // have. It must never be pushed later than the ×1 deadline.
    const slow = eventDurationMs("damage", 24, 1);
    const fast = eventDurationMs("damage", 24, 5);
    expect(remainingMs(0, fast, 400)).toBeLessThan(remainingMs(0, slow, 400));
  });
});

describe("the ladders all key off the simulation tick", () => {
  // Stream chat can dispatch SET_SPEED with any number and the reducer stores
  // it as-is, so a bare `speed >= 5` ladder answers "×1" for a speed of 3 while
  // the loop is really ticking at 500ms.
  it("never produces a non-finite or non-positive duration", () => {
    for (const speed of [0, -3, 0.5, 3, 7, 1000, NaN, Infinity]) {
      for (const v of [flashMs(speed), moveAnimMs(speed), typewriterCharMs(speed)]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThan(0);
      }
      expect(eventDurationMs("attack", 30, speed)).toBeGreaterThanOrEqual(80);
      expect(moveAnimRate(speed)).toBeGreaterThan(0);
    }
  });

  it("treats an unknown fast speed like the fastest known one", () => {
    expect(flashMs(1000)).toBe(flashMs(5));
    expect(moveAnimMs(1000)).toBe(moveAnimMs(5));
    expect(typewriterCharMs(3)).toBe(typewriterCharMs(2));
  });

  it("is monotonic — faster is never slower", () => {
    expect(flashMs(1)).toBeGreaterThan(flashMs(2));
    expect(flashMs(2)).toBeGreaterThan(flashMs(5));
    expect(moveAnimMs(1)).toBeGreaterThan(moveAnimMs(2));
    expect(moveAnimMs(2)).toBeGreaterThan(moveAnimMs(5));
    expect(typewriterCharMs(1)).toBeGreaterThan(typewriterCharMs(5));
  });
});

describe("x1 is byte-for-byte the old behaviour", () => {
  // Nobody's normal-speed battle may look different because of this fix.
  it("keeps every inline ladder these functions replaced", () => {
    expect(flashMs(1)).toBe(1400);
    expect(flashMs(2)).toBe(1000);
    expect(flashMs(5)).toBe(700);
    expect(moveAnimMs(1)).toBe(600);
    expect(moveAnimMs(2)).toBe(420);
    expect(moveAnimMs(5)).toBe(280);
    expect(typewriterCharMs(1)).toBe(30);
    expect(typewriterCharMs(2)).toBe(16);
    expect(typewriterCharMs(5)).toBe(7);
  });

  it("reproduces the event driver's original arithmetic", () => {
    // ×1: 30ms/char + 200ms tail, +480 for damage, +600 for a faint.
    expect(eventDurationMs("attack", 20, 1)).toBe(20 * 30 + 200);
    expect(eventDurationMs("damage", 20, 1)).toBe(20 * 30 + 200 + 480);
    expect(eventDurationMs("recoil", 20, 1)).toBe(20 * 30 + 200 + 480);
    expect(eventDurationMs("faint", 20, 1)).toBe(20 * 30 + 200 + 600);
    expect(eventDurationMs("attack", 20, 5)).toBe(20 * 7 + 60);
  });

  it("still floors a very short line so nothing flickers past unread", () => {
    expect(eventDurationMs("attack", 0, 5)).toBe(80);
  });
});

describe("the move effect's keyframes obey the speed setting", () => {
  it("plays at exactly the rate its shortened lifetime needs", () => {
    // THE FIX. The stylesheet is authored at MOVE_ANIM_BASE_MS; the element is
    // removed after moveAnimMs. The rate is the ratio, so the same PROPORTION
    // of every archetype is seen at every speed — before this, ×5 showed the
    // first 47% of a 600ms Flamethrower and cut.
    for (const speed of SPEEDS) {
      expect(moveAnimMs(speed) * moveAnimRate(speed)).toBeCloseTo(MOVE_ANIM_BASE_MS);
    }
  });

  it("leaves x1 completely untouched", () => {
    // A rate of exactly 1 is what lets setCssAnimationRate short-circuit and
    // touch nothing at all at normal speed.
    expect(moveAnimRate(1)).toBe(1);
  });

  it("speeds up rather than slows down as the game gets faster", () => {
    expect(moveAnimRate(5)).toBeGreaterThan(moveAnimRate(2));
    expect(moveAnimRate(2)).toBeGreaterThan(moveAnimRate(1));
  });

  it("stays legible — it compresses far less than the tick does", () => {
    // Deliberate. Scaling the effect by the full 5× the simulation speeds up
    // would make it a 120ms flicker nobody can read, which is why the lifetime
    // ladder is gentler than battleSpeedScale and the rate follows it.
    const tickRatio = tickIntervalFor(1) / tickIntervalFor(5);   // 5
    expect(moveAnimRate(5)).toBeLessThan(tickRatio);
    expect(moveAnimRate(5)).toBeGreaterThan(1.5);
  });
});

describe("the effects that arm these timers do not restart on a speed change", () => {
  // Source-level, because the game suite is node-env with no DOM. Weaker than
  // rendering, but the regression is precisely "somebody adds state.speed back
  // to a dep list", and that IS visible in the source.

  it("keeps state.speed out of the battle loop's dependency array", () => {
    // Listing it cancelled the in-flight tick and armed a fresh full interval,
    // so the loop never reached a tick while the buttons were being clicked.
    // `schedule()` reads the live speed off stateRef, so the dep buys nothing.
    const src = stripComments(read("hooks", "useBattleLoop.ts"));
    const deps = /\},\s*\[([^\]]*)\]\s*\);/.exec(src);
    expect(deps, "could not find the effect's dependency array").toBeTruthy();
    expect(deps![1]).not.toMatch(/\bstate\.speed\b/);
    // ...and the things that genuinely DO gate scheduling are still listed.
    expect(deps![1]).toMatch(/\bstate\.paused\b/);
    expect(deps![1]).toMatch(/\bstate\.phase\b/);
    // The loop must still read the current speed when it arms its timer.
    expect(src).toMatch(/tickIntervalFor\(cur\.speed\)/);
  });

  it("schedules every speed-scaled timer through remainingMs", () => {
    // The three that keep state.speed in their deps — they have to, since the
    // window's length depends on it — must anchor to a stored start time.
    for (const file of [
      ["hooks", "useEventDriver.ts"],
      ["components", "BattleScene.tsx"],
      ["components", "MoveAnimation.tsx"],
    ]) {
      const src = stripComments(read(...file));
      expect(src, file.join("/")).toMatch(/remainingMs\(/);
    }
  });

  it("gives the typewriter a cursor that survives the effect restarting", () => {
    // An effect-local `let i` was the bug: changing speed re-ran the effect and
    // the line jumped back to its first character.
    const src = stripComments(read("components", "BattleScene.tsx"));
    const body = /function Typewriter\([\s\S]*?\n}/.exec(src);
    expect(body, "Typewriter no longer parses as a top-level function").toBeTruthy();
    expect(body![0]).toMatch(/useRef\(0\)/);
    expect(body![0]).not.toMatch(/\blet i\b/);
  });
});
