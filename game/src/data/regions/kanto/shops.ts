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
//
// ── TMs ────────────────────────────────────────────────────────────────────
// Each mart stocks the machine that matches what the town is ABOUT — Thunder
// Wave where the Electric gym is, Will-O-Wisp under the ghost tower. That is
// not decoration: it means a player who wants Toxic can guess Fuchsia before
// looking it up, and a town with a mart now has a reason to be revisited.
// The department store carries the setup staples every build wants.
//
// Only the status/setup machines are sold anywhere. Every attacking TM is a
// route drop — see data/machineSources.ts for why the line is drawn there.

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
      // Rock town, rock machines.
      { itemId: "tm69" },
      { itemId: "tm37" },
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
      { itemId: "tm18" },
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
      { itemId: "tm73" },
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
      { itemId: "tm61" },
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
      { itemId: "moonstone" },
      { itemId: "sunstone" },
      { itemId: "repel" },
      { itemId: "superrepel" },
      { itemId: "maxrepel" },
      { itemId: "honey" },
      // Celadon-exclusive: the Exp. Share buff. Buying activates a
      // 300-battle timer that shares ~25% EXP per non-fainted party
      // member.
      { itemId: "expShare" },
      // Link Cable — a consumable that triggers a solo trade-evolution
      // on a held mon. Lets offline players finish the Pokédex
      // without needing a friend.
      { itemId: "linkcable" },
      // Trade-evolution catalysts. Hold + trade (or Link Cable) to evolve:
      // Steelix, Scizor, Kingdra, Slowking, Politoed, Porygon2. (Dubious Disc /
      // Protector / Electirizer / Magmarizer are held back until Porygon-Z /
      // Rhyperior / Electivire / Magmortar exist in the dex.)
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
      // The setup trio — every competitive build starts from one of these.
      { itemId: "tm75" },
      { itemId: "tm83" },
      { itemId: "tm04" },
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
      // Poison gym town.
      { itemId: "tm06" },
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
      // Volcano island.
      { itemId: "tm11" },
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
