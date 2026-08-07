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
import { applyChunk, applyLine, initialBattleView, type NarrationLine } from "../src/state/pvpBattleView";

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

// ── THE BOARD A LINE DESCRIBES ──────────────────────────────────────
//
// One socket chunk can be a whole turn. A measured burst produced 13
// narration lines and a two-turn board jump in a single React commit — the
// foe fainted, the replacement switched in, the weather started — and the
// board was applied instantly while the text queued behind it. The player
// watched the outcome, then read about it, and the faint animation had no
// beat to play in because the replacement was already standing there.
//
// So every line now carries the board AS IT WAS when that line was decoded,
// and the arena draws THAT rather than the newest one. These tests pin the
// pairing, because a snapshot taken one line early or late is worse than no
// snapshot: it would draw a board that contradicts the sentence under it.
describe("each line carries the board it is talking about", () => {
  // The REAL applyChunk, not a re-implementation of it. An earlier draft of
  // this helper did the stamping itself, which would have passed whether or
  // not the shipped code stamped anything at all.
  const chunk = (raw: string[]) => {
    const scratch: { pendingMove: NarrationLine | null } = { pendingMove: null };
    return applyChunk(initialBattleView("You", "Rival"), raw.join("\n"), "a", scratch).lines;
  };

  it("pairs the faint line with the board in which it HAS fainted", () => {
    // Taken after the line is applied, not before. A snapshot from before
    // would render "Pidgey fainted!" over a Pidgey standing at full health.
    const out = chunk([...OPENING, "|-damage|p2a: Pidgey|0 fnt", "|faint|p2a: Pidgey"]);
    const faint = out.find((l) => l.kind === "faint");
    expect(faint?.view?.foe.active?.fainted, "faint line shows a living Pokemon").toBe(true);
  });

  it("keeps the pre-faint board on the line BEFORE the faint", () => {
    // The whole point of a per-line snapshot: consecutive lines must differ,
    // or the board is still jumping and the snapshots are decorative.
    const out = chunk([
      ...OPENING,
      "|-damage|p2a: Pidgey|60/120",
      "|-damage|p2a: Pidgey|0 fnt",
      "|faint|p2a: Pidgey",
    ]);
    const hurt = out.find((l) => l.kind === "damage");
    expect(hurt?.view?.foe.active?.fainted).toBe(false);
    expect(hurt?.view?.foe.active?.hpPct).toBe(50);
  });

  it("pairs a switch line with the board holding the NEW Pokemon", () => {
    const out = chunk([
      ...OPENING,
      "|faint|p2a: Pidgey",
      "|switch|p2a: Rattata|Rattata, L50, M|100/100",
    ]);
    const sw = out.filter((l) => l.kind === "switch").at(-1);
    expect(sw?.view?.foe.active?.name).toBe("Rattata");
    // And the faint before it still shows Pidgey — the two boards are
    // genuinely different objects, which is what lets the arena animate
    // between them.
    const faint = out.find((l) => l.kind === "faint");
    expect(faint?.view?.foe.active?.name).toBe("Pidgey");
  });
});
