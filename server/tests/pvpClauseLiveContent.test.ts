// The Evasion and OHKO clauses are LIVE against content that ships today.
//
// ─── The claim this file exists to make un-restatable ─────────────────────
//
// lib/pvpFormat.ts used to document the two clauses as free:
//
//     Evasion Clause  (Double Team / Minimize)      0 accounts affected
//     OHKO Clause     (Fissure / Sheer Cold / …)    0 accounts affected
//     … nobody in the game owns one of those moves
//
// and a review then repeated it as "they aren't in the game's dex at all, so
// this is a guard for future content". Both were produced by grepping
// game/src/data/pokemon.ts and moves.ts and by counting PARTIES only. Both are
// false, and the corrected measurement is in the module header. What is asserted
// here is the part a comment cannot enforce:
//
//   * the banned move ids are reachable through NORMAL PLAY — Gligar learns
//     Guillotine at Lv 52 and the Johto encounter table spawns it wild at
//     Lv 67-70, so `defaultMoves()` hands a freshly-caught one Guillotine in its
//     starting four. Yanma / Scizor (Double Team) and Qwilfish / Blissey
//     (Minimize) are the same story;
//   * the moves WORK, so the ban is not theatre: game/src/data/moves.ts
//     backfills any move it does not hand-author from @pkmn/dex, which is why
//     real save rows carry `guillotine` as pp 5 / maxPp 5 and why the simulator
//     would happily let it 30%-one-shot anything;
//   * the refusal is a usable message rather than a wall — it names the Pokemon,
//     names the move in words, and says how to fix it;
//   * and there is no lockout: the same Pokemon with the move dropped is
//     accepted, and unrated formats never refuse it at all.
//
// Read-only production measurement behind the header's corrected table, for the
// record (2,310 saves — 7,051 party Pokemon, 35,669 box Pokemon): OHKO 0 party /
// 33 box across 27 accounts, Evasion 0 party / 1 box across 1 account, Moody 0.
// It cannot be asserted here — a test may not reach the database — so it is the
// fixtures below that are pinned instead: they are the real shapes those rows
// contain.
//
// Moody genuinely IS a future guard, and that is measured rather than assumed
// too (section 4).

import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Dex } from "@pkmn/sim";

const db = vi.hoisted(() => ({
  prisma: {
    pvpMatch: { create: vi.fn(async () => ({})) },
    playerRating: { upsert: vi.fn(async () => ({ rating: 1000, peakRating: 1000 })), update: vi.fn(async () => ({})) },
    $transaction: vi.fn(async () => ({})),
    $executeRaw: vi.fn(async () => 1),
  },
}));
vi.mock("../src/db.js", () => ({ prisma: db.prisma }));

import { checkTeamForFormat } from "../src/pvp.js";
import { checkTeamLegality, SIM_BASE_FORMAT_ID } from "../src/lib/pvpFormat.js";

// ── Reading the client's data files ───────────────────────────────────────
// Parsed as text rather than imported: game/src/data/moves.ts pulls in
// @pkmn/dex and runs a backfill loop at module scope, and game/ is a separate
// package. The parse is deliberately narrow and asserts its own yield, so a
// reformat of the data file shows up as a failed parse rather than as a silently
// empty result that makes every assertion below vacuous.

const GAME_DATA = path.join(process.cwd(), "..", "game", "src", "data");
const read = (...p: string[]) => fs.readFileSync(path.join(GAME_DATA, ...p), "utf8");

