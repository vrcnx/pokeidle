// Desired role state.
//
// The single most important assertion in this file is that `managedRoles` is
// exactly three names. The bot's reconciler removes any MANAGED role a member
// should not have; if this list ever grew to "every role", the first pass
// would strip Moderator, Admin and every self-assigned role from every linked
// member in the server. The scope of that list IS the blast radius.

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  links: [] as Array<{
    discordId: string;
    userId: string;
    user: { username: string; accountLevel: number; bannedUntil: Date | null };
  }>,
  top: null as { userId: string } | null,
};

vi.mock("../src/db.js", () => ({
  prisma: {
    discordLink: { findMany: async () => state.links },
    playerRating: { findFirst: async () => state.top },
  },
}));

import {
  ACE_TRAINER_MIN_LEVEL,
  ROLE_ACE_TRAINER,
  ROLE_CHAMPION,
  ROLE_TRAINER,
  desiredRoles,
} from "../src/lib/discordRoles.js";

function link(
  discordId: string,
  userId: string,
  accountLevel: number,
  bannedUntil: Date | null = null,
) {
  return { discordId, userId, user: { username: userId, accountLevel, bannedUntil } };
}

beforeEach(() => {
  state.links = [];
  state.top = null;
});

describe("managedRoles", () => {
  it("is exactly the three roles this system owns", async () => {
    const d = await desiredRoles();
    expect(d.managedRoles.sort()).toEqual([ROLE_ACE_TRAINER, ROLE_CHAMPION, ROLE_TRAINER].sort());
  });

  it("lists Champion even when nobody holds it", async () => {
    // This is what makes handover work with no events and no memory: the bot
    // removes any managed role not in a member's desired set, so the previous
    // champion is stripped by the same pass that grants the new one. If
    // Champion dropped out of the list when vacant, a departing champion would
    // keep the role forever.
    state.links = [link("d1", "u1", 10)];
    const d = await desiredRoles();
    expect(d.champion).toBeNull();
    expect(d.managedRoles).toContain(ROLE_CHAMPION);
  });
});

describe("role assignment", () => {
  it("gives every linked, unbanned account the Trainer role", async () => {
    state.links = [link("d1", "u1", 1)];
    const d = await desiredRoles();
    expect(d.members[0].roles).toEqual([ROLE_TRAINER]);
  });

  it("adds Ace Trainer at or above the level threshold", async () => {
    state.links = [
      link("d1", "below", ACE_TRAINER_MIN_LEVEL - 1),
      link("d2", "exactly", ACE_TRAINER_MIN_LEVEL),
      link("d3", "above", ACE_TRAINER_MIN_LEVEL + 10),
    ];
    const d = await desiredRoles();
    const roles = Object.fromEntries(d.members.map((m) => [m.username, m.roles]));
    expect(roles.below).not.toContain(ROLE_ACE_TRAINER);
    expect(roles.exactly).toContain(ROLE_ACE_TRAINER);
    expect(roles.above).toContain(ROLE_ACE_TRAINER);
  });

  it("gives Champion to the current #1 and nobody else", async () => {
    state.links = [link("d1", "u1", 50), link("d2", "u2", 60)];
    state.top = { userId: "u2" };
    const d = await desiredRoles();
    const roles = Object.fromEntries(d.members.map((m) => [m.username, m.roles]));
    expect(roles.u2).toContain(ROLE_CHAMPION);
    expect(roles.u1).not.toContain(ROLE_CHAMPION);
    expect(d.champion).toEqual({ username: "u2", discordId: "d2" });
  });

  it("does not award Champion when the #1 has no linked Discord account", async () => {
    state.links = [link("d1", "u1", 50)];
    state.top = { userId: "someone-not-in-discord" };
    const d = await desiredRoles();
    expect(d.champion).toBeNull();
    expect(d.members[0].roles).not.toContain(ROLE_CHAMPION);
  });
});

describe("banned accounts", () => {
  it("hold NO managed roles at all — not just a demotion", async () => {
    const future = new Date(Date.now() + 60 * 60_000);
    state.links = [link("d1", "banned", 99, future)];
    state.top = { userId: "banned" };
    const d = await desiredRoles();
    // Even though this account is level 99 AND top of the ladder.
    expect(d.members[0].roles).toEqual([]);
    expect(d.champion).toBeNull();
  });

  it("regain their roles once the ban has expired", async () => {
    const past = new Date(Date.now() - 60 * 60_000);
    state.links = [link("d1", "served", ACE_TRAINER_MIN_LEVEL, past)];
    const d = await desiredRoles();
    expect(d.members[0].roles).toEqual([ROLE_TRAINER, ROLE_ACE_TRAINER]);
  });

  it("keep their link row, so the ban stays appealable and no alt can rebind", async () => {
    const future = new Date(Date.now() + 60 * 60_000);
    state.links = [link("d1", "banned", 10, future)];
    const d = await desiredRoles();
    // Still present as a member with an empty role list — the row was not
    // deleted. Unlinking on ban would free the Discord account to bind a fresh
    // alt immediately.
    expect(d.members).toHaveLength(1);
    expect(d.members[0].discordId).toBe("d1");
  });
});
