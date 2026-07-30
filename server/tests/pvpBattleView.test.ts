// The PvP battle-view reducer, driven by a REAL @pkmn/sim battle.
//
// This test lives in server/tests rather than game/tests because
// @pkmn/sim is a server dependency and the point of the test is to
// assert the client decoder against genuine simulator output. The
// decoder (game/src/state/pvpBattleView.ts) is pure TypeScript with zero
// imports, so importing it across the package boundary costs nothing.
//
// Why a real battle: a protocol decoder tested against hand-written
// lines only proves the decoder agrees with the author's memory of the
// protocol. Capturing real output already disproved two of my
// assumptions — |raw| carries HTML and |debug| carries engine internals
// ("rain water boost"), both of which would have been printed to players
// as log lines, and foe HP is reported EXACTLY in this format rather than
// as a percentage. Neither was findable by review.
//
// The battle below is seeded, so it is deterministic and the assertions
// are exact rather than "something happened".

import { describe, expect, it } from "vitest";
import { BattleStreams, Teams } from "@pkmn/sim";
import {
  initialBattleView,
  applyChunk,
  applyLine,
  parseCondition,
  parseDetails,
  type BattleView,
  type NarrationLine,
} from "../../game/src/state/pvpBattleView.js";

const P1 = [
  {
    name: "Blastoise", species: "blastoise", item: "leftovers", ability: "torrent",
    moves: ["surf", "toxic", "raindance", "icebeam"], nature: "Modest", level: 50,
    evs: { hp: 4, atk: 0, def: 0, spa: 252, spd: 0, spe: 252 },
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
  },
  {
    name: "Forretress", species: "forretress", item: "", ability: "sturdy",
    moves: ["spikes", "stealthrock", "gyroball", "toxicspikes"], nature: "Relaxed", level: 50,
    evs: { hp: 252, atk: 0, def: 252, spa: 0, spd: 4, spe: 0 },
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
  },
];
const P2 = [
  {
    name: "Charizard", species: "charizard", item: "lifeorb", ability: "blaze",
    moves: ["flamethrower", "swordsdance", "substitute", "thunderwave"], nature: "Timid", level: 50,
    evs: { hp: 4, atk: 0, def: 0, spa: 252, spd: 0, spe: 252 },
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
  },
  {
    name: "Machamp", species: "machamp", item: "", ability: "noguard",
    moves: ["rockslide", "dynamicpunch", "bulkup", "earthquake"], nature: "Adamant", level: 50,
    evs: { hp: 252, atk: 252, def: 4, spa: 0, spd: 0, spe: 0 },
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
  },
];

/**
 * Run a seeded battle and fold the p1 player stream through the decoder,
 * exactly as the client does with `battle:state` chunks.
 */
async function runBattle(): Promise<{
  view: BattleView; lines: NarrationLine[]; rawTags: Set<string>;
}> {
  const omni = new BattleStreams.BattleStream();
  const ps = BattleStreams.getPlayerStreams(omni);
  const rawTags = new Set<string>();
  let view = initialBattleView("Alice", "Bob");
  const lines: NarrationLine[] = [];
  const scratch = { pendingMove: null as NarrationLine | null };

  const reader = (async () => {
    for await (const chunk of ps.p1) {
      for (const l of chunk.split("\n")) {
        if (l.startsWith("|")) rawTags.add(l.split("|")[1] ?? "");
      }
      const r = applyChunk(view, chunk, "a", scratch);
      view = r.view;
      lines.push(...r.lines);
    }
  })();
  // Drain the other streams or the simulator back-pressures.
  void (async () => { for await (const _c of ps.omniscient) { /* drain */ } })();
  void (async () => { for await (const _c of ps.p2) { /* drain */ } })();

  // `!Team Preview` DELIBERATELY, even though production now ships the phase
  // ON: this battle exists to test the mid-battle decoder over twelve scripted
  // turns, and starting it on turn 1 keeps the script's indices meaningful. The
  // phase itself has its own describe block at the bottom of this file, driven
  // on the production format string.
  omni.write([
    `>start {"formatid":"gen5customgame@@@!Team Preview","seed":[1,2,3,4]}`,
    `>player p1 {"name":"Alice","team":${JSON.stringify(Teams.pack(P1 as never))}}`,
    `>player p2 {"name":"Bob","team":${JSON.stringify(Teams.pack(P2 as never))}}`,
  ].join("\n"));

  const script: [string, string][] = [
    ["move 2", "move 4"],   // Toxic (misses) vs Thunder Wave  → par + miss
    ["move 3", "move 3"],   // Rain Dance vs Substitute        → weather + sub
    ["move 1", "move 2"],   // Surf vs Swords Dance            → boost + super effective
    ["move 1", "move 1"],   // Surf vs Flamethrower            → resisted + Life Orb + cant(par)
    ["switch 2", "switch 2"],
    ["move 1", "move 3"],   // Spikes vs Bulk Up               → sidestart
    ["move 2", "move 1"], ["move 1", "move 4"],
    ["move 1", "move 1"], ["move 1", "move 1"], ["move 1", "move 1"], ["move 1", "move 1"],
  ];
  for (const [a, b] of script) {
    await new Promise((r) => setTimeout(r, 40));
    try { omni.write(`>p1 ${a}\n>p2 ${b}`); } catch { /* battle may already be over */ }
  }
  await new Promise((r) => setTimeout(r, 700));
  void reader;
  return { view, lines, rawTags };
}

