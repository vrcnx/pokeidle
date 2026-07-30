// What a player is allowed to see about a giveaway.
//
// These assert over the OBJECT shapePublicGiveaway returns, not over route
// source. A grep for a `where` clause rots the moment someone refactors the
// query; a projection test keeps holding. The rules being pinned:
//
//   * an entrant who lost never appears — no username, no id, no count of
//     "entered but didn't win";
//   * no user id of any kind ever leaves, including the viewer's own;
//   * winners and the draw seed appear only AFTER drawnAt (publishing the
//     seed early would let an entrant compute the outcome);
//   * `draft` and `cancelled` are operator state and are not public at all —
//     production is holding an unpublished draft right now;
//   * the viewer's delivery state is their own and nobody else's.
//
// Fixtures are the real production rows, verbatim (13 Giveaway rows read
// read-only from prod: 12 drawn, 1 draft, entry counts 9-33, winnerCount up
// to 12, prize shapes single-item / multi-item / pokemon).

import { describe, expect, it } from "vitest";
import {
  shapePublicGiveaway,
  PUBLIC_GIVEAWAY_STATUSES,
  type GiveawayRowForView,
} from "../src/lib/giveaway.js";

const ME = "user_me";
const THEM = "user_them";

function row(over: Partial<GiveawayRowForView> = {}): GiveawayRowForView {
  return {
    id: "gw1",
    title: "Master Ball Drop",
    description: "One Master Ball each for ten trainers.",
    status: "drawn",
    createdAt: new Date("2026-07-24T23:37:32.285Z"),
    startsAt: null,
    endsAt: null,
    drawnAt: new Date("2026-07-25T20:02:14.359Z"),
    winnerCount: 10,
    minAccountLevel: null,
    prizes: '[{"kind":"item","itemId":"masterball","quantity":1}]',
    drawSeed: "3f9a1c0e5b7d2846",
    entries: [],
    _count: { entries: 26 },
    ...over,
  };
}

/** Every string that appears anywhere in the projection, at any depth. */
function allStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) allStrings(x, out);
  else if (v && typeof v === "object" && !(v instanceof Date))
    for (const x of Object.values(v)) allStrings(x, out);
  return out;
}

/** Every key name in the projection, at any depth. */
function allKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) allKeys(x, out);
  else if (v && typeof v === "object" && !(v instanceof Date))
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      allKeys(x, out);
    }
  return out;
}

describe("shapePublicGiveaway — status gate", () => {
  it("refuses a draft row even if a caller hands one over by mistake", () => {
    // Production holds exactly this: "Shiny Time" / Shiny Gengar Lv50, drafted
    // and unpublished. It must be invisible.
    expect(shapePublicGiveaway(row({ status: "draft" }), { viewerId: ME })).toBeNull();
  });

  it("refuses a cancelled row", () => {
    expect(shapePublicGiveaway(row({ status: "cancelled" }), { viewerId: ME })).toBeNull();
  });

  it("refuses an unrecognised status rather than defaulting to visible", () => {
    expect(shapePublicGiveaway(row({ status: "paused" }), { viewerId: ME })).toBeNull();
  });

  it("passes exactly the three public statuses", () => {
    for (const status of PUBLIC_GIVEAWAY_STATUSES) {
      expect(shapePublicGiveaway(row({ status }), { viewerId: ME })).not.toBeNull();
    }
    expect([...PUBLIC_GIVEAWAY_STATUSES]).toEqual(["open", "closed", "drawn"]);
  });
});

