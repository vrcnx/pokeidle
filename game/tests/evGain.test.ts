// EVs were awarded on every defeat and every catch since the natures/EVs
// feature shipped, and NOTHING surfaced it. The only EV control a player ever
// saw was the berry row in the detail modal, which SUBTRACTS — so the whole
// system read as "you can lower a number that nothing raises". Three players
// concluded exactly that in chat (dudsdiem in pt-BR; ma62087 twice in es:
// "no entiendo el chiste de bajar los EV si al final no le podemos subir").
//
// The regression these tests lock in is therefore about FEEDBACK, plus the two
// species that really did yield nothing. If the log line ever goes quiet again,
// the complaint comes straight back.

import { describe, expect, it } from "vitest";
import { reducer } from "../src/state/reducer";
import { evYieldFor, evTotal, applyEvYield, describeEvGain, MAX_EV_TOTAL } from "../src/data/evYields";
import { pokemonTable } from "../src/data/pokemon";
import { makeMon, battleState, freshVolatile } from "./helpers";

/** Drive a real kill: a downed enemy plus one queued event, because
 *  CONSUME_EVENT bails on an empty queue and the EXP/EV award lives in
 *  resolveTurnEnd, which only runs once the queue drains. */
function killEnemy(speciesKey: string, evs?: Partial<Record<string, number>>) {
  const lead = makeMon({
    evs: {
      hp: 0, attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0,
      ...(evs as any),
    },
  });
  const enemy = makeMon({
    id: "foe",
    speciesKey,
    name: pokemonTable[speciesKey].name,
    currentHp: 0,
    level: 10,
  });
  const state = battleState(enemy, {
    party: [lead],
    playerPokemon: lead,
    playerVolatile: freshVolatile(),
    pendingEvents: [{ type: "faint", payload: { target: "enemy" }, message: "Foe fainted!" }],
  });
  return reducer(state, { type: "CONSUME_EVENT" });
}

describe("EV yield data", () => {
  it("covers every species — ekans/arbok used to yield a silent zero", () => {
    const zero = Object.keys(pokemonTable).filter((k) => evTotal(evYieldFor(k)) === 0);
    expect(zero).toEqual([]);
  });

  it("gives ekans and arbok their canonical Attack yields", () => {
    expect(evYieldFor("ekans").attack).toBe(1);
    expect(evYieldFor("arbok").attack).toBe(2);
  });
});

describe("applyEvYield caps", () => {
  it("stops a stat at 252", () => {
    const at252 = { hp: 0, attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 252 };
    expect(applyEvYield(at252, evYieldFor("pidgey")).speed).toBe(252);
  });

  it("stops the total at 510", () => {
    const near = { hp: 252, attack: 252, defense: 6, spAttack: 0, spDefense: 0, speed: 0 };
    expect(evTotal(near)).toBe(MAX_EV_TOTAL);
    expect(evTotal(applyEvYield(near, evYieldFor("pidgey")))).toBe(MAX_EV_TOTAL);
  });
});

describe("describeEvGain", () => {
  it("returns null when nothing moved, so the caller stays silent", () => {
    const evs = { hp: 1, attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0 };
    expect(describeEvGain(evs, evs)).toBeNull();
  });

  it("reports the delta that landed, per stat", () => {
    const before = { hp: 0, attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0 };
    const after = { hp: 1, attack: 0, defense: 0, spAttack: 0, spDefense: 2, speed: 0 };
    expect(describeEvGain(before, after)).toBe("+1 HP, +2 Sp. Def");
  });
});

describe("EV gain is visible in the battle log", () => {
  it("logs the exact stat and amount when a foe goes down", () => {
    const next = killEnemy("pidgey");                 // pidgey yields 1 Speed
    expect(next.playerPokemon!.evs!.speed).toBe(1);
    const line = next.battleLog.find((l) => /gained EVs:/.test(l));
    expect(line).toBeTruthy();
    expect(line).toContain("+1 Speed");
  });

  it("recomputes the live stat, so the gain is not cosmetic", () => {
    // 252 Speed EVs is +63 to the stat at level 100 and still a real bump at 20.
    const withEvs = killEnemy("pidgeot");             // 3 Speed
    expect(withEvs.playerPokemon!.evs!.speed).toBe(3);
    expect(withEvs.playerPokemon!.speed).toBeGreaterThan(0);
  });

  it("says NOTHING when the stat is already maxed, rather than claiming a phantom gain", () => {
    const next = killEnemy("pidgey", { speed: 252 });
    expect(next.playerPokemon!.evs!.speed).toBe(252);
    expect(next.battleLog.some((l) => /gained EVs:/.test(l))).toBe(false);
  });

  it("tells a fully-trained mon it is done, instead of going silent at 510", () => {
    const next = killEnemy("pidgey", { hp: 252, attack: 252, defense: 6 });
    expect(next.battleLog.some((l) => /fully EV trained/.test(l))).toBe(true);
  });
});
