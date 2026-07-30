// The narration pacer's four contract properties.
//
// The owner asked for a battle message box; the hard part was never the box, it
// was that PvP narration arrives in bursts. Measured on a live battle: ONE
// socket message carrying 19 protocol lines produced 13 narration lines in a
// SINGLE React commit, and in that same commit the board jumped two turns. A
// box that renders the newest line would have flickered through all thirteen in
// one frame.
//
// So the pacer has to hold four properties, and each one gets a test here
// rather than a comment:
//
//   1. it never falls so far behind that the box describes a turn the board has
//      moved past — bounded by LAG_BUDGET_MS;
//   2. it never blocks or delays the player's input — it has no input surface
//      at all, and every operation is synchronous and allocation-bounded;
//   3. it drains instead of stalling when the battle ends;
//   4. it survives a `battle:rejoin`, where a whole battle's log replaces the
//      array at once, WITHOUT animating 200 lines.
//
// Driven with a virtual clock rather than fake timers: the class takes `now` as
// an argument precisely so its behaviour can be asserted exactly, at any speed,
// including the "throttled background tab fires setTimeout once a second" case
// that a real timer cannot reproduce in a unit test.

import { describe, expect, it } from "vitest";
import {
  NarrationPacer,
  LAG_BUDGET_MS,
  MIN_HOLD_MS,
  MAX_QUEUE,
  holdForKind,
  MINOR_KINDS,
} from "../src/utils/pvpNarrationPacer";
import type { NarrationLine } from "../src/state/pvpBattleView";

function line(kind: NarrationLine["kind"], text = kind): NarrationLine {
  return { kind, text };
}

/** The exact 13-line shape the live battle produced from one chunk: two moves
 *  with modifiers, a faint, a replacement switch-in, weather, a boost and a
 *  turn boundary. */
function realisticBurst(): NarrationLine[] {
  return [
    line("move", "Your Espeon used Psychic!"),
    line("damage", "Foe's Tyranitar lost 41% HP."),
    line("move", "Foe's Tyranitar used Crunch!"),
    line("damage", "Your Espeon lost 70% HP."),
    line("boost", "Foe's Tyranitar's Sp. Def rose!"),
    line("turn", "Turn 6"),
    line("move", "Your Espeon used Shadow Ball!"),
    line("damage", "Foe's Tyranitar lost 38% HP."),
    line("faint", "Foe's Tyranitar fainted!"),
    line("switch", "Foe's Gengar came out!"),
    line("weather", "Sandstorm kicked up!"),
    line("damage", "Your Espeon was hurt by Sandstorm."),
    line("turn", "Turn 7"),
  ];
}

/** Drive the pacer to completion, collecting every beat the box showed. */
function playOut(pacer: NarrationPacer, startAt: number): { texts: string[]; endedAt: number } {
  const texts: string[] = [];
  if (pacer.current) texts.push(pacer.current.line.text);
  let now = startAt;
  for (let guard = 0; guard < 500; guard++) {
    const due = pacer.nextDueAt();
    if (due == null) break;
    now = Math.max(now, due);
    if (pacer.tick(now) && pacer.current) texts.push(pacer.current.line.text);
  }
  return { texts, endedAt: now };
}