describe("shapePublicGiveaway — no entrant list, no ids", () => {
  const entries = [
    { userId: ME, username: "phoenix", isWinner: false },
    { userId: THEM, username: "koruem", isWinner: true },
    { userId: "user_c", username: "naill", isWinner: true },
  ];

  it("emits no key that looks like an id or an entrant list", () => {
    const v = shapePublicGiveaway(row({ entries }), { viewerId: ME })!;
    for (const k of allKeys(v)) {
      expect(k, `leaked key ${k}`).not.toMatch(/userId|ownerId|entrant|entries|seedFor/i);
    }
  });

  it("never emits a user id as a value, not even the viewer's own", () => {
    const v = shapePublicGiveaway(row({ entries }), { viewerId: ME })!;
    const strings = allStrings(v);
    expect(strings).not.toContain(ME);
    expect(strings).not.toContain(THEM);
    expect(strings).not.toContain("user_c");
  });

  it("names winners but not the loser who is standing right next to them", () => {
    const v = shapePublicGiveaway(row({ entries }), { viewerId: ME })!;
    expect(v.winners).toEqual(["koruem", "naill"]);
    expect(allStrings(v)).not.toContain("phoenix");
  });

  it("filters losers even when a caller forgets to narrow the query", () => {
    // The route narrows to `viewer OR winner`, so this shape should never
    // reach here — but the projection must not depend on that.
    const sloppy = [
      ...entries,
      { userId: "user_d", username: "loser_one", isWinner: false },
      { userId: "user_e", username: "loser_two", isWinner: false },
    ];
    const v = shapePublicGiveaway(row({ entries: sloppy }), { viewerId: ME })!;
    expect(v.winners).toEqual(["koruem", "naill"]);
    expect(allStrings(v)).not.toContain("loser_one");
    expect(allStrings(v)).not.toContain("loser_two");
  });

  it("winners is a flat array of strings, never objects", () => {
    const v = shapePublicGiveaway(row({ entries }), { viewerId: ME })!;
    for (const w of v.winners) expect(typeof w).toBe("string");
  });
});

describe("shapePublicGiveaway — entry count is an aggregate", () => {
  it("uses the DB count, not the narrowed rows it was handed", () => {
    // 26 real entrants; the query loaded 2 rows (the viewer + the winner).
    const v = shapePublicGiveaway(
      row({
        _count: { entries: 26 },
        entries: [
          { userId: ME, username: "phoenix", isWinner: false },
          { userId: THEM, username: "koruem", isWinner: true },
        ],
      }),
      { viewerId: ME },
    )!;
    expect(v.entryCount).toBe(26);
  });

  it("falls back to the row count when no _count was selected", () => {
    const v = shapePublicGiveaway(
      row({ _count: undefined, entries: [{ userId: ME, username: "phoenix", isWinner: false }] }),
      { viewerId: ME },
    )!;
    expect(v.entryCount).toBe(1);
  });

  it("reports zero for a live giveaway nobody has entered", () => {
    const v = shapePublicGiveaway(
      row({ status: "open", drawnAt: null, entries: [], _count: { entries: 0 } }),
      { viewerId: ME },
    )!;
    expect(v.entryCount).toBe(0);
    expect(v.hasEntered).toBe(false);
  });
});

describe("shapePublicGiveaway — winners and seed wait for the draw", () => {
  const entries = [
    { userId: ME, username: "phoenix", isWinner: true },
    { userId: THEM, username: "koruem", isWinner: true },
  ];

  it("withholds both while the giveaway is still open", () => {
    // isWinner can be set inside the draw transaction a moment before drawnAt
    // lands. Until drawnAt exists, neither the names nor the seed go out.
    const v = shapePublicGiveaway(
      row({ status: "open", drawnAt: null, entries }),
      { viewerId: ME },
    )!;
    expect(v.winners).toEqual([]);
    expect(v.drawSeed).toBeNull();
  });

  it("withholds the seed on a closed-but-undrawn giveaway", () => {
    const v = shapePublicGiveaway(
      row({ status: "closed", drawnAt: null, entries }),
      { viewerId: ME },
    )!;
    expect(v.drawSeed).toBeNull();
    expect(v.winners).toEqual([]);
  });

  it("publishes both once drawn — that is the fairness proof", () => {
    const v = shapePublicGiveaway(row({ entries }), { viewerId: ME })!;
    expect(v.winners).toEqual(["phoenix", "koruem"]);
    expect(v.drawSeed).toBe("3f9a1c0e5b7d2846");
  });
});

