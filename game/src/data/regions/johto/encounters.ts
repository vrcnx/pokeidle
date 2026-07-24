export const encounters: Record<string, { name: string; encounters: { speciesKey: string; weight: number; minLevel: number; maxLevel: number }[] }> = {
  route29: {
    name: "Route 29",
    encounters: [
      { speciesKey: "pidgey", weight: 25, minLevel: 40, maxLevel: 42 },
      { speciesKey: "sentret", weight: 22, minLevel: 40, maxLevel: 42 },
      { speciesKey: "rattata", weight: 20, minLevel: 40, maxLevel: 42 },
      { speciesKey: "hoothoot", weight: 15, minLevel: 40, maxLevel: 42 },
      { speciesKey: "hoppip", weight: 3, minLevel: 40, maxLevel: 42 },
    ],
  },
  route30: {
    name: "Route 30",
    encounters: [
      { speciesKey: "caterpie", weight: 25, minLevel: 41, maxLevel: 43 },
      { speciesKey: "weedle", weight: 25, minLevel: 41, maxLevel: 43 },
      { speciesKey: "pidgey", weight: 22, minLevel: 41, maxLevel: 43 },
      { speciesKey: "hoothoot", weight: 12, minLevel: 41, maxLevel: 43 },
      { speciesKey: "spinarak", weight: 10, minLevel: 41, maxLevel: 43 },
    ],
  },
  route31: {
    name: "Route 31",
    encounters: [
      { speciesKey: "rattata", weight: 25, minLevel: 42, maxLevel: 44 },
      { speciesKey: "bellsprout", weight: 22, minLevel: 42, maxLevel: 44 },
      { speciesKey: "hoothoot", weight: 15, minLevel: 42, maxLevel: 44 },
      { speciesKey: "spinarak", weight: 12, minLevel: 42, maxLevel: 44 },
      { speciesKey: "zubat", weight: 5, minLevel: 42, maxLevel: 44 },
    ],
  },
  sproutTower: {
    name: "Sprout Tower",
    encounters: [
      { speciesKey: "gastly", weight: 25, minLevel: 42, maxLevel: 45 },
      { speciesKey: "rattata", weight: 15, minLevel: 42, maxLevel: 45 },
    ],
  },
  route32: {
    name: "Route 32",
    encounters: [
      { speciesKey: "rattata", weight: 20, minLevel: 43, maxLevel: 46 },
      { speciesKey: "ekans", weight: 18, minLevel: 43, maxLevel: 46 },
      { speciesKey: "wooper", weight: 18, minLevel: 43, maxLevel: 46 },
      { speciesKey: "bellsprout", weight: 15, minLevel: 43, maxLevel: 46 },
      { speciesKey: "zubat", weight: 10, minLevel: 43, maxLevel: 46 },
      { speciesKey: "hoppip", weight: 10, minLevel: 43, maxLevel: 46 },
      { speciesKey: "mareep", weight: 8, minLevel: 43, maxLevel: 46 },
      { speciesKey: "pidgey", weight: 5, minLevel: 43, maxLevel: 46 },
      { speciesKey: "hoothoot", weight: 5, minLevel: 43, maxLevel: 46 },
      { speciesKey: "gastly", weight: 3, minLevel: 43, maxLevel: 46 },
    ],
  },
  ruinsOfAlph: {
    name: "Ruins of Alph",
    encounters: [
      { speciesKey: "natu", weight: 25, minLevel: 45, maxLevel: 48 },
      { speciesKey: "smeargle", weight: 10, minLevel: 45, maxLevel: 48 },
      { speciesKey: "wooper", weight: 5, minLevel: 45, maxLevel: 48 },
      { speciesKey: "quagsire", weight: 5, minLevel: 45, maxLevel: 48 },
    ],
  },
  unionCave: {
    name: "Union Cave",
    encounters: [
      { speciesKey: "zubat", weight: 25, minLevel: 46, maxLevel: 49 },
      { speciesKey: "geodude", weight: 22, minLevel: 46, maxLevel: 49 },
      { speciesKey: "sandshrew", weight: 20, minLevel: 46, maxLevel: 49 },
      { speciesKey: "rattata", weight: 15, minLevel: 46, maxLevel: 49 },
      { speciesKey: "onix", weight: 8, minLevel: 46, maxLevel: 49 },
    ],
  },
  route33: {
    name: "Route 33",
    encounters: [
      { speciesKey: "zubat", weight: 25, minLevel: 47, maxLevel: 49 },
      { speciesKey: "rattata", weight: 20, minLevel: 47, maxLevel: 49 },
      { speciesKey: "spearow", weight: 20, minLevel: 47, maxLevel: 49 },
      { speciesKey: "geodude", weight: 15, minLevel: 47, maxLevel: 49 },
      { speciesKey: "hoppip", weight: 10, minLevel: 47, maxLevel: 49 },
      { speciesKey: "ekans", weight: 5, minLevel: 47, maxLevel: 49 },
    ],
  },
  slowpokeWell: {
    name: "Slowpoke Well",
    encounters: [
      { speciesKey: "zubat", weight: 28, minLevel: 47, maxLevel: 50 },
      { speciesKey: "slowpoke", weight: 14, minLevel: 47, maxLevel: 50 },
      { speciesKey: "golbat", weight: 5, minLevel: 47, maxLevel: 50 },
    ],
  },
  ilexForest: {
    name: "Ilex Forest",
    encounters: [
      { speciesKey: "oddish", weight: 20, minLevel: 48, maxLevel: 51 },
      { speciesKey: "caterpie", weight: 18, minLevel: 48, maxLevel: 51 },
      { speciesKey: "weedle", weight: 18, minLevel: 48, maxLevel: 51 },
      { speciesKey: "zubat", weight: 15, minLevel: 48, maxLevel: 51 },
      { speciesKey: "venonat", weight: 15, minLevel: 48, maxLevel: 51 },
      { speciesKey: "metapod", weight: 8, minLevel: 48, maxLevel: 51 },
      { speciesKey: "kakuna", weight: 8, minLevel: 48, maxLevel: 51 },
      { speciesKey: "paras", weight: 6, minLevel: 48, maxLevel: 51 },
      { speciesKey: "psyduck", weight: 5, minLevel: 48, maxLevel: 51 },
      { speciesKey: "hoothoot", weight: 5, minLevel: 48, maxLevel: 51 },
      { speciesKey: "pidgey", weight: 3, minLevel: 48, maxLevel: 51 },
    ],
  },
  route34: {
    name: "Route 34",
    encounters: [
      { speciesKey: "rattata", weight: 20, minLevel: 49, maxLevel: 52 },
      { speciesKey: "pidgey", weight: 18, minLevel: 49, maxLevel: 52 },
      { speciesKey: "drowzee", weight: 18, minLevel: 49, maxLevel: 52 },
      { speciesKey: "hoothoot", weight: 15, minLevel: 49, maxLevel: 52 },
      { speciesKey: "jigglypuff", weight: 8, minLevel: 49, maxLevel: 52 },
      { speciesKey: "abra", weight: 6, minLevel: 49, maxLevel: 52 },
      { speciesKey: "ditto", weight: 3, minLevel: 49, maxLevel: 52 },
    ],
  },
  route35: {
    name: "Route 35",
    encounters: [
      { speciesKey: "pidgey", weight: 20, minLevel: 51, maxLevel: 54 },
      { speciesKey: "drowzee", weight: 18, minLevel: 51, maxLevel: 54 },
      { speciesKey: "hoothoot", weight: 18, minLevel: 51, maxLevel: 54 },
      { speciesKey: "snubbull", weight: 15, minLevel: 51, maxLevel: 54 },
      { speciesKey: "psyduck", weight: 12, minLevel: 51, maxLevel: 54 },
      { speciesKey: "growlithe", weight: 8, minLevel: 51, maxLevel: 54 },
      { speciesKey: "jigglypuff", weight: 5, minLevel: 51, maxLevel: 54 },
    ],
  },
  nationalPark: {
    name: "National Park",
    encounters: [
      { speciesKey: "ledyba", weight: 15, minLevel: 52, maxLevel: 55 },
      { speciesKey: "spinarak", weight: 15, minLevel: 52, maxLevel: 55 },
      { speciesKey: "sunkern", weight: 15, minLevel: 52, maxLevel: 55 },
      { speciesKey: "hoothoot", weight: 15, minLevel: 52, maxLevel: 55 },
      { speciesKey: "psyduck", weight: 12, minLevel: 52, maxLevel: 55 },
      { speciesKey: "nidoranF", weight: 10, minLevel: 52, maxLevel: 55 },
      { speciesKey: "nidoranM", weight: 10, minLevel: 52, maxLevel: 55 },
      { speciesKey: "venonat", weight: 8, minLevel: 52, maxLevel: 55 },
      { speciesKey: "pidgey", weight: 6, minLevel: 52, maxLevel: 55 },
      { speciesKey: "caterpie", weight: 3, minLevel: 52, maxLevel: 55 },
      { speciesKey: "weedle", weight: 3, minLevel: 52, maxLevel: 55 },
      // The Johto starters you didn't pick, as a very rare preserve spawn
      // (~0.9% each) — mirrors how the Kanto trio is obtainable in the Safari
      // Zone. Players had no way at all to complete the starter lines before.
      { speciesKey: "chikorita", weight: 1, minLevel: 52, maxLevel: 55 },
      { speciesKey: "cyndaquil", weight: 1, minLevel: 52, maxLevel: 55 },
      { speciesKey: "totodile", weight: 1, minLevel: 52, maxLevel: 55 },
    ],
  },
  route36: {
    name: "Route 36",
    encounters: [
      { speciesKey: "hoothoot", weight: 22, minLevel: 52, maxLevel: 55 },
      { speciesKey: "pidgey", weight: 20, minLevel: 52, maxLevel: 55 },
      { speciesKey: "ledyba", weight: 15, minLevel: 52, maxLevel: 55 },
      { speciesKey: "spinarak", weight: 15, minLevel: 52, maxLevel: 55 },
      { speciesKey: "bellsprout", weight: 12, minLevel: 52, maxLevel: 55 },
      { speciesKey: "growlithe", weight: 5, minLevel: 52, maxLevel: 55 },
      { speciesKey: "gastly", weight: 3, minLevel: 52, maxLevel: 55 },
    ],
  },
  route37: {
    name: "Route 37",
    encounters: [
      { speciesKey: "pidgey", weight: 20, minLevel: 54, maxLevel: 57 },
      { speciesKey: "growlithe", weight: 20, minLevel: 54, maxLevel: 57 },
      { speciesKey: "stantler", weight: 18, minLevel: 54, maxLevel: 57 },
      { speciesKey: "ledyba", weight: 12, minLevel: 54, maxLevel: 57 },
      { speciesKey: "spinarak", weight: 12, minLevel: 54, maxLevel: 57 },
    ],
  },
  bellTower: {
    name: "Bell Tower (Tin Tower)",
    encounters: [
      { speciesKey: "gastly", weight: 25, minLevel: 56, maxLevel: 59 },
      { speciesKey: "rattata", weight: 15, minLevel: 56, maxLevel: 59 },
    ],
  },
  burnedTower: {
    name: "Burned Tower",
    encounters: [
      { speciesKey: "koffing", weight: 25, minLevel: 55, maxLevel: 58 },
      { speciesKey: "rattata", weight: 20, minLevel: 55, maxLevel: 58 },
      { speciesKey: "zubat", weight: 12, minLevel: 55, maxLevel: 58 },
      { speciesKey: "raticate", weight: 5, minLevel: 55, maxLevel: 58 },
      { speciesKey: "weezing", weight: 2, minLevel: 55, maxLevel: 58 },
    ],
  },
  route38: {
    name: "Route 38",
    encounters: [
      { speciesKey: "meowth", weight: 22, minLevel: 58, maxLevel: 60 },
      { speciesKey: "rattata", weight: 20, minLevel: 58, maxLevel: 60 },
      { speciesKey: "raticate", weight: 15, minLevel: 58, maxLevel: 60 },
      { speciesKey: "magnemite", weight: 15, minLevel: 58, maxLevel: 60 },
      { speciesKey: "pidgeotto", weight: 10, minLevel: 58, maxLevel: 60 },
      { speciesKey: "noctowl", weight: 8, minLevel: 58, maxLevel: 60 },
      { speciesKey: "snubbull", weight: 3, minLevel: 58, maxLevel: 60 },
    ],
  },
  route39: {
    name: "Route 39",
    encounters: [
      { speciesKey: "meowth", weight: 20, minLevel: 59, maxLevel: 61 },
      { speciesKey: "rattata", weight: 18, minLevel: 59, maxLevel: 61 },
      { speciesKey: "raticate", weight: 15, minLevel: 59, maxLevel: 61 },
      { speciesKey: "magnemite", weight: 12, minLevel: 59, maxLevel: 61 },
      { speciesKey: "pidgeotto", weight: 10, minLevel: 59, maxLevel: 61 },
      { speciesKey: "noctowl", weight: 8, minLevel: 59, maxLevel: 61 },
      { speciesKey: "farfetchd", weight: 6, minLevel: 59, maxLevel: 61 },
      { speciesKey: "tauros", weight: 4, minLevel: 59, maxLevel: 61 },
      { speciesKey: "miltank", weight: 4, minLevel: 59, maxLevel: 61 },
    ],
  },
  route40: {
    name: "Route 40",
    encounters: [
      { speciesKey: "tentacool", weight: 25, minLevel: 60, maxLevel: 62 },
      { speciesKey: "tentacruel", weight: 5, minLevel: 60, maxLevel: 62 },
    ],
  },
  whirlIslands: {
    name: "Whirl Islands",
    encounters: [
      { speciesKey: "krabby", weight: 25, minLevel: 61, maxLevel: 64 },
      { speciesKey: "zubat", weight: 22, minLevel: 61, maxLevel: 64 },
      { speciesKey: "seel", weight: 18, minLevel: 61, maxLevel: 64 },
      { speciesKey: "golbat", weight: 8, minLevel: 61, maxLevel: 64 },
    ],
  },
  route41: {
    name: "Route 41",
    encounters: [
      { speciesKey: "tentacool", weight: 22, minLevel: 61, maxLevel: 63 },
      { speciesKey: "tentacruel", weight: 10, minLevel: 61, maxLevel: 63 },
      { speciesKey: "mantine", weight: 3, minLevel: 61, maxLevel: 63 },
    ],
  },
  route42: {
    name: "Route 42",
    encounters: [
      { speciesKey: "zubat", weight: 20, minLevel: 58, maxLevel: 61 },
      { speciesKey: "spearow", weight: 18, minLevel: 58, maxLevel: 61 },
      { speciesKey: "mankey", weight: 15, minLevel: 58, maxLevel: 61 },
      { speciesKey: "golbat", weight: 8, minLevel: 58, maxLevel: 61 },
      { speciesKey: "marill", weight: 4, minLevel: 58, maxLevel: 61 },
    ],
  },
  mtMortar: {
    name: "Mt. Mortar",
    encounters: [
      { speciesKey: "zubat", weight: 25, minLevel: 61, maxLevel: 64 },
      { speciesKey: "machop", weight: 20, minLevel: 61, maxLevel: 64 },
      { speciesKey: "geodude", weight: 18, minLevel: 61, maxLevel: 64 },
      { speciesKey: "rattata", weight: 15, minLevel: 61, maxLevel: 64 },
      { speciesKey: "raticate", weight: 10, minLevel: 61, maxLevel: 64 },
      { speciesKey: "golbat", weight: 10, minLevel: 61, maxLevel: 64 },
      { speciesKey: "marill", weight: 5, minLevel: 61, maxLevel: 64 },
    ],
  },
  route43: {
    name: "Route 43",
    encounters: [
      { speciesKey: "venonat", weight: 20, minLevel: 64, maxLevel: 66 },
      { speciesKey: "girafarig", weight: 15, minLevel: 64, maxLevel: 66 },
      { speciesKey: "sentret", weight: 15, minLevel: 64, maxLevel: 66 },
      { speciesKey: "pidgeotto", weight: 12, minLevel: 64, maxLevel: 66 },
      { speciesKey: "noctowl", weight: 12, minLevel: 64, maxLevel: 66 },
      { speciesKey: "farfetchd", weight: 10, minLevel: 64, maxLevel: 66 },
      { speciesKey: "furret", weight: 6, minLevel: 64, maxLevel: 66 },
      { speciesKey: "venomoth", weight: 5, minLevel: 64, maxLevel: 66 },
      { speciesKey: "mareep", weight: 3, minLevel: 64, maxLevel: 66 },
    ],
  },
  lakeOfRage: {
    name: "Lake of Rage",
    encounters: [
      { speciesKey: "magikarp", weight: 25, minLevel: 63, maxLevel: 66 },
      { speciesKey: "gyarados", weight: 5, minLevel: 63, maxLevel: 66 },
    ],
  },
  rocketHideout: {
    name: "Team Rocket Hideout (Mahogany)",
    encounters: [
      { speciesKey: "voltorb", weight: 15, minLevel: 64, maxLevel: 67 },
      { speciesKey: "koffing", weight: 15, minLevel: 64, maxLevel: 67 },
      { speciesKey: "geodude", weight: 15, minLevel: 64, maxLevel: 67 },
    ],
  },
  route44: {
    name: "Route 44",
    encounters: [
      { speciesKey: "lickitung", weight: 20, minLevel: 65, maxLevel: 67 },
      { speciesKey: "bellsprout", weight: 15, minLevel: 65, maxLevel: 67 },
      { speciesKey: "tangela", weight: 15, minLevel: 65, maxLevel: 67 },
      { speciesKey: "weepinbell", weight: 10, minLevel: 65, maxLevel: 67 },
      { speciesKey: "poliwhirl", weight: 5, minLevel: 65, maxLevel: 67 },
    ],
  },
  icePath: {
    name: "Ice Path",
    encounters: [
      { speciesKey: "swinub", weight: 22, minLevel: 66, maxLevel: 69 },
      { speciesKey: "delibird", weight: 20, minLevel: 66, maxLevel: 69 },
      { speciesKey: "zubat", weight: 18, minLevel: 66, maxLevel: 69 },
      { speciesKey: "golbat", weight: 12, minLevel: 66, maxLevel: 69 },
      { speciesKey: "jynx", weight: 5, minLevel: 66, maxLevel: 69 },
      { speciesKey: "sneasel", weight: 5, minLevel: 66, maxLevel: 69 },
    ],
  },
  dragonsDen: {
    name: "Dragon's Den",
    encounters: [
      { speciesKey: "magikarp", weight: 20, minLevel: 68, maxLevel: 71 },
      { speciesKey: "dratini", weight: 8, minLevel: 68, maxLevel: 71 },
    ],
  },
  route45: {
    name: "Route 45",
    encounters: [
      { speciesKey: "graveler", weight: 22, minLevel: 67, maxLevel: 70 },
      { speciesKey: "geodude", weight: 18, minLevel: 67, maxLevel: 70 },
      { speciesKey: "gligar", weight: 6, minLevel: 67, maxLevel: 70 },
    ],
  },
  route46: {
    name: "Route 46",
    encounters: [
      { speciesKey: "geodude", weight: 25, minLevel: 44, maxLevel: 47 },
      { speciesKey: "spearow", weight: 18, minLevel: 44, maxLevel: 47 },
      { speciesKey: "rattata", weight: 12, minLevel: 44, maxLevel: 47 },
      { speciesKey: "jigglypuff", weight: 5, minLevel: 44, maxLevel: 47 },
      { speciesKey: "phanpy", weight: 4, minLevel: 44, maxLevel: 47 },
    ],
  },
  darkCave: {
    name: "Dark Cave",
    encounters: [
      { speciesKey: "geodude", weight: 25, minLevel: 60, maxLevel: 68 },
      { speciesKey: "zubat", weight: 22, minLevel: 60, maxLevel: 68 },
      { speciesKey: "dunsparce", weight: 3, minLevel: 60, maxLevel: 68 },
      { speciesKey: "golbat", weight: 8, minLevel: 60, maxLevel: 68 },
      { speciesKey: "graveler", weight: 6, minLevel: 60, maxLevel: 68 },
      { speciesKey: "wobbuffet", weight: 5, minLevel: 60, maxLevel: 68 },
      { speciesKey: "ursaring", weight: 3, minLevel: 60, maxLevel: 68 },
    ],
  },
  mtSilver: {
    name: "Mt. Silver",
    encounters: [
      { speciesKey: "poliwhirl", weight: 18, minLevel: 75, maxLevel: 80 },
      { speciesKey: "golbat", weight: 15, minLevel: 75, maxLevel: 80 },
      { speciesKey: "ponyta", weight: 15, minLevel: 75, maxLevel: 80 },
      { speciesKey: "tangela", weight: 12, minLevel: 75, maxLevel: 80 },
      { speciesKey: "arbok", weight: 10, minLevel: 75, maxLevel: 80 },
      { speciesKey: "ursaring", weight: 10, minLevel: 75, maxLevel: 80 },
      { speciesKey: "donphan", weight: 8, minLevel: 75, maxLevel: 80 },
      { speciesKey: "doduo", weight: 5, minLevel: 75, maxLevel: 80 },
      { speciesKey: "dodrio", weight: 3, minLevel: 75, maxLevel: 80 },
      { speciesKey: "rapidash", weight: 3, minLevel: 75, maxLevel: 80 },
      { speciesKey: "sneasel", weight: 3, minLevel: 75, maxLevel: 80 },
    ],
  },
};