describe("NarrationPacer — property 1: never falls behind the board", () => {
  it("keeps the whole 13-line live burst inside the lag budget", () => {
    const p = new NarrationPacer();
    p.observe(realisticBurst(), 0);
    // The box has adopted the first line and the rest is the backlog. That
    // backlog is what "how stale can the box be" means, and it must fit.
    expect(p.pending).toBeGreaterThan(0);
    expect(p.backlogMs()).toBeLessThanOrEqual(LAG_BUDGET_MS);
  });

  it("compresses rather than dropping when a burst still fits", () => {
    const p = new NarrationPacer();
    const burst = realisticBurst();
    p.observe(burst, 0);
    const { texts } = playOut(p, 0);
    // Every one of the 13 lines was shown — the pacer sped up, it did not skip.
    expect(texts).toEqual(burst.map((l) => l.text));
  });

  it("plays a whole burst out in about the budget, not the raw reading time", () => {
    const p = new NarrationPacer();
    const burst = realisticBurst();
    const raw = burst.reduce((a, l) => a + holdForKind(l.kind), 0);
    p.observe(burst, 0);
    const { endedAt } = playOut(p, 0);
    // Left unpaced, these 13 lines want ~8.6s of reading time. The board has
    // already moved two turns on, so that is exactly the staleness the budget
    // exists to prevent.
    expect(raw).toBeGreaterThan(6000);
    expect(endedAt).toBeLessThanOrEqual(LAG_BUDGET_MS + holdForKind("move"));
  });

  it("holds the backlog bound under sustained pressure, dropping minor lines first", () => {
    const p = new NarrationPacer();
    p.observe([line("turn", "Turn 1")], 0);
    // Ten turns' worth arriving without the box ever catching up.
    for (let i = 0; i < 10; i++) {
      p.observe(
        [line("turn", "Turn 1"), ...Array.from({ length: 10 }, (_, k) => line("damage", `d${i}-${k}`))],
        0,
      );
      expect(p.pending).toBeLessThanOrEqual(MAX_QUEUE);
      expect(p.backlogMs()).toBeLessThanOrEqual(LAG_BUDGET_MS);
    }
  });

  it("never drops a move, a faint, a switch or a verdict to make room", () => {
    const p = new NarrationPacer();
    const anchor = line("turn", "Turn 1");
    p.observe([anchor], 0);
    // An oversized APPEND (not a first render — that path is the rejoin
    // heuristic, tested under property 4). 54 lines against a 20-deep queue, so
    // 34 have to go: every one of them must come out of the bookkeeping.
    const flood: NarrationLine[] = [];
    for (let i = 0; i < 6; i++) {
      flood.push(line("move", `move-${i}`), line("faint", `faint-${i}`), line("switch", `switch-${i}`));
      for (let k = 0; k < 6; k++) flood.push(line("damage", `noise-${i}-${k}`));
    }
    p.observe([anchor, ...flood], 0);
    const { texts } = playOut(p, 0);
    const load = flood.filter((l) => !MINOR_KINDS.has(l.kind)).map((l) => l.text);
    expect(load).toHaveLength(18);
    for (const t of load) expect(texts).toContain(t);
  });

  it("a floor-length full queue still fits the budget — the bound is structural", () => {
    // MAX_QUEUE * MIN_HOLD_MS is deliberately under LAG_BUDGET_MS. If that ever
    // stops being true, backlogMs() can exceed the budget no matter what the
    // compression does, and this test is what says so.
    expect(MAX_QUEUE * MIN_HOLD_MS).toBeLessThanOrEqual(LAG_BUDGET_MS);
  });
});

