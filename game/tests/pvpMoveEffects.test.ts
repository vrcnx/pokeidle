// PvP move effects, driven end-to-end from real protocol lines.
//
// The arena had zero animation. The fix drives the IDLE game's existing
// `.move-anim` system from PvP narration, and the risky part is not the CSS —
// every rule in app.css is globally scoped, so emitting the class names is all
// that is needed — but the three translations in between:
//
//   1. `NarrationLine` carries only composed text, so the move has to be read
//      back out of the sentence the decoder built. That makes the decoder's
//      phrasing a CONTRACT, so these tests feed real protocol lines through the
//      real `applyLine` rather than hand-writing the sentence. If
//      pvpBattleView.ts is ever rephrased, this fails loudly instead of the
//      effects silently stopping.
//   2. The protocol speaks Showdown's flat ids while `archetypeFor`'s signature
//      overrides and `SHAKE_MOVES` are keyed on the idle game's camelCase ones,
//      so Hyper Beam and Self-Destruct would lose their signature effect AND
//      their screen shake if looked up naively.
//   3. Aim. A self-buff has to put its aura on the USER, and the narration does
//      not say who the target was.

import { describe, expect, it } from "vitest";
import { applyLine, initialBattleView, type NarrationLine } from "../src/state/pvpBattleView";
import {
  effectForNarration,
  bannerForNarration,
  moveNameFromNarration,
  idleMoveKey,
  toMoveId,
} from "../src/utils/pvpMoveEffects";
import { SHAKE_MOVES } from "../src/utils/moveEffects";
import { displayNarration } from "../src/utils/pvpNarrationText";

/** Fold real protocol lines through the real decoder and return the narration
 *  it produced, exactly as state/pvp.ts's `battle:state` handler would. */
function narrate(lines: string[], mySide: "a" | "b" = "a"): { lines: NarrationLine[]; view: ReturnType<typeof initialBattleView> } {
  let view = initialBattleView("You", "Rival");
  const scratch: { pendingMove: NarrationLine | null } = { pendingMove: null };
  const out: NarrationLine[] = [];
  for (const raw of lines) {
    const r = applyLine(view, raw, mySide, scratch);
    view = r.view;
    out.push(...r.lines);
  }
  if (scratch.pendingMove) out.push(scratch.pendingMove);
  return { lines: out, view };
}

const OPENING = [
  "|player|p1|You|1|1200",
  "|player|p2|Rival|2|1180",
  "|teamsize|p1|6",
  "|teamsize|p2|6",
  "|switch|p1a: Espeon|Espeon, L50, F|180/180",
  "|switch|p2a: Tyranitar|Tyranitar, L50, M|200/200",
  "|turn|1",
];

function moveLineFor(protocol: string[], mySide: "a" | "b" = "a"): NarrationLine {
  const { lines } = narrate([...OPENING, ...protocol], mySide);
  const move = lines.filter((l) => l.kind === "move").pop();
  if (!move) throw new Error("no move line was produced");
  return move;
}

describe("reading the move back out of the decoder's own sentence", () => {
  it("recovers the move from a real |move| line", () => {
    const line = moveLineFor(["|move|p1a: Espeon|Shadow Ball|p2a: Tyranitar"]);
    expect(line.text).toBe("Your Espeon used Shadow Ball!");
    expect(moveNameFromNarration(line.text)).toBe("Shadow Ball");
  });

  it("recovers it for the opponent's move too", () => {
    const line = moveLineFor(["|move|p2a: Tyranitar|Crunch|p1a: Espeon"]);
    expect(line.text).toBe("Foe's Tyranitar used Crunch!");
    expect(moveNameFromNarration(line.text)).toBe("Crunch");
  });

  it("survives a nickname containing the word 'used'", () => {
    // The `.*` in the parser is greedy so it binds to the LAST " used ".
    expect(moveNameFromNarration("Your what I used to be used Shadow Ball!")).toBe("Shadow Ball");
  });

  it("returns null rather than a wrong answer for a non-move line", () => {
    expect(moveNameFromNarration("Foe's Tyranitar fainted!")).toBeNull();
    expect(moveNameFromNarration("")).toBeNull();
  });
});

