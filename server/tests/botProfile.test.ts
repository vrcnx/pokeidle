// The bot's save-blob extractor.
//
// Two things are pinned here, and they are the two that would hurt in
// production:
//
//   1. NO PRIVATE FIELD ESCAPES. Every DTO is an explicit allowlist, and the
//      test asserts absence rather than presence — a future edit that spreads
//      a Prisma row into a response fails here rather than in a screenshot.
//   2. SHAPE DRIFT DEGRADES, IT DOES NOT THROW. The save blob's shape changes
//      with most patches and the bot is a separate deploy, so a party entry
//      missing half its fields must render as a partial embed, never as a 500
//      the bot shows as a red error box.

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  user: null as Record<string, unknown> | null,
  rating: null as Record<string, unknown> | null,
  ratingCount: 0,
  ratings: [] as Record<string, unknown>[],
  users: [] as Record<string, unknown>[],
};

vi.mock("../src/db.js", () => ({
  prisma: {
    user: {
      findFirst: async () => state.user,
      findMany: async () => state.users,
      findUnique: async () => state.user,
    },
    playerRating: {
      findUnique: async () => state.rating,
      findFirst: async () => state.rating,
      findMany: async () => state.ratings,
      count: async () => state.ratingCount,
    },
  },
}));

import { botDex, botIdentity, botLeaderboard, botMon, botParty } from "../src/lib/botProfile.js";

const NOW = new Date("2026-07-31T00:00:00Z");

function baseUser(extra: Record<string, unknown> = {}) {
  return {
    id: "u1",
    username: "ash",
    name: "Ash",
    accountLevel: 42,
    pokedexCaughtCount: 151,
    dailyStreak: 7,
    longestDailyStreak: 30,
    createdAt: NOW,
    lastSeenAt: NOW,
    // Fields that must NEVER reach a DTO. Present on the row on purpose: the
    // point of the test is that the extractor does not pass them through.
    email: "ash@example.com",
    isAdmin: true,
    banReason: "spamming",
    bannedUntil: null,
    saveData: null,
    ...extra,
  };
}

beforeEach(() => {
  state.user = null;
  state.rating = null;
  state.ratingCount = 0;
  state.ratings = [];
  state.users = [];
});

describe("botIdentity", () => {
  it("returns only public fields", async () => {
    state.user = baseUser();
    const dto = await botIdentity("u1");
    expect(dto).not.toBeNull();
    expect(dto!.username).toBe("ash");
    expect(dto!.accountLevel).toBe(42);
    // The allowlist assertion. Every one of these is on the source row.
    expect(dto).not.toHaveProperty("email");
    expect(dto).not.toHaveProperty("isAdmin");
    expect(dto).not.toHaveProperty("banReason");
    expect(dto).not.toHaveProperty("saveData");
    expect(JSON.stringify(dto)).not.toContain("ash@example.com");
  });

  it("reports an account with no rated matches as unranked, not as rating 1000", async () => {
    state.user = baseUser();
    state.rating = null;
    const dto = await botIdentity("u1");
    expect(dto!.rating.unranked).toBe(true);
    // No ladder position for an unranked player — printing "#1" for someone
    // who has never played would be worse than printing nothing.
    expect(dto!.rating.ladderPosition).toBeNull();
  });

  it("treats a PlayerRating row with 0 matches as unranked too", async () => {
    // The row can exist with matchesPlayed 0; the default 1000 in it is not a
    // result and must not be rendered as one.
    state.user = baseUser();
    state.rating = { rating: 1000, peakRating: 1000, matchesPlayed: 0, wins: 0, losses: 0, forfeits: 0 };
    const dto = await botIdentity("u1");
    expect(dto!.rating.unranked).toBe(true);
  });

  it("derives ladder position from a COUNT of higher ratings", async () => {
    state.user = baseUser();
    state.rating = { rating: 1400, peakRating: 1450, matchesPlayed: 12, wins: 8, losses: 4, forfeits: 0 };
    state.ratingCount = 3; // three players rated above
    const dto = await botIdentity("u1");
    expect(dto!.rating.ladderPosition).toBe(4);
    expect(dto!.rating.unranked).toBe(false);
  });

  it("returns null for an account the visibility filter excludes", async () => {
    state.user = null; // the banned/deleted case — findFirst matches nothing
    expect(await botIdentity("u1")).toBeNull();
  });
});