describe("NarrationPacer — property 2: never blocks or delays input", () => {
  it("has no way to reach the player's choice — it only ever sees lines and a clock", () => {
    const p = new NarrationPacer();
    // Every member is a line-in, a clock-in or a read-out. There is deliberately
    // nothing request-shaped, choice-shaped or lock-shaped on the class, which is
    // the structural reason a drain cannot gate the move picker: the picker
    // renders from room.request and this cannot see it, let alone disable it.
    const surface = Object.getOwnPropertyNames(NarrationPacer.prototype);
    expect(surface.filter((n) => /request|choose|choice|move\b|disable|block|lock|await/i.test(n)))
      .toEqual([]);
    // And nothing here is async: no member can leave the caller waiting.
    expect(p.observe(realisticBurst(), 0)).toBeUndefined();
    expect(typeof p.tick(0)).toBe("boolean");
  });

  it("observe and tick are synchronous and bounded — no unbounded work on the render path", () => {
    const p = new NarrationPacer();
    // 400 lines in one commit (far past anything real) still terminates in
    // bounded work, because the queue is capped before anything is played.
    const huge = Array.from({ length: 400 }, (_, i) => line("damage", `d${i}`));
    p.observe(huge, 0);
    expect(p.pending).toBeLessThanOrEqual(MAX_QUEUE);
  });

  it("costs zero timers when there is nothing to say", () => {
    const p = new NarrationPacer();
    // Most of a battle is spent waiting for a choice. nextDueAt() === null is
    // what lets the owner arm no timer at all in that state.
    expect(p.nextDueAt()).toBeNull();
    p.observe([line("turn", "Turn 1")], 0);
    playOut(p, 0);
    expect(p.nextDueAt()).toBeNull();
  });

  it("settles to the newest line in one tick when a hidden tab wakes up minutes later", () => {
    const p = new NarrationPacer();
    p.observe(realisticBurst(), 0);
    // Browsers clamp a background tab's setTimeout to ~1s, and an alt-tabbed or
    // slept machine can be far worse. Everything queued is now a minute old, so
    // narrating it would describe a board the player has already seen move —
    // the pacer settles to the current line instead of replaying history.
    const settled = p.tick(60_000);
    expect(settled).toBe(true);
    expect(p.pending).toBe(0);
    expect(p.current?.line.text).toBe("Turn 7");
    expect(p.nextDueAt()).toBeNull();
  });

  it("only skips lines that are genuinely stale, judged on the LINE's age not the tick's", () => {
    const p = new NarrationPacer();
    // The anchor must be the SAME object across both observes, because that is
    // what a real append is (`[...room.narration, ...decoded.lines]` reuses the
    // previous lines) and it is how the pacer tells an append from a rebuild.
    const anchor = line("turn", "Turn 1");
    p.observe([anchor], 0);
    playOut(p, 0);
    // Fresh lines arriving 60s into a quiet battle are NOT stale, even though
    // the pacer's own clock has not moved for a minute. Distinguishing the two
    // by tick lateness alone gets exactly one of these two cases wrong.
    p.observe([anchor, line("move", "m1"), line("move", "m2")], 60_000);
    p.tick(60_000);
    expect(p.current?.line.text).toBe("m1");
    expect(p.pending).toBe(1);
  });

  it("REGRESSION: an idle gap is not lateness — a burst after a quiet spell is still paced", () => {
    // Reproduced on the live arena: the box sat on "Turn 1" for 42 seconds
    // waiting for the opponent, then a turn arrived and the box jumped STRAIGHT
    // to the last damage line. The move, its super-effective tag and its
    // animation were never committed to the DOM. Cause: beats advance from when
    // the previous one was DUE, and an idle pacer's due time was 42 seconds in
    // the past, so every beat counted as already-elapsed and the catch-up loop
    // drained the whole turn inside one synchronous tick.
    const p = new NarrationPacer();
    const anchor = line("turn", "Turn 1");
    p.observe([anchor], 0);
    playOut(p, 0);
    expect(p.current?.line.text).toBe("Turn 1");

    const idleFor = 42_000;
    p.observe(
      [anchor, line("move", "Your Espeon used Shadow Ball!"), line("damage", "Foe's Tyranitar lost 59% HP.")],
      idleFor,
    );
    // First tick after the gap must land on the MOVE, not skip past it.
    expect(p.tick(idleFor)).toBe(true);
    expect(p.current?.line.text).toBe("Your Espeon used Shadow Ball!");
    expect(p.current?.animate).toBe(true);
    expect(p.pending).toBe(1);

    // And the move keeps its full reading time from NOW, not a window that
    // expired 42 seconds ago.
    expect(p.nextDueAt()).toBeGreaterThanOrEqual(idleFor + holdForKind("move") - 1);
  });

  it("still absorbs timer jitter, so a slip does not accumulate into drift", () => {
    const p = new NarrationPacer();
    p.observe([line("turn", "T"), line("move", "m1"), line("move", "m2")], 0);
    const firstDue = p.nextDueAt()!;
    // A tick 40ms late — ordinary jitter — advances from the DUE time, so the
    // schedule does not slip by 40ms on every beat for the rest of the battle.
    p.tick(firstDue + 40);
    expect(p.nextDueAt()).toBeLessThanOrEqual(firstDue + holdForKind("move") + 1);
  });

  it("gives a beat its FULL hold when the tick was coarse rather than jittery", () => {
    // The live failure this pins: a background tab's timers land on ~1s
    // boundaries. If that counted as credited lateness, a 900ms move beat would
    // be adopted already-expired and the very next pop would replace it in the
    // same tick — the move, its tags and its animation never reaching the DOM.
    const p = new NarrationPacer();
    p.observe([line("turn", "T"), line("move", "m1"), line("damage", "d1")], 0);
    const due = p.nextDueAt()!;
    const coarse = due + 1000;
    p.tick(coarse);
    expect(p.current?.line.text).toBe("m1");
    expect(p.pending).toBe(1);
    expect(p.nextDueAt()).toBeGreaterThan(coarse);
  });
});

describe("NarrationPacer — property 3: drains, not stalls, when the battle ends", () => {
  it("hurry collapses the tail to the floor and reaches the verdict fast", () => {
    const p = new NarrationPacer();
    const burst = [
      ...realisticBurst(),
      line("faint", "Your Espeon fainted!"),
      line("win", "You wins!"),
    ];
    p.observe(burst, 0);
    p.hurry(0);
    const { texts, endedAt } = playOut(p, 0);
    expect(texts[texts.length - 1]).toBe("You wins!");
    // The whole tail plays out in well under a second — the box lands on the
    // result instead of narrating a finished battle for eight.
    expect(endedAt).toBeLessThan(1000);
  });

  it("hurry keeps the KO and the verdict — it drains, it does not skip to the end", () => {
    const p = new NarrationPacer();
    p.observe(
      [line("move", "m"), line("damage", "d"), line("faint", "Foe's Gengar fainted!"), line("win", "You wins!")],
      0,
    );
    p.hurry(0);
    const { texts } = playOut(p, 0);
    expect(texts).toContain("Foe's Gengar fainted!");
    expect(texts).toContain("You wins!");
    // The bookkeeping line is what gets sacrificed, not the story.
    expect(texts).not.toContain("d");
  });

  it("hurry is idempotent, so a re-render cannot re-trigger it", () => {
    const p = new NarrationPacer();
    p.observe(realisticBurst(), 0);
    expect(p.hurry(0)).toBe(true);
    expect(p.hurry(0)).toBe(false);
  });

  it("reset leaves nothing behind for the next battle to inherit", () => {
    const p = new NarrationPacer();
    p.observe(realisticBurst(), 0);
    p.reset();
    expect(p.current).toBeNull();
    expect(p.pending).toBe(0);
    expect(p.nextDueAt()).toBeNull();
    // And a brand-new battle's first line is treated as a first line, not as a
    // continuation of the one that just finished.
    p.observe([line("turn", "Turn 1")], 0);
    expect(p.current?.line.text).toBe("Turn 1");
    expect(p.current?.animate).toBe(true);
  });
});