describe("archetype selection from a live battle's own lines", () => {
  it("picks the type-driven special archetype and aims it at the foe", () => {
    const eff = effectForNarration(moveLineFor(["|move|p1a: Espeon|Shadow Ball|p2a: Tyranitar"]), "a");
    expect(eff).not.toBeNull();
    expect(eff!.archetype).toBe("ghost-special");
    expect(eff!.target).toBe("enemy");
    expect(eff!.shake).toBe(false);
    // The Ghost type colour, so the aura/impact overlays tint correctly.
    expect(eff!.typeColor).toBe("#705898");
  });

  it("flips the aim when the OPPONENT attacks", () => {
    const eff = effectForNarration(moveLineFor(["|move|p2a: Tyranitar|Crunch|p1a: Espeon"]), "a");
    expect(eff!.archetype).toBe("physical-impact");
    expect(eff!.target).toBe("player");
  });

  it("aims from the right seat when we are p2", () => {
    const eff = effectForNarration(
      moveLineFor(["|move|p2a: Tyranitar|Crunch|p1a: Espeon"], "b"),
      "b",
    );
    // Same protocol line, opposite seat: now it is OUR Tyranitar attacking.
    expect(eff!.target).toBe("enemy");
  });

  it("puts a self-buff's aura on the user, not across the field", () => {
    // This is the case the category alone gets wrong: a status move defaults to
    // the foe, so Swords Dance would have flashed on the opponent.
    const eff = effectForNarration(moveLineFor(["|move|p1a: Espeon|Swords Dance|p1a: Espeon"]), "a");
    expect(eff!.archetype).toBe("status-aura");
    expect(eff!.target).toBe("player");
  });

  it("puts a screen on the caster's own side", () => {
    const eff = effectForNarration(moveLineFor(["|move|p1a: Espeon|Reflect|p1a: Espeon"]), "a");
    expect(eff!.target).toBe("player");
  });

  it("still aims an offensive status move at the foe", () => {
    const eff = effectForNarration(moveLineFor(["|move|p1a: Espeon|Thunder Wave|p2a: Tyranitar"]), "a");
    expect(eff!.archetype).toBe("status-aura");
    expect(eff!.target).toBe("enemy");
  });

  it("aims a hazard at the foe's side", () => {
    const eff = effectForNarration(moveLineFor(["|move|p1a: Espeon|Stealth Rock|p2a: Tyranitar"]), "a");
    expect(eff!.target).toBe("enemy");
  });

  it("produces no effect for a line that is not a move", () => {
    const { lines } = narrate([...OPENING, "|faint|p2a: Tyranitar"]);
    const faint = lines.find((l) => l.kind === "faint")!;
    expect(effectForNarration(faint, "a")).toBeNull();
  });

  it("degrades to null rather than throwing on a move the table does not know", () => {
    const eff = effectForNarration(
      { kind: "move", text: "Your Espeon used Totally Fake Move!", side: "a" },
      "a",
    );
    expect(eff).toBeNull();
  });
});

