// The bot's tournament DTOs.
//
// Three things are pinned here, in descending order of what they would cost in
// production:
//
//   1. NO USER IDS ESCAPE. The in-game bracket shows userIds to a logged-in
//      player; a Discord embed gets screenshotted into a public channel. The
//      tests assert ABSENCE, so a future edit that spreads a bracket slot or a
//      Prisma row into the DTO fails here rather than in a screenshot.
//   2. `yourMatch` PICKS THE RIGHT MATCH. It is the entire reason this surface
//      exists: rounds run asynchronously for up to 24h, so "who, and by when"
//      is the message. A live pairing must always beat a decided one, and an
//      eliminated player must still get the match that explains why.
//   3. A MALFORMED BRACKET DEGRADES. `bracket` is a JSON blob written by the
//      runner. The bot is a separate deploy, so a shape it cannot parse must
//      render a tournament with no pairing, never throw a 500 that Discord
//      shows as a red error box.

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  tournaments: [] as Record<string, unknown>[],
  one: null as Record<string, unknown> | null,
  /** Queued findMany results, consumed in call order. botTournamentsPending
   *  issues two (open, then completed); everything else issues one. */
  findManyQueue: [] as Record<string, unknown>[][],
  links: [] as Record<string, unknown>[],
  updateManyCalls: [] as { where: Record<string, unknown>; data: Record<string, unknown> }[],
  updateManyCount: 1,
};

vi.mock("../src/db.js", () => ({
  prisma: {
    tournament: {
      findMany: async () =>
        state.findManyQueue.length ? state.findManyQueue.shift()! : state.tournaments,
      findUnique: async () => state.one,
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        state.updateManyCalls.push(args);
        return { count: state.updateManyCount };
      },
    },
    discordLink: {
      findMany: async () => state.links,
    },
  },
}));

import {
  botTournamentDetail,
  botTournamentList,
  botTournamentsPending,
  markTournamentAnnounced,
  markTournamentReported,
} from "../src/lib/botTournaments.js";

const NOW = new Date("2026-08-01T00:00:00Z");
const DEADLINE = Date.UTC(2026, 7, 2, 12, 0, 0);

/** A row shaped like Prisma's, carrying fields that must never reach a DTO. */
function row(extra: Record<string, unknown> = {}) {
  return {
    id: "t1",
    name: "Summer Cup",
    format: "anything-goes",
    status: "live",
    levelCap: 50,
    startsAt: NOW,
    finishedAt: null,
    championId: null,
    championUsername: null,
    prizes: null,
    roundWindowMinutes: 1440,
    bracket: null,
    // Must NEVER surface: ownerId is an admin's User.id.
    ownerId: "admin-user-id",
    createdAt: NOW,
    entries: [
      { userId: "u1", username: "ash", eliminated: false, seed: 1 },
      { userId: "u2", username: "gary", eliminated: false, seed: 2 },
    ],
    ...extra,
  };
}

/** Two rounds: r0 decided, r1 live. Mirrors lib/bracket.ts's shape. */
function bracketJson(): string {
  return JSON.stringify({
    rounds: [
      {
        index: 0,
        matches: [
          {
            id: "r0.m0",
            a: { kind: "player", userId: "u1", username: "ash", seed: 1 },
            b: { kind: "player", userId: "u3", username: "misty", seed: 4 },
            winnerId: "u1",
            winBy: "battle",
            deadlineAt: DEADLINE - 86_400_000,
          },
        ],
      },
      {
        index: 1,
        matches: [
          {
            id: "r1.m0",
            a: { kind: "player", userId: "u1", username: "ash", seed: 1 },
            b: { kind: "player", userId: "u2", username: "gary", seed: 2 },
            winnerId: null,
            deadlineAt: DEADLINE,
          },
        ],
      },
    ],
  });
}

beforeEach(() => {
  state.tournaments = [];
  state.one = null;
  state.findManyQueue = [];
  state.links = [];
  state.updateManyCalls = [];
  state.updateManyCount = 1;
});

