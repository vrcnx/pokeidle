import type { ConsumableDef } from "../types";

export const consumables: Record<string, ConsumableDef> = {
    expShare: {
      id: "expShare",
      name: "Exp. Share",
      // Said 3% while reducer.ts:178 shares Math.floor(exp * 0.25).
      // The item is 8x better than advertised, so players were skipping
      // the single best purchase in the game based on our own copy.
      description: "Shares 25% EXP with each non-fainted party member for 300 battles. Buy it from Celadon Dept. Store.",
      duration: 300,
      buyPrice: 20000,
    },
    repel: {
      id: "repel",
      name: "Repel",
      description: "Halves a wild Pokemon's encounter weight on the current route for 500 battles.",
      duration: 500,
      buyPrice: 2e3,
    },
    // Super/Max Repel were stocked in five marts at $500/$700 but had NO
    // entry here — so USE_EFFECT_ITEM hit `if (!def) return state` and
    // silently did nothing. Players were paying real money for a no-op,
    // repeatedly, with no feedback that anything was wrong.
    //
    // Priced/scaled as the ladder the shop already implied: longer
    // duration for more money, same halving effect.
    superrepel: {
      id: "superrepel",
      name: "Super Repel",
      description: "Halves a wild Pokemon's encounter weight on the current route for 1,000 battles.",
      duration: 1000,
      buyPrice: 500,
    },
    maxrepel: {
      id: "maxrepel",
      name: "Max Repel",
      description: "Halves a wild Pokemon's encounter weight on the current route for 2,000 battles.",
      duration: 2000,
      buyPrice: 700,
    },
    honey: {
      id: "honey",
      name: "Honey",
      description: "Doubles a wild Pokemon's encounter weight on the current route for 500 battles.",
      duration: 500,
      buyPrice: 2e3,
    },
  };
