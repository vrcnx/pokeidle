// Listing a Pokemon must not store a save the server itself would refuse.
//
// The escrow write builds `{...save, party: filtered, box: filtered}` and
// carried `activePlayerPokemonIndex` / `playerPokemon` across untouched. Sell
// the mon at the LAST party index — which is ordinary, because the index
// tracks whoever was last switched in and handleFaint parks it on the last
// living member — and the stored index points past the end of the party.
//
// saveValidation rejects exactly that shape, and this route was the only save
// writer in the codebase that never called validateSave, so it was the one
// place that could PERSIST a blob the server would 400 coming from the player.
//
// Two things then break, neither of them visible from the listing:
//
//   * if that account later WINS an item lot, settlement rebuilds their blob
//     without touching the party, validateSave fails, and the settlement
//     cancels itself — the winner never gets the machine they paid for.
//   * every admin save-patch and item grant on the account is refused with
//     "patch produced invalid save", so the repair path is unavailable for
//     precisely the accounts that need repairing.
//
// These pin the shape rather than the route, because the shape is the defect.

import { describe, expect, it } from "vitest";
import { validateSave } from "../src/lib/saveValidation.js";

const mon = (id: string) => ({
  id, speciesKey: "pidgey", level: 10, totalExp: 100,
  maxHp: 30, currentHp: 30, attack: 12, defense: 11,
  spAttack: 10, spDefense: 10, speed: 14,
  moves: [], ivs: { hp: 0, attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0 },
});

/** A save the way the game holds it: three in party, the LAST one active. */
const before = () => {
  const party = [mon("a"), mon("b"), mon("c")];
  return {
    money: 1000, party, box: [], inventory: {},
    pokedexCaught: [], shinyCaught: [], unlockedLocations: [],
    activePlayerPokemonIndex: 2,
    playerPokemon: party[2],
    nextPokemonId: 4,
  } as Record<string, unknown>;
};

/** The OLD escrow: filter the arrays, carry everything else over. */
const escrowNaive = (save: Record<string, unknown>, sellId: string) => ({
  ...save,
  party: (save.party as any[]).filter((m) => m.id !== sellId),
  box: (save.box as any[]).filter((m) => m.id !== sellId),
});

/** The FIXED escrow: re-anchor the index and the active mon. */
const escrowFixed = (save: Record<string, unknown>, sellId: string) => {
  const party = (save.party as any[]).filter((m) => m.id !== sellId);
  const idx = Math.max(0, Math.min(Number(save.activePlayerPokemonIndex ?? 0) || 0, party.length - 1));
  return {
    ...save,
    party,
    box: (save.box as any[]).filter((m) => m.id !== sellId),
    activePlayerPokemonIndex: party.length ? idx : 0,
    playerPokemon: party.length ? party[idx] : null,
  };
};

describe("the shape the old escrow produced", () => {
  it("starts from a save the server accepts", () => {
    expect(validateSave(before()).ok).toBe(true);
  });

  it("becomes one the server REFUSES when the active mon is sold", () => {
    // This is the whole bug in one assertion: a write path produced bytes
    // that the accept path would reject.
    const bad = escrowNaive(before(), "c");
    const v = validateSave(bad);
    expect(v.ok).toBe(false);
    expect(String(v.ok ? "" : v.reason)).toMatch(/activePlayerPokemonIndex/i);
  });
});

describe("re-anchoring fixes it", () => {
  it("keeps the save valid when the ACTIVE (last) mon is sold", () => {
    expect(validateSave(escrowFixed(before(), "c")).ok).toBe(true);
  });

  it("keeps the save valid when a non-active mon is sold", () => {
    expect(validateSave(escrowFixed(before(), "a")).ok).toBe(true);
  });

  it("points playerPokemon at a mon that is actually still in the party", () => {
    // Not just in range — the same object. A stale playerPokemon is how a mon
    // that has been escrowed away stays fightable.
    const out = escrowFixed(before(), "c") as any;
    expect(out.party.some((m: any) => m.id === out.playerPokemon.id)).toBe(true);
    expect(out.party[out.activePlayerPokemonIndex].id).toBe(out.playerPokemon.id);
  });

  it("survives selling down to a single Pokemon", () => {
    const one = escrowFixed(escrowFixed(before(), "c"), "b") as any;
    expect(one.party).toHaveLength(1);
    expect(one.activePlayerPokemonIndex).toBe(0);
    expect(validateSave(one).ok).toBe(true);
  });

  it("does not throw or go negative on an empty party", () => {
    // The route refuses to empty the party, but the arithmetic must not be
    // the thing that depends on that — Math.min(idx, -1) would be -1.
    const empty = escrowFixed({ ...before(), party: [], playerPokemon: null }, "a") as any;
    expect(empty.activePlayerPokemonIndex).toBe(0);
    expect(empty.playerPokemon).toBeNull();
  });
});
