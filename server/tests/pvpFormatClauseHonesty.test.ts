// Every rule the shipped format declares must be a TRUE statement about the
// battle it introduces.
//
// ─── The defect this file exists for ──────────────────────────────────────
//
// The shipped format declared three battle clauses, one of which was
// "HP Percentage Mod". It was known — measured, and written down in
// lib/pvpFormat.ts — that the rule did nothing in this format: Custom Game runs
// `debug: true` → reportExactHP, and reportExactHP wins over reportPercentages,
// so a player still receives exact foe HP. It was kept anyway, on the reasoning
// that declaring an inert rule was "harmless and correct to declare".
//
// It was neither. Declaring a rule makes the simulator publish a rule line on
// BOTH player streams, and that line is the rule's own description:
//
//     |rule|HP Percentage Mod: HP is shown in percentages
//
// Reproduced by execution on the exact format string production shipped, in the
// same battle whose next-but-two line was
//
//     |switch|p2a: BRAVO|Snorlax, L50, F|235/235
//
// i.e. a declaration that HP is hidden, immediately followed by exact HP. That
// line is persisted into PvpMatch.battleLog by endBattle and served to both
// participants by the replay route, so the false statement outlives the battle.
//
// The fix was to remove the rule. This file is the guard, and it is deliberately
// NOT "assert the string is absent" — a string assertion would pass just as well
// against a rule that had been renamed, and would prove nothing about any rule
// added in future. Instead it MEASURES the promise: for the shipped format, if a
// declared rule line says HP is shown in percentages, then HP must actually be
// shown in percentages. Section 2 runs the same measurement against the old
// three-rule string as a positive control, so the check is proven able to fail.
//
// No database and no socket: lib/pvpFormat.ts imports nothing, and the battles
// here are driven straight at @pkmn/sim. Nothing to mock.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { BattleStreams, Teams } from "@pkmn/sim";
import { simFormatId, SIM_BASE_FORMAT_ID } from "../src/lib/pvpFormat.js";

const PROD_FORMAT = simFormatId(false);
/** The string that shipped before this fix, kept verbatim as the control. */
const OLD_FORMAT = `${SIM_BASE_FORMAT_ID}@@@Sleep Clause Mod,Endless Battle Clause,HP Percentage Mod,!Team Preview`;

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Set5 = Parameters<typeof Teams.pack>[0];

/** Snorlax is the measurement instrument: 235 HP at Lv 50 with no EVs, so
 *  "exact HP" and "percentage HP" cannot be confused — a percentage report of a
 *  full Pokemon is always `100/100`. A species whose real max HP happened to be
 *  100 would make the assertion ambiguous. */
const one = (name: string, species: string, ability: string, move: string) => ([{
  name, species, item: "", ability, moves: [move], nature: "Hardy",
  evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
  ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
  level: 50, shiny: false, gender: "",
}] as unknown as Set5);

const TEAM_A = one("ALPHA", "machamp", "guts", "closecombat");
const TEAM_B = one("BRAVO", "snorlax", "thickfat", "bodyslam");

interface Streams { p1: string[]; p2: string[]; omni: string[]; throws: string[] }

async function run(formatid: string, turns = 3): Promise<Streams> {
  const stream = new BattleStreams.BattleStream();
  const ps = BattleStreams.getPlayerStreams(stream);
  const out: Streams = { p1: [], p2: [], omni: [], throws: [] };
  const pump = async (s: AsyncIterable<string>, into: string[]) => {
    try {
      for await (const chunk of s) for (const l of chunk.split("\n")) if (l) into.push(l);
    } catch (e) { out.throws.push(e instanceof Error ? e.message : String(e)); }
  };
  void pump(ps.p1, out.p1);
  void pump(ps.p2, out.p2);
  void pump(ps.omniscient, out.omni);
  stream.write([
    `>start {"formatid":${JSON.stringify(formatid)},"seed":[9,8,7,6]}`,
    `>player p1 {"name":"Alice","team":${JSON.stringify(Teams.pack(TEAM_A))}}`,
    `>player p2 {"name":"Bob","team":${JSON.stringify(Teams.pack(TEAM_B))}}`,
  ].join("\n"));
  await settle(150);
  for (let t = 0; t < turns; t++) {
    try { stream.write(">p1 move 1"); stream.write(">p2 move 1"); }
    catch { break; }   // battle already over
    await settle(90);
  }
  await settle(120);
  try { stream.destroy(); } catch { /* already gone */ }
  return out;
}

