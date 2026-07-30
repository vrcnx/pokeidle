// What the standing rail control says, and when.
//
// The fixtures are built from the real production timeline (13 Giveaway rows,
// read read-only): a four-giveaway burst published in one minute, entry counts
// of 9-33, winnerCount up to 12, four rows with endsAt === null, and a 38-hour
// stretch right now with nothing running at all. Those are the shapes the row
// has to survive, so those are the shapes tested.

import { describe, expect, it } from "vitest";
import type { GiveawayStats, PublicGiveaway } from "../src/net/api";
import {
  railState,
  relativeTime,
  countdown,
  shortCountdown,
  isLiveNow,
  WIN_BANNER_MS,
} from "../src/utils/giveawayRail";

const NOW = Date.parse("2026-07-29T12:00:00.000Z");
const H = 3_600_000;
const D = 86_400_000;

function gw(over: Partial<PublicGiveaway> = {}): PublicGiveaway {
  return {
    id: "g1",
    title: "Master Ball Drop",
    description: "One Master Ball each.",
    status: "open",
    createdAt: new Date(NOW - 2 * H).toISOString(),
    startsAt: null,
    endsAt: new Date(NOW + 6 * H).toISOString(),
    drawnAt: null,
    winnerCount: 10,
    minAccountLevel: null,
    prizes: [{ kind: "item", itemId: "masterball", quantity: 1 }],
    prizeSummary: "1x masterball",
    entryCount: 26,
    hasEntered: false,
    youWon: false,
    youWonDelivered: null,
    winners: [],
    drawSeed: null,
    ...over,
  };
}

function drawn(over: Partial<PublicGiveaway> = {}): PublicGiveaway {
  return gw({
    status: "drawn",
    endsAt: new Date(NOW - 3 * H).toISOString(),
    drawnAt: new Date(NOW - 3 * H).toISOString(),
    winners: ["koruem", "naill"],
    drawSeed: "3f9a1c0e5b7d2846",
    ...over,
  });
}

const stats: GiveawayStats = {
  total: 12,
  prizesAwarded: 68,
  distinctWinners: 39,
  firstAt: "2026-07-17T11:37:33.170Z",
  you: { entered: 8, won: 2 },
};

const call = (giveaways: PublicGiveaway[] | null, over: Partial<Parameters<typeof railState>[0]> = {}) =>
  railState({ giveaways, stats, now: NOW, ...over });

describe("railState — the row is always there", () => {
  it("renders a loading state rather than nothing before the first fetch", () => {
    const st = call(null);
    expect(st.kind).toBe("loading");
    expect(st.pulse).toBe(false);
  });

  // The regression. giveawayStore's catch branch deliberately keeps whatever
  // snapshot it already had, so a client whose FIRST fetch fails — signed out,
  // offline, server restarting — keeps `giveaways: null` with an error beside
  // it. That used to land on "loading", i.e. a row reading "Giveaways /
  // Checking…" for the rest of the session, on the one control whose whole
  // purpose is to never look broken.
  it("says so when the first fetch failed, instead of 'Checking…' forever", () => {
    const st = call(null, { error: "Failed to fetch" });
    expect(st.kind).toBe("offline");
    expect(st.kind).not.toBe("loading");
    // Quiet, not alarming: nothing is wrong with the game, one request failed.
    expect(st.tone).toBe("quiet");
    expect(st.pulse).toBe(false);
    // Nothing to open on — there is no data behind it.
    expect(st.targetId).toBeNull();
    expect(st.primary).toBeNull();
  });

  it("still shows 'loading' while the first fetch is genuinely in flight", () => {
    // No error yet = still trying. The distinction is the whole point.
    expect(call(null, { error: null }).kind).toBe("loading");
    expect(call(null, { error: undefined }).kind).toBe("loading");
    expect(call(null, {}).kind).toBe("loading");
  });

  it("a flaky poll on top of good data keeps showing the data, not an error", () => {
    // The store only clears `giveaways` on success, so an error alongside a
    // populated list means "the last refresh failed" — the rail must keep
    // reporting the giveaway it already knows about.
    const st = call([gw()], { error: "NetworkError" });
    expect(st.kind).toBe("live-unentered");
    expect(st.liveCount).toBe(1);
  });

  it("stays present and quiet through a dry spell", () => {
    // Production is in one right now: 38.8 hours since the last draw, with the
    // next giveaway still an unpublished draft. Nothing running is a REAL,
    // recurring state and the control must not vanish for it.
    const st = call([drawn({ drawnAt: new Date(NOW - 38.8 * H).toISOString() })]);
    expect(st.kind).toBe("idle");
    expect(st.tone).toBe("quiet");
    expect(st.pulse).toBe(false);
    // …and it still has something to say: this has happened 12 times.
    expect(st.totalHeld).toBe(12);
    expect(st.lastTitle).toBe("Master Ball Drop");
  });

  it("survives an account that has never seen a giveaway at all", () => {
    const st = railState({ giveaways: [], stats: null, now: NOW });
    expect(st.kind).toBe("idle");
    expect(st.totalHeld).toBe(0);
    expect(st.lastTitle).toBeNull();
  });

  it("ignores drafts and cancelled rows — the server never sends them", () => {
    // Belt and braces: production is holding an unpublished draft right now.
    const st = call([drawn()]);
    expect(st.kind).toBe("idle");
  });
});

