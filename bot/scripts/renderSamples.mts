// Render every card with representative sample data into bot/samples/.
//
// The point is that card layout cannot be verified by a typechecker. Text
// overflows, sprites land in the wrong box, a long nickname collides with the
// move column — none of that is a type error, and none of it is visible until
// somebody looks at a PNG. This is how you look, without a Discord server, a
// token, or a linked account.
//
// Sample data is deliberately AWKWARD rather than tidy: a nicknamed shiny with
// four long moves, an unranked player, a stuck prize, a Pokémon prize with no
// sprite. Pretty data hides exactly the bugs this exists to catch.
//
// Run: cd bot && npm run samples
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  profileCard, teamCard, monCard, rankCard, leaderboardCard, dexCard,
  giveawayCard, prizesCard, type PrizeDescriptor,
} from "../src/cards/index.ts";
import type { Identity, MonDetail, MonSummary, Rating } from "../src/api.ts";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "..", "samples");
mkdirSync(out, { recursive: true });

const party: MonSummary[] = [
  { slot: 1, speciesKey: "charizard", name: "Charizard", nickname: "Blaze", level: 78, isShiny: false, nature: "Adamant", heldItem: "leftovers", moves: ["flamethrower", "dragonClaw", "earthquake", "roost"] },
  { slot: 2, speciesKey: "pikachu", name: "Pikachu", nickname: null, level: 55, isShiny: true, nature: "Timid", heldItem: "lightball", moves: ["thunderbolt", "quickAttack"] },
  { slot: 3, speciesKey: "gengar", name: "Gengar", nickname: "Spooky Boy Supreme", level: 66, isShiny: false, nature: "Modest", heldItem: null, moves: ["shadowBall", "sludgeBomb", "thunderbolt", "destinyBond"] },
  { slot: 4, speciesKey: "lapras", name: "Lapras", nickname: null, level: 61, isShiny: false, nature: "Bold", heldItem: null, moves: ["surf", "iceBeam", "thunder", "bodySlam"] },
  { slot: 5, speciesKey: "dragonite", name: "Dragonite", nickname: null, level: 80, isShiny: false, nature: "Jolly", heldItem: null, moves: ["outrage", "extremeSpeed"] },
  { slot: 6, speciesKey: "snorlax", name: "Snorlax", nickname: null, level: 70, isShiny: false, nature: "Relaxed", heldItem: "leftovers", moves: ["bodySlam", "rest", "crunch"] },
];

const rating: Rating = {
  rating: 1487, peakRating: 1520, matchesPlayed: 64, wins: 41, losses: 23,
  forfeits: 0, unranked: false, badge: null, ladderPosition: 3,
};

const identity: Identity = {
  v: 1, userId: "u1", username: "phoenix", name: "Phoenix", accountLevel: 87,
  pokedexCaughtCount: 214, dailyStreak: 23, longestDailyStreak: 41,
  createdAt: "2025-11-02T00:00:00Z", lastSeenAt: "2026-08-01T00:00:00Z", rating,
};

const mon: MonDetail = {
  ...party[0], totalExp: 812345, currentHp: 240, maxHp: 268,
  attack: 293, defense: 198, spAttack: 241, spDefense: 205, speed: 236,
  ivs: { hp: 31, attack: 31, defense: 24, spAttack: 18, spDefense: 27, speed: 30 },
  evs: { attack: 252, speed: 252, hp: 6 },
  ability: "blaze",
};

const leaderboard = [
  { rank: 1, username: "rasputin", rating: 1622, wins: 88, losses: 20, accountLevel: 94 },
  { rank: 2, username: "kelsier", rating: 1544, wins: 61, losses: 30, accountLevel: 71 },
  { rank: 3, username: "phoenix", rating: 1487, wins: 41, losses: 23, accountLevel: 87 },
  { rank: 4, username: "averyverylongusernameindeed", rating: 1402, wins: 33, losses: 28, accountLevel: 55 },
  { rank: 5, username: "sazed", rating: 1350, wins: 22, losses: 21, accountLevel: 48 },
];

const masterball: PrizeDescriptor = { kind: "item", itemId: "masterball", quantity: 1 };
const money: PrizeDescriptor = { kind: "money", amount: 50_000 };
const candy: PrizeDescriptor = { kind: "item", itemId: "lifeorb", quantity: 3 };
const shinyMon: PrizeDescriptor = {
  kind: "pokemon", label: "Shiny Dratini", mon: { speciesKey: "dratini", isShiny: true, level: 30 },
};

async function write(name: string, buf: Buffer) {
  writeFileSync(resolve(out, name), buf);
  console.log(`  ${name}`);
}

console.log("Rendering samples…");
await write("profile.png", await profileCard(identity, party));
await write("team.png", await teamCard("phoenix", party));
await write("team-empty.png", await teamCard("newbie", []));
await write("mon.png", await monCard("phoenix", mon));
await write("rank.png", await rankCard("phoenix", rating));
await write("rank-unranked.png", await rankCard("newbie", { ...rating, unranked: true, matchesPlayed: 0, ladderPosition: null }));
await write("leaderboard.png", await leaderboardCard(leaderboard));
await write("dex.png", await dexCard({ username: "phoenix", caughtCount: 214, seenCount: 251, shinyCaughtCount: 7 }));
await write("giveaway.png", await giveawayCard({
  title: "Master Ball Friday",
  description: "One lucky trainer walks away with the good stuff.",
  prizes: [masterball, money, candy],
  winnerCount: 1,
}));
await write("prizes.png", await prizesCard("phoenix", [
  { summary: "1x Master Ball", prizes: [masterball], delivered: false, stuck: false },
  { summary: "$50,000", prizes: [money], delivered: true, stuck: false },
  { summary: "Shiny Dratini", prizes: [shinyMon], delivered: false, stuck: true },
]));
console.log(`Done → ${out}`);
