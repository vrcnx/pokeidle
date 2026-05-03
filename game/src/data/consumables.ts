import type { ConsumableDef } from "../types";

export const consumables: Record<string, ConsumableDef> = {
    expShare: {
      id: "expShare",
      name: "Exp. Share",
      description: "Shares 3% EXP with each non-fainted party member for 300 battles. Buy it from Celadon Dept. Store.",
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
    honey: {
      id: "honey",
      name: "Honey",
      description: "Doubles a wild Pokemon's encounter weight on the current route for 500 battles.",
      duration: 500,
      buyPrice: 2e3,
    },
  };
