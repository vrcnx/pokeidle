// Rematch plumbing.
//
// "Battle again" has to hand the server a real `Pokemon[]` from the save, but a
// finished room only holds the SIMULATOR's view of the team — idents and a
// details string. Getting that mapping wrong would silently start the next
// battle with the wrong team, which is worse than asking the player to pick
// again, so the resolver returns null rather than guessing and the caller falls
// back to the team builder.
//
// The two traps: LEVEL, because the random50 format caps the team at Lv 50
// server-side so a Lv 78 Snorlax arrives as "Snorlax, L50" and a level compare
// would reject every rated team; and DUPLICATES, because a party with three
// Rattata must resolve to three different Rattata.

import { describe, expect, it } from "vitest";
import { botTrainerIdFromLabel, resolveRematchTeam, rematchFormatFor } from "../src/utils/pvpRematch";
import { makeMon } from "./helpers";
import type { Pokemon } from "../src/types";

function roster(...entries: [string, string][]) {
  return entries.map(([ident, details]) => ({ ident, details }));
}

describe("recovering the bot trainer's id from its seat label", () => {
  it("derives the server's own trainer id from the label it sent", () => {
    // server/src/lib/pvpBotRoster.ts pairs { id: "bugcatcher", label: "Bug
    // Catcher AI" }, so the id is recoverable with the same id normalisation the
    // rest of the stack uses — no extra socket round trip to rematch the same AI.
    expect(botTrainerIdFromLabel("Bug Catcher AI")).toBe("bugcatcher");
    expect(botTrainerIdFromLabel("Youngster AI")).toBe("youngster");
    expect(botTrainerIdFromLabel("Ace Trainer AI")).toBe("acetrainer");
  });

  it("returns null for a human username, so a human is never sent down the bot path", () => {
    // A space is impossible in a real username (validateUsername allows only
    // [A-Za-z0-9_]), which is what makes the " AI" suffix unambiguous.
    expect(botTrainerIdFromLabel("Ghostface")).toBeNull();
    expect(botTrainerIdFromLabel("AI_Fan")).toBeNull();
    expect(botTrainerIdFromLabel("")).toBeNull();
  });

  it("returns null rather than an empty id for a degenerate label", () => {
    expect(botTrainerIdFromLabel(" AI")).toBeNull();
    expect(botTrainerIdFromLabel("!!! AI")).toBeNull();
  });
});

describe("resolving the simulator's roster back onto the save", () => {
  it("maps a whole team back, in battle order", () => {
    const espeon = makeMon({ speciesKey: "espeon", name: "Espeon", level: 78 });
    const snorlax = makeMon({ speciesKey: "snorlax", name: "Snorlax", level: 80 });
    const team = resolveRematchTeam(
      roster(["p1: Espeon", "Espeon, L50, F"], ["p1: Snorlax", "Snorlax, L50, M"]),
      [snorlax, espeon],
    );
    expect(team?.map((p) => p.id)).toEqual([espeon.id, snorlax.id]);
  });

  it("ignores the level entirely — the Lv 50 cap must not break a rated rematch", () => {
    // This is the trap. A ranked team is capped to L50 by the format, so the
    // details string never matches the save's real level.
    const mon = makeMon({ speciesKey: "dragonite", name: "Dragonite", level: 96 });
    const team = resolveRematchTeam(roster(["p1: Dragonite", "Dragonite, L50, M"]), [mon]);
    expect(team).toEqual([mon]);
  });

  it("keeps duplicates apart instead of resolving them all to the same Pokémon", () => {
    const a = makeMon({ speciesKey: "rattata", name: "Rattata" });
    const b = makeMon({ speciesKey: "rattata", name: "Rattata" });
    const c = makeMon({ speciesKey: "rattata", name: "Rattata" });
    const team = resolveRematchTeam(
      roster(
        ["p1: Rattata", "Rattata, L50, M"],
        ["p1: Rattata", "Rattata, L50, M"],
        ["p1: Rattata", "Rattata, L50, M"],
      ),
      [a, b, c],
    );
    expect(new Set(team?.map((p) => p.id)).size).toBe(3);
  });

  it("matches a nickname, and prefers the nicknamed mon over a same-species stranger", () => {
    const plain = makeMon({ speciesKey: "gengar", name: "Gengar" });
    const named = makeMon({ speciesKey: "gengar", name: "Gengar", nickname: "Spook" });
    const team = resolveRematchTeam(roster(["p1: Spook", "Gengar, L50, M"]), [plain, named]);
    expect(team).toEqual([named]);
  });

  it("falls back to species when the mon was renamed since the battle started", () => {
    const renamed = makeMon({ speciesKey: "gengar", name: "Gengar", nickname: "NewName" });
    const team = resolveRematchTeam(roster(["p1: Spook", "Gengar, L50, M"]), [renamed]);
    expect(team).toEqual([renamed]);
  });

  it("handles the species keys that break a naive slug — Mr. Mime, Nidoran-F, Farfetch'd", () => {
    const mons: Pokemon[] = [
      makeMon({ speciesKey: "mrmime", name: "Mr. Mime" }),
      makeMon({ speciesKey: "nidoranf", name: "Nidoran-F" }),
      makeMon({ speciesKey: "farfetchd", name: "Farfetch'd" }),
    ];
    const team = resolveRematchTeam(
      roster(
        ["p1: Mr. Mime", "Mr. Mime, L50, F"],
        ["p1: Nidoran-F", "Nidoran-F, L50, F"],
        ["p1: Farfetch'd", "Farfetch'd, L50, M"],
      ),
      mons,
    );
    expect(team?.map((p) => p.speciesKey)).toEqual(["mrmime", "nidoranf", "farfetchd"]);
  });

  it("returns null — never a partial team — when a Pokémon is no longer in the save", () => {
    // Released between battles. A four-of-five team would silently start a
    // different fight; the caller opens the team builder instead.
    const one = makeMon({ speciesKey: "espeon", name: "Espeon" });
    const team = resolveRematchTeam(
      roster(["p1: Espeon", "Espeon, L50, F"], ["p1: Snorlax", "Snorlax, L50, M"]),
      [one],
    );
    expect(team).toBeNull();
  });

  it("returns null for an empty roster rather than starting a battle with no team", () => {
    expect(resolveRematchTeam([], [makeMon()])).toBeNull();
  });

  it("returns null when the save is empty", () => {
    expect(resolveRematchTeam(roster(["p1: Espeon", "Espeon, L50, F"]), [])).toBeNull();
  });
});

describe("the format a rematch is sent in", () => {
  it("keeps a ranked rematch ranked", () => {
    expect(rematchFormatFor("random50")).toBe("random50");
  });

  it("falls back to anything-goes for every format battle:invite does not whitelist", () => {
    // The server whitelists exactly two formats on battle:invite — tournament
    // rooms are spawned by the bracket runner, never by a player — so a
    // tournament rematch has to become a friendly rather than be refused with
    // "bad target".
    expect(rematchFormatFor("anything-goes")).toBe("anything-goes");
    expect(rematchFormatFor("tournament")).toBe("anything-goes");
    expect(rematchFormatFor("bot")).toBe("anything-goes");
    expect(rematchFormatFor("")).toBe("anything-goes");
  });
});