const ruleLines = (s: string[]) => s.filter((l) => l.startsWith("|rule|"));

/** Does any declared rule PROMISE that HP is reported as a percentage? */
const promisesPercentHp = (rules: string[]) => rules.some((l) => /percentage/i.test(l));

/** Every HP denominator the side actually received, from |switch| lines. */
function hpDenominators(side: string[]): number[] {
  const out: number[] = [];
  for (const l of side) {
    if (!l.startsWith("|switch|")) continue;
    const cond = l.split("|").pop() ?? "";
    const m = /^(\d+)\/(\d+)/.exec(cond);
    if (m) out.push(Number(m[2]));
  }
  return out;
}

// ══ 1 · the shipped format keeps every promise it makes ═══════════════════

describe("no rule in the shipped format contradicts the battle it introduces", () => {
  it("declares only rules whose own description is true", async () => {
    const r = await run(PROD_FORMAT);
    expect(r.throws).toEqual([]);
    expect(r.omni.some((l) => l.startsWith("|start"))).toBe(true);

    const rules = ruleLines(r.p1);
    // Both sides are told the same rules — a rule line is not side-specific,
    // which is why publishing a false one reaches everybody.
    expect(ruleLines(r.p2)).toEqual(rules);

    const denominators = hpDenominators(r.p1);
    expect(denominators.length).toBeGreaterThan(0);
    const allPercent = denominators.every((d) => d === 100);

    // THE ASSERTION. Not "the string is absent" — the promise is measured.
    if (promisesPercentHp(rules)) {
      expect(
        allPercent,
        `a declared rule says HP is shown in percentages, but the player received exact HP: ${JSON.stringify(
          r.p1.filter((l) => l.startsWith("|switch|")),
        )}`,
      ).toBe(true);
    }
    // And the state of the world today: no such promise, and HP is exact.
    expect(promisesPercentHp(rules)).toBe(false);
    expect(allPercent).toBe(false);
    expect(r.p1.some((l) => /^\|switch\|p2a: BRAVO\|Snorlax, L50.*\|235\/235$/.test(l))).toBe(true);
  }, 25_000);

  it("still declares the two clauses that were measured to change play", async () => {
    const r = await run(PROD_FORMAT, 1);
    expect(ruleLines(r.p1)).toEqual([
      "|rule|Sleep Clause Mod: Limit one foe put to sleep",
      "|rule|Endless Battle Clause: Forcing endless battles is banned",
    ]);
    // Removing the inert rule must not have removed the format's teeth.
    expect(PROD_FORMAT).toContain("Sleep Clause Mod");
    expect(PROD_FORMAT).toContain("Endless Battle Clause");
    expect(PROD_FORMAT).toContain("!Team Preview");
    expect(r.omni.some((l) => l.startsWith("|turn|"))).toBe(true);
  }, 20_000);

  it("is the format pvp.ts actually starts battles on", () => {
    // simFormatId(false) is only "the shipped format" while pvp.ts is the thing
    // calling it. Source-level pin rather than a new export: this file must not
    // widen the module's API to test it.
    const src = fs.readFileSync(path.join(process.cwd(), "src", "pvp.ts"), "utf8");
    expect(src).toContain("const SIM_FORMAT_ID = simFormatId(false)");
    expect(src).toContain('`>start {"formatid":${JSON.stringify(SIM_FORMAT_ID)}}`');
  });
});

// ══ 2 · where the false line did and did not surface ═════════════════════