describe("pvpBattleView — against a real seeded @pkmn/sim battle", () => {
  it("decodes the mechanics that used to be invisible", async () => {
    const { view, lines, rawTags } = await runBattle();
    const texts = lines.map((l) => l.text);
    const kinds = new Set(lines.map((l) => l.kind));

    // Sanity: the battle actually ran.
    expect(rawTags.has("move")).toBe(true);
    expect(view.turn).toBeGreaterThan(3);

    // ── The one that mattered most. `|cant|p1a: X|par` was undecoded,
    // so a full-paralysis turn silently did nothing at all.
    expect(rawTags.has("cant")).toBe(true);
    expect(kinds.has("cant")).toBe(true);
    expect(texts.some((t) => /paralyzed! It can't move/.test(t ?? ""))).toBe(true);

    // ── Type effectiveness: the core of the game, previously dropped.
    const moveLines = lines.filter((l) => l.kind === "move");
    const allTags = moveLines.flatMap((l) => l.tags ?? []);
    expect(allTags).toContain("Super effective!");
    expect(allTags).toContain("Not very effective…");

    // ── Stat stages: Swords Dance appeared to do nothing.
    expect(kinds.has("boost")).toBe(true);
    expect(texts.some((t) => /Attack sharply rose/.test(t ?? ""))).toBe(true);

    // ── Status, weather, hazards, volatiles, misses, item triggers.
    expect(texts.some((t) => /was paralyzed!/.test(t ?? ""))).toBe(true);
    expect(texts.some((t) => /Rain kicked up!/.test(t ?? ""))).toBe(true);
    expect(texts.some((t) => /missed!/.test(t ?? ""))).toBe(true);
    expect(texts.some((t) => /Substitute started/.test(t ?? ""))).toBe(true);
    expect(texts.some((t) => /hurt by Life Orb/.test(t ?? ""))).toBe(true);
    expect(texts.some((t) => /restored HP with Leftovers/.test(t ?? ""))).toBe(true);
    expect(texts.some((t) => /Spikes was set/.test(t ?? ""))).toBe(true);
  });

  it("never leaks engine internals or HTML to the player", async () => {
    const { lines, rawTags } = await runBattle();
    // Both of these are emitted by real battles. |raw| is the custom-rule
    // infobox (every battle's preamble) and |debug| is engine commentary.
    expect(rawTags.has("raw")).toBe(true);
    expect(rawTags.has("debug")).toBe(true);
    for (const l of lines) {
      expect(l.text).not.toMatch(/</);                    // no HTML
      expect(l.text).not.toMatch(/rain water boost/);     // no debug spam
      expect(l.text).not.toMatch(/^\s*$/);                // no blank lines
    }
    // And the preamble tags produce no narration at all.
    expect(lines.some((l) => /Custom Game/.test(l.text ?? ""))).toBe(false);
  });

  it("tracks weather, boosts and hazards as STATE, not just log text", async () => {
    const { view } = await runBattle();
    // Rain was set on turn 2 and has 5 turns; the battle runs past that,
    // so assert on the structured fields rather than a specific value.
    expect(view.you.player).toBe("Alice");
    // Forretress laid Spikes on the foe's side.
    expect(view.foe.hazards.spikes).toBeGreaterThanOrEqual(1);
    // Both sides have a tracked active mon with a live HP percentage.
    expect(view.you.active).not.toBeNull();
    expect(view.foe.active).not.toBeNull();
    expect(view.you.active!.hpPct).toBeGreaterThanOrEqual(0);
    expect(view.you.active!.hpPct).toBeLessThanOrEqual(100);
    // The bench is discovered as Pokémon are revealed.
    expect(view.you.bench.length).toBeGreaterThanOrEqual(2);
    expect(view.you.teamSize).toBe(2);
    expect(view.foe.teamSize).toBe(2);
  });

  it("reports exact HP for BOTH sides in this format (the assumption I got wrong)", async () => {
    const { view } = await runBattle();
    // I assumed the foe's HP would arrive as a percentage. It does not —
    // gen5customgame reports it exactly. If a future format change hides
    // it, maxHp becomes 100 and this test is the tripwire.
    expect(view.foe.active!.hpKnownExact).toBe(true);
    expect(view.foe.active!.maxHp).toBeGreaterThan(100);
  });
});

describe("pvpBattleView — state transitions that a log-walk got wrong", () => {
  const scratch = () => ({ pendingMove: null as NarrationLine | null });

  it("clears boosts and volatiles on switch-out", () => {
    // The old tracker re-walked the log and never cleared these, so a
    // fresh Pokémon could inherit the previous one's confusion or +2 Atk.
    let v = initialBattleView();
    const s = scratch();
    for (const line of [
      "|switch|p1a: Machamp|Machamp, L50, M|197/197",
      "|-boost|p1a: Machamp|atk|2",
      "|-start|p1a: Machamp|confusion",
    ]) v = applyLine(v, line, "a", s).view;
    expect(v.you.active!.boosts.atk).toBe(2);
    expect(v.you.active!.volatiles).toContain("confusion");

    v = applyLine(v, "|switch|p1a: Blastoise|Blastoise, L50, M|155/155", "a", s).view;
    expect(v.you.active!.boosts).toEqual({});
    expect(v.you.active!.volatiles).toEqual([]);
    expect(v.you.active!.speciesKey).toBe("blastoise");
  });

  it("clamps stat stages at ±6 like the real engine", () => {
    let v = initialBattleView();
    const s = scratch();
    v = applyLine(v, "|switch|p1a: Machamp|Machamp, L50, M|197/197", "a", s).view;
    for (let i = 0; i < 6; i++) v = applyLine(v, "|-boost|p1a: Machamp|atk|2", "a", s).view;
    expect(v.you.active!.boosts.atk).toBe(6);
    for (let i = 0; i < 20; i++) v = applyLine(v, "|-unboost|p1a: Machamp|atk|2", "a", s).view;
    expect(v.you.active!.boosts.atk).toBe(-6);
  });

  it("clears a cured status from the authoritative condition field", () => {
    let v = initialBattleView();
    const s = scratch();
    v = applyLine(v, "|switch|p1a: Blastoise|Blastoise, L50, M|155/155", "a", s).view;
    v = applyLine(v, "|-status|p1a: Blastoise|par", "a", s).view;
    expect(v.you.active!.status).toBe("par");
    v = applyLine(v, "|-curestatus|p1a: Blastoise|par", "a", s).view;
    expect(v.you.active!.status).toBeNull();
    // And a later damage line must not resurrect it.
    v = applyLine(v, "|-damage|p1a: Blastoise|100/155", "a", s).view;
    expect(v.you.active!.status).toBeNull();
  });

  it("stacks Spikes to 3 and no further, and clears on -sideend", () => {
    let v = initialBattleView();
    const s = scratch();
    for (let i = 0; i < 5; i++) {
      v = applyLine(v, "|-sidestart|p2: Bob|move: Spikes", "a", s).view;
    }
    expect(v.foe.hazards.spikes).toBe(3);
    v = applyLine(v, "|-sideend|p2: Bob|move: Spikes", "a", s).view;
    expect(v.foe.hazards.spikes).toBe(0);
  });

  it("keeps screens separate from hazards", () => {
    let v = initialBattleView();
    const s = scratch();
    v = applyLine(v, "|-sidestart|p1: Alice|move: Light Screen", "a", s).view;
    v = applyLine(v, "|-sidestart|p1: Alice|move: Stealth Rock", "a", s).view;
    expect(v.you.screens.lightscreen).toBe(true);
    expect(v.you.hazards.stealthrock).toBe(true);
    expect(v.you.hazards.spikes).toBe(0);
  });

  it("suppresses per-turn weather upkeep but keeps the weather", () => {
    let v = initialBattleView();
    const s = scratch();
    const set = applyLine(v, "|-weather|Sandstorm", "a", s);
    v = set.view;
    expect(set.lines).toHaveLength(1);
    expect(v.weather?.label).toBe("Sandstorm");
    // The upkeep tick fires every single turn — narrating it floods the log.
    const tick = applyLine(v, "|-weather|Sandstorm|[upkeep]", "a", s);
    expect(tick.lines).toHaveLength(0);
    expect(tick.view.weather?.label).toBe("Sandstorm");
    const clear = applyLine(tick.view, "|-weather|none", "a", s);
    expect(clear.view.weather).toBeNull();
  });

  it("attaches crit/effectiveness to the move rather than emitting stray lines", () => {
    let v = initialBattleView();
    const s = scratch();
    v = applyLine(v, "|switch|p1a: Blastoise|Blastoise, L50, M|155/155", "a", s).view;
    v = applyLine(v, "|switch|p2a: Charizard|Charizard, L50, F|154/154", "a", s).view;
    // The move is HELD, not emitted, so modifiers can decorate it.
    const mv = applyLine(v, "|move|p1a: Blastoise|Surf|p2a: Charizard", "a", s);
    expect(mv.lines).toHaveLength(0);
    v = mv.view;
    v = applyLine(v, "|-supereffective|p2a: Charizard", "a", s).view;
    v = applyLine(v, "|-crit|p2a: Charizard", "a", s).view;
    const dmg = applyLine(v, "|-damage|p2a: Charizard|40/154", "a", s);
    // Flushing on damage emits the decorated move first, then the damage.
    expect(dmg.lines[0].kind).toBe("move");
    expect(dmg.lines[0].tags).toEqual(["Super effective!", "Critical hit!"]);
    expect(dmg.lines[1].kind).toBe("damage");
  });

  it("frames narration from the viewer's seat", () => {
    const s1 = scratch();
    let v = initialBattleView();
    v = applyLine(v, "|switch|p1a: Blastoise|Blastoise, L50, M|155/155", "a", s1).view;
    const asA = applyLine(v, "|-status|p1a: Blastoise|par", "a", s1);
    expect(asA.lines[0].text).toMatch(/^Your Blastoise/);

    // Same line, viewed from the other seat, must read as the opponent's.
    const s2 = scratch();
    let v2 = initialBattleView();
    v2 = applyLine(v2, "|switch|p1a: Blastoise|Blastoise, L50, M|155/155", "b", s2).view;
    const asB = applyLine(v2, "|-status|p1a: Blastoise|par", "b", s2);
    expect(asB.lines[0].text).toMatch(/^Foe's Blastoise/);
  });

  it("uses trainer names in neutral (spectator) framing", () => {
    const s = scratch();
    let v = initialBattleView("Alice", "Bob");
    v = applyLine(v, "|switch|p1a: Blastoise|Blastoise, L50, M|155/155", "a", s, true).view;
    const r = applyLine(v, "|-status|p1a: Blastoise|par", "a", s, true);
    expect(r.lines[0].text).toMatch(/Alice's Blastoise/);
  });

  it("survives a chunk boundary splitting a move from its modifiers", () => {
    // battle:state chunks are whatever the socket delivered, so a move
    // and its |-supereffective| can land in different chunks. The scratch
    // object is what carries the pending move across that boundary.
    const s = scratch();
    let v = initialBattleView();
    v = applyChunk(v, "|switch|p1a: Blastoise|Blastoise, L50, M|155/155", "a", s).view;
    const c1 = applyChunk(v, "|move|p1a: Blastoise|Surf|p2a: Charizard", "a", s);
    expect(c1.lines).toHaveLength(0);
    const c2 = applyChunk(c1.view, "|-supereffective|p2a: Charizard\n|-damage|p2a: Charizard|40/154", "a", s);
    expect(c2.lines[0].tags).toContain("Super effective!");
  });
});

describe("pvpBattleView — parsers", () => {
  it("parses details for awkward species names", () => {
    expect(parseDetails("Mr. Mime, L50, M").speciesKey).toBe("mrmime");
    expect(parseDetails("Nidoran-F, L12, F").speciesKey).toBe("nidoranf");
    expect(parseDetails("Porygon-Z, L100").speciesKey).toBe("porygonz");
    expect(parseDetails("Farfetch'd, L30, M, shiny")).toEqual({
      speciesKey: "farfetchd", level: 30, gender: "M", shiny: true,
    });
  });

  it("parses conditions including fainted and status", () => {
    expect(parseCondition("191/258")).toMatchObject({ hp: 191, maxHp: 258, status: null, fainted: false });
    expect(parseCondition("132/155 par")).toMatchObject({ status: "par", fainted: false });
    expect(parseCondition("0 fnt")).toMatchObject({ hp: 0, hpPct: 0, fainted: true, status: null });
    expect(Math.round(parseCondition("48/100").hpPct)).toBe(48);
  });

  it("does not mistake a substring for a status code", () => {
    // "Sparkling" contains "par". Word boundaries are what stop a nickname
    // or an effect name from being read as paralysis.
    expect(parseCondition("100/100 [from] Sparkling Aria").status).toBeNull();
  });
});

// ══ Team Preview, decoded from a real battle ══════════════════════════════
//
// The three tags that used to be in the decoder's deliberately-silent list —
// |clearpoke|, |poke| and |teampreview| — because the shipped format removed
// the phase with `!Team Preview` and they could never arrive. The phase is on
// now, and these lines are the ENTIRE channel through which one side learns
// anything about the other's team, so what the decoder does with them is a
// security surface and not only a rendering one.
//
// Driven off the same real simulator as the rest of this file, on the format
// string production actually ships.

describe("pvpBattleView — Team Preview", () => {
  const preview = async () => {
    const omni = new BattleStreams.BattleStream();
    const ps = BattleStreams.getPlayerStreams(omni);
    let view = initialBattleView("Alice", "Bob");
    const lines: NarrationLine[] = [];
    const scratch = { pendingMove: null as NarrationLine | null };
    const raw: string[] = [];
    void (async () => {
      for await (const chunk of ps.p1) {
        raw.push(chunk);
        const r = applyChunk(view, chunk, "a", scratch);
        view = r.view;
        lines.push(...r.lines);
      }
    })();
    void (async () => { for await (const _c of ps.omniscient) { /* drain */ } })();
    void (async () => { for await (const _c of ps.p2) { /* drain */ } })();
    // simFormatId(true) — Team Preview ON, i.e. what production ships.
    omni.write([
      `>start {"formatid":"gen5customgame@@@Sleep Clause Mod,Endless Battle Clause","seed":[5,6,7,8]}`,
      `>player p1 {"name":"Alice","team":${JSON.stringify(Teams.pack(P1 as never))}}`,
      `>player p2 {"name":"Bob","team":${JSON.stringify(Teams.pack(P2 as never))}}`,
    ].join("\n"));
    await new Promise((r) => setTimeout(r, 250));
    return {
      get view() { return view; },
      lines,
      raw,
      lock: async (a: string, b: string) => {
        omni.write(`>p1 ${a}\n>p2 ${b}`);
        await new Promise((r) => setTimeout(r, 300));
      },
      destroy: () => { try { omni.destroy(); } catch { /* already gone */ } },
    };
  };

  it("builds both rosters from |poke| and flags the phase", async () => {
    const p = await preview();
    expect(p.view.teamPreview).toBe(true);
    // Own side and foe side, in the order the protocol sent them, with the
    // 1-based slot the `team N` choice takes.
    // Gender is part of what the phase reveals and comes straight off the
    // `details` field, so it is asserted with the value the seeded battle
    // actually produced rather than an assumed blank.
    expect(p.view.you.preview).toEqual([
      { slot: 1, speciesKey: "blastoise", level: 50, gender: "F" },
      { slot: 2, speciesKey: "forretress", level: 50, gender: "F" },
    ]);
    expect(p.view.foe.preview.map((m) => m.speciesKey)).toEqual(["charizard", "machamp"]);
    // `|teamsize|` does not arrive until both sides lock, so the roster IS the
    // count — without this the preview screen could not say how many the foe
    // has while listing them.
    expect(p.view.foe.teamSize).toBe(2);
    p.destroy();
  }, 20_000);

  it("narrates NOTHING for the phase — a roster is not a battle log", async () => {
    const p = await preview();
    // The preamble really did arrive (twelve-ish lines including four |poke|),
    // so "no narration" is a decision rather than an empty stream.
    expect(p.raw.join("\n").split("\n").filter((l) => l.startsWith("|poke|"))).toHaveLength(4);
    expect(p.lines).toEqual([]);
    p.destroy();
  }, 20_000);

  it("decodes species, level and gender — and nothing else, because nothing else is sent", async () => {
    const p = await preview();
    const foe = p.view.foe.preview[0];
    // The shape is the boundary: PreviewMon has four fields and no HP, no
    // status, no ident, no moves. A `hpPct: 100` here would be the client
    // inventing a fact the server never sent.
    expect(Object.keys(foe).sort()).toEqual(["gender", "level", "slot", "speciesKey"]);
    // P2's Charizard holds a Life Orb and P1's Blastoise holds Leftovers, so
    // the raw |poke| lines carry the held-item marker. The decoder does not
    // read it, and the SERVER strips it before it ever reaches a client —
    // this asserts the client half, which is what stops a future edit from
    // rendering it if the server ever regressed.
    expect(JSON.stringify(p.view.foe.preview)).not.toContain("item");
    expect(JSON.stringify(p.view.you.preview)).not.toContain("item");
    p.destroy();
  }, 20_000);

  it("clears the phase at |start and puts the chosen lead on the field", async () => {
    const p = await preview();
    await p.lock("team 2", "team 2");
    expect(p.view.teamPreview).toBe(false);
    // Slot 2 on both sides, which is what `team 2` means.
    expect(p.view.you.active?.speciesKey).toBe("forretress");
    expect(p.view.foe.active?.speciesKey).toBe("machamp");
    // The rosters are KEPT, not cleared: the |poke| lines arrive once and the
    // rail's "+N not yet revealed" reads against them for the rest of the
    // battle.
    expect(p.view.you.preview).toHaveLength(2);
    expect(p.view.foe.preview).toHaveLength(2);
    // And the battle narrates normally from here.
    expect(p.lines.some((l) => l.kind === "turn" && l.text === "Turn 1")).toBe(true);
    p.destroy();
  }, 20_000);

  it("rebuilds one roster, not two, when a rejoin replays the whole log", async () => {
    // A reload mid-preview replays every delivered line through the same
    // decoder. |clearpoke| RESETS rather than appends, which is the only reason
    // that produces two Pokemon a side instead of four.
    const p = await preview();
    const replayed = applyChunk(
      initialBattleView("Alice", "Bob"),
      p.raw.join("\n"),
      "a",
      { pendingMove: null as NarrationLine | null },
    );
    expect(replayed.view.you.preview).toEqual(p.view.you.preview);
    expect(replayed.view.foe.preview).toEqual(p.view.foe.preview);
    expect(replayed.view.teamPreview).toBe(true);
    // Twice through, still two a side.
    const twice = applyChunk(replayed.view, p.raw.join("\n"), "a", { pendingMove: null as NarrationLine | null });
    expect(twice.view.foe.preview).toHaveLength(2);
    p.destroy();
  }, 20_000);
});