describe("no private data reaches the bot", () => {
  it("omits ownerId and every entrant userId", async () => {
    state.one = row({ bracket: bracketJson() });
    const t = await botTournamentDetail("t1", "u1");
    const json = JSON.stringify(t);

    expect(json).not.toContain("admin-user-id");
    expect(json).not.toContain("ownerId");
    // The viewer's own id is used to FIND their match and must not be echoed.
    expect(json).not.toContain("u1");
    expect(json).not.toContain("userId");
    // Usernames are public — they are already in the in-game bracket.
    expect(json).toContain("ash");
  });

  it("omits userIds from the list too", async () => {
    state.tournaments = [row()];
    const list = await botTournamentList("u1");
    expect(JSON.stringify(list)).not.toContain("userId");
  });
});

describe("yourMatch", () => {
  beforeEach(() => {
    state.one = row({ bracket: bracketJson() });
  });

  it("prefers the LIVE pairing over an already-decided one", async () => {
    const t = await botTournamentDetail("t1", "u1");
    // u1 appears in both rounds; round 2 is the one they can still act on.
    expect(t!.yourMatch).toMatchObject({
      roundNumber: 2,
      opponent: "gary",
      decided: false,
      youWon: null,
    });
  });

  it("carries the deadline as ISO so the bot can render a countdown", async () => {
    const t = await botTournamentDetail("t1", "u1");
    expect(t!.yourMatch!.deadlineAt).toBe(new Date(DEADLINE).toISOString());
  });

  it("gives an eliminated player the match that explains why", async () => {
    // misty lost in round 1 and appears nowhere else.
    const t = await botTournamentDetail("t1", "u3");
    expect(t!.yourMatch).toMatchObject({ roundNumber: 1, opponent: "ash", decided: true, youWon: false });
  });

  it("is null for someone who is not in the bracket at all", async () => {
    const t = await botTournamentDetail("t1", "nobody");
    expect(t!.yourMatch).toBeNull();
  });

  it("is null for an unlinked caller, and `you` is null rather than false", async () => {
    const t = await botTournamentDetail("t1", null);
    expect(t!.yourMatch).toBeNull();
    // null, not {entered:false} — the bot renders "run /link" rather than
    // telling a linked-looking user they are not entered.
    expect(t!.you).toBeNull();
  });

  it("reports a bye instead of inventing an opponent", async () => {
    state.one = row({
      bracket: JSON.stringify({
        rounds: [{
          index: 0,
          matches: [{
            id: "r0.m0",
            a: { kind: "player", userId: "u1", username: "ash", seed: 1 },
            b: { kind: "bye" },
            winnerId: null,
          }],
        }],
      }),
    });
    const t = await botTournamentDetail("t1", "u1");
    expect(t!.yourMatch).toMatchObject({ isBye: true, opponent: null });
  });

  it("surfaces the runner's walkover note verbatim", async () => {
    const note = "no-show: neither player online at the deadline — advanced higher seed";
    state.one = row({
      bracket: JSON.stringify({
        rounds: [{
          index: 0,
          matches: [{
            id: "r0.m0",
            a: { kind: "player", userId: "u1", username: "ash", seed: 1 },
            b: { kind: "player", userId: "u2", username: "gary", seed: 2 },
            winnerId: "u2",
            winBy: "walkover",
            note,
          }],
        }],
      }),
    });
    const t = await botTournamentDetail("t1", "u1");
    expect(t!.yourMatch!.note).toBe(note);
    expect(t!.yourMatch!.youWon).toBe(false);
  });

  it("does not name an opponent who is still a winnerOf placeholder", async () => {
    state.one = row({
      bracket: JSON.stringify({
        rounds: [{
          index: 0,
          matches: [{
            id: "r0.m0",
            a: { kind: "player", userId: "u1", username: "ash", seed: 1 },
            b: { kind: "winnerOf", matchId: "r0.m9" },
            winnerId: null,
          }],
        }],
      }),
    });
    const t = await botTournamentDetail("t1", "u1");
    expect(t!.yourMatch).toMatchObject({ opponent: null, isBye: false });
  });
});

describe("malformed brackets degrade rather than throw", () => {
  it.each([
    ["unparseable json", "{not json"],
    ["missing rounds", JSON.stringify({ nope: true })],
    ["rounds is not an array", JSON.stringify({ rounds: "nope" })],
    ["null bracket", null],
  ])("%s", async (_label, bracket) => {
    state.one = row({ bracket });
    const t = await botTournamentDetail("t1", "u1");
    expect(t).not.toBeNull();
    expect(t!.yourMatch).toBeNull();
    expect(t!.currentRound).toBeNull();
    // The tournament itself still renders — name, status and entrants survive.
    expect(t!.name).toBe("Summer Cup");
    expect(t!.entrants).toHaveLength(2);
  });
});

