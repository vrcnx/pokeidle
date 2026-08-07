// The free-rewards list the game reads.
//
// This surface exists because the Discord link reward was configured,
// granted correctly, and completely invisible: the prize was revealed only
// AFTER a successful redeem, so the offer never reached the players it was
// meant to attract. The properties that matter are therefore about honesty,
// not about rendering:
//
//   * it must never advertise something the grant path would refuse — a card
//     promising a Master Ball to a player who cannot get one is worse than no
//     card at all;
//   * it must read the SAME config row and the SAME PendingGrant receipt that
//     grantLinkReward reads, so the offer and the grant cannot drift apart;
//   * it is read-only. There is no claim path here, and a test that would pass
//     if one were added is a test that is not watching.
//
// db.js is stubbed so nothing reaches a database.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    config: null as { linkReward: string | null; linkRewardEnabled: boolean } | null,
    /** PendingGrant rows for the user under test. */
    grants: [] as Array<{ source: string }>,
    /** Whether a DiscordLink row exists for the user under test. */
    linked: false,
  },
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    discordConfig: { findUnique: async () => state.config },
    pendingGrant: {
      count: async ({ where }: { where: { source?: string } }) =>
        state.grants.filter((g) => !where.source || g.source === where.source).length,
    },
    discordLink: { findUnique: async () => (state.linked ? { userId: "u1" } : null) },
  },
}));

// DiscordConfig.linkReward is a JSON prize list — the same format the admin
// dashboard writes and the same one grantLinkReward parses.
const MASTERBALL_JSON = JSON.stringify([{ kind: "item", itemId: "masterball", quantity: 1 }]);

const { listPromos } = await import("../src/lib/promos.js");

beforeEach(() => {
  state.config = { linkReward: MASTERBALL_JSON, linkRewardEnabled: true };
  state.grants = [];
  state.linked = false;
});

describe("listPromos — the Discord link reward", () => {
  it("describes the offer the admin actually configured", async () => {
    const [p] = await listPromos("u1");
    expect(p.id).toBe("discord-link");
    expect(p.state).toBe("available");
    // The prize comes from the config row, parsed by the same parser the
    // grant path uses — not from a hardcoded string in the client.
    expect(p.prizes).toEqual([{ kind: "item", itemId: "masterball", quantity: 1 }]);
    // THE BUTTON LEAVES THE SITE, and that is the fix it encodes. It used to
    // read "Get the code" and lead to /link-discord — a page that does not
    // give you a code, it asks for one. The code is DM'd by the bot, which
    // cannot DM anyone who is not in the server, and nothing in the client,
    // the server or the deployed bundle was a link to that server. A card
    // whose whole proposition is joining offered every step except joining.
    expect(p.cta?.label).toBe("Join the Discord");
    expect(p.cta?.href).toMatch(/^https:\/\/discord\.gg\//);
  });

  it("reads 'already had it' from the grant ledger, not from a flag", async () => {
    state.grants = [{ source: "discord-link" }];
    const [p] = await listPromos("u1");
    expect(p.state).toBe("claimed");
    // Nothing to press. A CTA on a collected promo sends somebody to a page
    // that will refuse them.
    expect(p.cta).toBeNull();
    expect(p.note).toMatch(/collected/i);
  });

  // Unrelated grants must not be mistaken for this one. Every prize in the
  // game lands in the same table.
  it("does not count a giveaway win as the link reward", async () => {
    state.grants = [{ source: "giveaway" }];
    expect((await listPromos("u1"))[0].state).toBe("available");
  });

  // The grant only ever runs on a FIRST link. An account that linked before
  // the promotion existed will never be paid, so showing it a live offer
  // would be a promise the server cannot keep.
  it("warns an already-linked account that the offer cannot pay out", async () => {
    state.linked = true;
    const [p] = await listPromos("u1");
    expect(p.note).toMatch(/already linked/i);
  });

  describe("shows no card at all rather than a broken one", () => {
    it("when the promotion is switched off", async () => {
      state.config = { linkReward: MASTERBALL_JSON, linkRewardEnabled: false };
      expect(await listPromos("u1")).toEqual([]);
    });

    it("when no config row has ever been written", async () => {
      state.config = null;
      expect(await listPromos("u1")).toEqual([]);
    });

    it("when the prize field is blank or whitespace", async () => {
      state.config = { linkReward: "   ", linkRewardEnabled: true };
      expect(await listPromos("u1")).toEqual([]);
    });

    // The same call grantLinkReward makes, for the same reason: a prize
    // string the parser rejects is a prize the grant path will refuse, so
    // advertising it would create a support ticket rather than a Master Ball.
    it("when the prize string is malformed", async () => {
      state.config = { linkReward: "not a prize", linkRewardEnabled: true };
      expect(await listPromos("u1")).toEqual([]);
    });
  });
});

describe("listPromos — the shape of the surface", () => {
  // A promo is granted by the thing that proves you earned it. A second path
  // to the same prize is how one gets paid twice, so the module deliberately
  // exports nothing that writes.
  it("exports no way to claim anything", async () => {
    const mod = await import("../src/lib/promos.js");
    expect(Object.keys(mod).filter((k) => /claim|grant|redeem/i.test(k))).toEqual([]);
  });
});
