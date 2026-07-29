// PvP team-intake validation.
//
// The hole these pin: battle:invite / battle:queue / battle:respond each
// did nothing but `Array.isArray(team) && length 1..6` and then
// `team as never`. No stat bounds, no ownership check — on the path whose
// result endBattle rates into PlayerRating for random50. The trade path
// has enforced zod bounds since it shipped; PvP never got them.
//
// The acceptance fixture below is NOT invented. It is a byte-faithful
// copy of a real party member read out of production (2,299 saves,
// 40,587 Pokémon), down to the key order and the sparse 3-move moveset.
// The whole point of these tests is that legitimate teams pass, so the
// fixture has to be real — a hand-written one would only prove the
// schema agrees with my assumptions about the schema.
//
// The bounds themselves were chosen against that same dataset, not
// guessed: the maximum EV total in production is exactly 510 and the
// maximum IV exactly 31, so the ceilings sit precisely on what real play
// produces. Every one of the 40,587 mons passes validatePvpTeam.

import { describe, expect, it, vi, beforeEach } from "vitest";

const findUnique = vi.fn();
vi.mock("../src/db.js", () => ({
  prisma: { user: { findUnique: (...a: unknown[]) => findUnique(...a) } },
}));

const recorded: unknown[] = [];
vi.mock("../src/lib/errorReporting.js", () => ({
  recordError: (e: unknown) => { recorded.push(e); return Promise.resolve(); },
}));

import { validatePvpTeam, auditTeamOwnership } from "../src/lib/pvpTeamValidation.js";

/** Real party member, copied verbatim out of a production save. */
const REAL_MON = {
  id: "1",
  speciesKey: "charmander",
  name: "Charmander",
  nature: "Calm",
  level: 5,
  totalExp: 135,
  moves: [
    { id: "scratch", pp: 35, maxPp: 35 },
    { id: "growl", pp: 40, maxPp: 40 },
    { id: "ember", pp: 24, maxPp: 25 },
  ],
  currentHp: 20,
  maxHp: 20,
  attack: 9,
  defense: 10,
  spAttack: 11,
  spDefense: 11,
  speed: 12,
  ivs: { hp: 26, attack: 26, defense: 19, spAttack: 11, spDefense: 0, speed: 10 },
  evs: { hp: 0, attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0 },
  isShiny: false,
  ability: "blaze",
};

const mon = (over: Record<string, unknown> = {}) => ({ ...REAL_MON, ...over });

beforeEach(() => { recorded.length = 0; findUnique.mockReset(); });

describe("validatePvpTeam — accepts what real play produces", () => {
  it("accepts a real production party member unchanged", () => {
    const r = validatePvpTeam([REAL_MON]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.team[0].speciesKey).toBe("charmander");
  });

  it("accepts a full six with a maxed 510 EV spread (the production maximum)", () => {
    const maxed = mon({
      id: "9",
      evs: { hp: 6, attack: 252, defense: 0, spAttack: 252, spDefense: 0, speed: 0 },
      ivs: { hp: 31, attack: 31, defense: 31, spAttack: 31, spDefense: 31, speed: 31 },
      level: 100,
    });
    const team = [0, 1, 2, 3, 4, 5].map((i) => mon({ ...maxed, id: `m${i}` }));
    expect(validatePvpTeam(team).ok).toBe(true);
  });

  it("accepts a prize-grant id (pg<grantId>_<i>) — deterministic ids must not be rejected", () => {
    expect(validatePvpTeam([mon({ id: "pgabc123def456_0" })]).ok).toBe(true);
  });

  it("tolerates unknown client bookkeeping fields via passthrough", () => {
    const r = validatePvpTeam([mon({ status: "poisoned", sleepTurns: 2, statStages: { atk: 1 } })]);
    expect(r.ok).toBe(true);
  });

  it("accepts a mon with no evs/ivs/moves at all (admin-granted)", () => {
    const bare = { id: "z1", speciesKey: "mew", level: 70 };
    expect(validatePvpTeam([bare]).ok).toBe(true);
  });
});

