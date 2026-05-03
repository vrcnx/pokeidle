import type { EvolutionStone } from "../types";

// Legacy table — IDs match the inventory keys in itemsCatalog.ts.
// Kept here for back-compat with anywhere that resolves a stone by id.
export const evolutionStones: Record<string, EvolutionStone> = {
    thunderstone: { id: "thunderstone", name: "Thunder Stone", description: "Evolves certain Electric-type Pokemon." },
    firestone:    { id: "firestone",    name: "Fire Stone",    description: "Evolves certain Fire-type Pokemon." },
    waterstone:   { id: "waterstone",   name: "Water Stone",   description: "Evolves certain Water-type Pokemon." },
    leafstone:    { id: "leafstone",    name: "Leaf Stone",    description: "Evolves certain Grass-type Pokemon." },
    moonstone:    { id: "moonstone",    name: "Moon Stone",    description: "Evolves certain Pokemon." },
    sunstone:     { id: "sunstone",     name: "Sun Stone",     description: "Evolves certain Pokemon." },
  };
