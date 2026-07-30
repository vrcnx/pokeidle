// Prize rendering, against the prize rows production actually stores.
//
// Every fixture below is a verbatim copy of a `Giveaway.prizes` column read
// read-only from production (13 rows: 6 single-item, 3 multi-item, 3 pokemon,
// 0 money). What players are shown for those rows TODAY is the server's
// describePrizes() output, which emits the stored ids:
//
//     1x masterball
//     1x goldbottlecap + 2x silverbottlecap
//     1x moonstone + 1x firestone + 1x waterstone + 1x thunderstone + …
//
// These tests pin the mapping from those exact bytes to a real item name, a
// real sprite URL, and a quantity — via the same helpers the Bag and party
// already use, so a prize chip cannot drift into being its own visual
// language.

import { describe, expect, it } from "vitest";
import type { GiveawayPrize } from "../src/net/api";
import {
  prizeChips,
  describeChips,
  primaryPrizeLabel,
  formatPrizeMoney,
} from "../src/utils/prizeDisplay";

// ── the real rows ───────────────────────────────────────────────────
const MASTERBALL: GiveawayPrize[] = [{ kind: "item", itemId: "masterball", quantity: 1 }];

const BOTTLE_CAPS: GiveawayPrize[] = [
  { kind: "item", itemId: "goldbottlecap", quantity: 1 },
  { kind: "item", itemId: "silverbottlecap", quantity: 2 },
];

const STONE_BUNDLE: GiveawayPrize[] = [
  { kind: "item", itemId: "moonstone", quantity: 1 },
  { kind: "item", itemId: "firestone", quantity: 1 },
  { kind: "item", itemId: "waterstone", quantity: 1 },
  { kind: "item", itemId: "thunderstone", quantity: 1 },
  { kind: "item", itemId: "leafstone", quantity: 1 },
  { kind: "item", itemId: "sunstone", quantity: 1 },
];

const SHINY_CHARM_AND_NUGGETS: GiveawayPrize[] = [
  { kind: "item", itemId: "shinycharm", quantity: 1 },
  { kind: "item", itemId: "bignugget", quantity: 3 },
];

// Trimmed to the fields that matter; the stored blob also carries stats,
// moves, ivs, evs and ability.
const SHINY_MEW: GiveawayPrize[] = [
  {
    kind: "pokemon",
    label: "Shiny Mew (Lv70)",
    mon: {
      id: "1", speciesKey: "mew", name: "Mew", nature: "Naive", level: 70,
      totalExp: 344960, currentHp: 220, maxHp: 220, isShiny: true,
    },
  },
];

const SHINY_GENGAR: GiveawayPrize[] = [
  {
    kind: "pokemon",
    label: "Shiny Gengar Lv50",
    mon: { id: "559015", speciesKey: "gengar", name: "Gengar", level: 50, isShiny: true },
  },
];

describe("prizeChips — the single-item case (6 of 13 production rows)", () => {
  it("turns `masterball` into Master Ball with the game's own sprite", () => {
    const [chip] = prizeChips(MASTERBALL);
    expect(chip.kind).toBe("item");
    expect(chip.name).toBe("Master Ball");
    expect(chip.qty).toBe(1);
    expect(chip.known).toBe(true);
    // The kebab-case override in utils/sprites.ts — the same URL the Bag
    // renders for a Master Ball.
    expect(chip.spriteUrl).toContain("/sprites/items/master-ball.png");
  });

  it("does not print a quantity for a single item", () => {
    expect(describeChips(prizeChips(MASTERBALL))).toBe("Master Ball");
  });
});

describe("prizeChips — multi-item rows", () => {
  it("names and counts both bottle caps", () => {
    const chips = prizeChips(BOTTLE_CAPS);
    expect(chips.map((c) => [c.name, c.qty])).toEqual([
      ["Gold Bottle Cap", 1],
      ["Silver Bottle Cap", 2],
    ]);
    expect(describeChips(chips)).toBe("Gold Bottle Cap + Silver Bottle Cap ×2");
  });

  it("uses the catalog's sprite override rather than guessing the slug", () => {
    const chips = prizeChips(BOTTLE_CAPS);
    // silverbottlecap's PokeAPI file is "bottle-cap", not "silver-bottle-cap";
    // guessing would 404 it.
    expect(chips[0].spriteUrl).toContain("gold-bottle-cap.png");
    expect(chips[1].spriteUrl).toContain("/bottle-cap.png");
  });

  it("resolves every id in the six-stone bundle", () => {
    const chips = prizeChips(STONE_BUNDLE);
    expect(chips).toHaveLength(6);
    expect(chips.every((c) => c.known)).toBe(true);
    expect(chips.map((c) => c.name)).toEqual([
      "Moon Stone", "Fire Stone", "Water Stone", "Thunder Stone", "Leaf Stone", "Sun Stone",
    ]);
  });

  it("gives repeated shapes distinct keys", () => {
    const chips = prizeChips([...MASTERBALL, ...MASTERBALL]);
    expect(chips[0].key).not.toBe(chips[1].key);
  });

  it("replaces the raw string players see today", () => {
    // Production chat announced this one as "1x shinycharm + 3x bignugget".
    expect(describeChips(prizeChips(SHINY_CHARM_AND_NUGGETS)))
      .toBe("Shiny Charm + Big Nugget ×3");
  });
});