describe("validatePvpTeam — refuses forged stats", () => {
  it("refuses an IV above 31", () => {
    const r = validatePvpTeam([mon({ ivs: { ...REAL_MON.ivs, attack: 999 } })]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ivs/);
  });

  it("refuses an EV above 252 in one stat", () => {
    const r = validatePvpTeam([mon({ evs: { ...REAL_MON.evs, speed: 999 } })]);
    expect(r.ok).toBe(false);
  });

  it("refuses an EV total above 510 even when every stat is individually legal", () => {
    // 6 x 252 = 1512. Each value passes the per-stat ceiling; the total
    // is the rule the record schema cannot express, which is exactly the
    // kind of gap that makes "it has a schema" untrue in practice.
    const r = validatePvpTeam([mon({
      evs: { hp: 252, attack: 252, defense: 252, spAttack: 252, spDefense: 252, speed: 252 },
    })]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/510/);
  });

  it("refuses an out-of-range level", () => {
    expect(validatePvpTeam([mon({ level: 9999 })]).ok).toBe(false);
    expect(validatePvpTeam([mon({ level: 0 })]).ok).toBe(false);
  });

  it("refuses impossible raw stats", () => {
    expect(validatePvpTeam([mon({ attack: 50_000 })]).ok).toBe(false);
    expect(validatePvpTeam([mon({ maxHp: 50_000 })]).ok).toBe(false);
  });

  it("refuses more than 4 moves", () => {
    const r = validatePvpTeam([mon({
      moves: ["a", "b", "c", "d", "e"].map((id) => ({ id, pp: 10, maxPp: 10 })),
    })]);
    expect(r.ok).toBe(false);
  });

  it("refuses a team that reuses one Pokémon in six slots", () => {
    const r = validatePvpTeam([0, 1, 2, 3, 4, 5].map(() => mon()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/duplicate/);
  });

  it("refuses a mon with no id — ownership would be uncheckable", () => {
    const { id: _drop, ...noId } = REAL_MON;
    expect(validatePvpTeam([noId]).ok).toBe(false);
  });

  it("refuses prototype-polluting / oversized id strings", () => {
    expect(validatePvpTeam([mon({ id: "__proto__.x" })]).ok).toBe(false);
    expect(validatePvpTeam([mon({ speciesKey: "a".repeat(500) })]).ok).toBe(false);
  });

  it("still refuses the wrong team sizes", () => {
    expect(validatePvpTeam([]).ok).toBe(false);
    expect(validatePvpTeam([0, 1, 2, 3, 4, 5, 6].map((i) => mon({ id: `x${i}` }))).ok).toBe(false);
    expect(validatePvpTeam("not an array").ok).toBe(false);
    expect(validatePvpTeam(null).ok).toBe(false);
  });
});

describe("auditTeamOwnership — shadow mode", () => {
  const team = [mon({ id: "own1" }), mon({ id: "forged9" })];

  it("flags a Pokémon that is not in the sender's save", async () => {
    findUnique.mockResolvedValue({
      saveData: JSON.stringify({ party: [{ id: "own1" }], box: [{ id: "other" }] }),
    });
    const r = await auditTeamOwnership("u1", team as never, { format: "random50", via: "queue" });
    expect(r.checked).toBe(true);
    expect(r.unowned).toEqual(["forged9"]);
    // and it must leave a triage trail naming the species, not just an id
    expect(recorded).toHaveLength(1);
    const meta = (recorded[0] as { meta: Record<string, unknown> }).meta;
    expect((recorded[0] as { message: string }).message).toBe("pvp_team_unowned");
    expect(meta.unowned).toEqual([{ id: "forged9", species: "charmander", level: 5 }]);
  });

  it("finds mons in the box, not just the party", async () => {
    findUnique.mockResolvedValue({
      saveData: JSON.stringify({ party: [{ id: "zzz" }], box: [{ id: "own1" }, { id: "forged9" }] }),
    });
    const r = await auditTeamOwnership("u1", team as never, { format: "random50", via: "queue" });
    expect(r.unowned).toEqual([]);
    expect(recorded).toHaveLength(0);
  });

  // The false-positive guards. Each of these would, if it accused, block a
  // legitimate queue join once ENFORCE_OWNERSHIP flips on.
  it("does not accuse when the save is missing", async () => {
    findUnique.mockResolvedValue({ saveData: null });
    const r = await auditTeamOwnership("u1", team as never, { format: "random50", via: "queue" });
    expect(r).toEqual({ unowned: [], checked: false });
    expect(recorded).toHaveLength(0);
  });

  it("does not accuse when the save is malformed JSON", async () => {
    findUnique.mockResolvedValue({ saveData: "{not json" });
    const r = await auditTeamOwnership("u1", team as never, { format: "random50", via: "queue" });
    expect(r.checked).toBe(false);
    expect(recorded).toHaveLength(0);
  });

  it("does not accuse when the save has an empty party AND box", async () => {
    // Indistinguishable from a failed read — must not be read as forgery.
    findUnique.mockResolvedValue({ saveData: JSON.stringify({ party: [], box: [] }) });
    const r = await auditTeamOwnership("u1", team as never, { format: "random50", via: "queue" });
    expect(r.checked).toBe(false);
    expect(recorded).toHaveLength(0);
  });

  it("does not throw when the DB read fails", async () => {
    findUnique.mockRejectedValue(new Error("connection lost"));
    const r = await auditTeamOwnership("u1", team as never, { format: "random50", via: "queue" });
    expect(r).toEqual({ unowned: [], checked: false });
  });
});
