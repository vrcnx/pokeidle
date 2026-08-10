#!/usr/bin/env node
/**
 * Build src/data/regions/hoenn/ from the compact spec below.
 *
 *   npx vite-node scripts/gen-hoenn.mjs
 *
 * ── WHY A GENERATOR FOR A HAND-AUTHORED REGION ───────────────────────────
 * Kanto and Johto are literal data files, and for a region that already
 * exists that is the right shape — you read them, you edit one number.
 *
 * Hoenn is 62 locations. Written out longhand that is ~600 lines of route
 * objects in which every entry repeats the same five fields, and the parts a
 * human actually decides — where a place sits on the map, what lives there,
 * what it connects to — are buried in the boilerplate. Worse, the UNLOCK CHAIN
 * has to be consistent across all 62 or the region is unreachable past the
 * break, and that is not a property you can eyeball.
 *
 * So the spec below is the decisions, one line each, and the expansion is
 * mechanical: positions laid out along the progression, unlock gates derived
 * from the preceding stop, unlockOrder assigned in sequence. Getting the chain
 * right becomes a property of the generator rather than of 62 chances to
 * mistype a location id.
 *
 * The OUTPUT is committed and is what the game reads. This is not a runtime
 * dependency.
 *
 * ── THE LEVEL BAND ───────────────────────────────────────────────────────
 * Johto's gyms run 48 → 75 and its Elite Four 75 → 85. Hoenn sits directly
 * above: gyms 80 → 104, Elite Four 106 → 112, Champion Steven at 115. A
 * player arriving with a Johto-capable team has a real fight and an obvious
 * next rung.
 *
 * That is the FARM band, which is what an established player sees. A new
 * player gets the journey band instead — see JOURNEY_LEVEL_OFFSET in
 * utils/regionJourney.ts, which subtracts a flat amount until the region is
 * completed, so Route 101 is Lv 2-4 on the way through and Lv 78-80 forever
 * after.
 */

import { writeFileSync, mkdirSync } from "node:fs";

const OUT = new URL("../src/data/regions/hoenn/", import.meta.url);
const LINE = String.fromCharCode(10);
const q = (s) => JSON.stringify(s);

/**
 * The spec uses richer labels than the engine has.
 *
 * RouteType is `town | route | cave | victoryRoad | raid` and nothing else —
 * it drives the biome background fallback and the journey exemption, not
 * flavour. "city" and "water" are kept in the spec because they say something
 * true about the place and make the table readable, and they are folded to the
 * engine's vocabulary here rather than being invented in it. Adding a real
 * `water` type would mean a new biome background and a new fallback branch,
 * which is a bigger change than Hoenn needs.
 */
const TYPE_MAP = { city: "town", water: "route" };
const engineType = (t) => TYPE_MAP[t] ?? t;

/**
 * Hoenn's unlockOrder block.
 *
 * 100, not 90. Johto's highest is 89, which is the obvious number to continue
 * from and the wrong one — KANTO reaches 99, because Raid Island was appended
 * to it long after the region itself was laid out. Starting at 90 collided on
 * Route 116 and the route list would have sorted unstably between two regions.
 * Caught by hoenn.test.ts rather than by reading, which is the point of it.
 */
let order = 100;

// ── THE SPEC ─────────────────────────────────────────────────────────────
// [id, display name, type, x, y, description, [wild encounters]]
//
// Order IS the progression: each entry unlocks off the one before it, which
// is what makes the chain correct by construction. `connections` are the
// canonical geography and are allowed to run sideways — the unlock chain and
// the map graph are different things, and conflating them is how you get a
// region that draws correctly and cannot be walked.
//
// Encounters are the real Hoenn tables, trimmed to the handful that carry
// each area's character. Levels are the FARM band; the journey offset takes
// care of the first playthrough.
const E = (speciesKey, weight, minLevel, maxLevel) => ({ speciesKey, weight, minLevel, maxLevel });

