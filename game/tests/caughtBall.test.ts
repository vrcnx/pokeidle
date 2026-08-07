// Which ball caught a Pokemon.
//
// Two things worth pinning, and they pull in opposite directions:
//
//   * the ball is RECORDED, on both catch paths. There are two — the instant
//     one and the animated one — and they hold the ball id in different
//     places, so this is exactly the kind of field that gets stamped on one
//     and forgotten on the other. The reducer has drifted that way before,
//     which is why both go through applyCatchSuccess.
//
//   * the ball is never INVENTED. Everything caught before this field existed
//     has none, and so does everything that was never caught — a starter, a
//     gift, a trade, a prize. Those display as a Poké Ball, and the display
//     is the ONLY place that default lives. Nothing writes it into a save,
//     because that would turn "we do not know" into "we know it was a Poké
//     Ball" permanently, and someone who spent a Master Ball on a legendary
//     last month would be reading a record that contradicts them.

import { describe, expect, it } from "vitest";
import { reducer } from "../src/state/reducer";
import { caughtBallOf } from "../src/utils/pokemon";
import { makeMon, battleState } from "./helpers";
import type { GameState } from "../src/types";

const wild = (over: Partial<GameState> = {}): GameState =>
  battleState(
    makeMon({ speciesKey: "pidgey", name: "Pidgey", level: 5, currentHp: 1, maxHp: 20 }),
    { inventory: { pokeball: 5, ultraball: 5, masterball: 2 }, nextPokemonId: 100, ...over },
  );

/** Every Pokemon the player owns after a catch — party first, then box. */
const owned = (s: GameState) => [...s.party, ...s.box];

describe("the ball is recorded on both catch paths", () => {
  it("stamps the ball on the instant path", () => {
    // A Master Ball never fails, so this catches without depending on a roll.
    const after = reducer(wild(), { type: "CATCH_POKEMON", payload: { ballId: "masterball" } });
    const caught = owned(after).find((p) => p.speciesKey === "pidgey");
    expect(caught?.caughtBall).toBe("masterball");
  });

  it("stamps the ball on the animated path, which clears its own record first", () => {
    // TRY_CATCH parks the ball on `catchAnim` and CATCH_RESOLVE nulls that
    // before applying the result — so the resolve step has to read it BEFORE
    // clearing. If it ever stops doing that this test sees "pokeball".
    const thrown = reducer(wild(), { type: "TRY_CATCH", payload: { ballId: "masterball" } });
    expect(thrown.catchAnim?.ballId).toBe("masterball");
    const after = reducer(thrown, { type: "CATCH_RESOLVE" });
    const caught = owned(after).find((p) => p.speciesKey === "pidgey");
    expect(caught?.caughtBall).toBe("masterball");
  });

  it("records the ball actually thrown, not a default", () => {
    const after = reducer(wild(), { type: "CATCH_POKEMON", payload: { ballId: "ultraball" } });
    const caught = owned(after).find((p) => p.speciesKey === "pidgey");
    // The failure this guards is a stamp hardcoded to "pokeball", which would
    // pass both tests above if they only used Master Balls.
    expect(caught?.caughtBall).toBe("ultraball");
    expect(caught?.caughtBall).not.toBe("pokeball");
  });
});

describe("a Pokemon with no ball recorded", () => {
  it("displays as a Poké Ball", () => {
    expect(caughtBallOf({})).toBe("pokeball");
    expect(caughtBallOf({ caughtBall: undefined })).toBe("pokeball");
  });

  it("keeps its own ball when it has one", () => {
    expect(caughtBallOf({ caughtBall: "ultraball" })).toBe("ultraball");
  });

  it("is not rewritten by being displayed", () => {
    // The whole point of resolving on read. If this ever fails, a migration
    // has been added and the save no longer distinguishes a recorded ball
    // from a guessed one.
    const mon = makeMon({ speciesKey: "eevee" });
    delete (mon as { caughtBall?: string }).caughtBall;
    caughtBallOf(mon);
    expect("caughtBall" in mon).toBe(false);
  });
});