/** speciesKey → [level, moveId][] out of game/src/data/levelUpMoves.ts. */
function parseLevelUpMoves(): Record<string, [number, string][]> {
  const src = read("levelUpMoves.ts");
  const out: Record<string, [number, string][]> = {};
  let species: string | null = null;
  for (const line of src.split("\n")) {
    const head = /^ {2}([A-Za-z0-9_]+):\s*\[/.exec(line);
    if (head) { species = head[1]; out[species] = []; }
    if (!species) continue;
    for (const m of line.matchAll(/\[\s*(\d+),\s*"([A-Za-z0-9_]+)"\s*\]/g)) {
      out[species].push([Number(m[1]), m[2]]);
    }
  }
  return out;
}

/** game/src/utils/moves.ts defaultMoves(): the last four learned by `level`. */
const defaultMoves = (table: Record<string, [number, string][]>, species: string, level: number) =>
  (table[species] ?? []).filter(([l]) => l <= level).map(([, id]) => id).slice(-4);

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const LEVEL_UP = parseLevelUpMoves();

// ══ 1 · the banned ids are reachable through normal play ══════════════════

describe("the Evasion and OHKO clauses are live against shipped content", () => {
  it("parsed the client's level-up table at all", () => {
    // Guards every assertion below: a failed parse must not look like "no
    // species learns a banned move".
    expect(Object.keys(LEVEL_UP).length).toBeGreaterThan(200);
    expect(LEVEL_UP.gligar).toBeDefined();
    expect(LEVEL_UP.bulbasaur?.some(([, id]) => id === "tackle")).toBe(true);
  });

  it("finds every banned move that a Pokemon can LEARN, and names the species", () => {
    const BANNED = ["doubleteam", "minimize", "fissure", "sheercold", "guillotine", "horndrill"];
    const learners: Record<string, string[]> = {};
    for (const [species, list] of Object.entries(LEVEL_UP)) {
      for (const [lvl, id] of list) {
        if (BANNED.includes(slug(id))) {
          (learners[slug(id)] ??= []).push(`${species}@${lvl}`);
        }
      }
    }
    // Exactly the three that exist in the shipped tables today. A fourth
    // appearing here is not a failure of this test — it is the signal that one
    // more clause just became live content, and the header table needs
    // re-measuring before anyone calls it free again.
    expect(Object.keys(learners).sort()).toEqual(["doubleteam", "guillotine", "minimize"]);
    expect(learners.guillotine).toEqual(["gligar@52"]);
    expect(learners.doubleteam.sort()).toEqual(["scizor@48", "yanma@13"]);
    expect(learners.minimize.sort()).toEqual(["blissey@18", "qwilfish@10"]);
  });

  it("puts Guillotine in a WILD Gligar's starting four", () => {
    // The unbounded half of the problem: nobody chose this move. Johto spawns
    // Gligar above the level it learns Guillotine, and defaultMoves() takes the
    // last four learned.
    const enc = read(path.join("regions", "johto", "encounters.ts"));
    const line = enc.split("\n").find((l) => l.includes('speciesKey: "gligar"'));
    expect(line, "Johto no longer spawns Gligar — re-check this test's premise").toBeDefined();
    const min = Number(/minLevel:\s*(\d+)/.exec(line!)![1]);
    const max = Number(/maxLevel:\s*(\d+)/.exec(line!)![1]);
    expect(min).toBe(67);
    expect(max).toBe(70);
    for (const level of [min, max]) {
      expect(defaultMoves(LEVEL_UP, "gligar", level)).toEqual(
        ["feintattack", "slash", "screech", "guillotine"],
      );
    }
  });

  it("and the move is not hand-authored — it arrives from the @pkmn backfill, which is why it WORKS", () => {
    const moves = read("moves.ts");
    // Not in the hand-authored table…
    expect(/^ {4}guillotine:/m.test(moves)).toBe(false);
    // …but the file backfills everything it did not author from Showdown's data
    // layer, so `moves.guillotine` exists at runtime with real pp. That is the
    // mechanism behind the pp 5 / maxPp 5 the production rows carry, and the
    // reason "it isn't in the dex" was the wrong test to run.
    expect(moves).toContain('import { Dex } from "@pkmn/dex"');
    expect(moves).toContain("for (const m of Dex.moves.all())");
    // What the simulator would do with it if the clause let it through. Same
    // base format pvp.ts validates ids against; the cast is @pkmn's branded ID
    // type, which a plain string literal does not satisfy.
    const dex = Dex.forFormat(SIM_BASE_FORMAT_ID as never);
    const g = dex.moves.get("guillotine");
    expect(g.exists).toBe(true);
    expect(g.ohko).toBeTruthy();
    expect(g.pp).toBe(5);
    for (const id of ["doubleteam", "minimize"]) {
      const m = dex.moves.get(id);
      expect(m.exists).toBe(true);
      expect(m.boosts?.evasion, `${id} no longer boosts evasion`).toBeGreaterThan(0);
    }
  });
});

// ══ 2 · a real production payload is refused, with a usable message ═══════

describe("the refusal a real player actually hits", () => {
  /** The exact shape a production save row carries — same species, level, move
   *  ids and pp values as the rows measured in the box of 27 accounts. */
  const gligar = {
    id: "mon_gligar_1",
    speciesKey: "gligar",
    name: "Gligar",
    nickname: null as string | null,
    level: 68,
    ability: "hyperCutter",
    moves: [
      { id: "feintattack", pp: 20, maxPp: 20 },
      { id: "slash", pp: 20, maxPp: 20 },
      { id: "screech", pp: 40, maxPp: 40 },
      { id: "guillotine", pp: 5, maxPp: 5 },
    ],
  };
  const yanma = {
    id: "mon_yanma_1", speciesKey: "yanma", name: "Yanma", nickname: "BUZZ",
    level: 20, ability: "compoundEyes",
    moves: [
      { id: "foresight", pp: 40, maxPp: 40 },
      { id: "quickattack", pp: 30, maxPp: 30 },
      { id: "doubleteam", pp: 15, maxPp: 15 },
      { id: "sonicboom", pp: 20, maxPp: 20 },
    ],
  };

  it("refuses it in the rated queue and in tournaments, with code ohko", () => {
    for (const format of ["random50", "tournament"]) {
      const r = checkTeamForFormat([gligar] as never, format);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.violations.map((v) => v.code)).toEqual(["ohko"]);
      // The message has three jobs: name the Pokemon, name the move in words a
      // player recognises, and say what to do. The raw id was being interpolated
      // before, which reads as a typo for the lowercase-concatenated ids the
      // game's own tables use ("doubleteam").
      expect(r.error).toContain("Gligar");
      expect(r.error).toContain("Guillotine");
      expect(r.error).not.toContain("guillotine");
      expect(r.error).toContain("Manage Moves");
      expect(r.error).toContain("OHKO Clause");
    }
  });

  it("uses the nickname when there is one, so the player can find the Pokemon", () => {
    const r = checkTeamForFormat([yanma] as never, "random50");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violations.map((v) => v.code)).toEqual(["evasion"]);
    expect(r.error).toContain("BUZZ");
    expect(r.error).toContain("Double Team");
    expect(r.error).toContain("Manage Moves");
  });

  it("is friction, not a lockout: the same Pokemon without the move is accepted", () => {
    const fixed = { ...gligar, moves: gligar.moves.filter((m) => m.id !== "guillotine") };
    expect(checkTeamForFormat([fixed] as never, "random50").ok).toBe(true);
    // Three real moves left, so "fix it in Manage Moves" leaves a usable
    // Pokemon rather than a Struggle bot.
    expect(fixed.moves).toHaveLength(3);
    expect(fixed.moves.every((m) => m.maxPp > 0)).toBe(true);
  });

  it("says nothing at all in an unrated format", () => {
    for (const format of ["anything-goes", "bot"]) {
      expect(checkTeamForFormat([gligar] as never, format).ok).toBe(true);
      expect(checkTeamForFormat([yanma] as never, format).ok).toBe(true);
    }
  });

  it("reports both sides of a mixed team at once", () => {
    const r = checkTeamForFormat([gligar, yanma] as never, "random50");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violations.map((v) => v.code).sort()).toEqual(["evasion", "ohko"]);
  });
});

