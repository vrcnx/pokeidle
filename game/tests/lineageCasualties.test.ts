// "I have a shiny Scyther in my Pokédex, but it's not in my PC or my party."
//
// Reported as data loss. It is not corruption — it is mergeCloudAdvance doing
// exactly what it is designed to do. `pokedexCaught` and `shinyCaught` are
// MONOTONIC and unioned from both lineages; party and box are SPENDABLE and
// taken whole from ONE. So a Pokémon caught on the lineage that loses the
// merge leaves its dex entry behind and goes with the wallet.
//
// That trade-off is deliberate and every alternative is worse (unioning the
// box resurrects Pokémon the other lineage already sold — the duplication
// exploit saveReconcile.ts documents at length). What was genuinely wrong is
// that it happened SILENTLY: a designed rollback nobody is told about is
// indistinguishable from a bug, and the player's next move is a report that
// cannot be acted on.
//
// So these tests pin two things. First, that the symptom really is reachable
// from the merge — reproduced end to end below, because a diagnosis nobody
// can re-run is a guess. Second, that the merge now names what it cost.

import { describe, expect, it } from "vitest";
import {
  lineageCasualties,
  lostMonsMessage,
  mergeCloudAdvance,
  spendableSide,
} from "../src/state/saveReconcile";

const mon = (over: Record<string, unknown> = {}) => ({
  id: "1", speciesKey: "pidgey", name: "Pidgey", level: 5, isShiny: false, ...over,
});

/** A save blob with just enough shape for the reconciler. */
const blob = (over: Record<string, unknown> = {}) => ({
  playerPokemon: mon({ id: "p0", speciesKey: "bulbasaur", name: "Bulbasaur" }),
  party: [mon({ id: "p0", speciesKey: "bulbasaur", name: "Bulbasaur" })],
  box: [],
  money: 1000,
  inventory: {},
  pokedexCaught: ["bulbasaur"],
  shinyCaught: [],
  shinySeen: [],
  wildBattlesWon: 0,
  trainerBattlesWon: 0,
  ...over,
});

const SCYTHER = mon({ id: "42", speciesKey: "scyther", name: "Scyther", level: 31, isShiny: true });

describe("the reported symptom, reproduced", () => {
  it("keeps the dex entry and drops the Pokémon", () => {
    // The player catches a shiny Scyther in this browser. Another session was
    // further ahead, so the merge takes ITS party and box.
    const local = blob({
      box: [SCYTHER],
      pokedexCaught: ["bulbasaur", "scyther"],
      shinyCaught: ["scyther"],
      shinySeen: ["scyther"],
      wildBattlesWon: 10,
    });
    const cloud = blob({ wildBattlesWon: 99 });

    const merged = mergeCloudAdvance(local, cloud);

    expect(spendableSide(local, cloud)).toBe("cloud");
    // Exactly what the player described.
    expect(merged.pokedexCaught).toContain("scyther");
    expect(merged.shinyCaught).toContain("scyther");
    expect([...merged.party, ...merged.box].map((m: any) => m.speciesKey)).not.toContain("scyther");
  });

  it("is not corruption — the dex union is what the design promises", () => {
    // Stated as a test so nobody 'fixes' this by dropping the union and
    // silently rolling back Pokédex progress instead.
    const local = blob({ pokedexCaught: ["bulbasaur", "scyther"], wildBattlesWon: 1 });
    const cloud = blob({ pokedexCaught: ["bulbasaur", "gastly"], wildBattlesWon: 50 });
    const merged = mergeCloudAdvance(local, cloud);
    expect(merged.pokedexCaught.sort()).toEqual(["bulbasaur", "gastly", "scyther"]);
  });
});

