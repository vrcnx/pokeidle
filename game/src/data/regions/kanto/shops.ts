import type { ShopDef } from "../../../types";

// Mart stocks per town. Keeps to items with real mechanics: pokeballs,
// repels/honey, evolution stones (luxury, only at the big stores). Items
// with no implementation (potions, status cures, battle items, berries)
// are intentionally omitted — they'd just be money sinks for the player.
//
// Tiering:
//   Pallet:    no mart (intentional)
//   Viridian:  basic balls
//   Pewter:    + Great Ball (gated)
//   Cerulean:  + Ultra Ball (gated), Repel, Honey
//   Vermilion: + Super Repel
//   Lavender:  + Max Repel
//   Celadon:   department store — Pokeballs, repels, all 4 buyable stones
//   Saffron:   pokeballs + repels (urban basics)
//   Fuchsia:   pokeballs + repels
//   Cinnabar:  pokeballs + Fire/Water stones (volcanic island specialty)
//   Indigo:    end-game basics — top-tier balls + max repel only

export const shops: Record<string, ShopDef> = {
  viridianCity: {
    name: "Viridian Mart",
    items: [{ itemId: "pokeball" }],
  },
  pewterCity: {
    name: "Pewter Mart",
    items: [
      { itemId: "pokeball" },
      { itemId: "greatball", unlockWildBattlesWon: 50 },
    ],
  },
  ceruleanCity: {
    name: "Cerulean Mart",
    items: [
      { itemId: "pokeball" },
      { itemId: "greatball" },
      { itemId: "ultraball", unlockWildBattlesWon: 150 },
      { itemId: "repel" },
      { itemId: "honey" },
    ],
  },
  vermilionCity: {
    name: "Vermilion Mart",
    items: [
      { itemId: "pokeball" },
      { itemId: "greatball" },
      { itemId: "ultraball" },
      { itemId: "repel" },
      { itemId: "superrepel" },
      { itemId: "honey" },
    ],
  },
  lavenderTown: {
    name: "Lavender Mart",
    items: [
      { itemId: "pokeball" },
      { itemId: "greatball" },
      { itemId: "ultraball" },
      { itemId: "repel" },
      { itemId: "superrepel" },
      { itemId: "maxrepel" },
      { itemId: "honey" },
    ],
  },
  celadonCity: {
    name: "Celadon Dept. Store",
    items: [
      { itemId: "pokeball" },
      { itemId: "greatball" },
      { itemId: "ultraball" },
      { itemId: "firestone" },
      { itemId: "waterstone" },
      { itemId: "thunderstone" },
      { itemId: "leafstone" },
      { itemId: "repel" },
      { itemId: "superrepel" },
      { itemId: "maxrepel" },
      { itemId: "honey" },
      // Celadon-exclusive: the Exp. Share buff. Buying activates a 300-battle
      // timer that shares 3% EXP per non-fainted party member.
      { itemId: "expShare" },
      // Battle held items.
      { itemId: "leftovers" },
      { itemId: "lifeorb" },
      { itemId: "focussash" },
      { itemId: "charcoal" },
      { itemId: "mysticwater" },
      { itemId: "magnet" },
      { itemId: "miracleseed" },
      { itemId: "nevermeltice" },
      { itemId: "blackbelt" },
      { itemId: "poisonbarb" },
      { itemId: "softsand" },
      { itemId: "sharpbeak" },
      { itemId: "twistedspoon" },
      { itemId: "silverpowder" },
      { itemId: "hardstone" },
      { itemId: "spelltag" },
      { itemId: "dragonfang" },
      { itemId: "blackglasses" },
      { itemId: "silkscarf" },
    ],
  },
  saffronCity: {
    name: "Saffron Mart",
    items: [
      { itemId: "pokeball" },
      { itemId: "greatball" },
      { itemId: "ultraball" },
      { itemId: "repel" },
      { itemId: "superrepel" },
      { itemId: "maxrepel" },
    ],
  },
  fuchsiaCity: {
    name: "Fuchsia Mart",
    items: [
      { itemId: "pokeball" },
      { itemId: "greatball" },
      { itemId: "ultraball" },
      { itemId: "repel" },
      { itemId: "superrepel" },
      { itemId: "maxrepel" },
    ],
  },
  cinnabarIsland: {
    name: "Cinnabar Mart",
    items: [
      { itemId: "pokeball" },
      { itemId: "greatball" },
      { itemId: "ultraball" },
      { itemId: "firestone" },
      { itemId: "waterstone" },
      { itemId: "honey" },
    ],
  },
  indigoPlat: {
    name: "Indigo Plateau Mart",
    items: [
      { itemId: "ultraball" },
      { itemId: "maxrepel" },
    ],
  },
};