const SPEC = [
  ["littlerootTown", "Littleroot Town", "town", 5, 50,
    "A quiet town under a wide sky, where Professor Birch keeps his lab and every Hoenn journey begins.", []],
  ["route101", "Route 101", "route", 11, 50,
    "A short strip of tall grass between Littleroot and Oldale, thick with Poochyena and Zigzagoon.",
    [E("zigzagoon", 30, 78, 80), E("poochyena", 30, 78, 80), E("wurmple", 25, 78, 80)]],
  ["oldaleTown", "Oldale Town", "town", 17, 50,
    "A small farming town with a Mart that seems to have been built the week before you arrived.", []],
  ["route103", "Route 103", "route", 17, 42,
    "A windy shoreline north of Oldale where trainers spar within sight of the water.",
    [E("zigzagoon", 28, 79, 81), E("poochyena", 26, 79, 81), E("wingull", 24, 79, 81), E("marill", 12, 79, 81)]],
  ["route102", "Route 102", "route", 23, 50,
    "A green lane of flowers and puddles running west toward Petalburg.",
    [E("zigzagoon", 24, 80, 82), E("wurmple", 22, 80, 82), E("lotad", 20, 80, 82), E("seedot", 20, 80, 82), E("ralts", 4, 80, 82)]],
  ["petalburgCity", "Petalburg City", "city", 29, 50,
    "A calm city of tree-lined water channels, and the home gym of a leader who will not battle you yet.", []],
  ["route104", "Route 104", "route", 35, 50,
    "A coastal road of soft sand and sea breeze, split by the woods that sit across its middle.",
    [E("wingull", 26, 81, 83), E("zigzagoon", 24, 81, 83), E("taillow", 22, 81, 83), E("marill", 18, 81, 83)]],
  ["petalburgWoods", "Petalburg Woods", "cave", 35, 43,
    "A damp, green wood where the canopy closes over the path and bug catchers wait in the gloom.",
    [E("wurmple", 26, 82, 84), E("shroomish", 24, 82, 84), E("silcoon", 18, 82, 84), E("cascoon", 18, 82, 84), E("slakoth", 10, 82, 84)]],
  ["rustboroCity", "Rustboro City", "city", 41, 50,
    "A city of grey stone and tall windows, built around the Devon Corporation and the region's first gym.", []],
  ["route116", "Route 116", "route", 47, 43,
    "A dusty road east of Rustboro leading to a tunnel that has been half-finished for years.",
    [E("whismur", 26, 83, 85), E("skitty", 22, 83, 85), E("nincada", 20, 83, 85), E("taillow", 20, 83, 85), E("abra", 6, 83, 85)]],
  ["rusturfTunnel", "Rusturf Tunnel", "cave", 53, 43,
    "An unfinished tunnel, dark and echoing, dug from both ends by people who never quite met in the middle.",
    [E("whismur", 45, 84, 86), E("zubat", 40, 84, 86), E("loudred", 10, 84, 86)]],
  ["route115", "Route 115", "route", 41, 42,
    "A cliffside shore north of Rustboro where the wind comes straight off the sea.",
    [E("taillow", 26, 84, 86), E("swablu", 24, 84, 86), E("wingull", 22, 84, 86), E("jigglypuff", 14, 84, 86)]],
  ["route105", "Route 105", "water", 35, 58,
    "Open water south of the mainland, dotted with rocks that only surface at low tide.",
    [E("tentacool", 40, 84, 86), E("wingull", 30, 84, 86), E("pelipper", 14, 84, 86)]],
  ["route106", "Route 106", "water", 35, 65,
    "A rough stretch of sea leading to the mouth of Granite Cave.",
    [E("tentacool", 38, 85, 87), E("wingull", 28, 85, 87), E("pelipper", 16, 85, 87)]],
  ["dewfordTown", "Dewford Town", "town", 41, 65,
    "An island town of fishermen and surfers where the only news arrives by mail.", []],
  ["graniteCave", "Granite Cave", "cave", 47, 65,
    "A layered cave of pale stone above and glittering dark below, where Steven Stone comes looking for rocks.",
    [E("zubat", 30, 86, 88), E("makuhita", 26, 86, 88), E("aron", 22, 86, 88), E("geodude", 18, 86, 88), E("sableye", 4, 86, 88)]],
  ["route107", "Route 107", "water", 47, 72,
    "Warm shallows crowded with swimmers and the occasional very large jellyfish.",
    [E("tentacool", 42, 86, 88), E("wingull", 26, 86, 88), E("carvanha", 12, 86, 88)]],
  ["route108", "Route 108", "water", 53, 72,
    "Deep blue water on the approach to the Abandoned Ship.",
    [E("tentacool", 40, 87, 89), E("wingull", 26, 87, 89), E("carvanha", 14, 87, 89)]],
  ["route109", "Route 109", "route", 59, 65,
    "Slateport's beach, loud with holidaymakers and the smell of fried food.",
    [E("tentacool", 32, 87, 89), E("wingull", 28, 87, 89), E("pelipper", 16, 87, 89), E("azurill", 12, 87, 89)]],
  ["slateportCity", "Slateport City", "city", 59, 58,
    "A busy port of market stalls and shipyards, where the sea air carries three arguments at once.", []],
  ["route110", "Route 110", "route", 59, 50,
    "A long coastal cycling road running north under a raised bike track.",
    [E("electrike", 26, 88, 90), E("gulpin", 22, 88, 90), E("minun", 18, 88, 90), E("plusle", 18, 88, 90), E("oddish", 12, 88, 90)]],
  ["mauvilleCity", "Mauville City", "city", 59, 42,
    "A bright grid of a city built around a game corner and a very loud gym.", []],
  ["route117", "Route 117", "route", 53, 35,
    "A gentle meadow west of Mauville with a day care and a lot of long grass.",
    [E("oddish", 24, 88, 90), E("marill", 22, 88, 90), E("illumise", 16, 88, 90), E("volbeat", 16, 88, 90), E("zigzagoon", 16, 88, 90)]],
  ["verdanturfTown", "Verdanturf Town", "town", 47, 35,
    "A town famous for its clean air, sitting in the shadow of a mountain that is anything but clean.", []],
  ["route111", "Route 111", "route", 65, 35,
    "A desert road where the sandstorm never quite stops and goggles are not optional.",
    [E("sandshrew", 26, 89, 91), E("trapinch", 24, 89, 91), E("baltoy", 22, 89, 91), E("cacnea", 18, 89, 91)]],
  ["route112", "Route 112", "route", 65, 28,
    "A volcanic slope of black grit and warm wind, cut through by a path into the mountain.",
    [E("numel", 34, 90, 92), E("machop", 26, 90, 92), E("marill", 20, 90, 92)]],
  ["fieryPath", "Fiery Path", "cave", 59, 28,
    "A tunnel under Mt. Chimney where the rock is too hot to lean on.",
    [E("numel", 30, 90, 92), E("machop", 26, 90, 92), E("koffing", 22, 90, 92), E("slugma", 18, 90, 92), E("torkoal", 4, 90, 92)]],
  ["route113", "Route 113", "route", 71, 28,
    "A road buried in volcanic ash, where footprints stay for hours.",
    [E("spinda", 28, 90, 92), E("slugma", 26, 90, 92), E("skarmory", 12, 90, 92)]],
  ["fallarborTown", "Fallarbor Town", "town", 77, 28,
    "A farming town resigned to living downwind of a volcano.", []],
  ["route114", "Route 114", "route", 77, 21,
    "A rocky descent from Fallarbor toward Meteor Falls, past a man who carves things out of stone.",
    [E("swablu", 24, 91, 93), E("nuzleaf", 22, 91, 93), E("lotad", 20, 91, 93), E("seviper", 14, 91, 93), E("zangoose", 14, 91, 93)]],
  ["meteorFalls", "Meteor Falls", "cave", 71, 21,
    "A vast cavern of waterfalls and pale light, where something fell out of the sky a very long time ago.",
    [E("zubat", 28, 92, 94), E("solrock", 20, 92, 94), E("lunatone", 20, 92, 94), E("golbat", 18, 92, 94), E("bagon", 6, 92, 94)]],
  ["jaggedPass", "Jagged Pass", "route", 59, 21,
    "A switchback trail down the volcano's flank, exposed to every gust that comes over the ridge.",
    [E("machop", 28, 92, 94), E("numel", 24, 92, 94), E("spoink", 24, 92, 94)]],
  ["lavaridgeTown", "Lavaridge Town", "town", 53, 21,
    "A hot-spring town on the mountainside, all steam and cracked tile and very relaxed people.", []],
  ["route118", "Route 118", "route", 71, 42,
    "A wide river mouth east of Mauville, crossed by anglers who have been there all day.",
    [E("electrike", 26, 93, 95), E("zigzagoon", 22, 93, 95), E("wingull", 20, 93, 95), E("kecleon", 8, 93, 95)]],
  ["route119", "Route 119", "route", 77, 42,
    "A humid green corridor of tall grass and rain, running north beside the river.",
    [E("linoone", 24, 94, 96), E("oddish", 22, 94, 96), E("tropius", 16, 94, 96), E("kecleon", 10, 94, 96)]],
  ["fortreeCity", "Fortree City", "city", 83, 42,
    "A city built entirely in the canopy, joined by rope bridges and a gym you have to climb.", []],
  ["route120", "Route 120", "route", 89, 42,
    "A misty stretch of forest and shallow ponds east of Fortree.",
    [E("oddish", 22, 95, 97), E("marill", 20, 95, 97), E("absol", 14, 95, 97), E("seedot", 20, 95, 97), E("kecleon", 8, 95, 97)]],
  ["route121", "Route 121", "route", 89, 50,
    "Open grassland on the approach to Lilycove, with the sea audible before it is visible.",
    [E("shuppet", 24, 96, 98), E("oddish", 22, 96, 98), E("wingull", 20, 96, 98), E("gloom", 16, 96, 98)]],
  ["lilycoveCity", "Lilycove City", "city", 89, 58,
    "A harbour city of department stores and contest halls, where everything eventually arrives.", []],
  ["route122", "Route 122", "water", 83, 65,
    "Choppy water at the foot of Mt. Pyre, quieter than it ought to be.",
    [E("tentacool", 38, 96, 98), E("wingull", 26, 96, 98), E("carvanha", 18, 96, 98)]],
  ["mtPyre", "Mt. Pyre", "cave", 83, 72,
    "A mountain of graves and wind chimes, where the living speak quietly out of habit.",
    [E("shuppet", 34, 97, 99), E("duskull", 30, 97, 99), E("vulpix", 18, 97, 99), E("chimecho", 4, 97, 99)]],
  ["route123", "Route 123", "route", 77, 72,
    "A long hillside of flower beds and berry patches on the southern coast.",
    [E("linoone", 22, 97, 99), E("gloom", 20, 97, 99), E("shuppet", 18, 97, 99), E("kecleon", 10, 97, 99)]],
  ["route124", "Route 124", "water", 95, 58,
    "Wide eastern sea over a sunken village, popular with divers.",
    [E("tentacool", 34, 98, 100), E("wingull", 24, 98, 100), E("chinchou", 20, 98, 100)]],
  ["mossdeepCity", "Mossdeep City", "city", 101, 58,
    "An island city of white sand and satellite dishes, with a gym run by twins.", []],
  ["route125", "Route 125", "water", 101, 50,
    "Rocky water north of Mossdeep where the current pulls toward the shoal.",
    [E("tentacool", 32, 99, 101), E("wingull", 24, 99, 101), E("sealeo", 14, 99, 101)]],
  ["shoalCave", "Shoal Cave", "cave", 107, 50,
    "A tidal cave that is two different caves depending on when you walk in.",
    [E("zubat", 30, 99, 101), E("spheal", 28, 99, 101), E("golbat", 20, 99, 101), E("snorunt", 14, 99, 101)]],
  ["route126", "Route 126", "water", 95, 65,
    "Deep water around a submerged crater, with Sootopolis somewhere below.",
    [E("tentacool", 32, 100, 102), E("wingull", 22, 100, 102), E("horsea", 18, 100, 102)]],
  ["sootopolisCity", "Sootopolis City", "city", 95, 72,
    "A white city inside a dormant crater, reachable only from the water and lit like a held breath.", []],
  ["caveOfOrigin", "Cave of Origin", "cave", 101, 72,
    "A cave beneath Sootopolis that goes further down than it should, and is very quiet.",
    [E("zubat", 40, 101, 103), E("golbat", 34, 101, 103), E("sableye", 12, 101, 103)]],
  ["route127", "Route 127", "water", 101, 65,
    "Open sea south-east of the crater, deep enough that the bottom is only a rumour.",
    [E("tentacool", 32, 101, 103), E("wingull", 22, 101, 103), E("wailmer", 20, 101, 103)]],
  ["route128", "Route 128", "water", 107, 65,
    "The deepest water in Hoenn, above a cavern nobody is supposed to be able to open.",
    [E("tentacool", 30, 102, 104), E("wailmer", 24, 102, 104), E("luvdisc", 20, 102, 104)]],
  ["seafloorCavern", "Seafloor Cavern", "cave", 113, 65,
    "A sealed chamber on the sea floor, reached by a passage that was not meant to be found.",
    [E("zubat", 34, 103, 105), E("golbat", 30, 103, 105), E("magikarp", 20, 103, 105)]],
  ["route129", "Route 129", "water", 107, 72,
    "Rough southern sea where something very large surfaces at intervals.",
    [E("wailmer", 30, 103, 105), E("tentacool", 26, 103, 105), E("wailord", 8, 103, 105)]],
  ["route130", "Route 130", "water", 101, 79,
    "Empty water over a mirage island that is not there most days.",
    [E("wingull", 32, 104, 106), E("tentacool", 28, 104, 106), E("wailmer", 20, 104, 106)]],
  ["route131", "Route 131", "water", 95, 79,
    "Calm water in the lee of a tower nobody climbs any more.",
    [E("tentacool", 30, 104, 106), E("wingull", 26, 104, 106), E("luvdisc", 20, 104, 106)]],
  ["pacifidlogTown", "Pacifidlog Town", "town", 89, 79,
    "A town of houses lashed to rafts, rising and falling with the tide.", []],
  ["skyPillar", "Sky Pillar", "cave", 89, 86,
    "A crumbling tower whose floors give way, climbing far past where the clouds start.",
    [E("golbat", 30, 105, 107), E("sableye", 24, 105, 107), E("claydol", 22, 105, 107), E("banette", 18, 105, 107)]],
  ["route132", "Route 132", "water", 83, 79,
    "A broken chain of islets on the long way back east.",
    [E("tentacool", 30, 105, 107), E("wingull", 26, 105, 107), E("horsea", 20, 105, 107)]],
  ["route133", "Route 133", "water", 77, 79,
    "Deep water and strong current, with nothing on the horizon in any direction.",
    [E("tentacool", 30, 106, 108), E("wingull", 24, 106, 108), E("wailmer", 20, 106, 108)]],
  ["route134", "Route 134", "water", 71, 79,
    "A one-way rip that carries you west whether or not that was the plan.",
    [E("tentacool", 28, 106, 108), E("wingull", 24, 106, 108), E("luvdisc", 22, 106, 108)]],
  ["everGrandeCity", "Ever Grande City", "city", 113, 72,
    "A cliff of waterfalls and flowers with the Pokémon League at the top and nothing else at all.", []],
  ["victoryRoadHoenn", "Victory Road", "victoryRoad", 119, 72,
    "The last cave, three floors of it, full of trainers who got this far and stopped.",
    [E("golbat", 26, 108, 110), E("hariyama", 22, 108, 110), E("lairon", 20, 108, 110), E("loudred", 18, 108, 110), E("mawile", 10, 108, 110)]],
];

