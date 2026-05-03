import type { BallDef } from "../types";

export const pokeballs: Record<string, BallDef> = {
    pokeball: {
      id: "pokeball",
      name: "Poke Ball",
      description: "A standard ball for catching Pokemon.",
      buyPrice: 200,
      ballModifier: 1,
    },
    greatball: {
      id: "greatball",
      name: "Great Ball",
      description: "A high-performance ball with a better catch rate.",
      buyPrice: 600,
      ballModifier: 1.5,
    },
    ultraball: {
      id: "ultraball",
      name: "Ultra Ball",
      description: "An ultra-performance ball with an even better catch rate.",
      buyPrice: 1200,
      ballModifier: 2,
    },
    masterball: {
      id: "masterball",
      name: "Master Ball",
      description: "The best ball that catches any Pokemon without fail.",
      buyPrice: null,
      ballModifier: 255,
    },
  };
