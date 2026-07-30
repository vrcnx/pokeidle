// The server's PvP tier table must BE the client's PvP tier table.
//
// ── THE DEFECT THIS FILE EXISTS TO PREVENT ───────────────────────────
// game/src/state/pvpTiers.ts has existed since before the ladder rewards, and
// it says of itself: "Single source of truth so client/server don't drift." It
// is already rendered in the PvP hub (components/PvpHubModal.tsx calls
// tierFor(rating)).
//
// server/src/lib/pvpBadge.ts then shipped a SECOND, different table. Executed
// side by side over 15 ratings, 8 of the 15 disagreed:
//
//     rating 1200 → server "Gold",     hub "Silver"
//     rating 1250 → server "Gold",     hub "Silver"
//     rating 1350 → server "Platinum", hub "Gold"
//     rating 1400 → server "Platinum", hub "Gold"
//     rating 1500 → server "Master",   hub "Platinum"
//     rating 1600 → server "Master",   hub "Platinum"
//     rating 1700 → server "Master",   hub "Diamond"
//     rating 1800 → server "Master",   hub "Diamond"
//
// "Master" did not exist client-side, "Diamond" did not exist server-side, and a
// 0-match account was "Rookie" on the server and "Bronze" in the hub. The server
// would therefore have announced a milestone bonus under a tier name that
// contradicted what the player was looking at while it landed.
//
// ── WHY THIS TEST PARSES THE CLIENT FILE AS TEXT ─────────────────────
// Importing across the package boundary would drag the client's module graph
// (and its tsconfig) into the server's test run and into `tsc`. Reading the file
// and extracting the numbers is stronger anyway: it fails if a tier is added,
// removed, renamed or re-floored on EITHER side, including by an edit made
// without ever opening the server code. The client file is owned by another task
// and is deliberately only ever READ here.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { PVP_BADGE_TIERS, pvpTierForRating } from "../src/lib/pvpBadge.js";

const CLIENT_TIERS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../game/src/state/pvpTiers.ts",
);

interface ClientTier { id: string; name: string; floor: number; ceil: number }

/** Extract the client's PVP_TIERS entries from source text. */
function readClientTiers(): ClientTier[] {
  const src = readFileSync(CLIENT_TIERS_PATH, "utf8");
  const block = src.slice(src.indexOf("PVP_TIERS"));
  const rows: ClientTier[] = [];
  const re = /id:\s*"([a-z]+)"\s*,\s*name:\s*"([A-Za-z]+)"\s*,\s*floor:\s*(\d+)\s*,\s*ceil:\s*(\d+)/g;
  for (let m = re.exec(block); m; m = re.exec(block)) {
    rows.push({ id: m[1], name: m[2], floor: Number(m[3]), ceil: Number(m[4]) });
  }
  return rows;
}

describe("server and client PvP tier tables are the same table", () => {
  const client = readClientTiers();

  it("finds the client's table at all, so a silent parse failure cannot pass this file", () => {
    expect(client.length).toBeGreaterThanOrEqual(5);
    expect(client[0].floor).toBe(0);
    // The bands are contiguous, which is what makes "floor" sufficient.
    for (let i = 1; i < client.length; i++) {
      expect(client[i].floor).toBe(client[i - 1].ceil);
    }
  });

  it("has exactly the same tier ids, in the same order", () => {
    expect(PVP_BADGE_TIERS.map((t) => t.id)).toEqual(client.map((t) => t.id));
  });

  it("has exactly the same labels", () => {
    expect(PVP_BADGE_TIERS.map((t) => t.label)).toEqual(client.map((t) => t.name));
  });

  it("has exactly the same rating floors", () => {
    expect(PVP_BADGE_TIERS.map((t) => t.minRating)).toEqual(client.map((t) => t.floor));
  });

  it("agrees on the tier for every rating, including the 8 that used to disagree", () => {
    const clientTierFor = (rating: number) =>
      client.find((t) => rating >= t.floor && rating < t.ceil) ?? client[client.length - 1];
    // The exact ratings from the reproduction, plus a sweep either side of every
    // boundary and well past the top band.
    const probes = new Set<number>([0, 900, 1000, 1050, 1100, 1150, 1200, 1250, 1300, 1350,
      1400, 1500, 1600, 1700, 1800, 2500, 2999]);
    for (const t of client) {
      probes.add(t.floor - 1);
      probes.add(t.floor);
      probes.add(t.floor + 1);
    }
    for (const r of [...probes].filter((r) => r >= 0)) {
      expect(pvpTierForRating(r).id, `rating ${r}`).toBe(clientTierFor(r).id);
      expect(pvpTierForRating(r).label, `rating ${r}`).toBe(clientTierFor(r).name);
    }
  });

  it("invents no tier the client has never heard of", () => {
    const clientIds = new Set(client.map((t) => t.id));
    for (const t of PVP_BADGE_TIERS) expect(clientIds.has(t.id)).toBe(true);
    // The two specific names from the reproduction.
    expect(PVP_BADGE_TIERS.some((t) => t.id === "master")).toBe(false);
    expect(PVP_BADGE_TIERS.some((t) => (t.id as string) === "rookie")).toBe(false);
    expect(PVP_BADGE_TIERS.some((t) => t.id === "diamond")).toBe(true);
  });
});