/** Canonical geography. The unlock chain runs down SPEC; this is the map. */
const LINKS = {
  littlerootTown: ["route101"],
  route101: ["littlerootTown", "oldaleTown"],
  oldaleTown: ["route101", "route102", "route103"],
  route103: ["oldaleTown"],
  route102: ["oldaleTown", "petalburgCity"],
  petalburgCity: ["route102", "route104"],
  route104: ["petalburgCity", "petalburgWoods", "rustboroCity", "route105"],
  petalburgWoods: ["route104"],
  rustboroCity: ["route104", "route115", "route116"],
  route116: ["rustboroCity", "rusturfTunnel"],
  rusturfTunnel: ["route116", "verdanturfTown"],
  route115: ["rustboroCity", "meteorFalls"],
  route105: ["route104", "route106"],
  route106: ["route105", "dewfordTown"],
  dewfordTown: ["route106", "graniteCave", "route107"],
  graniteCave: ["dewfordTown"],
  route107: ["dewfordTown", "route108"],
  route108: ["route107", "route109"],
  route109: ["route108", "slateportCity"],
  slateportCity: ["route109", "route110"],
  route110: ["slateportCity", "mauvilleCity"],
  mauvilleCity: ["route110", "route111", "route117", "route118"],
  route117: ["mauvilleCity", "verdanturfTown"],
  verdanturfTown: ["route117", "rusturfTunnel"],
  route111: ["mauvilleCity", "route112", "route113"],
  route112: ["route111", "fieryPath", "jaggedPass"],
  fieryPath: ["route112"],
  route113: ["route111", "fallarborTown"],
  fallarborTown: ["route113", "route114"],
  route114: ["fallarborTown", "meteorFalls"],
  meteorFalls: ["route114", "route115"],
  jaggedPass: ["route112", "lavaridgeTown"],
  lavaridgeTown: ["jaggedPass"],
  route118: ["mauvilleCity", "route119"],
  route119: ["route118", "fortreeCity"],
  fortreeCity: ["route119", "route120"],
  route120: ["fortreeCity", "route121"],
  route121: ["route120", "lilycoveCity"],
  lilycoveCity: ["route121", "route122", "route124"],
  route122: ["lilycoveCity", "mtPyre"],
  mtPyre: ["route122", "route123"],
  route123: ["mtPyre"],
  route124: ["lilycoveCity", "mossdeepCity", "route126"],
  mossdeepCity: ["route124", "route125", "route127"],
  route125: ["mossdeepCity", "shoalCave"],
  shoalCave: ["route125"],
  route126: ["route124", "sootopolisCity"],
  sootopolisCity: ["route126", "caveOfOrigin"],
  caveOfOrigin: ["sootopolisCity"],
  route127: ["mossdeepCity", "route128"],
  route128: ["route127", "seafloorCavern", "route129"],
  seafloorCavern: ["route128"],
  route129: ["route128", "route130"],
  route130: ["route129", "route131"],
  route131: ["route130", "pacifidlogTown"],
  pacifidlogTown: ["route131", "skyPillar", "route132"],
  skyPillar: ["pacifidlogTown"],
  route132: ["pacifidlogTown", "route133"],
  route133: ["route132", "route134"],
  route134: ["route133", "everGrandeCity"],
  everGrandeCity: ["route134", "victoryRoadHoenn"],
  victoryRoadHoenn: ["everGrandeCity"],
};

