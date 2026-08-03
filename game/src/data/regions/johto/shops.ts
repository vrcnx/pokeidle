import type { ShopDef } from "../../../types";

// TMs follow the same rule Kanto's marts do: each town stocks the machine
// that matches what it is known for, and only the status/setup machines are
// sold at all. Goldenrod mirrors Celadon's setup staples so a player who came
// up through Johto is never sent back across the map for Swords Dance.
export const shops: Record<string, ShopDef> = {
  cherrygroveCity: {
    name: "Cherrygrove Mart",
    items: [
      { itemId: "pokeball" },
    ],
  },
  violetCity: {
    name: "Violet City Mart",
    items: [
      { itemId: "pokeball" },
      { itemId: "greatball", unlockWildBattlesWon: 50 },
      { itemId: "tm73" },
    ],
  },
  azaleaTown: {
    name: "Azalea Mart",
    items: [
      { itemId: "pokeball" },
      { itemId: "greatball" },
      { itemId: "ultraball", unlockWildBattlesWon: 150 },
      { itemId: "repel" },
      { itemId: "honey" },
      { itemId: "tm18" },
    ],
  },
  goldenrodCity: {
    name: "Goldenrod Dept. Store",
    items: [
      { itemId: "pokeball" },
      { itemId: "greatball" },
      { itemId: "ultraball" },
      { itemId: "firestone" },
      { itemId: "waterstone" },
      { itemId: "thunderstone" },
      { itemId: "leafstone" },
      { itemId: "moonstone" },
      { itemId: "sunstone" },
      { itemId: "repel" },
      { itemId: "superrepel" },
      { itemId: "maxrepel" },
      { itemId: "honey" },
      { itemId: "expShare" },
      { itemId: "linkcable" },
      // Trade-evolution catalysts (Steelix, Scizor, Kingdra, Slowking,
      // Politoed, Porygon2). Gen-4-target catalysts held back until their
      // species exist in the dex.
      { itemId: "metalcoat" },
      { itemId: "kingsrock" },
      { itemId: "dragonscale" },
      { itemId: "upgrade" },
      // EV berries — each lowers one stat's EVs by 10, so a mis-trained
      // spread can be reworked instead of the Pokémon being written off.
      { itemId: "pomegberry" },
      { itemId: "kelpsyberry" },
      { itemId: "qualotberry" },
      { itemId: "hondewberry" },
      { itemId: "grepaberry" },
      { itemId: "tamatoberry" },
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
      // The setup staples, same as Celadon.
      { itemId: "tm75" },
      { itemId: "tm83" },
      { itemId: "tm04" },
    ],
  },
  ecruteakCity: {
    name: "Ecruteak Mart",
    items: [
      { itemId: "pokeball" },
      { itemId: "greatball" },
      { itemId: "ultraball" },
      { itemId: "repel" },
      { itemId: "superrepel" },
      { itemId: "honey" },
      { itemId: "spelltag" },
      // Burned Tower, ghost country.
      { itemId: "tm61" },
    ],
  },
  olivineCity: {
    name: "Olivine Mart",
    items: [
      { itemId: "pokeball" },
      { itemId: "greatball" },
      { itemId: "ultraball" },
      { itemId: "repel" },
      { itemId: "superrepel" },
      { itemId: "maxrepel" },
      { itemId: "honey" },
      { itemId: "hardstone" },
      // Port town on the sand.
      { itemId: "tm37" },
    ],
  },
  cianwoodCity: {
    name: "Cianwood Mart",
    items: [
      { itemId: "pokeball" },
      { itemId: "greatball" },
      { itemId: "ultraball" },
      { itemId: "repel" },
      { itemId: "superrepel" },
      { itemId: "honey" },
      { itemId: "blackbelt" },
      // Fighting dojo town.
      { itemId: "tm08" },
    ],
  },
  mahoganyTown: {
    name: "Mahogany Mart",
    items: [
      { itemId: "pokeball" },
      { itemId: "greatball" },
      { itemId: "ultraball" },
      { itemId: "repel" },
      { itemId: "superrepel" },
      { itemId: "maxrepel" },
      { itemId: "honey" },
      { itemId: "nevermeltice" },
      // Gateway to the Ice gym and the Lake of Rage.
      { itemId: "tm07" },
    ],
  },
};
