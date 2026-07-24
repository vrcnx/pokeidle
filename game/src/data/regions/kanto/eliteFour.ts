import type { GymLeader } from "../../../types";

// Elite Four — fought as a gauntlet at Indigo Plateau, no healing between
// fights. Defeating all four unlocks the Champion fight.
export const eliteFour: GymLeader[] = [
  {
    id: "lorelei",
    name: "Lorelei",
    title: "Elite Four",
    locationKey: "indigoPlat",
    badgeName: "",
    badgeColor: "#88aacc",
    spriteKey: "lorelei-gen3",
    team: [
      { speciesKey: "dewgong", level: 68 },
      { speciesKey: "cloyster", level: 67 },
      { speciesKey: "slowbro", level: 68 },
      { speciesKey: "jynx", level: 70 },
      { speciesKey: "lapras", level: 70 },
    ],
  },
  {
    id: "bruno",
    name: "Bruno",
    title: "Elite Four",
    locationKey: "indigoPlat",
    badgeName: "",
    badgeColor: "#cc8866",
    spriteKey: "bruno-gen3",
    team: [
      { speciesKey: "onix", level: 68 },
      { speciesKey: "hitmonchan", level: 70 },
      { speciesKey: "hitmonlee", level: 70 },
      { speciesKey: "onix", level: 71 },
      { speciesKey: "machamp", level: 73 },
    ],
  },
  {
    id: "agatha",
    name: "Agatha",
    title: "Elite Four",
    locationKey: "indigoPlat",
    badgeName: "",
    badgeColor: "#9966cc",
    spriteKey: "agatha-gen3",
    team: [
      { speciesKey: "gengar", level: 72 },
      { speciesKey: "golbat", level: 72 },
      { speciesKey: "haunter", level: 71 },
      { speciesKey: "arbok", level: 74 },
      { speciesKey: "gengar", level: 76 },
    ],
  },
  {
    id: "lance",
    name: "Lance",
    title: "Elite Four",
    locationKey: "indigoPlat",
    badgeName: "",
    badgeColor: "#dd6644",
    spriteKey: "lance-gen3",
    team: [
      { speciesKey: "gyarados", level: 76 },
      { speciesKey: "dragonair", level: 74 },
      { speciesKey: "dragonair", level: 74 },
      { speciesKey: "aerodactyl", level: 78 },
      { speciesKey: "dragonite", level: 80 },
    ],
  },
];

export const champion: GymLeader = {
  id: "blue",
  name: "Blue",
  title: "Pokemon League Champion",
  locationKey: "indigoPlat",
  badgeName: "",
  badgeColor: "#ffcc44",
  spriteKey: "blue-gen3",
  team: [
    { speciesKey: "pidgeot", level: 81 },
    { speciesKey: "alakazam", level: 79 },
    { speciesKey: "rhydon", level: 81 },
    { speciesKey: "gyarados", level: 83 },
    { speciesKey: "arcanine", level: 83 },
    { speciesKey: "venusaur", level: 85 },
  ],
};

export const rewardShopCatalog: { itemId: string; tokenCost: number }[] = [
  { itemId: "expShare",     tokenCost: 2 },
  { itemId: "firestone",    tokenCost: 1 },
  { itemId: "waterstone",   tokenCost: 1 },
  { itemId: "thunderstone", tokenCost: 1 },
  { itemId: "leafstone",    tokenCost: 1 },
  { itemId: "moonstone",    tokenCost: 2 },
  { itemId: "sunstone",     tokenCost: 2 },
];
