import type { ChangelogEntry } from "../types";

export const CURRENT_VERSION = "0.4.0";
export const LAST_SEEN_VERSION_KEY = "pokemon-idle-last-seen-version";

export const changelog: ChangelogEntry[] = [
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