describe("railState — live and entered state", () => {
  it("asks for an entry when something is live and unentered", () => {
    const st = call([gw()]);
    expect(st.kind).toBe("live-unentered");
    expect(st.tone).toBe("urgent");
    expect(st.pulse).toBe(true);
    expect(st.liveCount).toBe(1);
    expect(st.unenteredCount).toBe(1);
    expect(st.targetId).toBe("g1");
    expect(st.endsInMs).toBe(6 * H);
  });

  it("goes calm — and stops pulsing — once the player is in", () => {
    const st = call([gw({ hasEntered: true })]);
    expect(st.kind).toBe("live-entered");
    expect(st.tone).toBe("calm");
    expect(st.pulse).toBe(false);
  });

  it("reports mixed when some of the burst are entered and some are not", () => {
    // The 07-27 burst: four giveaways created inside one minute.
    const burst = [
      gw({ id: "a", hasEntered: true,  endsAt: new Date(NOW + 6 * H).toISOString() }),
      gw({ id: "b", hasEntered: true,  endsAt: new Date(NOW + 10 * H).toISOString() }),
      gw({ id: "c", hasEntered: false, endsAt: new Date(NOW + 14 * H).toISOString() }),
      gw({ id: "d", hasEntered: true,  endsAt: new Date(NOW + 21 * H).toISOString() }),
    ];
    const st = call(burst);
    expect(st.kind).toBe("live-mixed");
    expect(st.liveCount).toBe(4);
    expect(st.unenteredCount).toBe(1);
    // …and it points the dialog at the one there is something to do about.
    expect(st.targetId).toBe("c");
  });

  it("reports live-unentered, not mixed, when none of them are entered", () => {
    const st = call([gw({ id: "a" }), gw({ id: "b" })]);
    expect(st.kind).toBe("live-unentered");
    expect(st.unenteredCount).toBe(2);
  });

  it("is calm when every live giveaway is entered, however many there are", () => {
    const st = call([gw({ id: "a", hasEntered: true }), gw({ id: "b", hasEntered: true })]);
    expect(st.kind).toBe("live-entered");
    expect(st.liveCount).toBe(2);
    expect(st.unenteredCount).toBe(0);
  });
});

describe("railState — which giveaway leads", () => {
  it("prefers the unentered one even when an entered one closes sooner", () => {
    const st = call([
      gw({ id: "soon", hasEntered: true, endsAt: new Date(NOW + 1 * H).toISOString() }),
      gw({ id: "later", hasEntered: false, endsAt: new Date(NOW + 20 * H).toISOString() }),
    ]);
    expect(st.targetId).toBe("later");
  });

  it("among equals, leads with the one that closes first", () => {
    const st = call([
      gw({ id: "late", endsAt: new Date(NOW + 20 * H).toISOString() }),
      gw({ id: "early", endsAt: new Date(NOW + 2 * H).toISOString() }),
    ]);
    expect(st.targetId).toBe("early");
    expect(st.endsInMs).toBe(2 * H);
  });

  it("does not let an open-ended giveaway outrank one that is about to close", () => {
    // Four production rows have endsAt === null ("open until the operator
    // draws"). A null deadline is not an early one.
    const st = call([
      gw({ id: "forever", endsAt: null }),
      gw({ id: "closing", endsAt: new Date(NOW + 10 * 60_000).toISOString() }),
    ]);
    expect(st.targetId).toBe("closing");
  });

  it("carries a null deadline through as null rather than as zero", () => {
    const st = call([gw({ endsAt: null })]);
    expect(st.endsInMs).toBeNull();
    expect(st.kind).toBe("live-unentered");
  });
});