describe("NarrationPacer — property 4: survives battle:rejoin", () => {
  it("adopts a rebuilt log silently instead of animating the whole battle", () => {
    const p = new NarrationPacer();
    // A normal battle, paced.
    const live = [line("turn", "Turn 1"), line("move", "Your Espeon used Psychic!")];
    p.observe(live, 0);
    playOut(p, 0);

    // battle:rejoin: state/pvp.ts rebuilds `narration` from the server's whole
    // side-filtered log via a FRESH applyChunk, so every object is new.
    const replayed: NarrationLine[] = Array.from({ length: 44 }, (_, i) => line("move", `replayed-${i}`));
    p.observe(replayed, 1000);

    expect(p.pending).toBe(0);
    expect(p.current?.line.text).toBe("replayed-43");
    // The critical bit: no effect may fire for an adopted line, or a rejoin
    // would replay 44 move animations at once.
    expect(p.current?.animate).toBe(false);
  });

  it("treats a first-render batch bigger than an opening turn as a replay", () => {
    const p = new NarrationPacer();
    // Rejoining into a room this component has never rendered: the whole log
    // arrives at once with no previous anchor to diff against.
    const log = Array.from({ length: 60 }, (_, i) => line("damage", `d${i}`));
    p.observe(log, 0);
    expect(p.current?.animate).toBe(false);
    expect(p.pending).toBe(0);
  });

  it("still animates a genuine opening chunk", () => {
    const p = new NarrationPacer();
    // A real battle's first chunk: two switch-ins and turn 1. Small, and it
    // must animate — this is the case a naive "big first batch = replay" rule
    // would silently break.
    p.observe(
      [
        line("switch", "Your Espeon is on the field!"),
        line("switch", "Foe's Tyranitar came out!"),
        line("turn", "Turn 1"),
      ],
      0,
    );
    expect(p.current?.animate).toBe(true);
    const { texts } = playOut(p, 0);
    expect(texts).toHaveLength(3);
  });

  it("keeps animating appends after the 300-line trim shifts the array", () => {
    // room.narration is `slice(-300)`, so once a battle passes 300 lines every
    // append also DROPS lines off the front. A length-based diff would read
    // that as a rebuild and silently stop animating for the rest of the match;
    // the identity search is what makes it keep working.
    const p = new NarrationPacer();
    const all: NarrationLine[] = Array.from({ length: 320 }, (_, i) => line("move", `m${i}`));
    let window = all.slice(0, 300);
    p.observe(window, 0);
    playOut(p, 0);
    expect(p.current?.line.text).toBe("m299");

    // Two more lines arrive; the window slides and m0/m1 fall off the front.
    window = all.slice(2, 302);
    p.observe(window, 5000);
    expect(p.pending + (p.current ? 1 : 0)).toBeGreaterThan(0);
    const { texts } = playOut(p, 5000);
    expect(texts).toContain("m301");
    expect(p.current?.animate).toBe(true);
  });

  it("re-seeds cleanly when a new battle resets narration to empty", () => {
    const p = new NarrationPacer();
    p.observe([line("win", "You wins!")], 0);
    playOut(p, 0);
    // battle:start for the rematch: a brand-new room with narration: [].
    p.observe([], 1000);
    expect(p.current).toBeNull();
    p.observe([line("switch", "Your Snorlax is on the field!")], 1000);
    expect(p.current?.line.text).toBe("Your Snorlax is on the field!");
    expect(p.current?.animate).toBe(true);
  });
});

describe("NarrationPacer — beat identity", () => {
  it("gives every beat a fresh seq so a repeated move replays its keyframes", () => {
    const p = new NarrationPacer();
    p.observe([line("move", "Your Espeon used Psychic!"), line("move", "Your Espeon used Psychic!")], 0);
    const first = p.current?.seq ?? 0;
    p.tick(10_000);
    expect(p.current?.seq).toBeGreaterThan(first);
    expect(p.current?.line.text).toBe("Your Espeon used Psychic!");
  });

  it("holds a move line longer than an HP line", () => {
    expect(holdForKind("move")).toBeGreaterThan(holdForKind("damage"));
    expect(holdForKind("faint")).toBeGreaterThan(holdForKind("damage"));
    expect(holdForKind("win")).toBeGreaterThanOrEqual(holdForKind("faint"));
  });
});