describe("prizeChips — Pokémon prizes render as Pokémon", () => {
  it("reads speciesKey and isShiny out of the stored mon blob", () => {
    const [chip] = prizeChips(SHINY_MEW);
    expect(chip.kind).toBe("pokemon");
    expect(chip.name).toBe("Shiny Mew (Lv70)");
    expect(chip.isShiny).toBe(true);
    expect(chip.known).toBe(true);
    // Animated Gen-V shiny sprite, by numeric species id (151 = Mew).
    expect(chip.spriteUrl).toContain("/shiny/151.gif");
    // …degrading to the static PNG on a different CDN subtree, exactly like
    // every other sprite in the app.
    expect(chip.fallbackSpriteUrl).toContain("/pokemon/shiny/151.png");
  });

  it("handles the label variant with no parentheses", () => {
    const [chip] = prizeChips(SHINY_GENGAR);
    expect(chip.name).toBe("Shiny Gengar Lv50");
    expect(chip.spriteUrl).toContain("/shiny/94.gif");
  });

  it("falls back to the species name when the label is blank", () => {
    const [chip] = prizeChips([{ kind: "pokemon", label: "  ", mon: { speciesKey: "mew" } }]);
    expect(chip.name).toBe("Mew");
    expect(chip.isShiny).toBe(false);
    expect(chip.spriteUrl).toContain("/151.gif");
    expect(chip.spriteUrl).not.toContain("shiny");
  });

  it("survives a pokemon prize with no mon at all", () => {
    // Pre-blob rows: the legacy shape carried only a label.
    const [chip] = prizeChips([{ kind: "pokemon", label: "Shiny Mew (Lv70)" }]);
    expect(chip.name).toBe("Shiny Mew (Lv70)");
    expect(chip.known).toBe(false);
    expect(chip.spriteUrl).toBe("");
    expect(chip.glyph).toBe("✨");
  });
});

describe("prizeChips — money", () => {
  // Never used in production across 13 giveaways, but it is in PrizeSchema
  // (up to 10,000,000) so it has to render.
  it("formats money the way the game formats money", () => {
    const [chip] = prizeChips([{ kind: "money", amount: 50000 }]);
    expect(chip.name).toBe("$50,000");
    expect(chip.qty).toBe(1);
    expect(chip.spriteUrl).toBe("");
    expect(chip.glyph).toBe("💰");
  });

  it("handles the schema ceiling and the floor", () => {
    expect(formatPrizeMoney(10_000_000)).toBe("$10,000,000");
    expect(formatPrizeMoney(1)).toBe("$1");
  });
});

describe("prizeChips — nothing renders blank", () => {
  it("shows an unknown item id rather than an empty chip", () => {
    // A visible unknown is a bug somebody can report; a blank chip is a bug
    // nobody can.
    const [chip] = prizeChips([{ kind: "item", itemId: "notarealitem", quantity: 2 }]);
    expect(chip.name).toBe("notarealitem");
    expect(chip.qty).toBe(2);
    expect(chip.known).toBe(false);
  });

  it("survives an empty, null or malformed prize list", () => {
    expect(prizeChips([])).toEqual([]);
    expect(prizeChips(null)).toEqual([]);
    expect(prizeChips(undefined)).toEqual([]);
    expect(describeChips([])).toBe("");
  });

  it("clamps a missing or nonsense quantity to at least one", () => {
    expect(prizeChips([{ kind: "item", itemId: "nugget" }])[0].qty).toBe(1);
    expect(prizeChips([{ kind: "item", itemId: "nugget", quantity: 0 }])[0].qty).toBe(1);
  });
});

describe("primaryPrizeLabel — the rail has one line", () => {
  it("prints a single prize in full", () => {
    expect(primaryPrizeLabel(MASTERBALL)).toBe("Master Ball");
  });

  it("leads with the first prize and counts the rest", () => {
    // "Moon Stone & 5 more" fits a 250px rail; the six-item string does not.
    expect(primaryPrizeLabel(STONE_BUNDLE)).toBe("Moon Stone & 5 more");
    expect(primaryPrizeLabel(BOTTLE_CAPS)).toBe("Gold Bottle Cap & 1 more");
  });

  // The regression: this used to read "Gold Bottle Cap +1", and a history row
  // three inches away reads "@a, @b, @c +9" — same sigil, one counting prizes
  // and the other counting winners the row had no space to name. Whatever the
  // wording, the one hard rule is that `+N` never counts prizes.
  it("never spends '+N' on a prize count — that notation belongs to winners", () => {
    for (const prizes of [STONE_BUNDLE, BOTTLE_CAPS, MASTERBALL]) {
      expect(primaryPrizeLabel(prizes)).not.toMatch(/\+\s*\d/);
    }
    // …and the count is still there to be read, just named.
    expect(primaryPrizeLabel(STONE_BUNDLE)).toMatch(/\b5 more$/);
  });

  it("keeps the quantity on the lead prize", () => {
    expect(primaryPrizeLabel([{ kind: "item", itemId: "bignugget", quantity: 3 }]))
      .toBe("Big Nugget ×3");
  });

  it("is empty, not 'undefined', for a prizeless row", () => {
    expect(primaryPrizeLabel([])).toBe("");
  });
});
