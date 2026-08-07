// What the message box says when HP moves.
//
// The decoder turns `|-damage|` into a sentence, and two of the sentences it
// produced read as bugs to a player:
//
//   "Foe's Pidgey lost 100% HP."   directly above   "Foe's Pidgey fainted!"
//   "Foe's Pidgey lost 0% HP."     for sub-1% chip damage
//
// The first is one event reported twice, and the first telling is in a
// register no Pokémon game has ever used. The second is a rounding artefact
// that reads as the game failing to do anything.
//
// Real protocol lines through the real decoder — the same harness
// pvpMoveEffects.test.ts uses — because the thing under test is the sentence
// a player actually sees, and hand-writing it here would test a copy.

import { describe, expect, it } from "vitest";
import { applyLine, initialBattleView, type NarrationLine } from "../src/state/pvpBattleView";

function narrate(lines: string[], mySide: "a" | "b" = "a"): NarrationLine[] {
  let view = initialBattleView("You", "Rival");
  const scratch: { pendingMove: NarrationLine | null } = { pendingMove: null };
  const out: NarrationLine[] = [];
  for (const raw of lines) {
    const r = applyLine(view, raw, mySide, scratch);
    view = r.view;
    out.push(...r.lines);
  }
  if (scratch.pendingMove) out.push(scratch.pendingMove);
  return out;
}

const OPENING = [
  "|player|p1|You|1|1200",
  "|player|p2|Rival|2|1180",
  "|switch|p1a: Espeon|Espeon, L50, M|155/155",
  "|switch|p2a: Pidgey|Pidgey, L50, F|120/120",
];

const texts = (ls: NarrationLine[]) => ls.map((l) => l.text);

describe("a lethal hit", () => {
  it("does not narrate the damage and the faint separately", () => {
    const out = texts(narrate([...OPENING, "|-damage|p2a: Pidgey|0 fnt", "|faint|p2a: Pidgey"]));
    // The faint line is the better of the two tellings, so it is the one kept.
    expect(out.some((t) => /fainted/.test(t))).toBe(true);
    expect(out.some((t) => /lost .*HP/.test(t)), `redundant damage line: ${out.join(" | ")}`).toBe(false);
  });

  it("never says 100% HP", () => {
    // The exact string reported. 100% is only ever reachable by a hit that
    // kills from full, which is precisely the case above.
    const out = texts(narrate([...OPENING, "|-damage|p2a: Pidgey|0 fnt", "|faint|p2a: Pidgey"]));
    expect(out.join(" ")).not.toContain("100% HP");
  });

  it("still names the CAUSE when the kill is attributed", () => {
    // "was hurt by Spikes" then "fainted" reads correctly: the first line
    // carries why, the second carries what. Only the unattributed telling is
    // redundant, so only that one is dropped.
    const out = texts(narrate([
      ...OPENING,
      "|-damage|p2a: Pidgey|0 fnt|[from] Spikes",
      "|faint|p2a: Pidgey",
    ]));
    expect(out.some((t) => /hurt by Spikes/.test(t)), out.join(" | ")).toBe(true);
    expect(out.some((t) => /fainted/.test(t))).toBe(true);
  });
});

describe("damage too small to round to a percent", () => {
  it("says a little HP rather than 0%", () => {
    // 120/120 -> 120/120 is not reachable, so use a 1hp chip on a big pool:
    // 500/500 -> 499/500 is 0.2%, which rounds to 0.
    const out = texts(narrate([
      "|player|p1|You|1|1200",
      "|player|p2|Rival|2|1180",
      "|switch|p1a: Espeon|Espeon, L50, M|155/155",
      "|switch|p2a: Blissey|Blissey, L50, F|500/500",
      "|-damage|p2a: Blissey|499/500",
    ]));
    const line = out.find((t) => /Blissey/.test(t) && /HP|little/.test(t));
    expect(line, out.join(" | ")).toBeDefined();
    expect(line).not.toContain("0% HP");
    expect(line).toContain("a little HP");
  });

  it("still gives a percentage when there is one worth giving", () => {
    const out = texts(narrate([...OPENING, "|-damage|p2a: Pidgey|60/120"]));
    expect(out.some((t) => /lost 50% HP/.test(t)), out.join(" | ")).toBe(true);
  });
});
