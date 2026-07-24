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
    { id: "newbark_1", name: "Youngster Joey", trainerClass: "youngster", team: [{ speciesKey: "rattata", level: 38 }] },
    { id: "newbark_2", name: "Lass Carrie", trainerClass: "lass", team: [{ speciesKey: "sentret", level: 39 }, { speciesKey: "hoothoot", level: 39 }] },
    { id: "newbark_3", name: "School Kid Alan", trainerClass: "schoolkid", team: [{ speciesKey: "pidgey", level: 40 }, { speciesKey: "wooper", level: 40 }, { speciesKey: "sentret", level: 41 }] },
  ],
  cherrygroveCity: [
    { id: "cherrygrove_1", name: "Youngster Joey", trainerClass: "youngster", team: [{ speciesKey: "rattata", level: 40 }, { speciesKey: "sentret", level: 40 }] },
    { id: "cherrygrove_2", name: "Lass Carrie", trainerClass: "lass", team: [{ speciesKey: "hoppip", level: 41 }, { speciesKey: "marill", level: 41 }] },
    { id: "cherrygrove_3", name: "Bird Keeper Roy", trainerClass: "birdKeeper", team: [{ speciesKey: "pidgey", level: 41 }, { speciesKey: "spearow", level: 42 }, { speciesKey: "hoothoot", level: 42 }] },
    { id: "cherrygrove_4", name: "Sailor Eugene", trainerClass: "sailor", team: [{ speciesKey: "marill", level: 43 }, { speciesKey: "wooper", level: 43 }, { speciesKey: "poliwag", level: 44 }, { speciesKey: "tentacool", level: 44 }] },
  ],
  violetCity: [
    { id: "violet_1", name: "Lass Krise", trainerClass: "lass", team: [{ speciesKey: "pidgey", level: 45 }] },
    { id: "violet_2", name: "School Kid Alan", trainerClass: "schoolkid", team: [{ speciesKey: "sentret", level: 45 }, { speciesKey: "spearow", level: 46 }] },
    { id: "violet_3", name: "Bird Keeper Vance", trainerClass: "birdKeeper", team: [{ speciesKey: "pidgey", level: 46 }, { speciesKey: "spearow", level: 47 }] },
    { id: "violet_4", name: "Sage Li", trainerClass: "sage", team: [{ speciesKey: "bellsprout", level: 47 }, { speciesKey: "gastly", level: 47 }, { speciesKey: "hoothoot", level: 48 }] },
    { id: "violet_5", name: "Bird Keeper Roy", trainerClass: "birdKeeper", team: [{ speciesKey: "spearow", level: 48 }, { speciesKey: "hoothoot", level: 48 }, { speciesKey: "pidgey", level: 49 }, { speciesKey: "doduo", level: 49 }] },
  ],
  azaleaTown: [
    { id: "azalea_1", name: "Bug Catcher Rob", trainerClass: "bugCatcher", team: [{ speciesKey: "caterpie", level: 49 }, { speciesKey: "weedle", level: 49 }] },
    { id: "azalea_2", name: "Lass Krise", trainerClass: "lass", team: [{ speciesKey: "paras", level: 49 }, { speciesKey: "ledyba", level: 50 }] },
    { id: "azalea_3", name: "Camper Lewis", trainerClass: "camper", team: [{ speciesKey: "slowpoke", level: 50 }, { speciesKey: "spinarak", level: 51 }] },
    { id: "azalea_4", name: "Bug Catcher Josh", trainerClass: "bugCatcher", team: [{ speciesKey: "metapod", level: 51 }, { speciesKey: "kakuna", level: 51 }, { speciesKey: "caterpie", level: 52 }] },
    { id: "azalea_5", name: "Sage Gaku", trainerClass: "sage", team: [{ speciesKey: "spinarak", level: 52 }, { speciesKey: "ledyba", level: 52 }, { speciesKey: "paras", level: 52 }, { speciesKey: "slowpoke", level: 53 }] },
  ],
  goldenrodCity: [
    { id: "goldenrod_1", name: "Lass Cassidy", trainerClass: "lass", team: [{ speciesKey: "clefairy", level: 52 }, { speciesKey: "jigglypuff", level: 52 }] },
    { id: "goldenrod_2", name: "School Kid Kipp", trainerClass: "schoolkid", team: [{ speciesKey: "sentret", level: 53 }, { speciesKey: "meowth", level: 53 }] },
    { id: "goldenrod_3", name: "Beauty Bridget", trainerClass: "beauty", team: [{ speciesKey: "snubbull", level: 54 }, { speciesKey: "teddiursa", level: 54 }, { speciesKey: "jigglypuff", level: 55 }] },
    { id: "goldenrod_4", name: "Gentleman Alfred", trainerClass: "gentleman", team: [{ speciesKey: "girafarig", level: 55 }, { speciesKey: "aipom", level: 55 }, { speciesKey: "furret", level: 56 }] },
    { id: "goldenrod_5", name: "Cooltrainer Gemma", trainerClass: "coolTrainer", team: [{ speciesKey: "aipom", level: 56 }, { speciesKey: "girafarig", level: 56 }, { speciesKey: "teddiursa", level: 57 }, { speciesKey: "miltank", level: 57 }] },
  ],
  ecruteakCity: [
    { id: "ecruteak_1", name: "Sage Edmond", trainerClass: "sage", team: [{ speciesKey: "drowzee", level: 56 }, { speciesKey: "gastly", level: 56 }] },
    { id: "ecruteak_2", name: "Channeler Tamara", trainerClass: "channeler", team: [{ speciesKey: "gastly", level: 56 }, { speciesKey: "misdreavus", level: 57 }] },
    { id: "ecruteak_3", name: "Beauty Kaori", trainerClass: "beauty", team: [{ speciesKey: "growlithe", level: 57 }, { speciesKey: "murkrow", level: 58 }] },
    { id: "ecruteak_4", name: "Psychic Rodney", trainerClass: "psychic", team: [{ speciesKey: "drowzee", level: 58 }, { speciesKey: "natu", level: 58 }, { speciesKey: "kadabra", level: 59 }] },
    { id: "ecruteak_5", name: "Sage Ping", trainerClass: "sage", team: [{ speciesKey: "gastly", level: 59 }, { speciesKey: "natu", level: 60 }, { speciesKey: "haunter", level: 61 }, { speciesKey: "xatu", level: 61 }] },
  ],
  olivineCity: [
    { id: "olivine_1", name: "Swimmer Kirk", trainerClass: "swimmer", team: [{ speciesKey: "tentacool", level: 62 }, { speciesKey: "chinchou", level: 63 }] },
    { id: "olivine_2", name: "Sailor Ernest", trainerClass: "sailor", team: [{ speciesKey: "krabby", level: 63 }, { speciesKey: "seel", level: 64 }] },
    { id: "olivine_3", name: "Beauty Olivia", trainerClass: "beauty", team: [{ speciesKey: "staryu", level: 64 }, { speciesKey: "marill", level: 65 }, { speciesKey: "shellder", level: 65 }] },
    { id: "olivine_4", name: "Gentleman Alfred", trainerClass: "gentleman", team: [{ speciesKey: "magnemite", level: 66 }, { speciesKey: "magnemite", level: 66 }, { speciesKey: "magneton", level: 67 }] },
    { id: "olivine_5", name: "Sailor Huey", trainerClass: "sailor", team: [{ speciesKey: "tentacool", level: 66 }, { speciesKey: "kingler", level: 67 }, { speciesKey: "tentacruel", level: 67 }, { speciesKey: "lanturn", level: 67 }] },
  ],
  cianwoodCity: [
    { id: "cianwood_1", name: "Swimmer Dara", trainerClass: "swimmer", team: [{ speciesKey: "poliwag", level: 59 }, { speciesKey: "tentacool", level: 59 }] },
    { id: "cianwood_2", name: "Sailor Ernest", trainerClass: "sailor", team: [{ speciesKey: "tentacool", level: 60 }, { speciesKey: "poliwhirl", level: 60 }] },
    { id: "cianwood_3", name: "Blackbelt Lung", trainerClass: "blackbelt", team: [{ speciesKey: "machop", level: 60 }, { speciesKey: "mankey", level: 61 }, { speciesKey: "machoke", level: 61 }] },
    { id: "cianwood_4", name: "Blackbelt Kiyo", trainerClass: "blackbelt", team: [{ speciesKey: "mankey", level: 62 }, { speciesKey: "primeape", level: 62 }, { speciesKey: "machoke", level: 63 }] },
    { id: "cianwood_5", name: "Blackbelt Wai", trainerClass: "blackbelt", team: [{ speciesKey: "machop", level: 63 }, { speciesKey: "machoke", level: 64 }, { speciesKey: "mankey", level: 63 }, { speciesKey: "primeape", level: 64 }] },
  ],
  mahoganyTown: [
    { id: "mahogany_1", name: "Camper Roland", trainerClass: "camper", team: [{ speciesKey: "swinub", level: 65 }, { speciesKey: "teddiursa", level: 65 }] },
    { id: "mahogany_2", name: "Hiker Russell", trainerClass: "hiker", team: [{ speciesKey: "geodude", level: 66 }, { speciesKey: "graveler", level: 67 }] },
    { id: "mahogany_3", name: "Super Nerd Markus", trainerClass: "superNerd", team: [{ speciesKey: "koffing", level: 67 }, { speciesKey: "grimer", level: 68 }] },
    { id: "mahogany_4", name: "Cool Trainer Gaven", trainerClass: "coolTrainer", team: [{ speciesKey: "seel", level: 68 }, { speciesKey: "delibird", level: 68 }, { speciesKey: "sneasel", level: 69 }] },
    { id: "mahogany_5", name: "Cool Trainer Sheila", trainerClass: "coolTrainer", team: [{ speciesKey: "sneasel", level: 69 }, { speciesKey: "delibird", level: 69 }, { speciesKey: "piloswine", level: 70 }, { speciesKey: "lapras", level: 70 }] },
  ],
  blackthornCity: [
    { id: "blackthorn_1", name: "Hiker Kenny", trainerClass: "hiker", team: [{ speciesKey: "graveler", level: 70 }, { speciesKey: "gligar", level: 70 }] },
    { id: "blackthorn_2", name: "Sage Koji", trainerClass: "sage", team: [{ speciesKey: "dratini", level: 71 }, { speciesKey: "seadra", level: 71 }] },
    { id: "blackthorn_3", name: "Blackbelt Kiyo", trainerClass: "blackbelt", team: [{ speciesKey: "larvitar", level: 71 }, { speciesKey: "machoke", level: 72 }, { speciesKey: "pupitar", level: 72 }] },
    { id: "blackthorn_4", name: "CoolTrainer Cody", trainerClass: "coolTrainer", team: [{ speciesKey: "arbok", level: 72 }, { speciesKey: "seadra", level: 73 }, { speciesKey: "gyarados", level: 73 }] },
    { id: "blackthorn_5", name: "Sage Gaku", trainerClass: "sage", team: [{ speciesKey: "dragonair", level: 73 }, { speciesKey: "dragonair", level: 74 }] },
    { id: "blackthorn_6", name: "Ace Trainer Darin", trainerClass: "ace", team: [{ speciesKey: "gyarados", level: 74 }, { speciesKey: "seadra", level: 74 }, { speciesKey: "dragonair", level: 75 }, { speciesKey: "kingdra", level: 75 }] },
  ],
  route29: [
    { id: "route29_1", name: "Youngster Mikey", trainerClass: "youngster", team: [{ speciesKey: "rattata", level: 40 }] },
  ],
  route30: [
    { id: "route30_1", name: "Bug Catcher Wade", trainerClass: "bugCatcher", team: [{ speciesKey: "caterpie", level: 41 }, { speciesKey: "weedle", level: 41 }] },
  ],
  route31: [
    { id: "route31_1", name: "Bird Keeper Abe", trainerClass: "birdKeeper", team: [{ speciesKey: "pidgey", level: 42 }, { speciesKey: "hoothoot", level: 42 }] },
  ],
  unionCave: [
    { id: "unionCave_1", name: "Hiker Bailey", trainerClass: "hiker", team: [{ speciesKey: "geodude", level: 46 }, { speciesKey: "onix", level: 47 }] },
    { id: "unionCave_2", name: "Hiker Grant", trainerClass: "hiker", team: [{ speciesKey: "zubat", level: 47 }, { speciesKey: "geodude", level: 47 }, { speciesKey: "geodude", level: 49 }] },
  ],
  route33: [
    { id: "route33_1", name: "Lass Dana", trainerClass: "lass", team: [{ speciesKey: "bellsprout", level: 47 }, { speciesKey: "hoothoot", level: 47 }] },
    { id: "route33_2", name: "Youngster Anthony", trainerClass: "youngster", team: [{ speciesKey: "rattata", level: 47 }, { speciesKey: "spearow", level: 48 }] },
  ],
  ilexForest: [
    { id: "ilexForest_1", name: "Bug Catcher Arnold", trainerClass: "bugCatcher", team: [{ speciesKey: "caterpie", level: 48 }, { speciesKey: "metapod", level: 48 }, { speciesKey: "weedle", level: 49 }] },
    { id: "ilexForest_2", name: "Bug Catcher Benny", trainerClass: "bugCatcher", team: [{ speciesKey: "spinarak", level: 49 }, { speciesKey: "ledyba", level: 49 }] },
  ],
  route34: [
    { id: "route34_1", name: "Camper Todd", trainerClass: "camper", team: [{ speciesKey: "sentret", level: 50 }, { speciesKey: "growlithe", level: 50 }] },
    { id: "route34_2", name: "School Kid Ricky", trainerClass: "schoolkid", team: [{ speciesKey: "magnemite", level: 49 }, { speciesKey: "voltorb", level: 51 }] },
  ],
  route35: [
    { id: "route35_1", name: "Lass Connie", trainerClass: "lass", team: [{ speciesKey: "oddish", level: 52 }, { speciesKey: "bellsprout", level: 52 }] },
    { id: "route35_2", name: "Bug Catcher Charlie", trainerClass: "bugCatcher", team: [{ speciesKey: "venonat", level: 51 }, { speciesKey: "weepinbell", level: 53 }] },
  ],
  nationalPark: [
    { id: "nationalPark_1", name: "Super Nerd Stan", trainerClass: "superNerd", team: [{ speciesKey: "voltorb", level: 54 }, { speciesKey: "koffing", level: 54 }] },
    { id: "nationalPark_2", name: "Bug Catcher Wayne", trainerClass: "bugCatcher", team: [{ speciesKey: "paras", level: 52 }, { speciesKey: "pineco", level: 54 }, { speciesKey: "ledyba", level: 52 }] },
  ],
  route36: [
    { id: "route36_1", name: "Hiker Anthony", trainerClass: "hiker", team: [{ speciesKey: "geodude", level: 53 }, { speciesKey: "machop", level: 53 }] },
    { id: "route36_2", name: "Camper Nate", trainerClass: "camper", team: [{ speciesKey: "sentret", level: 52 }, { speciesKey: "furret", level: 54 }] },
  ],
  route37: [
    { id: "route37_1", name: "Sage Nico", trainerClass: "sage", team: [{ speciesKey: "hoothoot", level: 55 }, { speciesKey: "gastly", level: 55 }] },
    { id: "route37_2", name: "Lass Tiffany", trainerClass: "lass", team: [{ speciesKey: "bellsprout", level: 54 }, { speciesKey: "natu", level: 56 }] },
  ],
  route38: [
    { id: "route38_1", name: "Beauty Cassie", trainerClass: "beauty", team: [{ speciesKey: "growlithe", level: 59 }, { speciesKey: "magnemite", level: 59 }] },
    { id: "route38_2", name: "Gentleman Preston", trainerClass: "gentleman", team: [{ speciesKey: "magnemite", level: 58 }, { speciesKey: "voltorb", level: 60 }] },
  ],
  route39: [
    { id: "route39_1", name: "Camper Otis", trainerClass: "camper", team: [{ speciesKey: "miltank", level: 59 }, { speciesKey: "tauros", level: 59 }] },
    { id: "route39_2", name: "Beauty Paula", trainerClass: "beauty", team: [{ speciesKey: "tauros", level: 60 }, { speciesKey: "growlithe", level: 60 }] },
  ],
  route40: [
    { id: "route40_1", name: "Swimmer Kai", trainerClass: "swimmer", team: [{ speciesKey: "tentacool", level: 61 }, { speciesKey: "shellder", level: 61 }] },
    { id: "route40_2", name: "Sailor Marlin", trainerClass: "sailor", team: [{ speciesKey: "krabby", level: 60 }, { speciesKey: "tentacool", level: 62 }] },
  ],
  whirlIslands: [
    { id: "whirlIslands_1", name: "Swimmer Nadia", trainerClass: "swimmer", team: [{ speciesKey: "seel", level: 61 }, { speciesKey: "qwilfish", level: 62 }] },
  ],
  route41: [
    { id: "route41_1", name: "Swimmer Elena", trainerClass: "swimmer", team: [{ speciesKey: "wooper", level: 61 }, { speciesKey: "krabby", level: 62 }] },
    { id: "route41_2", name: "Sailor Duke", trainerClass: "sailor", team: [{ speciesKey: "tentacool", level: 62 }, { speciesKey: "staryu", level: 63 }] },
  ],
  route42: [
    { id: "route42_1", name: "Hiker Parry", trainerClass: "hiker", team: [{ speciesKey: "geodude", level: 59 }, { speciesKey: "graveler", level: 59 }] },
    { id: "route42_2", name: "Blackbelt Kenji", trainerClass: "blackbelt", team: [{ speciesKey: "machop", level: 58 }, { speciesKey: "machoke", level: 60 }] },
  ],
  mtMortar: [
    { id: "mtMortar_1", name: "Blackbelt Nob", trainerClass: "blackbelt", team: [{ speciesKey: "machop", level: 61 }, { speciesKey: "machop", level: 61 }, { speciesKey: "onix", level: 62 }] },
    { id: "mtMortar_2", name: "Blackbelt Yoshi", trainerClass: "blackbelt", team: [{ speciesKey: "machoke", level: 62 }, { speciesKey: "geodude", level: 62 }] },
    { id: "mtMortar_3", name: "Hiker Reyes", trainerClass: "hiker", team: [{ speciesKey: "graveler", level: 63 }, { speciesKey: "onix", level: 64 }] },
  ],
  route43: [
    { id: "route43_1", name: "Juggler Irwin", trainerClass: "juggler", team: [{ speciesKey: "drowzee", level: 65 }, { speciesKey: "voltorb", level: 66 }] },
    { id: "route43_2", name: "Camper Bryce", trainerClass: "camper", team: [{ speciesKey: "mareep", level: 64 }, { speciesKey: "poliwag", level: 65 }] },
  ],
  route44: [
    { id: "route44_1", name: "Psychic Franklin", trainerClass: "psychic", team: [{ speciesKey: "natu", level: 66 }, { speciesKey: "haunter", level: 66 }] },
    { id: "route44_2", name: "Hiker Anton", trainerClass: "hiker", team: [{ speciesKey: "geodude", level: 65 }, { speciesKey: "sneasel", level: 67 }] },
  ],
  icePath: [
    { id: "icePath_1", name: "Hiker Simon", trainerClass: "hiker", team: [{ speciesKey: "zubat", level: 67 }, { speciesKey: "golbat", level: 67 }] },
    { id: "icePath_2", name: "Super Nerd Elliot", trainerClass: "superNerd", team: [{ speciesKey: "swinub", level: 66 }, { speciesKey: "sneasel", level: 68 }] },
    { id: "icePath_3", name: "Hiker Dale", trainerClass: "hiker", team: [{ speciesKey: "machoke", level: 67 }, { speciesKey: "swinub", level: 67 }, { speciesKey: "golbat", level: 69 }] },
  ],
  route45: [
    { id: "route45_1", name: "Hiker Erik", trainerClass: "hiker", team: [{ speciesKey: "graveler", level: 67 }, { speciesKey: "onix", level: 68 }] },
    { id: "route45_2", name: "CoolTrainer Vance", trainerClass: "coolTrainer", team: [{ speciesKey: "growlithe", level: 67 }, { speciesKey: "magnemite", level: 68 }, { speciesKey: "haunter", level: 69 }] },
    { id: "route45_3", name: "Ace Trainer Meredith", trainerClass: "ace", team: [{ speciesKey: "dunsparce", level: 68 }, { speciesKey: "sneasel", level: 69 }, { speciesKey: "golbat", level: 70 }] },
  ],
  route46: [
    { id: "route46_1", name: "Hiker Grady", trainerClass: "hiker", team: [{ speciesKey: "geodude", level: 45 }, { speciesKey: "graveler", level: 46 }] },
    { id: "route46_2", name: "Lass Priscilla", trainerClass: "lass", team: [{ speciesKey: "rattata", level: 44 }, { speciesKey: "furret", level: 46 }, { speciesKey: "dunsparce", level: 45 }] },
  ],
  darkCave: [
    { id: "darkCave_1", name: "Hiker Emmett", trainerClass: "hiker", team: [{ speciesKey: "geodude", level: 60 }, { speciesKey: "onix", level: 61 }] },
    { id: "darkCave_2", name: "Hiker Foster", trainerClass: "hiker", team: [{ speciesKey: "zubat", level: 60 }, { speciesKey: "golbat", level: 62 }, { speciesKey: "dunsparce", level: 61 }] },
  ],
};