describe("the merge names what it cost", () => {
  it("reports a Pokémon only the losing lineage held", () => {
    const local = blob({ box: [SCYTHER], wildBattlesWon: 10 });
    const cloud = blob({ wildBattlesWon: 99 });
    const lost = lineageCasualties(local, cloud);
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({ speciesKey: "scyther", isShiny: true, level: 31 });
  });

  it("reports nothing when the merge cost nothing", () => {
    // The common case, and the one that must stay quiet: a fully-synced
    // browser coming back to find the server wrote (an auction settlement, a
    // gift). Local has nothing the cloud lacks.
    const local = blob({ wildBattlesWon: 5 });
    const cloud = blob({ wildBattlesWon: 5 });
    expect(lineageCasualties(local, cloud)).toEqual([]);
    expect(lostMonsMessage([])).toBeNull();
  });

  it("follows the merge's decision rather than the argument order", () => {
    // The report has to track which side actually LOST, not assume cloud
    // always wins. Same Scyther, same two blobs — only the play count moves.
    expect(spendableSide(blob({ wildBattlesWon: 80 }), blob({ wildBattlesWon: 3 }))).toBe("local");

    // Scyther on the side with MORE play: it survives, so nothing to report.
    const localWins = lineageCasualties(
      blob({ box: [SCYTHER], wildBattlesWon: 80 }),
      blob({ wildBattlesWon: 3 }),
    );
    expect(localWins).toEqual([]);

    // The same Scyther on the side with LESS play: gone, and reported.
    const localLoses = lineageCasualties(
      blob({ box: [SCYTHER], wildBattlesWon: 3 }),
      blob({ wildBattlesWon: 80 }),
    );
    expect(localLoses).toHaveLength(1);
  });

  it("does not report a Pokémon that survived in the other side's party", () => {
    const shared = mon({ id: "9", speciesKey: "gastly", name: "Gastly" });
    const local = blob({ box: [shared], wildBattlesWon: 1 });
    const cloud = blob({ party: [blob().party[0], shared], wildBattlesWon: 90 });
    expect(lineageCasualties(local, cloud)).toEqual([]);
  });

  it("still reports a collided id that is a DIFFERENT Pokémon", () => {
    // nextPokemonId is a shared counter, so two lineages that both kept
    // playing mint the same id for different Pokémon. Matching on id alone
    // would call this "still present" and hide the case most worth naming.
    const local = blob({ box: [mon({ id: "42", speciesKey: "scyther", name: "Scyther", isShiny: true })], wildBattlesWon: 1 });
    const cloud = blob({ box: [mon({ id: "42", speciesKey: "rattata", name: "Rattata" })], wildBattlesWon: 90 });
    const lost = lineageCasualties(local, cloud);
    expect(lost).toHaveLength(1);
    expect(lost[0].speciesKey).toBe("scyther");
  });

  it("puts shinies first, then the highest levels", () => {
    // The message truncates, so the order decides what a player is told
    // about. A shiny is the entry they will go looking for.
    const local = blob({
      box: [
        mon({ id: "1", speciesKey: "rattata", name: "Rattata", level: 80 }),
        mon({ id: "2", speciesKey: "scyther", name: "Scyther", level: 12, isShiny: true }),
        mon({ id: "3", speciesKey: "pidgey", name: "Pidgey", level: 40 }),
      ],
      wildBattlesWon: 1,
    });
    const lost = lineageCasualties(local, blob({ wildBattlesWon: 90 }));
    expect(lost.map((m) => m.speciesKey)).toEqual(["scyther", "rattata", "pidgey"]);
  });

  it("survives a blob with no party or box at all", () => {
    // An older build simply omits keys it never had.
    expect(() => lineageCasualties({ playerPokemon: mon() }, { playerPokemon: mon() })).not.toThrow();
    expect(lineageCasualties({}, {})).toEqual([]);
  });
});

describe("what the player is actually told", () => {
  const say = (lost: Parameters<typeof lostMonsMessage>[0]) => lostMonsMessage(lost)!;

  it("names the Pokémon rather than counting them", () => {
    // A bare count is worse than silence: the player still has to work out
    // WHICH one is gone, which is the search that produced the report.
    const m = say(lineageCasualties(blob({ box: [SCYTHER], wildBattlesWon: 1 }), blob({ wildBattlesWon: 9 })));
    expect(m).toContain("Scyther");
    expect(m).toContain("Lv31");
    expect(m).toContain("✨");
  });

  it("explains that the dex entry was kept on purpose", () => {
    // The dex entry they can still see is the whole reason this reads as
    // corruption, so the message has to account for it.
    expect(say([{ id: "1", speciesKey: "scyther", name: "Scyther", isShiny: true, level: 31 }]))
      .toMatch(/Pok(é|e)dex entries were kept/i);
  });

  it("truncates a long list instead of printing forty names", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      id: String(i), speciesKey: "pidgey", name: `Pidgey${i}`, isShiny: false, level: 10,
    }));
    const m = say(many);
    expect(m).toContain("and 6 more");
    expect(m).toContain("Pidgey0");
    expect(m).not.toContain("Pidgey8");
  });

  it("reads correctly for exactly one", () => {
    expect(say([{ id: "1", speciesKey: "pidgey", name: "Pidgey", isShiny: false, level: 3 }]))
      .toContain("This Pokémon was");
  });
});
