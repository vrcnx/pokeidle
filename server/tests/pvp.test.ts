// PvP regression tests.
//
// The bugs pinned here were all found by EXECUTION, not review:
//   * `startsWith("|tie")` matched `|tier|[Gen 5] Custom Game` from the
//     preamble of every battle → every match "tied" the instant it began.
//   * camelCase ids (`mrMime`, `shadowBall`) handed straight to @pkmn/sim →
//     "(Unknown Pokémon)" and a crash on `>start` — PvP silently dead.
//
// DB + socket stubbing: pvp.ts imports ./db.js (prisma) and its error path
// imports ../socket.js indirectly — vi.mock below replaces both, so no test
// here can construct a PrismaClient or open a socket. The @pkmn/sim battle
// in the integration test runs entirely in-process.

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({
  prisma: {
    pvpMatch: { create: vi.fn(() => Promise.resolve({})) },
    $executeRaw: vi.fn(() => Promise.resolve(1)),
  },
}));

import {
  battleEndFromLine,
  pokemonToShowdownSet,
  adaptTeamForSimulator,
  startBattle,
  endBattle,
  battleRooms,
  type BattleRoom,
} from "../src/pvp.js";
import { answerTeamPreview, passTeamPreview } from "./support/teamPreview.js";

describe("battleEndFromLine — the |tie / |tier| parse", () => {
  it("does NOT treat the |tier| preamble line as a tie", () => {
    // Showdown emits this six lines into EVERY battle, before turn 1.
    expect(battleEndFromLine("|tier|[Gen 5] Custom Game")).toBeNull();
  });

  it("recognises the real argumentless tie line exactly", () => {
    expect(battleEndFromLine("|tie")).toBe("tie");
  });

  it("recognises a |tie| line with a trailing pipe/argument", () => {
    expect(battleEndFromLine("|tie|")).toBe("tie");
  });

  it("recognises a win line and extracts nothing else as an end", () => {
    expect(battleEndFromLine("|win|Alice")).toBe("win");
    expect(battleEndFromLine("|turn|1")).toBeNull();
    expect(battleEndFromLine("|winner")).toBeNull();
    expect(battleEndFromLine("|tiebreak-ish|x")).toBeNull();
    expect(battleEndFromLine("")).toBeNull();
  });
});

describe("pokemonToShowdownSet — camelCase ids", () => {
  it("normalises camelCase species / move / item ids to showdown ids", () => {
    const set = pokemonToShowdownSet({
      speciesKey: "mrMime",
      level: 50,
      heldItem: "master-ball",
      ability: "compoundEyes",
      moves: [{ id: "shadowBall" }, { id: "thunderShock" }],
    });
    expect(set.species).toBe("mrmime");
    expect(set.item).toBe("masterball");
    expect(set.ability).toBe("compoundeyes");
    expect(set.moves).toEqual(["shadowball", "thundershock"]);
  });

  it("maps game stat names to showdown abbreviations and defaults IVs to 31", () => {
    const set = pokemonToShowdownSet({
      speciesKey: "pikachu",
      level: 42,
      evs: { hp: 4, attack: 252, defense: 0, spAttack: 0, spDefense: 0, speed: 252 },
      moves: [{ id: "voltTackle" }],
    });
    expect(set.evs).toEqual({ hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 });
    expect(set.ivs).toEqual({ hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 });
    expect(set.level).toBe(42);
  });

  it("falls back to Tackle for an empty moveset", () => {
    const set = pokemonToShowdownSet({ speciesKey: "snorlax", level: 30 });
    expect(set.moves).toEqual(["tackle"]);
  });
});

