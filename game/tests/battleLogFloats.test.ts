// "Effectiveness and '+XP' texts stop appearing shortly after opening or
// refreshing the page." (br_15040fe48311121a4a)
//
// pushLog caps battleLog at the last 50 lines. Three float layers —
// ExpGainFlash, EffectivenessFlash and BattleJuice — each used
// `battleLog.length` as a "what's new since last render" cursor, so once the
// cap was reached `length` was pinned at 50, `end <= start` was permanently
// true and all three early-returned for the rest of the session. Refreshing
// reset the log to one line, which is why it briefly came back and why the
// report reads like an animation bug.
//
// These tests drive real battles through the reducer and assert the property
// the floats actually need: every line pushed is visible to a consumer exactly
// once, before AND after the cap. `linesSince` is the only place that
// arithmetic lives now — three copies of it is how it came to be wrong in
// three components at once.

import { describe, expect, it } from "vitest";
import { reducer } from "../src/state/reducer";
import { linesSince } from "../src/utils/battleLogCursor";
import { createPokemon } from "../src/utils/pokemon";
import type { GameState } from "../src/types";
import { makeMon, makeState } from "./helpers";

const LOG_CAP = 50;

/** A consumer of the log, exactly as the float components use it: a cursor ref
 *  plus one linesSince call per state change. */
function makeFloat(state: GameState) {
  let seen = state.battleLogSeq;
  const received: string[] = [];
  let fires = 0;
  return {
    observe(s: GameState) {
      const fresh = linesSince(s.battleLog, s.battleLogSeq, seen);
      seen = s.battleLogSeq;
      if (fresh.length === 0) return;
      fires++;
      received.push(...fresh);
    },
    get received() { return received; },
    get fires() { return fires; },
  };
}

/** Run wild battles to completion, letting a float watch every dispatch. */
function grind(battles: number, onState?: (s: GameState) => void): GameState {
  const lead = makeMon({ id: "lead", level: 60, currentHp: 500, maxHp: 500, attack: 300 });
  let state = makeState({ party: [lead], playerPokemon: lead });
  onState?.(state);
  for (let i = 0; i < battles; i++) {
    const wild = createPokemon("pidgey", 3, 5000 + i);
    state = reducer(state, { type: "START_ENCOUNTER", payload: { pokemon: wild } });
    onState?.(state);
    let guard = 0;
    while (state.phase === "battle" && guard++ < 40) {
      state = reducer(state, { type: "EXECUTE_TURN" });
      onState?.(state);
      let drain = 0;
      while (state.pendingEvents.length > 0 && drain++ < 60) {
        state = reducer(state, { type: "CONSUME_EVENT" });
        onState?.(state);
      }
    }
  }
  return state;
}

describe("the cap that broke the cursor is still the cap", () => {
  it("trims battleLog to 50 lines but never trims the counter", () => {
    const state = grind(12);
    expect(state.battleLog.length).toBe(LOG_CAP);
    expect(state.battleLogSeq).toBeGreaterThan(LOG_CAP);
  });

  it("saturates after only a handful of battles — 'shortly after opening'", () => {
    // Measured, not assumed: this is what makes the report's timing right.
    let battles = 0;
    let state = makeState();
    while (state.battleLog.length < LOG_CAP && battles < 50) {
      battles++;
      state = grind(battles);
    }
    expect(state.battleLog.length).toBe(LOG_CAP);
    expect(battles).toBeLessThanOrEqual(12);
  });
});

describe("a float keeps firing after the log saturates", () => {
  it("delivers every line exactly once across 40 battles", () => {
    let float: ReturnType<typeof makeFloat> | null = null;
    let pushed = 0;
    let lastSeq = 0;
    const final = grind(40, (s) => {
      if (!float) float = makeFloat(s);
      float.observe(s);
      pushed += s.battleLogSeq - lastSeq;
      lastSeq = s.battleLogSeq;
    });
    expect(final.battleLog.length).toBe(LOG_CAP);
    expect(pushed).toBeGreaterThan(200);            // far past the cap
    // Every line pushed reached the consumer. Under the old length cursor this
    // stopped dead at 50 and the remaining ~200 lines were never seen.
    expect(float!.received).toHaveLength(pushed);
    expect(float!.fires).toBeGreaterThan(100);
  });

  it("sees +EXP and effectiveness lines in the LAST battle, not just the first", () => {
    const expLines: string[] = [];
    let float: ReturnType<typeof makeFloat> | null = null;
    let afterSaturation = 0;
    grind(30, (s) => {
      if (!float) float = makeFloat(s);
      const before = float.received.length;
      float.observe(s);
      const fresh = float.received.slice(before);
      for (const line of fresh) {
        if (/gained (\d+) EXP/.test(line)) {
          expLines.push(line);
          if (s.battleLog.length === LOG_CAP) afterSaturation++;
        }
      }
    });
    expect(expLines.length).toBeGreaterThan(20);
    // The whole bug: zero of these arrived once the log was full.
    expect(afterSaturation).toBeGreaterThan(15);
  });

  it("proves the OLD length cursor dies, so this test can never pass vacuously", () => {
    let prevLen = 0;
    let fires = 0;
    let firesAfterCap = 0;
    grind(30, (s) => {
      const end = s.battleLog.length;
      const start = prevLen;
      prevLen = end;
      if (end <= start) return;
      fires++;
      if (end === LOG_CAP && start === LOG_CAP) firesAfterCap++;
    });
    // It can only ever fire while `length` is still climbing to 50, so it is
    // bounded by the cap however many battles are played — and then it is over.
    expect(fires).toBeLessThan(LOG_CAP);
    expect(firesAfterCap).toBe(0);
  });
});

describe("linesSince edges", () => {
  it("returns nothing when the counter has not moved", () => {
    expect(linesSince(["a", "b"], 2, 2)).toEqual([]);
  });

  it("returns just the tail that is new", () => {
    expect(linesSince(["a", "b", "c"], 7, 5)).toEqual(["b", "c"]);
  });

  it("returns the whole window when more was pushed than the window keeps", () => {
    // A trainer battle can resolve many lines in a single dispatch; the trimmed
    // ones are gone, and reading off the front of the array is not an option.
    expect(linesSince(["c", "d"], 10, 2)).toEqual(["c", "d"]);
  });

  it("rescans rather than going silent if the counter ever moves BACKWARD", () => {
    // A mid-session LOAD_SAVE is the only thing that could do this. Silence
    // until the counter climbs back is the original bug, so the safe direction
    // is to re-read the window.
    expect(linesSince(["a", "b"], 1, 900)).toEqual(["a", "b"]);
  });
});

describe("LOAD_SAVE cannot strand the cursors", () => {
  it("never moves battleLogSeq backward, even when the blob has none", () => {
    const grown = grind(6);
    expect(grown.battleLogSeq).toBeGreaterThan(10);
    // A cloud reconcile: battleLogSeq is not persisted, so the incoming blob
    // carries 0. Letting that win would put every float's cursor in the future.
    const loaded = reducer(grown, {
      type: "LOAD_SAVE",
      payload: { state: { battleLog: ["Game loaded!"], battleLogSeq: 0, money: 42 } },
    });
    expect(loaded.money).toBe(42);
    expect(loaded.battleLogSeq).toBe(grown.battleLogSeq);

    // And a float carried over from before the load still sees the next line.
    const float = makeFloat(loaded);
    const after = reducer(loaded, { type: "START_ENCOUNTER", payload: { pokemon: createPokemon("rattata", 4, 6000) } });
    float.observe(after);
    expect(float.received).toEqual([expect.stringContaining("appeared")]);
  });
});
