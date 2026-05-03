import type { TrainerEncounter } from "../../../types";

export const trainerEncounters: Record<string, TrainerEncounter[]> = {

    viridianCity: [
      {
        id: "viridian_1",
        name: "Youngster Joey",
        trainerClass: "youngster",
        team: [
          { speciesKey: "rattata", level: 6 },
          { speciesKey: "pidgey", level: 5 },
        ],
      },
      {
        id: "viridian_2",
        name: "Lass Sally",
        trainerClass: "lass",
        team: [
          { speciesKey: "nidoranF", level: 6 },
          { speciesKey: "nidoranM", level: 6 },
        ],
      },
      {
        id: "viridian_3",
        name: "Youngster Ben",
        trainerClass: "youngster",
        team: [
          { speciesKey: "rattata", level: 7 },
          { speciesKey: "spearow", level: 7 },
        ],
      },
      {
        id: "viridian_4",
        name: "Lass Robin",
        trainerClass: "lass",
        team: [
          { speciesKey: "pidgey", level: 5 },
          { speciesKey: "pidgey", level: 7 },
          { speciesKey: "pidgey", level: 9 },
        ],
      },
    ],
    pewterCity: [
      {
        id: "pewter_1",
        name: "Hiker Marcos",
        trainerClass: "hiker",
        team: [
          { speciesKey: "geodude", level: 10 },
          { speciesKey: "onix", level: 12 },
        ],
      },
      {
        id: "pewter_2",
        name: "Bug Catcher Rick",
        trainerClass: "bugCatcher",
        team: [
          { speciesKey: "caterpie", level: 9 },
          { speciesKey: "weedle", level: 9 },
          { speciesKey: "metapod", level: 10 },
          { speciesKey: "kakuna", level: 10 },
        ],
      },
      {
        id: "pewter_3",
        name: "Hiker Liam",
        trainerClass: "hiker",
        team: [
          { speciesKey: "geodude", level: 11 },
          { speciesKey: "geodude", level: 11 },
          { speciesKey: "geodude", level: 13 },
        ],
      },
      {
        id: "pewter_4",
        name: "Bug Catcher Doug",
        trainerClass: "bugCatcher",
        team: [
          { speciesKey: "caterpie", level: 11 },
          { speciesKey: "metapod", level: 11 },
          { speciesKey: "butterfree", level: 14 },
        ],
      },
      {
        id: "pewter_5",
        name: "Hiker Franklin",
        trainerClass: "hiker",
        team: [
          { speciesKey: "geodude", level: 12 },
          { speciesKey: "onix", level: 14 },
        ],
      },
    ],
    ceruleanCity: [
      {
        id: "cerulean_1",
        name: "Swimmer Luis",
        trainerClass: "swimmer",
        team: [
          { speciesKey: "staryu", level: 16 },
          { speciesKey: "goldeen", level: 18 },
        ],
      },
      {
        id: "cerulean_2",
        name: "Camper Lola",
        trainerClass: "camper",
        team: [
          { speciesKey: "oddish", level: 16 },
          { speciesKey: "bellsprout", level: 16 },
          { speciesKey: "pidgeotto", level: 18 },
        ],
      },
      {
        id: "cerulean_3",
        name: "Swimmer Diana",
        trainerClass: "swimmer",
        team: [
          { speciesKey: "poliwag", level: 17 },
          { speciesKey: "shellder", level: 17 },
          { speciesKey: "horsea", level: 19 },
        ],
      },
      {
        id: "cerulean_4",
        name: "Camper Jeff",
        trainerClass: "camper",
        team: [
          { speciesKey: "sandshrew", level: 18 },
          { speciesKey: "ekans", level: 18 },
          { speciesKey: "rattata", level: 20 },
        ],
      },
      {
        id: "cerulean_5",
        name: "Swimmer Tara",
        trainerClass: "swimmer",
        team: [
          { speciesKey: "staryu", level: 19 },
          { speciesKey: "staryu", level: 19 },
          { speciesKey: "goldeen", level: 21 },
        ],
      },
    ],
    vermilionCity: [
      {
        id: "vermilion_1",
        name: "Sailor Eddie",
        trainerClass: "sailor",
        team: [
          { speciesKey: "machop", level: 20 },
          { speciesKey: "tentacool", level: 20 },
        ],
      },
      {
        id: "vermilion_2",
        name: "Gentleman Arthur",
        trainerClass: "gentleman",
        team: [
          { speciesKey: "voltorb", level: 22 },
          { speciesKey: "magnemite", level: 22 },
        ],
      },
      {
        id: "vermilion_3",
        name: "Sailor Dylan",
        trainerClass: "sailor",
        team: [
          { speciesKey: "machop", level: 19 },
          { speciesKey: "machop", level: 21 },
          { speciesKey: "tentacool", level: 22 },
        ],
      },
      {
        id: "vermilion_4",
        name: "Gentleman Brooks",
        trainerClass: "gentleman",
        team: [
          { speciesKey: "pikachu", level: 22 },
          { speciesKey: "magnemite", level: 24 },
        ],
      },
      {
        id: "vermilion_5",
        name: "Sailor Huey",
        trainerClass: "sailor",
        team: [
          { speciesKey: "machop", level: 22 },
          { speciesKey: "shellder", level: 22 },
          { speciesKey: "machoke", level: 24 },
        ],
      },
    ],
    lavenderTown: [
      {
        id: "lavender_1",
        name: "Channeler Hope",
        trainerClass: "channeler",
        team: [
          { speciesKey: "gastly", level: 23 },
          { speciesKey: "gastly", level: 25 },
        ],
      },
      {
        id: "lavender_2",
        name: "Channeler Patricia",
        trainerClass: "channeler",
        team: [
          { speciesKey: "gastly", level: 24 },
          { speciesKey: "haunter", level: 26 },
        ],
      },
      {
        id: "lavender_3",
        name: "Channeler Carly",
        trainerClass: "channeler",
        team: [
          { speciesKey: "gastly", level: 22 },
          { speciesKey: "cubone", level: 24 },
          { speciesKey: "haunter", level: 26 },
        ],
      },
      {
        id: "lavender_4",
        name: "Channeler Laurel",
        trainerClass: "channeler",
        team: [
          { speciesKey: "cubone", level: 25 },
          { speciesKey: "gastly", level: 25 },
          { speciesKey: "haunter", level: 28 },
        ],
      },
    ],
    celadonCity: [
      {
        id: "celadon_1",
        name: "Beauty Bridget",
        trainerClass: "beauty",
        team: [
          { speciesKey: "clefairy", level: 26 },
          { speciesKey: "meowth", level: 26 },
        ],
      },
      {
        id: "celadon_2",
        name: "CoolTrainer Samuel",
        trainerClass: "coolTrainer",
        team: [
          { speciesKey: "eevee", level: 26 },
          { speciesKey: "exeggcute", level: 28 },
          { speciesKey: "pidgeotto", level: 28 },
        ],
      },
      {
        id: "celadon_3",
        name: "Beauty Tamia",
        trainerClass: "beauty",
        team: [
          { speciesKey: "oddish", level: 26 },
          { speciesKey: "clefairy", level: 28 },
          { speciesKey: "jigglypuff", level: 28 },
        ],
      },
      {
        id: "celadon_4",
        name: "CoolTrainer Alexa",
        trainerClass: "coolTrainer",
        team: [
          { speciesKey: "gloom", level: 27 },
          { speciesKey: "exeggcute", level: 27 },
          { speciesKey: "weepinbell", level: 30 },
        ],
      },
      {
        id: "celadon_5",
        name: "Beauty Lola",
        trainerClass: "beauty",
        team: [
          { speciesKey: "vulpix", level: 28 },
          { speciesKey: "clefairy", level: 28 },
        ],
      },
    ],
    saffronCity: [
      {
        id: "saffron_1",
        name: "Psychic Cameron",
        trainerClass: "psychic",
        team: [
          { speciesKey: "kadabra", level: 30 },
          { speciesKey: "drowzee", level: 30 },
        ],
      },
      {
        id: "saffron_2",
        name: "Scientist Taylor",
        trainerClass: "scientist",
        team: [
          { speciesKey: "voltorb", level: 29 },
          { speciesKey: "magnemite", level: 29 },
          { speciesKey: "electrode", level: 32 },
        ],
      },
      {
        id: "saffron_3",
        name: "Psychic Tyron",
        trainerClass: "psychic",
        team: [
          { speciesKey: "abra", level: 28 },
          { speciesKey: "kadabra", level: 31 },
          { speciesKey: "mrMime", level: 34 },
        ],
      },
      {
        id: "saffron_4",
        name: "Scientist Ivan",
        trainerClass: "scientist",
        team: [
          { speciesKey: "magnemite", level: 30 },
          { speciesKey: "voltorb", level: 30 },
          { speciesKey: "magneton", level: 34 },
        ],
      },
      {
        id: "saffron_5",
        name: "Psychic Johan",
        trainerClass: "psychic",
        team: [
          { speciesKey: "drowzee", level: 30 },
          { speciesKey: "hypno", level: 34 },
        ],
      },
    ],
    fuchsiaCity: [
      {
        id: "fuchsia_1",
        name: "Tamer Phil",
        trainerClass: "tamer",
        team: [
          { speciesKey: "arbok", level: 34 },
          { speciesKey: "sandslash", level: 34 },
        ],
      },
      {
        id: "fuchsia_2",
        name: "Juggler Dalton",
        trainerClass: "juggler",
        team: [
          { speciesKey: "voltorb", level: 31 },
          { speciesKey: "voltorb", level: 33 },
          { speciesKey: "voltorb", level: 35 },
          { speciesKey: "electrode", level: 38 },
        ],
      },
      {
        id: "fuchsia_3",
        name: "Tamer Edgar",
        trainerClass: "tamer",
        team: [
          { speciesKey: "arbok", level: 33 },
          { speciesKey: "weezing", level: 35 },
          { speciesKey: "primeape", level: 35 },
        ],
      },
      {
        id: "fuchsia_4",
        name: "Juggler Nelson",
        trainerClass: "juggler",
        team: [
          { speciesKey: "drowzee", level: 32 },
          { speciesKey: "hypno", level: 36 },
          { speciesKey: "kadabra", level: 36 },
        ],
      },
      {
        id: "fuchsia_5",
        name: "Tamer Vincent",
        trainerClass: "tamer",
        team: [
          { speciesKey: "rhyhorn", level: 36 },
          { speciesKey: "primeape", level: 36 },
        ],
      },
    ],
    cinnabarIsland: [
      {
        id: "cinnabar_1",
        name: "Scientist Beau",
        trainerClass: "scientist",
        team: [
          { speciesKey: "grimer", level: 36 },
          { speciesKey: "koffing", level: 38 },
          { speciesKey: "weezing", level: 40 },
        ],
      },
      {
        id: "cinnabar_2",
        name: "Super Nerd Derek",
        trainerClass: "superNerd",
        team: [
          { speciesKey: "magmar", level: 38 },
          { speciesKey: "ponyta", level: 38 },
        ],
      },
      {
        id: "cinnabar_3",
        name: "Scientist Ted",
        trainerClass: "scientist",
        team: [
          { speciesKey: "grimer", level: 37 },
          { speciesKey: "muk", level: 40 },
          { speciesKey: "electrode", level: 40 },
        ],
      },
      {
        id: "cinnabar_4",
        name: "Super Nerd Zack",
        trainerClass: "superNerd",
        team: [
          { speciesKey: "ponyta", level: 36 },
          { speciesKey: "rapidash", level: 40 },
          { speciesKey: "growlithe", level: 42 },
        ],
      },
      {
        id: "cinnabar_5",
        name: "Scientist Connor",
        trainerClass: "scientist",
        team: [
          { speciesKey: "voltorb", level: 38 },
          { speciesKey: "electrode", level: 38 },
          { speciesKey: "magneton", level: 42 },
        ],
      },
    ],
    indigoPlat: [
      {
        id: "indigo_1",
        name: "Ace Trainer Chloe",
        trainerClass: "ace",
        team: [
          { speciesKey: "pidgeot", level: 48 },
          { speciesKey: "alakazam", level: 50 },
          { speciesKey: "arcanine", level: 50 },
        ],
      },
      {
        id: "indigo_2",
        name: "CoolTrainer Naomi",
        trainerClass: "coolTrainer",
        team: [
          { speciesKey: "exeggutor", level: 48 },
          { speciesKey: "cloyster", level: 48 },
          { speciesKey: "machamp", level: 50 },
          { speciesKey: "arcanine", level: 52 },
        ],
      },
      {
        id: "indigo_3",
        name: "Ace Trainer Jason",
        trainerClass: "ace",
        team: [
          { speciesKey: "gyarados", level: 50 },
          { speciesKey: "nidoking", level: 50 },
          { speciesKey: "dragonair", level: 52 },
        ],
      },
      {
        id: "indigo_4",
        name: "CoolTrainer Vincent",
        trainerClass: "coolTrainer",
        team: [
          { speciesKey: "rhydon", level: 48 },
          { speciesKey: "slowbro", level: 50 },
          { speciesKey: "gengar", level: 52 },
          { speciesKey: "starmie", level: 55 },
        ],
      },
      {
        id: "indigo_5",
        name: "Ace Trainer Lauren",
        trainerClass: "ace",
        team: [
          { speciesKey: "venusaur", level: 50 },
          { speciesKey: "charizard", level: 50 },
          { speciesKey: "blastoise", level: 50 },
        ],
      },
      {
        id: "indigo_6",
        name: "CoolTrainer Grayson",
        trainerClass: "coolTrainer",
        team: [
          { speciesKey: "dragonite", level: 55 },
          { speciesKey: "lapras", level: 50 },
          { speciesKey: "snorlax", level: 52 },
        ],
      },
    ],
};
