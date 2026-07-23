import type { TrainerEncounter } from "../../../types";

export const trainerEncounters: Record<string, TrainerEncounter[]> = {
  // ── Town trainers ──────────────────────────────────────────────────
  // Towns have no wild encounters, so town trainers are the ONLY source
  // of `battlesWonByLocation[town]`. The unlock chain gates each route on
  // battles won at the preceding town (e.g. route29 needs 5 wins at New
  // Bark Town), so without these rosters the very first Johto route never
  // unlocks and the entire region is unreachable. Trainers are repeatable
  // via the rematch pool (see useBattleLoop), so a handful per town covers
  // every unlock threshold. Levels track each town's gym band. Mirrors how
  // Kanto towns (viridianCity, pewterCity, …) already work.
  newBarkTown: [
    { id: "newbark_1", name: "Youngster Joey", trainerClass: "youngster", team: [{ speciesKey: "rattata", level: 3 }] },
    { id: "newbark_2", name: "Lass Carrie", trainerClass: "lass", team: [{ speciesKey: "sentret", level: 4 }, { speciesKey: "hoothoot", level: 4 }] },
    { id: "newbark_3", name: "School Kid Alan", trainerClass: "schoolkid", team: [{ speciesKey: "pidgey", level: 5 }, { speciesKey: "wooper", level: 5 }, { speciesKey: "sentret", level: 6 }] },
  ],
  cherrygroveCity: [
    { id: "cherrygrove_1", name: "Youngster Joey", trainerClass: "youngster", team: [{ speciesKey: "rattata", level: 6 }, { speciesKey: "sentret", level: 6 }] },
    { id: "cherrygrove_2", name: "Lass Carrie", trainerClass: "lass", team: [{ speciesKey: "hoppip", level: 7 }, { speciesKey: "marill", level: 7 }] },
    { id: "cherrygrove_3", name: "Bird Keeper Roy", trainerClass: "birdKeeper", team: [{ speciesKey: "pidgey", level: 7 }, { speciesKey: "spearow", level: 8 }, { speciesKey: "hoothoot", level: 8 }] },
    { id: "cherrygrove_4", name: "Sailor Eugene", trainerClass: "sailor", team: [{ speciesKey: "marill", level: 9 }, { speciesKey: "wooper", level: 9 }, { speciesKey: "poliwag", level: 10 }, { speciesKey: "tentacool", level: 10 }] },
  ],
  violetCity: [
    { id: "violet_1", name: "Lass Krise", trainerClass: "lass", team: [{ speciesKey: "pidgey", level: 7 }] },
    { id: "violet_2", name: "School Kid Alan", trainerClass: "schoolkid", team: [{ speciesKey: "sentret", level: 7 }, { speciesKey: "spearow", level: 8 }] },
    { id: "violet_3", name: "Bird Keeper Vance", trainerClass: "birdKeeper", team: [{ speciesKey: "pidgey", level: 8 }, { speciesKey: "spearow", level: 9 }] },
    { id: "violet_4", name: "Sage Li", trainerClass: "sage", team: [{ speciesKey: "bellsprout", level: 9 }, { speciesKey: "gastly", level: 9 }, { speciesKey: "hoothoot", level: 10 }] },
    { id: "violet_5", name: "Bird Keeper Roy", trainerClass: "birdKeeper", team: [{ speciesKey: "spearow", level: 10 }, { speciesKey: "hoothoot", level: 10 }, { speciesKey: "pidgey", level: 11 }, { speciesKey: "doduo", level: 11 }] },
  ],
  azaleaTown: [
    { id: "azalea_1", name: "Bug Catcher Rob", trainerClass: "bugCatcher", team: [{ speciesKey: "caterpie", level: 12 }, { speciesKey: "weedle", level: 12 }] },
    { id: "azalea_2", name: "Lass Krise", trainerClass: "lass", team: [{ speciesKey: "paras", level: 12 }, { speciesKey: "ledyba", level: 13 }] },
    { id: "azalea_3", name: "Camper Lewis", trainerClass: "camper", team: [{ speciesKey: "slowpoke", level: 13 }, { speciesKey: "spinarak", level: 14 }] },
    { id: "azalea_4", name: "Bug Catcher Josh", trainerClass: "bugCatcher", team: [{ speciesKey: "metapod", level: 14 }, { speciesKey: "kakuna", level: 14 }, { speciesKey: "caterpie", level: 15 }] },
    { id: "azalea_5", name: "Sage Gaku", trainerClass: "sage", team: [{ speciesKey: "spinarak", level: 15 }, { speciesKey: "ledyba", level: 15 }, { speciesKey: "paras", level: 15 }, { speciesKey: "slowpoke", level: 16 }] },
  ],
  goldenrodCity: [
    { id: "goldenrod_1", name: "Lass Cassidy", trainerClass: "lass", team: [{ speciesKey: "clefairy", level: 16 }, { speciesKey: "jigglypuff", level: 16 }] },
    { id: "goldenrod_2", name: "School Kid Kipp", trainerClass: "schoolkid", team: [{ speciesKey: "sentret", level: 17 }, { speciesKey: "meowth", level: 17 }] },
    { id: "goldenrod_3", name: "Beauty Bridget", trainerClass: "beauty", team: [{ speciesKey: "snubbull", level: 18 }, { speciesKey: "teddiursa", level: 18 }, { speciesKey: "jigglypuff", level: 19 }] },
    { id: "goldenrod_4", name: "Gentleman Alfred", trainerClass: "gentleman", team: [{ speciesKey: "girafarig", level: 19 }, { speciesKey: "aipom", level: 19 }, { speciesKey: "furret", level: 20 }] },
    { id: "goldenrod_5", name: "Cooltrainer Gemma", trainerClass: "coolTrainer", team: [{ speciesKey: "aipom", level: 20 }, { speciesKey: "girafarig", level: 20 }, { speciesKey: "teddiursa", level: 21 }, { speciesKey: "miltank", level: 21 }] },
  ],
  ecruteakCity: [
    { id: "ecruteak_1", name: "Sage Edmond", trainerClass: "sage", team: [{ speciesKey: "drowzee", level: 20 }, { speciesKey: "gastly", level: 20 }] },
    { id: "ecruteak_2", name: "Channeler Tamara", trainerClass: "channeler", team: [{ speciesKey: "gastly", level: 20 }, { speciesKey: "misdreavus", level: 21 }] },
    { id: "ecruteak_3", name: "Beauty Kaori", trainerClass: "beauty", team: [{ speciesKey: "growlithe", level: 21 }, { speciesKey: "murkrow", level: 22 }] },
    { id: "ecruteak_4", name: "Psychic Rodney", trainerClass: "psychic", team: [{ speciesKey: "drowzee", level: 22 }, { speciesKey: "natu", level: 22 }, { speciesKey: "kadabra", level: 23 }] },
    { id: "ecruteak_5", name: "Sage Ping", trainerClass: "sage", team: [{ speciesKey: "gastly", level: 23 }, { speciesKey: "natu", level: 24 }, { speciesKey: "haunter", level: 25 }, { speciesKey: "xatu", level: 25 }] },
  ],
  olivineCity: [
    { id: "olivine_1", name: "Swimmer Kirk", trainerClass: "swimmer", team: [{ speciesKey: "tentacool", level: 26 }, { speciesKey: "chinchou", level: 27 }] },
    { id: "olivine_2", name: "Sailor Ernest", trainerClass: "sailor", team: [{ speciesKey: "krabby", level: 27 }, { speciesKey: "seel", level: 28 }] },
    { id: "olivine_3", name: "Beauty Olivia", trainerClass: "beauty", team: [{ speciesKey: "staryu", level: 28 }, { speciesKey: "marill", level: 29 }, { speciesKey: "shellder", level: 29 }] },
    { id: "olivine_4", name: "Gentleman Alfred", trainerClass: "gentleman", team: [{ speciesKey: "magnemite", level: 30 }, { speciesKey: "magnemite", level: 30 }, { speciesKey: "magneton", level: 31 }] },
    { id: "olivine_5", name: "Sailor Huey", trainerClass: "sailor", team: [{ speciesKey: "tentacool", level: 30 }, { speciesKey: "kingler", level: 31 }, { speciesKey: "tentacruel", level: 31 }, { speciesKey: "lanturn", level: 31 }] },
  ],
  cianwoodCity: [
    { id: "cianwood_1", name: "Swimmer Dara", trainerClass: "swimmer", team: [{ speciesKey: "poliwag", level: 26 }, { speciesKey: "tentacool", level: 26 }] },
    { id: "cianwood_2", name: "Sailor Ernest", trainerClass: "sailor", team: [{ speciesKey: "tentacool", level: 27 }, { speciesKey: "poliwhirl", level: 27 }] },
    { id: "cianwood_3", name: "Blackbelt Lung", trainerClass: "blackbelt", team: [{ speciesKey: "machop", level: 27 }, { speciesKey: "mankey", level: 28 }, { speciesKey: "machoke", level: 28 }] },
    { id: "cianwood_4", name: "Blackbelt Kiyo", trainerClass: "blackbelt", team: [{ speciesKey: "mankey", level: 29 }, { speciesKey: "primeape", level: 29 }, { speciesKey: "machoke", level: 30 }] },
    { id: "cianwood_5", name: "Blackbelt Wai", trainerClass: "blackbelt", team: [{ speciesKey: "machop", level: 30 }, { speciesKey: "machoke", level: 31 }, { speciesKey: "mankey", level: 30 }, { speciesKey: "primeape", level: 31 }] },
  ],
  mahoganyTown: [
    { id: "mahogany_1", name: "Camper Roland", trainerClass: "camper", team: [{ speciesKey: "swinub", level: 28 }, { speciesKey: "teddiursa", level: 28 }] },
    { id: "mahogany_2", name: "Hiker Russell", trainerClass: "hiker", team: [{ speciesKey: "geodude", level: 29 }, { speciesKey: "graveler", level: 30 }] },
    { id: "mahogany_3", name: "Super Nerd Markus", trainerClass: "superNerd", team: [{ speciesKey: "koffing", level: 30 }, { speciesKey: "grimer", level: 31 }] },
    { id: "mahogany_4", name: "Cool Trainer Gaven", trainerClass: "coolTrainer", team: [{ speciesKey: "seel", level: 31 }, { speciesKey: "delibird", level: 31 }, { speciesKey: "sneasel", level: 32 }] },
    { id: "mahogany_5", name: "Cool Trainer Sheila", trainerClass: "coolTrainer", team: [{ speciesKey: "sneasel", level: 32 }, { speciesKey: "delibird", level: 32 }, { speciesKey: "piloswine", level: 33 }, { speciesKey: "lapras", level: 33 }] },
  ],
  blackthornCity: [
    { id: "blackthorn_1", name: "Hiker Kenny", trainerClass: "hiker", team: [{ speciesKey: "graveler", level: 36 }, { speciesKey: "gligar", level: 36 }] },
    { id: "blackthorn_2", name: "Sage Koji", trainerClass: "sage", team: [{ speciesKey: "dratini", level: 37 }, { speciesKey: "seadra", level: 37 }] },
    { id: "blackthorn_3", name: "Blackbelt Kiyo", trainerClass: "blackbelt", team: [{ speciesKey: "larvitar", level: 37 }, { speciesKey: "machoke", level: 38 }, { speciesKey: "pupitar", level: 38 }] },
    { id: "blackthorn_4", name: "CoolTrainer Cody", trainerClass: "coolTrainer", team: [{ speciesKey: "arbok", level: 38 }, { speciesKey: "seadra", level: 39 }, { speciesKey: "gyarados", level: 39 }] },
    { id: "blackthorn_5", name: "Sage Gaku", trainerClass: "sage", team: [{ speciesKey: "dragonair", level: 39 }, { speciesKey: "dragonair", level: 40 }] },
    { id: "blackthorn_6", name: "Ace Trainer Darin", trainerClass: "ace", team: [{ speciesKey: "gyarados", level: 40 }, { speciesKey: "seadra", level: 40 }, { speciesKey: "dragonair", level: 41 }, { speciesKey: "kingdra", level: 41 }] },
  ],
  route29: [
    { id: "route29_1", name: "Youngster Mikey", trainerClass: "youngster", team: [{ speciesKey: "rattata", level: 3 }] },
  ],
  route30: [
    { id: "route30_1", name: "Bug Catcher Wade", trainerClass: "bugCatcher", team: [{ speciesKey: "caterpie", level: 5 }, { speciesKey: "weedle", level: 5 }] },
  ],
  route31: [
    { id: "route31_1", name: "Bird Keeper Abe", trainerClass: "birdKeeper", team: [{ speciesKey: "pidgey", level: 7 }, { speciesKey: "hoothoot", level: 7 }] },
  ],
  unionCave: [
    { id: "unionCave_1", name: "Hiker Bailey", trainerClass: "hiker", team: [{ speciesKey: "geodude", level: 9 }, { speciesKey: "onix", level: 10 }] },
    { id: "unionCave_2", name: "Hiker Grant", trainerClass: "hiker", team: [{ speciesKey: "zubat", level: 10 }, { speciesKey: "geodude", level: 10 }, { speciesKey: "geodude", level: 12 }] },
  ],
  route33: [
    { id: "route33_1", name: "Lass Dana", trainerClass: "lass", team: [{ speciesKey: "bellsprout", level: 12 }, { speciesKey: "hoothoot", level: 12 }] },
    { id: "route33_2", name: "Youngster Anthony", trainerClass: "youngster", team: [{ speciesKey: "rattata", level: 12 }, { speciesKey: "spearow", level: 13 }] },
  ],
  ilexForest: [
    { id: "ilexForest_1", name: "Bug Catcher Arnold", trainerClass: "bugCatcher", team: [{ speciesKey: "caterpie", level: 14 }, { speciesKey: "metapod", level: 14 }, { speciesKey: "weedle", level: 15 }] },
    { id: "ilexForest_2", name: "Bug Catcher Benny", trainerClass: "bugCatcher", team: [{ speciesKey: "spinarak", level: 15 }, { speciesKey: "ledyba", level: 15 }] },
  ],
  route34: [
    { id: "route34_1", name: "Camper Todd", trainerClass: "camper", team: [{ speciesKey: "sentret", level: 16 }, { speciesKey: "growlithe", level: 16 }] },
    { id: "route34_2", name: "School Kid Ricky", trainerClass: "schoolkid", team: [{ speciesKey: "magnemite", level: 15 }, { speciesKey: "voltorb", level: 17 }] },
  ],
  route35: [
    { id: "route35_1", name: "Lass Connie", trainerClass: "lass", team: [{ speciesKey: "oddish", level: 17 }, { speciesKey: "bellsprout", level: 17 }] },
    { id: "route35_2", name: "Bug Catcher Charlie", trainerClass: "bugCatcher", team: [{ speciesKey: "venonat", level: 16 }, { speciesKey: "weepinbell", level: 18 }] },
  ],
  nationalPark: [
    { id: "nationalPark_1", name: "Super Nerd Stan", trainerClass: "superNerd", team: [{ speciesKey: "voltorb", level: 19 }, { speciesKey: "koffing", level: 19 }] },
    { id: "nationalPark_2", name: "Bug Catcher Wayne", trainerClass: "bugCatcher", team: [{ speciesKey: "paras", level: 17 }, { speciesKey: "pineco", level: 19 }, { speciesKey: "ledyba", level: 17 }] },
  ],
  route36: [
    { id: "route36_1", name: "Hiker Anthony", trainerClass: "hiker", team: [{ speciesKey: "geodude", level: 19 }, { speciesKey: "machop", level: 19 }] },
    { id: "route36_2", name: "Camper Nate", trainerClass: "camper", team: [{ speciesKey: "sentret", level: 18 }, { speciesKey: "furret", level: 20 }] },
  ],
  route37: [
    { id: "route37_1", name: "Sage Nico", trainerClass: "sage", team: [{ speciesKey: "hoothoot", level: 20 }, { speciesKey: "gastly", level: 20 }] },
    { id: "route37_2", name: "Lass Tiffany", trainerClass: "lass", team: [{ speciesKey: "bellsprout", level: 19 }, { speciesKey: "natu", level: 21 }] },
  ],
  route38: [
    { id: "route38_1", name: "Beauty Cassie", trainerClass: "beauty", team: [{ speciesKey: "growlithe", level: 21 }, { speciesKey: "magnemite", level: 21 }] },
    { id: "route38_2", name: "Gentleman Preston", trainerClass: "gentleman", team: [{ speciesKey: "magnemite", level: 20 }, { speciesKey: "voltorb", level: 22 }] },
  ],
  route39: [
    { id: "route39_1", name: "Camper Otis", trainerClass: "camper", team: [{ speciesKey: "miltank", level: 22 }, { speciesKey: "tauros", level: 22 }] },
    { id: "route39_2", name: "Beauty Paula", trainerClass: "beauty", team: [{ speciesKey: "tauros", level: 23 }, { speciesKey: "growlithe", level: 23 }] },
  ],
  route40: [
    { id: "route40_1", name: "Swimmer Kai", trainerClass: "swimmer", team: [{ speciesKey: "tentacool", level: 24 }, { speciesKey: "shellder", level: 24 }] },
    { id: "route40_2", name: "Sailor Marlin", trainerClass: "sailor", team: [{ speciesKey: "krabby", level: 23 }, { speciesKey: "tentacool", level: 25 }] },
  ],
  whirlIslands: [
    { id: "whirlIslands_1", name: "Swimmer Nadia", trainerClass: "swimmer", team: [{ speciesKey: "seel", level: 26 }, { speciesKey: "qwilfish", level: 27 }] },
  ],
  route41: [
    { id: "route41_1", name: "Swimmer Elena", trainerClass: "swimmer", team: [{ speciesKey: "wooper", level: 25 }, { speciesKey: "krabby", level: 26 }] },
    { id: "route41_2", name: "Sailor Duke", trainerClass: "sailor", team: [{ speciesKey: "tentacool", level: 26 }, { speciesKey: "staryu", level: 27 }] },
  ],
  route42: [
    { id: "route42_1", name: "Hiker Parry", trainerClass: "hiker", team: [{ speciesKey: "geodude", level: 27 }, { speciesKey: "graveler", level: 27 }] },
    { id: "route42_2", name: "Blackbelt Kenji", trainerClass: "blackbelt", team: [{ speciesKey: "machop", level: 26 }, { speciesKey: "machoke", level: 28 }] },
  ],
  mtMortar: [
    { id: "mtMortar_1", name: "Blackbelt Nob", trainerClass: "blackbelt", team: [{ speciesKey: "machop", level: 29 }, { speciesKey: "machop", level: 29 }, { speciesKey: "onix", level: 30 }] },
    { id: "mtMortar_2", name: "Blackbelt Yoshi", trainerClass: "blackbelt", team: [{ speciesKey: "machoke", level: 30 }, { speciesKey: "geodude", level: 30 }] },
    { id: "mtMortar_3", name: "Hiker Reyes", trainerClass: "hiker", team: [{ speciesKey: "graveler", level: 31 }, { speciesKey: "onix", level: 32 }] },
  ],
  route43: [
    { id: "route43_1", name: "Juggler Irwin", trainerClass: "juggler", team: [{ speciesKey: "drowzee", level: 28 }, { speciesKey: "voltorb", level: 29 }] },
    { id: "route43_2", name: "Camper Bryce", trainerClass: "camper", team: [{ speciesKey: "mareep", level: 27 }, { speciesKey: "poliwag", level: 28 }] },
  ],
  route44: [
    { id: "route44_1", name: "Psychic Franklin", trainerClass: "psychic", team: [{ speciesKey: "natu", level: 31 }, { speciesKey: "haunter", level: 31 }] },
    { id: "route44_2", name: "Hiker Anton", trainerClass: "hiker", team: [{ speciesKey: "geodude", level: 30 }, { speciesKey: "sneasel", level: 32 }] },
  ],
  icePath: [
    { id: "icePath_1", name: "Hiker Simon", trainerClass: "hiker", team: [{ speciesKey: "zubat", level: 33 }, { speciesKey: "golbat", level: 33 }] },
    { id: "icePath_2", name: "Super Nerd Elliot", trainerClass: "superNerd", team: [{ speciesKey: "swinub", level: 32 }, { speciesKey: "sneasel", level: 34 }] },
    { id: "icePath_3", name: "Hiker Dale", trainerClass: "hiker", team: [{ speciesKey: "machoke", level: 33 }, { speciesKey: "swinub", level: 33 }, { speciesKey: "golbat", level: 35 }] },
  ],
  route45: [
    { id: "route45_1", name: "Hiker Erik", trainerClass: "hiker", team: [{ speciesKey: "graveler", level: 35 }, { speciesKey: "onix", level: 36 }] },
    { id: "route45_2", name: "CoolTrainer Vance", trainerClass: "coolTrainer", team: [{ speciesKey: "growlithe", level: 35 }, { speciesKey: "magnemite", level: 36 }, { speciesKey: "haunter", level: 37 }] },
    { id: "route45_3", name: "Ace Trainer Meredith", trainerClass: "ace", team: [{ speciesKey: "dunsparce", level: 36 }, { speciesKey: "sneasel", level: 37 }, { speciesKey: "golbat", level: 38 }] },
  ],
  route46: [
    { id: "route46_1", name: "Hiker Grady", trainerClass: "hiker", team: [{ speciesKey: "geodude", level: 29 }, { speciesKey: "graveler", level: 30 }] },
    { id: "route46_2", name: "Lass Priscilla", trainerClass: "lass", team: [{ speciesKey: "rattata", level: 28 }, { speciesKey: "furret", level: 30 }, { speciesKey: "dunsparce", level: 29 }] },
  ],
  darkCave: [
    { id: "darkCave_1", name: "Hiker Emmett", trainerClass: "hiker", team: [{ speciesKey: "geodude", level: 30 }, { speciesKey: "onix", level: 31 }] },
    { id: "darkCave_2", name: "Hiker Foster", trainerClass: "hiker", team: [{ speciesKey: "zubat", level: 30 }, { speciesKey: "golbat", level: 32 }, { speciesKey: "dunsparce", level: 31 }] },
  ],
};