// ── Expansion ────────────────────────────────────────────────────────────
const routes = [];
const encounters = [];
let prev = null;

for (const [id, name, type, x, y, description, wild] of SPEC) {
  // The gate. Littleroot waits on Johto's Champion — the same shape New Bark
  // Town uses to wait on Kanto's — and everything after it waits on battles
  // won at the previous stop, which is what makes the chain correct by
  // construction rather than by 62 careful edits.
  const unlock = prev === null
    ? "{ championDefeated: true }"
    : `{ battlesAtLocation: [{ locationId: ${q(prev)}, count: ${engineType(type) === "town" ? 5 : 6} }] }`;

  routes.push(`  ${id}: {
    id: ${q(id)},
    name: ${q(name)},
    type: ${q(engineType(type))},
    description: ${q(description)},
    connections: [${(LINKS[id] ?? []).map(q).join(", ")}],
    unlock: ${unlock},
    unlockOrder: ${order++},
    position: { x: ${x.toFixed(2)}, y: ${y.toFixed(2)} },
  },`);

  if (wild.length) {
    encounters.push(`  ${id}: {
    name: ${q(name)},
    encounters: [
${wild.map((w) => `      { speciesKey: ${q(w.speciesKey)}, weight: ${w.weight}, minLevel: ${w.minLevel}, maxLevel: ${w.maxLevel} },`).join(LINE)}
    ],
  },`);
  }
  prev = id;
}

