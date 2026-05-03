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
      { speciesKey: "dewgong", level: 54 },
      { speciesKey: "cloyster", level: 53 },
      { speciesKey: "slowbro", level: 54 },
      { speciesKey: "jynx", level: 56 },
      { speciesKey: "lapras", level: 56 },
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
      { speciesKey: "onix", level: 53 },
      { speciesKey: "hitmonchan", level: 55 },
      { speciesKey: "hitmonlee", level: 55 },
      { speciesKey: "onix", level: 56 },
      { speciesKey: "machamp", level: 58 },
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
      { speciesKey: "gengar", level: 56 },
      { speciesKey: "golbat", level: 56 },
      { speciesKey: "haunter", level: 55 },
      { speciesKey: "arbok", level: 58 },
      { speciesKey: "gengar", level: 60 },
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
      { speciesKey: "gyarados", level: 58 },
      { speciesKey: "dragonair", level: 56 },
      { speciesKey: "dragonair", level: 56 },
      { speciesKey: "aerodactyl", level: 60 },
      { speciesKey: "dragonite", level: 62 },
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
    { speciesKey: "pidgeot", level: 61 },
    { speciesKey: "alakazam", level: 59 },
    { speciesKey: "rhydon", level: 61 },
    { speciesKey: "gyarados", level: 63 },
    { speciesKey: "arcanine", level: 63 },
    { speciesKey: "venusaur", level: 65 },
  ],
};

export const rewardShopCatalog: { itemId: string; tokenCost: number }[] = [
  { itemId: "expShare",     tokenCost: 2 },
  { itemId: "firestone",    tokenCost: 1 },
  { itemId: "waterstone",   tokenCost: 1 },
  { itemId: "thunderstone", tokenCost: 1 },
  { itemId: "leafstone",    tokenCost: 1 },
  { itemId: "moonstone",    tokenCost: 2 },
];