describe("list ordering and shape", () => {
  it("puts an OPEN tournament first — it is the only actionable row", async () => {
    state.tournaments = [
      row({ id: "done", status: "completed" }),
      row({ id: "running", status: "live" }),
      row({ id: "joinable", status: "open" }),
    ];
    const list = await botTournamentList(null);
    expect(list.map((t) => t.id)).toEqual(["joinable", "running", "done"]);
  });

  it("marks whether the caller is entered", async () => {
    state.tournaments = [row()];
    const [mine] = await botTournamentList("u1");
    expect(mine.you).toMatchObject({ entered: true, eliminated: false, seed: 1 });

    const [theirs] = await botTournamentList("stranger");
    expect(theirs.you).toMatchObject({ entered: false });
  });

  it("returns null prizeSummary rather than an empty string when unset", async () => {
    state.tournaments = [row({ prizes: null })];
    const [t] = await botTournamentList(null);
    expect(t.prizeSummary).toBeNull();
  });
});

describe("announce poll", () => {
  it("resolves the champion's Discord id so the result can ping them", async () => {
    state.findManyQueue = [
      [],
      [row({ id: "done", status: "completed", championId: "u1", championUsername: "ash", discordMessageId: "m1" })],
    ];
    state.links = [{ userId: "u1", discordId: "123456789" }];

    const { toReport } = await botTournamentsPending();
    expect(toReport[0]).toMatchObject({ championUsername: "ash", championDiscordId: "123456789" });
  });

  it("falls back to null when the champion never linked Discord", async () => {
    state.findManyQueue = [
      [],
      [row({ id: "done", status: "completed", championId: "u9", championUsername: "brock", discordMessageId: "m1" })],
    ];
    state.links = [];

    const { toReport } = await botTournamentsPending();
    // Null rather than a fabricated mention — the bot bolds the username.
    expect(toReport[0].championDiscordId).toBeNull();
    expect(toReport[0].championUsername).toBe("brock");
  });

  it("still exposes no userIds in the announce payloads", async () => {
    state.findManyQueue = [[row({ id: "open1", status: "open" })], []];
    const pending = await botTournamentsPending();
    const json = JSON.stringify(pending.toAnnounce);
    expect(json).not.toContain("userId");
    expect(json).not.toContain("admin-user-id");
  });

  it("claims the announcement under a NULL guard, so a racing instance loses", async () => {
    state.updateManyCount = 1;
    expect(await markTournamentAnnounced("t1", "msg1", "chan1")).toBe(true);
    expect(state.updateManyCalls[0].where).toMatchObject({ id: "t1", discordMessageId: null });
    expect(state.updateManyCalls[0].data).toMatchObject({
      discordMessageId: "msg1",
      discordChannelId: "chan1",
    });

    // Row already marked → 0 updated → the caller deletes its duplicate.
    state.updateManyCount = 0;
    expect(await markTournamentAnnounced("t1", "msg2", "chan1")).toBe(false);
  });

  it("guards the result marker the same way", async () => {
    state.updateManyCount = 1;
    expect(await markTournamentReported("t1")).toBe(true);
    expect(state.updateManyCalls[0].where).toMatchObject({ id: "t1", discordResultsAt: null });

    state.updateManyCount = 0;
    expect(await markTournamentReported("t1")).toBe(false);
  });
});

describe("detail", () => {
  it("returns null for an unknown id so the bot can say so", async () => {
    state.one = null;
    expect(await botTournamentDetail("nope", null)).toBeNull();
  });

  it("reports the current round 1-based, because Round 0 reads like a bug", async () => {
    state.one = row({ bracket: bracketJson() });
    const t = await botTournamentDetail("t1", "u1");
    expect(t!.currentRound).toBe(2);
    expect(t!.totalRounds).toBe(2);
  });

  it("sorts entrants by seed and keeps eliminated ones visible", async () => {
    state.one = row({
      entries: [
        { userId: "u2", username: "gary", eliminated: true, seed: 3 },
        { userId: "u1", username: "ash", eliminated: false, seed: 1 },
      ],
    });
    const t = await botTournamentDetail("t1", null);
    expect(t!.entrants.map((e) => e.username)).toEqual(["ash", "gary"]);
    expect(t!.entrants[1].eliminated).toBe(true);
  });
});