// ── Gyms, in badge order ─────────────────────────────────────────────────
const GYMS = [
  ["roxanne", "Roxanne", "Rustboro City", "rustboroCity", "Stone Badge", "#B0A18C", [["geodude", 78], ["nosepass", 80]]],
  ["brawly", "Brawly", "Dewford Town", "dewfordTown", "Knuckle Badge", "#C96A3A", [["machop", 82], ["makuhita", 84]]],
  ["wattson", "Wattson", "Mauville City", "mauvilleCity", "Dynamo Badge", "#E8C63A", [["magnemite", 86], ["voltorb", 86], ["manectric", 88]]],
  ["flannery", "Flannery", "Lavaridge Town", "lavaridgeTown", "Heat Badge", "#D2452F", [["numel", 90], ["slugma", 90], ["torkoal", 92]]],
  ["norman", "Norman", "Petalburg City", "petalburgCity", "Balance Badge", "#9AA0A6", [["spinda", 93], ["vigoroth", 94], ["slaking", 96]]],
  ["winona", "Winona", "Fortree City", "fortreeCity", "Feather Badge", "#8FB8E8", [["swellow", 97], ["pelipper", 97], ["skarmory", 98], ["altaria", 99]]],
  ["tateAndLiza", "Tate & Liza", "Mossdeep City", "mossdeepCity", "Mind Badge", "#C48BD9", [["claydol", 100], ["xatu", 100], ["lunatone", 101], ["solrock", 101]]],
  ["wallace", "Wallace", "Sootopolis City", "sootopolisCity", "Rain Badge", "#4FA8C7", [["luvdisc", 102], ["whiscash", 103], ["sealeo", 103], ["milotic", 104]]],
];