describe("what the player's log actually does with a rule line", () => {
  it("drops it — the review that said the UI printed it was wrong", async () => {
    // A review reported that the client renders the rule text verbatim into the
    // player's battle log via pvpBattleView's `default` branch. It does not:
    // "rule" is listed among the decoder's deliberately-silent tags. Measured
    // here against the real client decoder — the same cross-package import
    // tests/pvpBattleView.test.ts already uses — because "the wire is wrong" and
    // "the player sees something wrong" are different severities and the fix was
    // justified on the first, not the second.
    const view = await import("../../game/src/state/pvpBattleView.js");
    const scratch = { pendingMove: null };
    const r = view.applyChunk(
      view.initialBattleView("Alice", "Bob"),
      [
        "|player|p1|Alice",
        "|rule|Sleep Clause Mod: Limit one foe put to sleep",
        "|rule|HP Percentage Mod: HP is shown in percentages",
        "|turn|1",
      ].join("\n"),
      "a",
      scratch,
    );
    expect(r.lines).toEqual([{ kind: "turn", text: "Turn 1" }]);
    expect(JSON.stringify(r.lines)).not.toMatch(/percentage/i);

    // Positive control: an UNKNOWN tag really does reach the log, so the
    // assertion above is about `rule` being handled and not about the decoder
    // dropping everything.
    const ctl = view.applyChunk(
      view.initialBattleView("Alice", "Bob"),
      "|totallyunknowntag|HP is shown in percentages",
      "a",
      { pendingMove: null },
    );
    expect(ctl.lines).toEqual([
      { kind: "info", text: "totallyunknowntag HP is shown in percentages" },
    ]);
  });

  it("keeps it in the persisted battle log, which is where it did surface", () => {
    // room.log is the omniscient channel verbatim, and endBattle snapshots it
    // into PvpMatch.battleLog, which GET /pvp/match/:id/replay serves to both
    // participants. So the false statement outlived the battle even though no
    // live UI printed it — asserted here as a property of the protocol rather
    // than of pvp.ts, which just stores what it is given.
    expect("|rule|HP Percentage Mod: HP is shown in percentages".startsWith("|rule|")).toBe(true);
    // The shipped format simply has no such line to store any more.
    expect(PROD_FORMAT).not.toContain("HP Percentage Mod");
  });
});

// ══ 3 · the control: the removed rule really did publish a false line ═════

describe("the removed rule was not a cosmetic worry", () => {
  it("reproduces the false statement when HP Percentage Mod is declared", async () => {
    const r = await run(OLD_FORMAT);
    expect(r.throws).toEqual([]);
    const rules = ruleLines(r.p1);
    // The rule was accepted — it never broke a battle, which is exactly why it
    // survived review.
    expect(r.omni.some((l) => l.startsWith("|start"))).toBe(true);
    expect(rules).toContain("|rule|HP Percentage Mod: HP is shown in percentages");
    expect(promisesPercentHp(rules)).toBe(true);
    // …and the promise is false in the same battle. This is the assertion that
    // proves section 1 is capable of failing rather than vacuously true.
    expect(hpDenominators(r.p1).every((d) => d === 100)).toBe(false);
    expect(r.p1.some((l) => l.includes("|235/235"))).toBe(true);
  }, 25_000);

  it("and removing it changed nothing else about the battle", async () => {
    // The cost side of the decision, measured rather than argued: with the rule
    // gone, both player streams and the omniscient stream are byte-identical
    // apart from the two lines that NAME the rule (its own |rule| line, and the
    // custom-rules infobox that counts them).
    const before = await run(OLD_FORMAT);
    const after = await run(PROD_FORMAT);
    // `|t:|<epoch seconds>` is wall-clock and differs between two runs that
    // straddle a second boundary; `|raw|` is the custom-rules infobox, which
    // COUNTS the rules and is asserted on separately below rather than ignored.
    const strip = (lines: string[]) => lines.filter(
      (l) => !l.startsWith("|rule|HP Percentage Mod")
        && !l.startsWith("|raw|")
        && !l.startsWith("|t:|"),
    );
    expect(strip(after.p1)).toEqual(strip(before.p1));
    expect(strip(after.p2)).toEqual(strip(before.p2));
    expect(strip(after.omni)).toEqual(strip(before.omni));
    // Damage, the thing the rule claimed to change, is identical.
    const dmg = (s: string[]) => s.filter((l) => l.startsWith("|-damage|"));
    expect(dmg(after.omni)).toEqual(dmg(before.omni));
    expect(dmg(after.omni).length).toBeGreaterThan(0);
    // The infobox difference IS the rule count, so it was not silently dropped
    // from the comparison above.
    const box = (s: string[]) => s.find((l) => l.startsWith("|raw|") && l.includes("custom rules"))!;
    expect(box(before.p1)).toContain("HP Percentage Mod");
    expect(box(after.p1)).not.toContain("HP Percentage Mod");
  }, 30_000);
});