// ══ 3 · the corrected documentation cannot silently revert ════════════════

describe("the module header states the measurement that was actually taken", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src", "lib", "pvpFormat.ts"), "utf8");

  it("no longer concludes the two clauses are free", () => {
    // The operative conclusion that was wrong ("So Evasion and OHKO are free to
    // enforce"), and the table row that produced it. Line-anchored, because the
    // header now QUOTES the old wording in order to correct it — a bare
    // substring check would fail on the correction itself.
    expect(src).not.toContain("free to enforce");
    expect(src).not.toMatch(/^\/\/\s{2,}(OHKO|Evasion) Clause[^\n]*0 accounts affected/m);
    expect(src).toContain("NOT a guard for future content");
  });

  it("records that the count includes the BOX, which is what the team builder pools", () => {
    expect(src).toContain("box");
    expect(src).toContain("35,669");
    expect(src).toContain("TeamBuilderModal");
  });
});

// ══ 4 · Moody really is a future guard ═══════════════════════════════════

describe("Moody Clause guards content that does not exist yet", () => {
  it("appears only as a HIDDEN ability, which no path in the game assigns", () => {
    const abilities = read("abilities.ts");
    // Every mention of moody outside the ability-description table is a
    // `hidden:` slot…
    const mentions = abilities.split("\n").filter((l) => /moody/.test(l));
    expect(mentions.length).toBeGreaterThan(1);
    const assignments = mentions.filter((l) => /primary:\s*\[[^\]]*moody/.test(l));
    expect(assignments).toEqual([]);
    expect(mentions.filter((l) => /hidden:\s*"moody"/.test(l)).length).toBe(3);
    // …and pickAbility only ever returns a primary, so a hidden ability cannot
    // reach a save. If this ever changes, Moody joins Evasion and OHKO as live
    // content and the header table needs re-measuring.
    const pick = /export function pickAbility[\s\S]*?\n}/.exec(abilities)?.[0] ?? "";
    expect(pick).toContain("entry.primary[");
    expect(pick).not.toContain("hidden");
  });

  it("is still enforced if one ever arrives", () => {
    const moody = [{ speciesKey: "octillery", name: "Octillery", level: 50, ability: "moody", moves: [{ id: "surf" }] }];
    const r = checkTeamLegality(moody);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violations.map((v) => v.code)).toEqual(["moody"]);
    expect(checkTeamForFormat(moody, "random50").ok).toBe(false);
    expect(checkTeamForFormat(moody, "bot").ok).toBe(true);
  });
});