const gymLeaders = GYMS.map(([id, name, town, locationKey, badgeName, badgeColor, team]) => `  {
    id: ${q(id)},
    name: ${q(name)},
    title: ${q(`${town} Gym Leader`)},
    locationKey: ${q(locationKey)},
    badgeName: ${q(badgeName)},
    badgeColor: ${q(badgeColor)},
    spriteKey: ${q(`${id.toLowerCase()}-gen3`)},
    team: [${team.map(([s, l]) => `{ speciesKey: ${q(s)}, level: ${l} }`).join(", ")}],
  },`);

// ── Elite Four and Champion ──────────────────────────────────────────────
const E4 = [
  ["sidney", "Sidney", "#4A4A55", [["mightyena", 106], ["shiftry", 106], ["cacturne", 107], ["crawdaunt", 107], ["absol", 108]]],
  ["phoebe", "Phoebe", "#8B6BB1", [["dusclops", 107], ["banette", 108], ["sableye", 108], ["banette", 109], ["dusclops", 109]]],
  ["glacia", "Glacia", "#7FB8D4", [["sealeo", 108], ["glalie", 109], ["sealeo", 109], ["glalie", 110], ["walrein", 111]]],
  ["drake", "Drake", "#6B4FA8", [["shelgon", 110], ["altaria", 110], ["flygon", 111], ["flygon", 111], ["salamence", 112]]],
];

const eliteFour = E4.map(([id, name, badgeColor, team]) => `  {
    id: ${q(id)},
    name: ${q(name)},
    title: "Elite Four",
    locationKey: "everGrandeCity",
    badgeName: "",
    badgeColor: ${q(badgeColor)},
    spriteKey: ${q(`${id}-gen3`)},
    team: [${team.map(([s, l]) => `{ speciesKey: ${q(s)}, level: ${l} }`).join(", ")}],
  },`);