describe("botParty", () => {
  it("projects only the public per-Pokémon fields", async () => {
    state.user = baseUser({
      saveData: JSON.stringify({
        party: [
          {
            id: "p1", speciesKey: "pikachu", name: "Pikachu", nickname: "Sparky",
            level: 50, isShiny: true, nature: "Timid", heldItem: "lightball",
            moves: [{ id: "thunderbolt", pp: 15, maxPp: 15 }, { id: "quickattack", pp: 30, maxPp: 30 }],
            ivs: { hp: 31 }, evs: { speed: 252 }, currentHp: 100, maxHp: 120,
          },
        ],
      }),
    });
    const party = await botParty("u1");
    expect(party).toHaveLength(1);
    expect(party![0]).toEqual({
      slot: 1,
      speciesKey: "pikachu",
      name: "Pikachu",
      nickname: "Sparky",
      level: 50,
      isShiny: true,
      nature: "Timid",
      heldItem: "lightball",
      moves: ["thunderbolt", "quickattack"],
    });
    // IVs/EVs are build information and are NOT in the team projection — only
    // /mon exposes them, and only for yourself.
    expect(party![0]).not.toHaveProperty("ivs");
    expect(party![0]).not.toHaveProperty("evs");
  });

  it("degrades on shape drift instead of throwing", async () => {
    state.user = baseUser({
      saveData: JSON.stringify({
        party: [
          { speciesKey: "bulbasaur" },                 // almost nothing set
          { speciesKey: "ivysaur", moves: "not-array" }, // wrong type
          { level: 5 },                                 // no speciesKey at all
          null,
        ],
      }),
    });
    const party = await botParty("u1");
    // The two entries with a speciesKey survive; the other two are dropped
    // rather than rendering as `undefined` in a public embed.
    expect(party).toHaveLength(2);
    expect(party![0]).toMatchObject({ speciesKey: "bulbasaur", level: 1, moves: [], isShiny: false });
    expect(party![1].moves).toEqual([]);
  });

  it("returns null (not []) for an unreadable save so the bot can say 'hasn't started'", async () => {
    state.user = baseUser({ saveData: "{{{ not json" });
    expect(await botParty("u1")).toBeNull();
    state.user = baseUser({ saveData: null });
    expect(await botParty("u1")).toBeNull();
  });

  it("caps at six even if the blob somehow holds more", async () => {
    state.user = baseUser({
      saveData: JSON.stringify({
        party: Array.from({ length: 9 }, (_, i) => ({ speciesKey: `mon${i}`, level: 5 })),
      }),
    });
    expect(await botParty("u1")).toHaveLength(6);
  });
});

describe("botMon", () => {
  beforeEach(() => {
    state.user = baseUser({
      saveData: JSON.stringify({
        party: [{ speciesKey: "pikachu", name: "Pikachu", level: 50, ivs: { hp: 31, speed: 30 }, evs: { speed: 252 }, maxHp: 120, speed: 110 }],
      }),
    });
  });

  it("includes IVs and EVs", async () => {
    const mon = await botMon("u1", 1);
    expect(mon!.ivs).toEqual({ hp: 31, speed: 30 });
    expect(mon!.evs).toEqual({ speed: 252 });
    expect(mon!.maxHp).toBe(120);
  });

  it("returns null for an out-of-range slot rather than throwing", async () => {
    expect(await botMon("u1", 0)).toBeNull();
    expect(await botMon("u1", 2)).toBeNull();
    expect(await botMon("u1", 99)).toBeNull();
  });

  it("drops non-numeric stat values instead of emitting NaN", async () => {
    state.user = baseUser({
      saveData: JSON.stringify({ party: [{ speciesKey: "x", ivs: { hp: "31", speed: 30 } }] }),
    });
    const mon = await botMon("u1", 1);
    expect(mon!.ivs).toEqual({ speed: 30 });
  });
});

describe("botDex", () => {
  it("uses the column for caught and the blob for the rest", async () => {
    state.user = baseUser({
      saveData: JSON.stringify({ pokedexSeen: ["a", "b", "c"], shinyCaught: ["a"] }),
    });
    const d = await botDex("u1");
    expect(d).toMatchObject({ caughtCount: 151, seenCount: 3, shinyCaughtCount: 1 });
    // No denominator: the server has no species table, so a completion
    // percentage would be invented and would silently go wrong the next time
    // a region is added.
    expect(d!.totalSpecies).toBeNull();
  });

  it("reports null rather than 0 for blob-derived counts when the save is unreadable", async () => {
    state.user = baseUser({ saveData: null });
    const d = await botDex("u1");
    expect(d!.caughtCount).toBe(151); // the column is still authoritative
    expect(d!.seenCount).toBeNull();  // 0 would read as "has seen nothing"
    expect(d!.shinyCaughtCount).toBeNull();
  });
});

describe("botLeaderboard", () => {
  it("drops rows whose account is not visible and renumbers the ranks", async () => {
    state.ratings = [
      { userId: "u1", rating: 1500, peakRating: 1500, matchesPlayed: 10, wins: 8, losses: 2 },
      { userId: "banned", rating: 1400, peakRating: 1400, matchesPlayed: 9, wins: 5, losses: 4 },
      { userId: "u3", rating: 1300, peakRating: 1300, matchesPlayed: 8, wins: 4, losses: 4 },
    ];
    // "banned" is absent from the user query — the visibility filter excluded it.
    state.users = [
      { id: "u1", username: "ash", name: null, accountLevel: 40 },
      { id: "u3", username: "misty", name: null, accountLevel: 30 },
    ];
    const rows = await botLeaderboard(10);
    expect(rows.map((r) => r.username)).toEqual(["ash", "misty"]);
    // Ranks are re-derived AFTER the filter so the list still reads 1..N
    // rather than 1, 3.
    expect(rows.map((r) => r.rank)).toEqual([1, 2]);
  });

  it("returns an empty board rather than throwing when nobody qualifies", async () => {
    state.ratings = [];
    expect(await botLeaderboard(10)).toEqual([]);
  });
});