describe("adaptTeamForSimulator — degrade, never refuse", () => {
  it("drops unknown species, clears unknown ability/item, drops unknown moves", () => {
    const { sets, notes } = adaptTeamForSimulator([
      { speciesKey: "totallyFakeMon", level: 20 },
      {
        speciesKey: "pikachu",
        level: 20,
        ability: "notARealAbility",
        heldItem: "notARealItem",
        moves: [{ id: "thunderShock" }, { id: "fakeMove9000" }],
      },
    ]);
    expect(sets).toHaveLength(1);
    expect(sets[0].species).toBe("pikachu");
    expect(sets[0].ability).toBe("");
    expect(sets[0].item).toBe("");
    expect(sets[0].moves).toEqual(["thundershock"]);
    expect(notes.length).toBeGreaterThanOrEqual(4);
  });

  it("gives a mon whose whole moveset was unknown a Tackle so it is never Struggle-locked", () => {
    const { sets } = adaptTeamForSimulator([
      { speciesKey: "pikachu", level: 20, moves: [{ id: "fakeMove9000" }] },
    ]);
    expect(sets[0].moves).toEqual(["tackle"]);
  });
});

// ── Integration: a real @pkmn/sim battle survives its own preamble ─────
// This is the execution test the hand-built harness had to invent: start a
// real simulator battle and prove the |tier| line in the preamble does not
// end it. No DB, no sockets — sendToUser is a collector.

function makeRoom(): BattleRoom {
  const team = (name: string) => [
    {
      speciesKey: "pikachu",
      name,
      level: 50,
      moves: [{ id: "thunderShock" }],
    },
  ];
  return {
    id: "b_test1",
    status: "invited",
    format: "anything-goes",
    createdAt: Date.now(),
    lastChoiceAt: Date.now(),
    a: { userId: "uA", username: "Alice", team: team("Pika-A"), stream: null, request: null, connected: true },
    b: { userId: "uB", username: "Bob", team: team("Pika-B"), stream: null, request: null, connected: true },
    log: [],
    stream: null,
    expiryTimer: null,
    spectators: new Set(),
  };
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("startBattle (real simulator)", () => {
  it("emits the |tier| preamble without ending the battle as a tie", async () => {
    const room = makeRoom();
    battleRooms.set(room.id, room);
    const events: { userId: string; event: string; payload: unknown }[] = [];
    const sendToUser = (userId: string, event: string, payload: unknown) =>
      void events.push({ userId, event, payload });
    const onReady = vi.fn();

    await startBattle(null as never, room, sendToUser, onReady);
    expect(onReady).toHaveBeenCalledTimes(1);

    // Turn 1 is now on the far side of Team Preview: the first |request| both
    // sides get is `{"teamPreview":true}`, and nothing reaches |turn|1 until
    // both have answered it. Production answers with the picker or, after
    // twenty seconds, with the auto-lock; a driver answers it here.
    await passTeamPreview(room);

    // Wait until the omniscient log has drained the preamble AND both
    // players have received their first |request| (turn 1 is live).
    await waitFor(() =>
      room.log.some((l) => l.startsWith("|tier|"))
      && room.log.some((l) => l.startsWith("|turn|1"))
    );

    // THE regression: the preamble includes a |tier| line...
    expect(room.log.some((l) => l.startsWith("|tier|"))).toBe(true);
    // ...and the battle must still be alive after it.
    expect(room.status).toBe("active");
    expect(room.endReason).toBeUndefined();
    expect(events.some((e) => e.event === "battle:complete")).toBe(false);
    // Both players got their private state stream.
    expect(events.some((e) => e.userId === "uA" && e.event === "battle:state")).toBe(true);
    expect(events.some((e) => e.userId === "uB" && e.event === "battle:state")).toBe(true);

    // Clean up: tear the room down so no interval outlives the test.
    await endBattle(room, undefined, "cancelled");
    battleRooms.delete(room.id);
  });

  it("refuses (throws) when one side has no simulator-recognisable Pokémon", async () => {
    const room = makeRoom();
    room.id = "b_test2";
    room.b.team = [{ speciesKey: "notARealSpecies", level: 50 }];
    battleRooms.set(room.id, room);
    await expect(
      startBattle(null as never, room, () => undefined),
    ).rejects.toThrow(/no Pokémon the battle simulator recognises/);
    battleRooms.delete(room.id);
  });
});