// ── Town trainers ────────────────────────────────────────────────────────
// Towns have no wild encounters, so town trainers are the ONLY source of
// `battlesWonByLocation[town]` — and the unlock chain gates the next stop on
// battles won at the previous one. Without a roster in every town the region
// dead-ends at the first one. Same reason Johto's towns have them.
const TOWN_TRAINERS = {
  littlerootTown: [["May", "youngster", [["torchic", 78]]], ["Rival Brendan", "youngster", [["mudkip", 79], ["zigzagoon", 78]]], ["Prof. Aide", "youngster", [["poochyena", 78]]]],
  oldaleTown: [["Youngster Calvin", "youngster", [["poochyena", 80], ["zigzagoon", 80]]], ["Lass Tiana", "lass", [["wurmple", 80]]], ["Bug Catcher Rick", "bugcatcher", [["wurmple", 81]]]],
  petalburgCity: [["Rich Boy Winston", "gentleman", [["zigzagoon", 82]]], ["Lady Cindy", "lass", [["zigzagoon", 82]]], ["Scientist Ivan", "scientist", [["magnemite", 83]]]],
  rustboroCity: [["School Kid Georgia", "youngster", [["shroomish", 84]]], ["Hiker Marc", "hiker", [["geodude", 85], ["aron", 85]]], ["Youngster Josh", "youngster", [["nincada", 84]]]],
  verdanturfTown: [["Battle Girl Vivian", "blackbelt", [["meditite", 88]]], ["Youngster Haley", "youngster", [["skitty", 88]]], ["Bug Maniac Brandon", "bugcatcher", [["nincada", 89]]]],
  dewfordTown: [["Black Belt Takao", "blackbelt", [["makuhita", 87]]], ["Fisherman Elliot", "fisherman", [["magikarp", 86], ["tentacool", 87]]], ["Sailor Huey", "sailor", [["machop", 87]]]],
  slateportCity: [["Sailor Dwayne", "sailor", [["wingull", 89]]], ["Tuber Ricky", "youngster", [["azurill", 88]]], ["Collector Edwin", "gentleman", [["gulpin", 89]]]],
  mauvilleCity: [["Guitarist Kirk", "youngster", [["electrike", 91]]], ["Bug Maniac Angelo", "bugcatcher", [["nincada", 90]]], ["Youngster Wattson Fan", "youngster", [["voltorb", 91]]]],
  fallarborTown: [["Hiker Trent", "hiker", [["geodude", 92], ["numel", 92]]], ["Beauty Sheila", "beauty", [["spinda", 92]]], ["Ruin Maniac Andres", "hiker", [["baltoy", 93]]]],
  lavaridgeTown: [["Hiker Lenny", "hiker", [["numel", 94]]], ["Kindler Cole", "firebreather", [["slugma", 94]]], ["Battle Girl Danielle", "blackbelt", [["machoke", 95]]]],
  fortreeCity: [["Bird Keeper Coby", "birdkeeper", [["swellow", 97]]], ["Ninja Boy Lung", "ninja", [["nincada", 96]]], ["Camper Branden", "camper", [["linoone", 96]]]],
  lilycoveCity: [["Beauty Bridget", "beauty", [["gloom", 98]]], ["Pokéfan Vanessa", "gentleman", [["skitty", 98]]], ["Sailor Edmond", "sailor", [["wingull", 99]]]],
  mossdeepCity: [["Psychic Cameron", "psychic", [["kadabra", 101]]], ["Gentleman Everett", "gentleman", [["xatu", 101]]], ["Ninja Boy Yasu", "ninja", [["ninjask", 100]]]],
  sootopolisCity: [["Swimmer Beverly", "swimmer", [["luvdisc", 103]]], ["Beauty Callie", "beauty", [["milotic", 104]]], ["Fisherman Nolan", "fisherman", [["whiscash", 103]]]],
  pacifidlogTown: [["Swimmer Tony", "swimmer", [["wailmer", 106]]], ["Fisherman Barny", "fisherman", [["luvdisc", 105]]], ["Sailor Duncan", "sailor", [["tentacruel", 106]]]],
  everGrandeCity: [["Cooltrainer Vito", "cooltrainer", [["swellow", 109], ["kadabra", 109]]], ["Cooltrainer Michelle", "cooltrainer", [["hariyama", 110]]], ["Cooltrainer Owen", "cooltrainer", [["lairon", 110]]]],
};

const trainerEncounters = Object.entries(TOWN_TRAINERS).map(([town, list]) => `  ${town}: [
${list.map(([name, cls, team], i) => `    { id: ${q(`${town}_${i + 1}`)}, name: ${q(name)}, trainerClass: ${q(cls)}, team: [${team.map(([s, l]) => `{ speciesKey: ${q(s)}, level: ${l} }`).join(", ")}] },`).join(LINE)}
  ],`);

// ── Marts ────────────────────────────────────────────────────────────────
// No TMs — machines are sold only at the TM Mart, on a daily rotation. Same
// rule as Kanto and Johto.
const SHOPS = [
  ["oldaleTown", "Oldale Mart", [["pokeball"]]],
  ["petalburgCity", "Petalburg Mart", [["pokeball"], ["greatball", 50]]],
  ["rustboroCity", "Rustboro Mart", [["pokeball"], ["greatball", 40]]],
  ["slateportCity", "Slateport Market", [["pokeball"], ["greatball"], ["ultraball", 220]]],
  ["mauvilleCity", "Mauville Mart", [["pokeball"], ["greatball"], ["ultraball", 180]]],
  ["lavaridgeTown", "Lavaridge Mart", [["greatball"], ["ultraball", 150]]],
  ["fortreeCity", "Fortree Mart", [["greatball"], ["ultraball", 120]]],
  ["lilycoveCity", "Lilycove Department Store", [["pokeball"], ["greatball"], ["ultraball"]]],
  ["mossdeepCity", "Mossdeep Mart", [["greatball"], ["ultraball"]]],
  ["sootopolisCity", "Sootopolis Mart", [["ultraball"]]],
  ["everGrandeCity", "Ever Grande Mart", [["ultraball"]]],
];
const shops = SHOPS.map(([id, name, items]) => `  ${id}: {
    name: ${q(name)},
    items: [
${items.map(([itemId, gate]) => `      { itemId: ${q(itemId)}${gate ? `, unlockWildBattlesWon: ${gate}` : ""} },`).join(LINE)}
    ],
  },`);