describe("the casing trap: Showdown ids vs the idle game's keys", () => {
  it("maps flat protocol ids onto the idle game's camelCase keys", () => {
    expect(idleMoveKey("hyperbeam")).toBe("hyperBeam");
    expect(idleMoveKey("solarbeam")).toBe("solarBeam");
    expect(idleMoveKey("selfdestruct")).toBe("selfDestruct");
    // Already-flat ids are left alone.
    expect(idleMoveKey("earthquake")).toBe("earthquake");
    expect(idleMoveKey("crunch")).toBe("crunch");
  });

  it("normalises display names the way the rest of the stack does", () => {
    expect(toMoveId("Shadow Ball")).toBe("shadowball");
    expect(toMoveId("Self-Destruct")).toBe("selfdestruct");
    expect(toMoveId("Hyper Beam")).toBe("hyperbeam");
  });

  it("gives Hyper Beam its signature effect AND its shake", () => {
    // Looked up as "hyperbeam" this fell through to generic-flash with no shake,
    // silently, for every signature move in the game.
    const eff = effectForNarration(moveLineFor(["|move|p1a: Espeon|Hyper Beam|p2a: Tyranitar"]), "a");
    expect(eff!.archetype).toBe("hyper-beam");
    expect(eff!.shake).toBe(true);
  });

  it("gives Solar Beam its signature effect", () => {
    const eff = effectForNarration(moveLineFor(["|move|p1a: Espeon|Solar Beam|p2a: Tyranitar"]), "a");
    expect(eff!.archetype).toBe("solar-beam");
  });

  it("gives Self-Destruct the explosion", () => {
    const eff = effectForNarration(moveLineFor(["|move|p1a: Espeon|Self-Destruct|p2a: Tyranitar"]), "a");
    expect(eff!.archetype).toBe("explosion");
    expect(eff!.shake).toBe(true);
  });

  it("shakes the scene on Earthquake, which needed no remapping", () => {
    const eff = effectForNarration(moveLineFor(["|move|p1a: Espeon|Earthquake|p2a: Tyranitar"]), "a");
    expect(eff!.shake).toBe(true);
    expect(eff!.archetype).toBe("physical-impact");
  });

  it("every SHAKE_MOVES entry is reachable from its protocol id", () => {
    // The guard that keeps the two vocabularies in sync: if a shake move is ever
    // added under a key the protocol cannot produce, this fails.
    for (const key of SHAKE_MOVES) {
      expect(idleMoveKey(toMoveId(key))).toBe(key);
    }
  });
});

describe("the effectiveness / crit banner", () => {
  it("reads the tags the decoder attaches to the move line", () => {
    const line = moveLineFor([
      "|move|p2a: Tyranitar|Crunch|p1a: Espeon",
      "|-supereffective|p1a: Espeon",
      "|-crit|p1a: Espeon",
      "|-damage|p1a: Espeon|54/180",
    ]);
    expect(line.tags).toEqual(["Super effective!", "Critical hit!"]);
    // Crit wins the headline over effectiveness, matching the idle game's own
    // EffectivenessFlash exactly.
    expect(bannerForNarration(line)).toEqual({ kind: "crit", text: "Critical hit!" });
  });

  it("shows super-effective on its own", () => {
    const line = moveLineFor([
      "|move|p1a: Espeon|Psychic|p2a: Tyranitar",
      "|-supereffective|p2a: Tyranitar",
    ]);
    expect(bannerForNarration(line)).toEqual({ kind: "se", text: "Super effective!" });
  });

  it("shows not-very-effective", () => {
    const line = moveLineFor([
      "|move|p1a: Espeon|Psychic|p2a: Tyranitar",
      "|-resisted|p2a: Tyranitar",
    ]);
    expect(bannerForNarration(line)!.kind).toBe("nve");
  });

  it("shows nothing for a neutral hit", () => {
    const line = moveLineFor(["|move|p1a: Espeon|Shadow Ball|p2a: Tyranitar"]);
    expect(bannerForNarration(line)).toBeNull();
  });
});

describe("the |win| phrasing, which the message box puts centre-screen", () => {
  it("was ungrammatical for the local player and is fixed at render time", () => {
    const { lines, view } = narrate([...OPENING, "|win|You"]);
    const win = lines.find((l) => l.kind === "win")!;
    // The decoder's own text — third-person, and wrong for our own name. This is
    // an assertion ABOUT the upstream bug, not an endorsement of it: it is what
    // makes the fix below meaningful and it will fail if the decoder is fixed.
    expect(win.text).toBe("You wins!");
    expect(displayNarration(win, view)).toBe("You win!");
  });

  it("keeps third person for the opponent", () => {
    const { lines, view } = narrate([...OPENING, "|win|Rival"]);
    const win = lines.find((l) => l.kind === "win")!;
    expect(displayNarration(win, view)).toBe("Rival wins!");
  });

  it("leaves every other line untouched", () => {
    const { lines, view } = narrate([...OPENING, "|faint|p2a: Tyranitar"]);
    for (const l of lines) {
      if (l.kind !== "win") expect(displayNarration(l, view)).toBe(l.text);
    }
  });

  it("falls back to the decoder's text for an unrecognised winner", () => {
    const { view } = narrate(OPENING);
    const line: NarrationLine = { kind: "win", text: "Somebody Else wins!" };
    expect(displayNarration(line, view)).toBe("Somebody Else wins!");
  });
});