describe("shapePublicGiveaway — the viewer's own state", () => {
  const entries = [
    { userId: ME, username: "phoenix", isWinner: true },
    { userId: THEM, username: "koruem", isWinner: true },
  ];

  it("marks hasEntered / youWon from the viewer's row only", () => {
    const mine = shapePublicGiveaway(row({ entries }), { viewerId: ME })!;
    expect(mine.hasEntered).toBe(true);
    expect(mine.youWon).toBe(true);

    const theirs = shapePublicGiveaway(row({ entries }), { viewerId: "user_stranger" })!;
    expect(theirs.hasEntered).toBe(false);
    expect(theirs.youWon).toBe(false);
  });

  it("reports delivery only for the viewer, and only when they won", () => {
    const delivered = new Map([["gw1", true]]);
    expect(shapePublicGiveaway(row({ entries }), { viewerId: ME, delivered })!.youWonDelivered)
      .toBe(true);
    // A non-winner learns nothing about anyone's delivery, even though the
    // same map is in scope.
    expect(
      shapePublicGiveaway(row({ entries }), { viewerId: "user_stranger", delivered })!
        .youWonDelivered,
    ).toBeNull();
  });

  it("says null — not false — when a win predates the grant queue", () => {
    // Production: 68 winner rows against 33 giveaway PendingGrant rows. The
    // older wins have no grant row at all, and "not delivered" would be a lie
    // about a prize that was written straight into the save years-of-patches
    // ago. null means "unknown", and the UI falls back to generic copy.
    const v = shapePublicGiveaway(row({ entries }), { viewerId: ME, delivered: new Map() })!;
    expect(v.youWonDelivered).toBeNull();
  });

  it("reports an owed-but-undelivered prize as false", () => {
    // Three real winners are sitting on one of these right now; one waited 36h.
    const delivered = new Map([["gw1", false]]);
    const v = shapePublicGiveaway(row({ entries }), { viewerId: ME, delivered })!;
    expect(v.youWonDelivered).toBe(false);
  });
});

describe("shapePublicGiveaway — the fields history needs", () => {
  it("always carries a date, even when endsAt and drawnAt are null", () => {
    // Four production rows have endsAt === null; a drawn one with no date at
    // all cannot be rendered as history.
    const v = shapePublicGiveaway(
      row({ status: "closed", endsAt: null, drawnAt: null }),
      { viewerId: ME },
    )!;
    expect(v.createdAt).toEqual(new Date("2026-07-24T23:37:32.285Z"));
  });

  it("parses the real prize shapes production stores", () => {
    const multi = shapePublicGiveaway(
      row({
        prizes:
          '[{"kind":"item","itemId":"goldbottlecap","quantity":1},{"kind":"item","itemId":"silverbottlecap","quantity":2}]',
      }),
      { viewerId: ME },
    )!;
    expect(multi.prizes).toEqual([
      { kind: "item", itemId: "goldbottlecap", quantity: 1 },
      { kind: "item", itemId: "silverbottlecap", quantity: 2 },
    ]);

    const mon = shapePublicGiveaway(
      row({
        prizes:
          '[{"kind":"pokemon","label":"Shiny Mew (Lv70)","mon":{"speciesKey":"mew","level":70,"isShiny":true}}]',
      }),
      { viewerId: ME },
    )!;
    expect(mon.prizes[0]).toMatchObject({ kind: "pokemon", label: "Shiny Mew (Lv70)" });
    // The mon blob survives — it is the advertised prize, and the client
    // needs speciesKey + isShiny to render a real sprite instead of a string.
    expect((mon.prizes[0] as { mon: Record<string, unknown> }).mon.speciesKey).toBe("mew");
  });

  it("survives a corrupt prizes column without throwing", () => {
    const v = shapePublicGiveaway(row({ prizes: "not json" }), { viewerId: ME })!;
    expect(v.prizes).toEqual([]);
    expect(v.prizeSummary).toBe("No prize set");
  });
});