// ── Emit ─────────────────────────────────────────────────────────────────
const HEAD = (what) => `// GENERATED by scripts/gen-hoenn.mjs — do not edit by hand.
//
// ${what}
// Regenerate with:  npx vite-node scripts/gen-hoenn.mjs
`;

mkdirSync(OUT, { recursive: true });
const w = (f, body) => writeFileSync(new URL(f, OUT), body, "utf8");

w("routes.ts", `${HEAD("Hoenn's 62 locations, gated behind Johto's Champion.")}
import type { Route } from "../../../types";

export const routes: Record<string, Route> = {
${routes.join(LINE)}
};
`);

w("encounters.ts", `${HEAD("Wild tables. Levels are the FARM band — a first playthrough sees these minus JOURNEY_LEVEL_OFFSET.hoenn (see utils/regionJourney.ts).")}
export const encounters: Record<string, { name: string; encounters: { speciesKey: string; weight: number; minLevel: number; maxLevel: number }[] }> = {
${encounters.join(LINE)}
};
`);

w("gymLeaders.ts", `${HEAD("Eight gyms, 78 -> 104. Sits directly above Johto's 48 -> 75 band.")}
import type { GymLeader } from "../../../types";

export const gymLeaders: GymLeader[] = [
${gymLeaders.join(LINE)}
];
`);

w("eliteFour.ts", `${HEAD("Elite Four 106 -> 112, Champion Steven at 115 — the new ceiling.")}
import type { GymLeader } from "../../../types";

export const eliteFour: GymLeader[] = [
${eliteFour.join(LINE)}
];

export const champion: GymLeader = {
  id: "steven",
  name: "Steven",
  title: "Hoenn Champion",
  locationKey: "everGrandeCity",
  badgeName: "",
  badgeColor: "#8E9BAE",
  spriteKey: "steven-gen3",
  team: [
    { speciesKey: "skarmory", level: 113 },
    { speciesKey: "claydol", level: 113 },
    { speciesKey: "aggron", level: 114 },
    { speciesKey: "cradily", level: 114 },
    { speciesKey: "armaldo", level: 114 },
    { speciesKey: "metagross", level: 115 },
  ],
};
`);

w("trainerEncounters.ts", `${HEAD("Town rosters. Towns have no wild encounters, so these are the ONLY source of battles-won at a town — and the unlock chain runs on exactly that. Without them the region dead-ends at Littleroot.")}
import type { TrainerEncounter } from "../../../types";

export const trainerEncounters: Record<string, TrainerEncounter[]> = {
${trainerEncounters.join(LINE)}
};
`);

w("shops.ts", `${HEAD("Marts. No TMs — machines are sold only at the TM Mart, on a daily rotation.")}
import type { ShopDef } from "../../../types";

export const shops: Record<string, ShopDef> = {
${shops.join(LINE)}
};
`);

w("index.ts", `${HEAD("The region object.")}
import type { Region } from "../types";
import { routes } from "./routes";
import { encounters } from "./encounters";
import { gymLeaders } from "./gymLeaders";
import { eliteFour, champion } from "./eliteFour";
import { trainerEncounters } from "./trainerEncounters";
import { shops } from "./shops";

// Hoenn — unlocked after beating Johto's Champion. Littleroot Town carries the
// actual gate (\`unlock: { championDefeated: true }\` in routes.ts); the
// \`unlockCondition\` below states the same relationship on the Region object,
// per the checklist in regions/types.ts.
//
// NOT added to LEGACY_REGIONS in utils/regionJourney.ts, and that is the whole
// point of the journey system: a Pokemon with no recorded origin counts as
// native to Kanto and Johto only, so an established box cannot walk into Hoenn
// and flatten it. That list is frozen.
export const hoenn: Region = {
  id: "hoenn",
  name: "Hoenn",
  starters: ["treecko", "torchic", "mudkip"],
  startingLocation: "littlerootTown",
  unlockCondition: { championDefeatedIn: "johto" },
  routes,
  encounters,
  gymLeaders,
  eliteFour,
  champion,
  trainerEncounters,
  shops,
};
`);

console.log(`locations: ${SPEC.length}`);
console.log(`with wild encounters: ${encounters.length}`);
console.log(`gyms: ${GYMS.length}  elite four: ${E4.length}`);
console.log(`towns with trainers: ${Object.keys(TOWN_TRAINERS).length}`);
console.log(`marts: ${SHOPS.length}`);
console.log(`unlockOrder: 100 .. ${order - 1}`);
