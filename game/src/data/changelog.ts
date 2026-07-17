import type { ChangelogEntry } from "../types";

// The version the client is currently running. Bump this (and add a
// matching entry at the TOP of `changelog`) whenever you ship something
// players should know about. The What's New modal keys off it.
//
// Keep this in sync with package.json's version field.
export const CURRENT_VERSION = "0.5.0";
export const LAST_SEEN_VERSION_KEY = "pokemon-idle-last-seen-version";

// Compare two dotted versions. Returns >0 if a is newer than b.
// Used to show a returning player ONLY the entries published since they
// were last here, rather than the entire history every time.
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// Entries NEWER than `since`. A null/unknown `since` means we have never
// recorded a version for this player, which is the brand-new-player case
// — they get nothing, because a wall of release notes is a terrible
// first thing to see in a game you have not played yet.
export function changesSince(since: string | null): ChangelogEntry[] {
  if (!since) return [];
  return changelog.filter((e) => compareVersions(e.version, since) > 0);
}

export const changelog: ChangelogEntry[] = [
    {
      version: "0.5.0",
      subtitle: "Universal Mart, gamified PvP, achievements & a big bug sweep",
      date: "2026-07-17",
      highlight: true,
      sections: [
        {
          heading: "Poke Mart is now universal",
          items: [
            "Every mart now stocks everything you have unlocked anywhere — no more travelling back to Celadon for a stone",
            "Visit a town once and its stock is yours from any mart, forever",
            "New category tabs (Poke Balls / Repels / Stones / Held Items) with live counts, and each item shows where you first found it",
            "Locked items now show real progress (\"12 / 50 wild battles\") instead of a static requirement",
          ],
        },
        {
          heading: "Battle Hub — PvP rebuilt",
          items: [
            "Brand-new gamified lobby: trainer card with your rank, rating ring, win streak and full team on show",
            "Ranked tiers — Bronze, Silver, Gold, Platinum and Diamond, with your progress to the next tier",
            "Last-10 form guide, live top-3 leaderboard, and one-tap spectating of matches happening right now",
            "Your current party is pre-selected when you queue, so Ready Up is genuinely one click",
          ],
        },
        {
          heading: "Achievements",
          items: [
            "30 achievements across catching, battling, PvP, trading, money, exploration, collection and the story",
            "Bronze through Diamond tiers, with a trophy gallery showing your progress on everything still locked",
            "Unlock toasts pop the moment you earn one — find the gallery in Settings > Stats",
          ],
        },
        {
          heading: "Pokedex glow-up",
          items: [
            "Completion ring, milestone badges (10 / 25 / 50 / 100 / 151) and per-type completion bars",
            "Filter by Caught / Seen / Shiny / undiscovered",
            "Shiny entries now sparkle in the grid so your collection actually shows off",
          ],
        },
        {
          heading: "Battle feel",
          items: [
            "Level-ups, catches and money now pop on screen instead of only scrolling past in the log",
            "Sprites are pre-loaded so wild Pokemon appear instantly instead of flickering in",
          ],
        },
        {
          heading: "Catching fixes (thank you for the reports!)",
          items: [
            "Auto-catch defaulted to \"only new species\", which silently stopped throwing balls at Pokemon you had already caught — it now catches everything by default, and existing saves have been migrated",
            "The per-species CATCH button was mislabelled and toggled the WRONG way — it now clearly reads CATCH or SKIP",
            "\"Catch All\" did nothing on routes you had not customised. Fixed",
            "Shinies could escape if a route was configured a certain way — \"always catch shinies\" now genuinely overrides everything, and will use any ball you own",
            "Safari Zone Dratini spawned below every sensible level threshold, so it was never caught. Fixed",
          ],
        },
        {
          heading: "Save & progression fixes",
          items: [
            "Fixed the big one: playing on a second device could silently roll your progress back. Saves are now versioned properly and the server refuses any write that would erase your badges, Elite Four wins or Pokedex",
            "Veteran trainers with 600+ Pokemon in the PC could not save at all, which also broke their trades. The cap is now 9,999",
            "Profile levels that were stuck (\"mine says 5838 forever\") now update correctly",
            "Pokedex counts no longer double-count",
          ],
        },
        {
          heading: "Quality of life",
          items: [
            "PC box Pokemon are no longer invisible until you hover them, and small sprites render at a readable size",
            "Friend requests now light up the Social button instead of hiding until you click in",
            "Fixed a crash that could take the whole app down (especially with browser translation turned on)",
          ],
        },
      ],
    },
    {
      version: "0.4.0",
      subtitle: "Repel & Honey, Exp. Share, Mobile Layout & QoL",
      sections: [
        {
          heading: "Repel & Honey Items",
          items: [
            "New consumable items: Repel (halves encounter weight) and Honey (doubles encounter weight) for a specific Pokemon on a route, lasting 500 battles",
            "Buy them from any Poke Mart for $2,000 each",
            "Apply from the detail panel by clicking a Pokemon tile, or use the new selector mode buttons in the Wild Pokemon header to batch-apply by clicking tiles directly",
            'Active effects show as blue "R" and yellow "H" badges on encounter tiles',
            "Active effect durations are displayed in the battle log and detail panel",
            "Re-using on the same species extends the duration instead of stacking",
          ],
        },
        {
          heading: "Exp. Share",
          items: [
            "New item available in the Reward Shop for 2 Victory Tokens",
            "When active, the battling Pokemon receives 50% EXP and all non-fainted party members receive 5% EXP each",
            "Lasts 1000 battles — activate from your Bag",
            "Party members can level up and learn moves from shared EXP",
          ],
        },
        {
          heading: "Mobile Layout",
          items: [
            "Completely new responsive layout for screens under 768px",
            "Tabbed navigation: Battle, Location, Party, Box, and Map tabs",
            "Battle scene scales to fit the screen width",
            "Battle log auto-hides when space is too tight",
          ],
        },
        {
          heading: "Shiny Charm",
          items: [
            "Complete the Pokedex (catch all 151 Pokemon) to unlock the Shiny Charm",
            "Doubles shiny encounter odds from 1/8192 to 1/4096",
            "Applies to wild encounters and raid legendaries",
            "Check your shiny stats and charm status in the ? info menu",
          ],
        },
        {
          heading: "New Content",
          items: [
            "Starters (Bulbasaur, Charmander, Squirtle) can now be found as ultra-rare encounters in the Safari Zone",
            "Omanyte and Kabuto now evolve into Omastar and Kabutops at level 40",
            'Added "Ultra Rare" rarity tier for the rarest encounters',
          ],
        },
        {
          heading: "Quality of Life",
          items: [
            'Default catch mode changed from "Always" to "Pokedex New" for less ball waste',
            "Route 6/Vermilion unlock order swapped with Route 7/Celadon for better progression flow",
            "Safari Zone encounter weights rebalanced for smoother distribution",
            "Duplicate move learning is now prevented — Pokemon won't re-learn moves they already know",
            "Move manage panel now validates the active Pokemon hasn't changed mid-edit",
            "Bag panel shows active effect status and lets you use Exp. Share directly",
            "Town map no longer shows a redundant tooltip for the current location",
          ],
        },
      ],
    },
    {
      version: "0.3.0",
      subtitle: "Legendary Raids, Move Effects & Battle Balance",
      sections: [
        {
          heading: "IV Assignment",
          items: [
            "Previously all Pokemon would have full 15 IVs, now they will be randomly assigned just like in the games",
          ],
        },
        {
          heading: "Legendary Raid System",
          items: [
            "Legendary Pokemon (Articuno, Zapdos, Moltres, Mewtwo, Mew) have been removed from wild encounters",
            "New Raid Island location unlocks after defeating the Champion",
            "Click Raid Island to heal your party and fight a random legendary repeatedly until you wipe or leave",
            "Legendaries will grow stronger as you beat them, you'll need a strong team to have the best odds of catching them",
            "Normal catch logic applies during raids — use your default ball settings",
            "10-minute cooldown between raids, persists across refreshes",
          ],
        },
        {
          heading: "Move Secondary Effects",
          items: [
            "Recoil moves (Take Down, Submission) now deal damage back to the user",
            "Hyper Beam now requires a recharge turn after use",
            "Self-Destruct causes the user to faint after dealing damage",
            "Multi-turn moves (Outrage, Petal Dance) lock the user in for 2–3 turns, then cause confusion self-damage",
            "High Jump Kick now damages the user on a miss",
          ],
        },
        {
          heading: "Stat Stage Moves",
          items: [
            "Status moves now actually work! Swords Dance, Amnesia, Barrier, Harden, Sharpen, and Defense Curl boost your stats in battle",
            "Growl, Leer, and Tail Whip lower the opponent's stats",
            "Stat changes range from -6 to +6 and reset each battle",
          ],
        },
        {
          heading: "Smarter AI",
          items: [
            "Your Pokemon now considers move drawbacks when picking attacks — it won't blindly spam Hyper Beam over Flamethrower",
            "Trainer Pokemon also weigh drawbacks when choosing moves",
            "Stat stages are factored into move selection for both sides",
          ],
        },
      ],
    },
    {
      version: "0.2.0",
      subtitle: "Gym Leaders, Elite Four, Evolution Items & More",
      sections: [
        {
          heading: "Gym Leaders, Elite Four & Champion",
          items: [
            "All 8 Kanto gym leaders are now in the game! Defeat them in order to earn badges and progress",
            "Each gym leader has their classic team from the original games",
            "After earning all 8 badges, take on the Elite Four gauntlet — Lorelei, Bruno, Agatha, and Lance back-to-back",
            "Defeat all four to face Champion Blue and his full team of 6",
          ],
        },
        {
          heading: "Victory Tokens & Reward Shop",
          items: [
            "Earn Victory Tokens by defeating gym leaders for the first time (1 token per gym) and completing the Elite Four gauntlet (1 token per champion defeat)",
            "Spend tokens in the new Reward Shop (accessible from the Gyms tab) on evolution items:",
            "Fire Stone, Water Stone, Thunder Stone, Leaf Stone — 1 token each",
            "Moon Stone, Link Cable — 2 tokens each",
          ],
        },
        {
          heading: "Evolution Items & Item-Based Evolution",
          items: [
            "Pokemon that evolve by stone or trade can now be evolved using these items from the stats panel",
            "Pokemon with multiple evolution options (e.g. Eevee) show all options side by side",
          ],
        },
        {
          heading: "Route & Location Progression Overhaul",
          items: [
            "Unlock criteria reworked: routes now unlock based on battles fought at specific locations and badges earned, instead of a flat total battle count",
          ],
        },
        {
          heading: "Auto-Proceed",
          items: [
            "New toggle button (▶▶) next to the settings gear in the battle scene",
            "When enabled, automatically travels to newly unlocked locations so you can idle hands-free",
          ],
        },
        {
          heading: "Quality of Life",
          items: [
            "Evolution button is now always visible and shows requirements, faded when not met",
            "Evolution items now work from the box, not just the party",
            "Fixed stretched sprites in the box, party info screen, and catch settings menu",
            "Trainer name display no longer blocks buttons during trainer battles",
            "Trainer/boss sprites are larger during battle intros",
            "Battle win tracking split into wild battles vs trainer battles, tracked per location",
          ],
        },
      ],
    },
  ];