describe("railState — a win leads, briefly", () => {
  const win = drawn({ id: "w", youWon: true, drawnAt: new Date(NOW - 2 * H).toISOString() });

  it("outranks a live giveaway", () => {
    const st = call([gw(), win]);
    expect(st.kind).toBe("won");
    expect(st.tone).toBe("won");
    expect(st.targetId).toBe("w");
    expect(st.pulse).toBe(true);
  });

  it("stops pulsing once the player has opened the dialog on it", () => {
    const st = call([win], { seenWins: new Set(["w"]) });
    expect(st.kind).toBe("won");
    expect(st.pulse).toBe(false);
  });

  it("expires on its own so it cannot become permanent chrome", () => {
    const stale = drawn({
      id: "w",
      youWon: true,
      drawnAt: new Date(NOW - WIN_BANNER_MS - 60_000).toISOString(),
    });
    expect(call([stale]).kind).toBe("idle");
    expect(call([stale, gw()]).kind).toBe("live-unentered");
  });

  it("holds right up to the 48h edge", () => {
    const edge = drawn({ id: "w", youWon: true, drawnAt: new Date(NOW - WIN_BANNER_MS + 1000).toISOString() });
    expect(call([edge]).kind).toBe("won");
  });

  it("ignores a win with no draw timestamp", () => {
    const st = call([drawn({ youWon: true, drawnAt: null, status: "closed" })]);
    expect(st.kind).toBe("idle");
  });

  it("leads with the most recent win when there is more than one", () => {
    // 39 distinct winners hold 68 wins; repeat winners are the norm, not the
    // exception (one name has five).
    const st = call([
      drawn({ id: "old", youWon: true, drawnAt: new Date(NOW - 40 * H).toISOString() }),
      drawn({ id: "new", youWon: true, drawnAt: new Date(NOW - 1 * H).toISOString() }),
    ]);
    expect(st.targetId).toBe("new");
  });
});

describe("isLiveNow — agrees with the server's isEnterable", () => {
  it("is false before startsAt", () => {
    expect(isLiveNow(gw({ startsAt: new Date(NOW + H).toISOString() }), NOW)).toBe(false);
  });

  it("is false at and after endsAt", () => {
    expect(isLiveNow(gw({ endsAt: new Date(NOW).toISOString() }), NOW)).toBe(false);
    expect(isLiveNow(gw({ endsAt: new Date(NOW - 1).toISOString() }), NOW)).toBe(false);
  });

  it("is true with no schedule at all", () => {
    expect(isLiveNow(gw({ startsAt: null, endsAt: null }), NOW)).toBe(true);
  });

  it("is false for anything not status open", () => {
    expect(isLiveNow(gw({ status: "closed" }), NOW)).toBe(false);
    expect(isLiveNow(gw({ status: "drawn" }), NOW)).toBe(false);
  });

  it("treats a passed deadline as not live even before the sweep draws it", () => {
    // The auto-draw sweep runs on a 15s timer, so status stays "open" for a
    // few seconds past endsAt. Offering an entry the server would refuse is
    // worse than showing the idle row for fifteen seconds.
    const st = call([gw({ endsAt: new Date(NOW - 5000).toISOString() })]);
    expect(st.kind).toBe("idle");
  });
});

describe("relativeTime — history needs a date it can read", () => {
  it("collapses the first minute", () => {
    expect(relativeTime(NOW - 30_000, NOW)).toEqual({ unit: "now", value: 0 });
    expect(relativeTime(NOW, NOW)).toEqual({ unit: "now", value: 0 });
  });

  it("counts minutes, then hours, then days", () => {
    expect(relativeTime(NOW - 90_000, NOW)).toEqual({ unit: "min", value: 1 });
    expect(relativeTime(NOW - 59 * 60_000, NOW)).toEqual({ unit: "min", value: 59 });
    expect(relativeTime(NOW - 2 * H, NOW)).toEqual({ unit: "hour", value: 2 });
    expect(relativeTime(NOW - 23 * H, NOW)).toEqual({ unit: "hour", value: 23 });
    expect(relativeTime(NOW - 3 * D, NOW)).toEqual({ unit: "day", value: 3 });
    expect(relativeTime(NOW - 6.9 * D, NOW)).toEqual({ unit: "day", value: 6 });
  });

  it("hands back to an absolute date past a week", () => {
    // The oldest production giveaway is 17 July; "12d ago" says less than
    // "17 Jul" once the archive is a fortnight deep.
    const then = NOW - 12 * D;
    expect(relativeTime(then, NOW)).toEqual({ unit: "date", value: then });
  });

  it("does not go negative on a clock that is slightly behind the server", () => {
    expect(relativeTime(NOW + 5_000, NOW)).toEqual({ unit: "now", value: 0 });
  });
});

describe("countdown / shortCountdown", () => {
  it("splits a deadline into d/h/m/s", () => {
    expect(countdown(2 * D + 3 * H + 4 * 60_000 + 5000)).toMatchObject({ d: 2, h: 3, m: 4, s: 5 });
  });

  it("flags the last hour as urgent", () => {
    expect(countdown(59 * 60_000).urgent).toBe(true);
    expect(countdown(61 * 60_000).urgent).toBe(false);
  });

  it("reports ended at and past zero", () => {
    expect(countdown(0).ended).toBe(true);
    expect(countdown(-1).ended).toBe(true);
    expect(shortCountdown(-1)).toBe("");
  });

  it("shows one useful unit pair, not four", () => {
    expect(shortCountdown(2 * D + 3 * H)).toBe("2d 3h");
    expect(shortCountdown(3 * H + 4 * 60_000)).toBe("3h 4m");
    expect(shortCountdown(4 * 60_000)).toBe("4m");
    expect(shortCountdown(9_000)).toBe("9s");
  });
});
