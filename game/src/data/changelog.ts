import type { ChangelogEntry } from "../types";

// The version the client is currently running. Bump this (and add a
// matching entry at the TOP of `changelog`) whenever you ship something
// players should know about. The What's New modal keys off it.
//
// Keep this in sync with package.json's version field.
export const CURRENT_VERSION = "1.0.0";
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
      version: "1.0.0",
      subtitle: "Hoenn",
      date: "2026-08-09",
      sections: [
        {
          heading: "🌋 Hoenn is open",
          items: [
            "A THIRD REGION. 62 places, from Littleroot Town to the top of Ever Grande City — every route, both deserts, the ash fields, Meteor Falls, the sea floor, and a tower that goes above the clouds",
            "It unlocks when you beat Johto's Champion. Littleroot is the door",
            "Eight gyms — Roxanne, Brawly, Wattson, Flannery, Norman, Winona, Tate & Liza, Wallace — then an Elite Four and Champion Steven at Lv 115, the new ceiling",
            "YOUR OLD TEAM CANNOT WALK IN. Hoenn is a journey region: on the way through, its Pokémon are the ones you catch there, and Route 101 really is Lv 2. Beat the Champion and it becomes a farm like everywhere else, at Lv 78 to 110",
            "Every location has its own artwork. All 62, plus a portrait for all thirteen gym leaders, Elite Four and the Champion",
          ],
        },
        {
          heading: "🌿 All 135 Hoenn Pokémon",
          items: [
            "Treecko, Torchic and Mudkip, and everything after them — the full national dex from 252 to 386",
            "Their real stats, types, abilities, evolutions and learnsets. Nothing is approximated",
            "The ten Hoenn legendaries that were already here for raids are unchanged — the new data agreed with them exactly, which is how we know the rest is right",
          ],
        },
        {
          heading: "⚔️ Every move in the game animates",
          items: [
            "484 moves now play a real animation, up from 233",
            "EARTHQUAKE USED TO DO NOTHING. So did Magnitude, Bulldoze and Fissure — they were the only moves in the game that played to a completely blank screen. The arena shakes now",
            "Surf, Eruption, Heat Wave, Muddy Water, Moonlight, Morning Sun, Meteor Mash, Sheer Cold, Solar Beam and Dragon Ascent all gained their real animations too",
            "Every move card now tells you what the move actually does, in one line",
          ],
        },
        {
          heading: "🐛 Evolving fixes your ability",
          items: [
            "EVOLVING GAVE YOU THE WRONG ABILITY. A Dragonite kept Dratini's Shed Skin instead of gaining Inner Focus — an ability belongs to a species, and what carries across an evolution is the slot, not the ability itself. Thank you Gshow for reporting it",
            "It affected 34 evolution lines. The one that cost you something real was GYARADOS, which should have Intimidate and had Magikarp's Swift Swim — a move that does nothing in this game. Every Gyarados in every save has been fighting without an ability",
            "Already-evolved Pokémon are repaired on load. A hidden ability stays hidden",
            "Fire Blast burned 30% of the time instead of 10%, and High Jump Kick was still on its old power of 100 — both left over from older generations. The whole move table is now pinned to the latest generation and tested against it",
          ],
        },
        {
          heading: "🎁 New rewards",
          items: [
            "POST ABOUT US ON REDDIT for a Master Ball and $500,000. Paste the link on the Rewards page — one per account",
            "YOUR DISCORD RANK PAYS OUT IN GAME. Ranks 5, 10, 15, 20, 25, 30 and then every 10 forever, in Poké Balls, with a Master Ball every 25 ranks. Ranks you earned before linking still count",
            "MILESTONE LEVELS PAY, and never stop — the ladder keeps scaling past level 1,000, with a Master Ball every 250. Everything you already passed is back-paid in one go",
            "INVITE A FRIEND: a Master Ball per signup up to 10, then $1,000,000 and a random shiny",
          ],
        },
        {
          heading: "✨ Move cards, redesigned by Pani",
          items: [
            "THIS DESIGN IS PANI'S — thank you. A move used to be a solid block of colour with white text on it, four at a time. Now the type is an edge and a readable chip, and the numbers are the brightest thing on the card",
            "White on some type colours measured 1.7:1 contrast. Electric was effectively unreadable. Every type chip now clears the accessibility bar",
            "PP warns amber when it is getting low and red when it is gone, and spent moves fade on Auto as well as Manual",
          ],
        },
        {
          heading: "⚙️ Smaller things",
          items: [
            "Selling is a button at the top of the auction page again, instead of at the bottom of a panel you had to select someone else's lot to see",
            "The auction side panel has room to breathe, and a fresh lot says \"no bids yet\" rather than stopping in mid-air",
            "Rewards always opens on Free rewards, with Discord at the top",
            "Every Pokémon records which Ball caught it",
            "PvP: the board waits for the sentence that explains it, fainting plays a faint animation, and attack animations run to the end",
          ],
        },
      ],
    },
    {
      version: "0.9.8",
      subtitle: "Rewards for levelling and for the Discord, and move cards you can actually read",
      date: "2026-08-07",
      sections: [
        {
          heading: "⚔️ Move cards, redesigned — thank you Pani",
          items: [
            "THIS DESIGN IS PANI'S. She mocked up a better move card and it was better in every way, so it is what shipped — thank you",
            "A move used to be a solid block of its type colour with white text on top, four at a time. That put the loudest thing on the card on its least useful information, so a moveset was four competing colour fields you had to read word by word",
            "Now the type is an edge and a chip you can read, and the numbers are the brightest thing on a card whose whole job is comparing numbers. Power, accuracy, category and PP are all on the card instead of split between the card and a tooltip",
            "White text on some type colours was as low as 1.7:1 contrast — Electric was effectively unreadable. The new type chip uses dark ink and clears the accessibility bar on all eighteen types",
            "PP warns twice now: amber when it is getting low, red when it is gone. Those are different decisions and they used to look the same",
            "PvP move tiles were supposed to be identical to the idle ones and had quietly drifted — they were missing the category icon. Both screens now draw from one component, so they cannot drift again",
          ],
        },
        {
          heading: "🪜 Levels pay out, forever",
          items: [
            "Milestone levels now pay money and Poké Balls, and the ladder never ends — it keeps scaling past level 1,000 rather than stopping at a number somebody guessed",
            "A Master Ball at every 250th level",
            "EVERYTHING YOU ALREADY PASSED IS PAID. If you were level 1,200 when this shipped, every tier below you is back-paid in one go rather than starting you from today",
            "The Rewards page draws it as a track you can see up: what you have collected, what is on its way, and what is coming, with the Master Ball milestones marked from a long way below them",
            "Releasing Pokémon lowers your account level, and the ladder is built for that — a tier you have been paid for is never paid again",
          ],
        },
        {
          heading: "💬 Discord rank pays out in-game",
          items: [
            "Your rank in the Discord now earns Poké Balls in the game. Ranks 5, 10, 15, 20, 25, 30, then every 10 after that, forever",
            "Ten balls a tier, upgrading from Poké to Great to Ultra as you climb, plus a Master Ball every 25 ranks",
            "ITEMS ONLY, NEVER MONEY, and that is deliberate. Chat XP paying cash would put a faucet on the game's economy whose tap is typing in a text box. A ball is used up when you throw it; money is not",
            "Ranks you earned BEFORE linking still count — link your account and they are paid",
            "Rewards can only be claimed once per pair of accounts. Unlinking and relinking does not pay again, in either direction",
          ],
        },
        {
          heading: "🎁 Invite a friend",
          items: [
            "Share your link and every friend who signs up through it pays you a Master Ball, up to 10",
            "Reach all 10 and you get $1,000,000 and a random shiny on top",
            "Your link and your running total live on the Rewards page",
          ],
        },
        {
          heading: "⚔️ PvP",
          items: [
            "THE BOARD NO LONGER RUNS AHEAD OF THE TEXT. HP bars, switches and the turn indicator used to update while the sentence explaining them was still being typed out, so you read about a knockout that had already happened",
            "Attack animations were being cut off partway — Shadow Ball in particular. They now play for their own length instead of for however long the sentence took to read",
            "A fainting Pokémon actually plays a faint animation, and it no longer stays standing after the text says it fainted",
            "The result dialog and the choose-your-next-Pokémon screen were both rebuilt",
          ],
        },
        {
          heading: "📱 On a phone",
          items: [
            "The hub's page picker is a proper menu now instead of a strip you had to scroll sideways. Trainer Card was unreachable on mobile entirely — it is in the list",
            "Attack effects were drawing BEHIND the enemy Pokémon instead of on top of it",
          ],
        },
        {
          heading: "⚙️ Smaller things",
          items: [
            "Every Pokémon now records which kind of Ball caught it, shown on its detail sheet. Older catches show as a Poké Ball, since that is not something we can go back and know",
            "Typing /link in chat explains where /link actually belongs",
            "The Connect Discord buttons all point at the real server invite",
          ],
        },
      ],
    },
    {
      version: "0.9.7",
      subtitle: "Johto is a journey again, a real auction house, and a pile of reported bugs",
      date: "2026-08-03",
      sections: [
        {
          heading: "🗺️ Johto is a region again, not a level-40 farm",
          items: [
            "Johto's wild levels are back to the real Gold/Silver curve WHILE you are working through it. Route 29 is Lv 2–4 again, Union Cave is 8–11, Mt. Silver is 37–42 — so arriving from Kanto is a new region rather than a wall you grind past",
            "The moment you beat Johto's champion it reverts to exactly the levels it has today. Nothing about an established player's farm moves: if you have already finished Johto, you will not notice this change at all",
            "CLEARING A REGION PAYS FOREVER. Every region you have beaten gives +10% EXP and +10% prize money from every battle, and +5% catch rate, for the rest of the game. Cumulative and additive — two regions is +20% EXP, not double — so it rewards finishing a region rather than rushing one",
            "Where a Pokémon was caught is now recorded. Nothing restricts you yet; it is the groundwork for future regions being real journeys instead of somewhere your level 100 team walks in and flattens",
          ],
        },
        {
          heading: "💰 The auction house, rebuilt",
          items: [
            "A wall of cards you can actually compare. The Pokémon is the biggest thing on a card and the price is the second — the old page put a full bidding form on every listing, which made every lot look identical from a distance",
            "Bidding moved to the side panel, so a card is for browsing and the panel is for committing. Closing lots get a warm edge and a countdown that moves while you watch",
            "LISTING A POKÉMON is one flow now: pick it from your party or PC, set a price, done. Sell lives in the panel next to the lot you are looking at",
            "TMs CAN BE AUCTIONED. Machines are reusable and route drops are fixed, so the auction house is how you get one you have not found — held in escrow like a Pokémon, returned if you cancel",
            "The page would not scroll. With 23 lots that meant most of them were unreachable, which is worth its own line",
          ],
        },
        {
          heading: "💿 The TM Mart",
          items: [
            "TMs have their own counter, and the stock ROTATES. Six machines a day out of a pool that deals through itself over four weeks, so every TM comes round and no TM is simply purchasable on demand",
            "Today's six are priced and buyable; the rest are listed as not-today with the day they return, so you can plan",
            "Raid drops are named on the Raids page. All six HMs plus the heaviest TMs — Hyper Beam, Giga Impact, Solar Beam, Overheat, Explosion — come from raids and nowhere else, and there was no way to know that",
          ],
        },
        {
          heading: "🐛 From your reports",
          items: [
            "REORDERING YOUR MOVES REFILLED EVERY PP. Dragging a move and saving handed the whole moveset full PP, so the fix for a Pokémon that had run dry was to open Manage Moves and press Save. PP now travels with the move it belongs to",
            "GEN 2 EVOLUTIONS HAD DUPLICATE, OUT-OF-ORDER MOVES. Scizor offered Quick Attack twice, and its move list ran to Lv 21 then started again from Lv 1. Steelix and Crobat had it too — the two halves of an evolution chain were spelling the same move two different ways. Thanks pani",
            "FALSE SWIPE COULD KNOCK A POKÉMON OUT. The one move in the game designed to leave a Pokémon on 1 HP so you can catch it. It now always does",
            "CHANGING GAME SPEED RESTARTED THE BATTLE INSTEAD OF RETIMING IT. The message box retyped the line you were reading from its first character, and clicking between speeds froze the game for as long as you kept clicking. Damage numbers and 'Super effective!' banners could also get stuck on screen permanently. Switching speed now retimes what is already running",
            "ATTACK ANIMATIONS IGNORED GAME SPEED. They were not playing faster at 5×, they were being cut off part-way — you were seeing the first third of a Flamethrower. Every effect now plays at the speed you set and shows the same amount of itself at 1×, 2× and 5×",
            "SHINY ANNOUNCEMENTS ARE GONE from global chat. They worked exactly as designed, and that was the problem: enough shinies are caught across the playerbase that real conversation was scrolling past behind a wall of them",
            "If a save rollback ever costs you a Pokémon — two devices, or a tab that was offline — the game now TELLS you which ones and why, instead of leaving you to find a Pokédex entry with nothing behind it",
          ],
        },
        {
          heading: "⚙️ Smaller things",
          items: [
            "PvP: the 'choose your lead' screen is gone. Your lead is the first Pokémon in your team, set where you already set it — in Edit Team, before the match",
            "The central dialog closes with an animation now, including when you click outside it",
            "The Bag's active Repel/Honey list is bounded and scrolls. Repels are per-species AND per-route, so repelling five species across four routes made twenty entries that pushed the whole bag off the bottom of the screen",
          ],
        },
      ],
    },
    {
      version: "0.9.6",
      subtitle: "TMs — 59 machines, and a moveset that's finally a decision",
      date: "2026-08-02",
      sections: [
        {
          heading: "💿 TMs and HMs are in",
          items: [
            "53 TMs and 6 HMs, taken from the Gen 5 machine list. Each teaches a specific move, and each species can only learn the machines it learns in the real games — Magikarp gets nothing, Mew gets almost everything, and your Snorlax can hold Thunderbolt while your Charizard can't",
            "They are REUSABLE. Teaching never uses one up, so the hard part is finding the machine, not rationing it. You only ever need one of each, and the Mart won't sell you a second",
            "Every machine you own appears in Manage Moves alongside the level-up pool, tagged with the TM that taught it. There's a level-up / TM filter once you own enough to need one",
            "Each Pokémon's move screen also lists what it COULD learn from a machine you haven't found yet — so a TM is worth going after before you own it",
            "Teach straight from the Bag: pick the TM, pick the Pokémon. A free slot learns it in one click; a full moveset hands you the move manager to choose what goes",
          ],
        },
        {
          heading: "🗺️ Where they come from",
          items: [
            "MARTS sell the setup toolkit — Swords Dance, Calm Mind, Toxic, Thunder Wave, Will-O-Wisp, the weather moves — and each town stocks what it is known for. Thunder Wave in Vermilion, Toxic in Fuchsia, Will-O-Wisp under the ghost tower in Lavender. The department stores carry the staples",
            "ROUTES hide the attacking TMs. Every route drops exactly one machine and nothing else drops it — 36 across Kanto and Johto, weaker moves early, Ice Beam and Earthquake deep in. Clear wild battles there and it will turn up",
            "RAIDS pay out what nothing sells: all six HMs plus the heaviest TMs — Hyper Beam, Giga Impact, Solar Beam, Overheat, Explosion",
          ],
        },
        {
          heading: "⚙️ Under the hood",
          items: [
            "Attacking moves can change stats now. The engine handled stat changes only on status moves — one attached to an attack was read and thrown away — so Psychic never dropped Sp. Def, Shadow Ball never dropped it either, and Overheat never crashed its user's Sp. Atk. All of them do now, and it is why Charge Beam, Bulldoze and Flash Cannon could ship at all",
            "Movesets are checked when you save them. Rearranging what a Pokémon already knows is untouched, but a move now has to come from somewhere: its level-up list, or a machine you actually hold",
            "42 of the 101 Gen 5 machines were deliberately left out. Protect, Substitute, Light Screen, Reflect, Rest, U-turn and the rest need battle mechanics this game does not have, and a TM that does nothing is worse than one that is not there",
          ],
        },
      ],
    },
    {
      version: "0.9.5",
      subtitle: "PvP is a real battle now, and a pile of things that quietly did nothing",
      date: "2026-07-30",
      sections: [
        {
          heading: "⚔️ PvP is a proper battle screen",
          items: [
            "PvP takes over the game window: your battle in the centre, your team and the opponent's on the right, the message box along the bottom — \"Darkrai used Shadow Ball!\", \"It's super effective!\" — and the same attack animations the rest of the game uses",
            "Everything the engine was already doing is finally visible. Paralysis, sleep, flinch and freeze now SAY so — before, your turn just did nothing and no line explained why. Same for type effectiveness, stat boosts, weather, hazards, Substitute, held items and abilities. The battles were always this detailed; you just couldn't see any of it",
            "BOT BATTLES. Nobody else queued? Practise against an AI instead. Never rated, always labelled, and level-matched to your team",
            "TEAM PREVIEW: see the opponent's Pokémon and pick your lead before turn one, the way a real battle simulator does",
            "Win, lose or draw now ends in a proper result screen with your rating change — and a Battle Again button, instead of dumping you back out",
            "Everything is manual. No auto-battling in PvP, and it runs at normal speed no matter what you've set the idle game to",
          ],
        },
        {
          heading: "⚖️ Ranked was unplayable for almost everyone, and nobody knew",
          items: [
            "The Lv 50 queue only ever levelled Pokémon DOWN. If your team was under 50 — and 87% of accounts are — you kept your real levels and fought opponents scaled to 50. Roughly 94% of players were entering ranked at a disadvantage they couldn't see. Everyone is now set to exactly the format level, both directions",
            "Competitive rules apply: no Sleep-spamming a whole team, no Fissure or Sheer Cold, no Double Team, and endless stalling can't run forever",
            "A disconnect is no longer an instant loss. You get 45 seconds to reconnect, your opponent is told what's happening instead of watching a frozen timer, and a battle killed by a server restart is voided rather than counted",
          ],
        },
        {
          heading: "🐛 Things that were silently doing nothing",
          items: [
            "Clicking a Pokémon sometimes did nothing at all. Holding the click a fraction too long — or moving the mouse 5 pixels — made the game treat it as a drag and swallow the click entirely. On a trackpad this happened constantly. Fixed",
            "Evolving a shiny registered the evolution as a NORMAL Pokémon in your dex. Shiny Growlithe → Arcanine, and the dex recorded a plain Arcanine. Fixed, and the 160 entries this destroyed across 68 accounts are being restored",
            "The auto-catch screen lied. It showed a green ✓ CATCH on species your settings were actually skipping — 444 accounts had every Route 1 Pokémon badged CATCH while nothing was ever thrown. The badge now tells the truth",
            "Effectiveness and +XP popups stopped appearing after about eight battles and never came back until you refreshed",
            "Your MASTER BALL could be spent automatically. If your selected balls ran out and a shiny appeared, the game reached for the next ball it could find — and that list ended with the Master Ball. It is now never thrown unless you choose it yourself",
          ],
        },
        {
          heading: "📦 PC, Pokédex and quality of life",
          items: [
            "BULK RELEASE: select several Pokémon in the PC and release them together, with one confirmation that names the count. Two of you asked for this while trying to clear hundreds of Magikarp",
            "Nicknames now show everywhere — party, PC, battle text, level-ups — instead of only in the rename box",
            "EV gains are finally shown when you earn them. They were always being awarded; nothing ever told you",
            "\"Not caught yet\" split into \"Not registered\" and \"Not owned\", so releasing or trading a species can bring it back into scope",
            "The Pokédex was rebuilt. Where to Find comes FIRST now, sorted best-route-first, with your current location pinned — and shiny odds are stated plainly at last: 1/8,192, or 1/4,096 with the Shiny Charm, the same on every route",
            "Trainer intro animations respect game speed. At 5× they were still playing at full length and stalling the battle",
            "Away progress: close the tab and come back to catch-up rewards for the time you were gone",
            "Auto-heal settings, and the Heal button moved to the Party card where it belongs",
          ],
        },
        {
          heading: "💰 Auctions, giveaways and speed",
          items: [
            "MAXIMUM BIDS. Set the most you're willing to pay and the game bids for you, only as high as it needs to. The lot goes to whoever valued it most — not whoever happened to be refreshing at the right second",
            "Minimum raises now scale with the price and with how contested a lot is. Before this, 87% of every bid ever placed was a raise of $10 or less, and most auctions were decided by a $5 click",
            "Minimum starting bid is $500. Pokémon were being listed for $1 by accident",
            "A GIVEAWAY BUTTON in the sidebar, plus a history of past giveaways and their winners. Only 67 players had ever entered one — because unless you were online the moment it was announced, there was no way to find it",
            "5× speed was restricted for a few hours on 30 July and then given back to everyone — 36% of accounts were playing on it, which turned out to be the argument for keeping it. It is still there. If your game reset itself to 2× that day, that was this, and clicking 5× again sticks",
          ],
        },
      ],
    },
    {
      version: "0.9.4",
      subtitle: "PvP actually works, a PC you can see, and your name is yours",
      date: "2026-07-29",
      sections: [
        {
          heading: "⚔️ PvP works now. It did not before — at all",
          items: [
            "Every PvP battle ended instantly as a tie: the screen opened, closed itself, and nothing counted. The cause was one missing character — the code watching for the battle to end checked for lines starting with \"|tie\", which also matched the \"|tier|\" line the engine prints at the START of every battle. So every match was declared over before turn one, since the day PvP shipped. If you ever tried PvP and thought it was broken: it was, and thank you to the player whose report finally caught it",
            "When a matchup genuinely can't start, you now get told why instead of watching a window appear and vanish",
          ],
        },
        {
          heading: "💻 PC storage, redesigned",
          items: [
            "No more pages. Your whole box is one scrolling grid — 90 Pokémon was three pages before; a full box would have been three hundred",
            "Every tile shows the Pokémon's name next to its level, because at box-sprite size half of you couldn't tell a Nidorino from a Nidoking (fair)",
            "A density toggle in the toolbar: comfortable big tiles, or compact ones that fit far more on screen",
            "The three stacked header rows are one toolbar. On smaller screens the old header alone was taller than the space left for actual Pokémon — at 1366×768 the grid was 32 pixels tall and didn't scroll. That's fixed properly",
          ],
        },
        {
          heading: "⚔️ Battles",
          items: [
            "Running every move to 0 PP no longer breaks your Pokémon. It used to silently switch itself to auto-battle, keep using empty moves at full power, and refuse to go back to manual until healed. Now it uses Struggle, like the real games — it hurts the user for a quarter of their max HP, and it can hit anything, so a Ghost can't trap you in a battle that never ends",
            "You can't throw balls at a fainted Pokémon any more. Every ball thrown at 0 HP was a guaranteed miss that still ate the ball — including, we're sorry to say, Master Balls, which would actually have \"caught\" it and consumed your rarest item for nothing",
            "Repel and Honey on the same Pokémon cancelled each other exactly, while both timers kept burning. You were paying twice for nothing. The second one is now refused with an explanation, and the item isn't consumed",
            "Hyper Beam, Solar Beam and Dragon Beam actually aim at the opponent now instead of firing dead straight — enemy Dragon Beams were leaving the screen entirely. The message bar also stopped flashing black on every update, and the Throw-a-Ball box no longer blinks in and out between encounters",
          ],
        },
        {
          heading: "🪪 Your name is yours",
          items: [
            "You can change your display name and your username, from your profile. If you signed up with Google, your real name became your public display name without asking you — that was wrong, and several of you said so. Renames are validated, unique, and rate-limited so nobody can impersonate anyone by name-swapping",
          ],
        },
        {
          heading: "📖 Small but important",
          items: [
            "Pokémon you get from trades, auction wins and gifts now register in your Pokédex (and shiny ones in your shiny dex). They never did — you could own a species your dex denied, and since finishing the dex now awards the Shiny Charm, completing it by trading was silently impossible",
            "Admins in chat wear a red ★ ADMIN badge in the side-rail chat too, so you can tell it's actually us",
            "The CHAT title bar and the chat window are one card now instead of two stacked ones — the seam between them was a styling rule fighting another styling rule, and the chat won",
          ],
        },
      ],
    },
    {
      version: "0.9.3",
      subtitle: "Evolutions that happen on their own, a Pokédex you can finish, and a long list of small fixes",
      date: "2026-07-28",
      sections: [
        {
          heading: "✨ Pokémon evolve on their own now",
          items: [
            "Level-up evolutions were never actually wired in. The code for them existed but nothing ever ran it, so a Charmander could sit at Lv45 forever — one of you filed that as a bug and you were right. They now happen by themselves the moment the level is reached",
            "If you want one left alone, every Pokémon has its own lock — right-click it in your party, or open its detail screen. That's the Everstone, basically. There's also a global Auto-Evolve toggle in the battle controls if you'd rather approve every one by hand",
            "Right-click → Evolve now works for level evolutions too, not just stones. Before this, a Pokémon could sit there glowing \"ready to evolve\" and its menu had no Evolve option anywhere in it",
            "Stones and Link Cables stay manual, because those spend an item and we're not spending it for you",
          ],
        },
        {
          heading: "📖 The Pokédex can be finished — and the Shiny Charm is a real item",
          items: [
            "Completing the Pokédex was supposed to award the Shiny Charm. It awarded nothing: the charm existed as a catalog entry that no code path ever put in anyone's bag, and the doubled shiny rate was applied invisibly behind a hidden check. Finishing the dex now hands you the actual item, with a message saying so. If you were already over the old threshold, you keep the doubled rate",
            "Tyrogue only ever became Hitmontop. Its Attack-vs-Defense split didn't exist in the data at all, so Hitmonlee and Hitmonchan were unreachable from that line. All three branches work now, and a Tyrogue's detail screen shows which one it is currently headed for",
            "That left Hitmontop gated behind an Attack = Defense tie that gets rarer the more a Pokémon levels (roughly 11.5% at Lv20, down to 2.6% at Lv100) — one species standing between everybody and dex completion, on a coin flip you couldn't see. It's now also a rare spawn in the Johto Nursery raid pool. Evolving Tyrogue at Lv20 is still the normal way to get one",
            "The dex also stops conflating two different things. A species you caught and later released, traded away or evolved stays registered — it just no longer claims to be sitting in one of your boxes. In your collection / registered but none owned / seen only / undiscovered are four distinct states now, with a legend under the filters saying which is which",
          ],
        },
        {
          heading: "🏝️ Raids",
          items: [
            "Catching the legendary used to END the raid. The single thing a raid is for was the one action that stopped it, and the only ways out burned your cooldown. A catch now clears the wave exactly like knocking it out does, and the next legendary comes straight in",
            "A raid in progress shows a banner with the wave you're on and how long you've been in there. Before, BEGIN RAID simply greyed out and nothing on the card explained why",
          ],
        },
        {
          heading: "💻 PC boxes",
          items: [
            "Dragging a Pokémon around your boxes does something now. The drag worked, the slot lit up when you hovered it, and the drop was thrown away in silence",
            "Box tiles show each Pokémon's level, and there are Shiny and IV-quality filters that stack with the search box and the sort order",
          ],
        },
        {
          heading: "🖥️ Battle view",
          items: [
            "Battle Pokémon are bigger — up to about a third bigger for the typical species. Sizes stay honest relative to each other, so a Ditto is still small next to an Onix; the arena just isn't mostly empty space any more",
            "The in-battle info cards were too narrow and cut off most names. They're wider now, and sized against the battle scene so they scale with whichever layout you're on. The extra room carries the Pokémon's type (or types), plus a Poké Ball on the opponent's card when that species is already registered in your Pokédex",
            "In Wide layout, the whole screen no longer resizes itself when you switch tabs in the right-hand column. Going from Mart to Map was shrinking the entire shell and pulling it off the edges of the display",
          ],
        },
        {
          heading: "🐛 Fixed",
          items: [
            "Super Repel and Max Repel work. We told you in 0.6.0 that they were fixed — that was wrong, and they still did nothing. The one screen that can start a repel was hardcoded to the basic Repel, so the other two were purchasable in a dozen marts with no way to use them at all. All three tiers now share one timer per Pokémon per route, and using one while you're already at the cap tells you instead of quietly eating the item",
            "Sprites no longer vanish for the rest of your session. A single failed image load used to hide that Pokémon everywhere until you reloaded the page (reported as \"Gengar's sprite eventually disappears\") — images now retry, and fall back to a visible placeholder rather than hiding themselves",
            "The Report a bug form no longer wipes everything you typed when you close it. Your draft is kept as you go and restored when you reopen the form, and closing with something still in the box asks whether to keep it or throw it away",
            "Selected text was nearly invisible — the highlight was a 6% white wash on a near-black background, so dragging over a box looked like nothing had been selected. Highlighting now actually shows, everywhere in the game",
          ],
        },
      ],
    },
    {
      version: "0.9.2",
      subtitle: "A wide screen layout, an honest Pokédex, and EXP for catching",
      date: "2026-07-24",
      sections: [
        {
          heading: "🖥️ New: Wide layout",
          items: [
            "Playing on a big monitor? Settings → Display now lets you switch between Classic and a new Wide layout that fills the screen instead of leaving big empty margins",
            "The battle view more than doubles in size (and keeps its exact proportions — nothing gets stretched or cropped)",
            "Classic is still the default, so nothing changes unless you pick Wide. Your choice is remembered on that device, and small screens keep the layout they already had",
          ],
        },
        {
          heading: "📖 The Pokédex can actually be completed",
          items: [
            "The dex counted 288 species, but 35 of those have no way to be caught yet — so players who had genuinely caught everything available were stuck showing 234/288 and could never reach 100%",
            "It now counts only the 253 species you can actually obtain, so completion (and the Master milestone) is reachable. Type totals are honest too",
            "The 35 unreleased entries keep their dex numbers but are dimmed and marked \"Not yet available\", so you can tell \"not released\" from \"haven't found it yet\"",
          ],
        },
        {
          heading: "⭐ Catching gives EXP",
          items: [
            "Knocking a wild Pokémon out gave your team EXP but CATCHING it gave nothing — so filling the Pokédex was actively costing you progress. A successful catch now awards the same EXP (and EV yield) that defeating it would have",
          ],
        },
        {
          heading: "🐛 Fixed",
          items: [
            "Fixed a freeze where the game could get stuck on a faint message and stop doing anything, if your active Pokémon fainted while you still had healthy ones on the bench",
            "Rebuilt the route list on the Map tab — cards now line up properly instead of stretching town rows across empty space, squeezing route names, and cramming unlock requirements side by side",
          ],
        },
      ],
    },
    {
      version: "0.9.1",
      subtitle: "Manual catching, the other starters, and a fairer defeat penalty",
      date: "2026-07-24",
      sections: [
        {
          heading: "🎯 Throw a ball yourself",
          items: [
            "You asked for it: during a wild encounter the right-hand panel now has a Throw a ball row — pick any ball you own and throw it by hand, instead of relying entirely on auto-catch rules",
            "Handy for a rare spawn your catch settings would have skipped. Weakening it first still improves your odds",
          ],
        },
        {
          heading: "🌱 The other Johto starters",
          items: [
            "Chikorita, Cyndaquil and Totodile can now be found — very rarely — in the National Park, so you can complete the lines you didn't pick",
            "(This mirrors how the Kanto trio has always been catchable in the Safari Zone.)",
          ],
        },
        {
          heading: "💰 Your money stops vanishing",
          items: [
            "Losing a battle used to cost a quarter of your entire bank — and because the game fights on its own while you're away, that quietly outpaced everything you earned. Several of you reported your balance going DOWN while winning",
            "The defeat penalty is now capped at 5% of your money, up to $5,000 max. Losses sting a little; they can't wipe a fortune any more",
            "(A separate double-charge on the same loss is fixed too — you were being billed twice.)",
          ],
        },
        {
          heading: "🪨 Evolution items you can actually buy",
          items: [
            "Moon Stone and Sun Stone are now stocked at the Celadon and Goldenrod Dept. Stores instead of being Elite-Four-reward-only — Nidoqueen, Nidoking, Clefable, Wigglytuff, Espeon, Umbreon, Bellossom and Sunflora are all reachable now",
            "Trade-evolution catalysts are on the shelves too: Metal Coat, King's Rock, Dragon Scale and Up-Grade. Combine one with a Link Cable to get Steelix, Scizor, Kingdra, Slowking, Politoed and Porygon2",
          ],
        },
        {
          heading: "🐛 Fixed",
          items: [
            "The Safari Zone needed one more badge than the town it sits in, stranding players who'd reached Fuchsia — it now opens with Fuchsia itself (this also unblocked the route to Victory Road)",
            "Route cards with lots of encounter species (hello, Safari Zone) no longer stretch so far that the travel button gets pushed out of reach",
            "Using an evolution item on a Pokémon whose evolution isn't in the game yet no longer errors out — and no longer eats the item",
          ],
        },
      ],
    },
    {
      version: "0.9.0",
      subtitle: "Johto is open — plus auctions, evolutions, and Hyper Training",
      date: "2026-07-24",
      highlight: true,
      sections: [
        {
          heading: "🗺️ The Johto region",
          items: [
            "A whole second region to explore, from New Bark Town to Mt. Silver — pick a Johto starter (Chikorita, Cyndaquil or Totodile) when you arrive",
            "Eight new gyms, a new Elite Four, and Champion Lance, all with the Johto Pokédex filling in behind them",
            "Johto is tuned as a genuine post-Kanto challenge now: gym aces climb from ~50 up to Clair's Lv75 Kingdra, the Elite Four sit in the high 70s–low 80s, and Lance tops out around 85 — no more steamrolling it with a Kanto team",
          ],
        },
        {
          heading: "💎 Auction house",
          items: [
            "The Trade tab is now a real auction house — list a Pokémon, set a starting bid, and let the server run the clock",
            "Listed Pokémon are held safely in escrow while the auction runs (so nothing can be duped or lost), and you can cancel to get it straight back if there are no bids",
            "Winners receive the exact Pokémon that was listed, delivered automatically when the auction settles",
          ],
        },
        {
          heading: "✨ Evolutions",
          items: [
            "Evolution stones work properly — Sun and Moon Stones included (Vaporeon/Jolteon/Flareon, plus Espeon and Umbreon via Sun/Moon Stone)",
            "Trade evolutions now happen with a Link Cable from your Bag — evolve Haunter→Gengar, Kadabra→Alakazam, Machoke→Machamp, Graveler→Golem, and item trades like Onix→Steelix",
            "Added missing evolutions: Golbat→Crobat, Chansey→Blissey, and Gloom→Bellossom",
          ],
        },
        {
          heading: "🍾 Bottle Caps & Hyper Training",
          items: [
            "Perfect your favourite Pokémon's IVs: a Gold Bottle Cap maxes every stat, a Silver Bottle Cap maxes one stat of your choice",
            "Use them from a Pokémon's detail screen (Hyper Training) — works on party and PC Pokémon alike",
            "Bottle Caps are a rare drop from raid catches, so a flawless team stays a real trophy",
          ],
        },
        {
          heading: "🎯 Catching",
          items: [
            "New \"weaken first\" catch setting — hold off on throwing a ball until the wild Pokémon is worn down, for a much better catch rate",
            "Catch odds now scale with the target's remaining HP, so chipping it down actually pays off",
          ],
        },
        {
          heading: "🐛 Reliability",
          items: [
            "Fixed the bug where some players' cash could be reset — saves now merge safely instead of ever rolling your progress backward, and the affected accounts were refunded",
            "Hardened cloud save syncing across logout/login and multiple devices so your account can't be duplicated or clobbered",
          ],
        },
      ],
    },
    {
      version: "0.8.1",
      subtitle: "Trade offers in chat, emoji, and a real Exp Share fix",
      date: "2026-07-18",
      highlight: true,
      sections: [
        {
          heading: "🔄 Trade offers",
          items: [
            "The chat panel's second tab is now Trade instead of Local — post \"offering X for Y\" as a card, and anyone can click Open Trade to send you a trade invite on the spot",
            "Town-specific local chat saw very little use, so it's gone in favor of this — nothing else about chat changed",
          ],
        },
        {
          heading: "😀 Emoji",
          items: ["A picker button next to the chat input — no more needing your OS's emoji shortcut"],
        },
        {
          heading: "🐛 Fixed",
          items: [
            "Exp. Share bought from the Elite Four Reward Shop now actually activates — it was silently doing nothing before",
            "Server announcements and giveaway results now show as a distinct card in chat instead of looking like a personal message",
          ],
        },
      ],
    },
    {
      version: "0.8.0",
      subtitle: "Daily rewards, and a proper welcome",
      date: "2026-07-17",
      highlight: true,
      sections: [
        {
          heading: "🔥 Daily rewards",
          items: [
            "Log in each day for a reward — money and Poké Balls on a 7-day cycle, building to an Ultra Ball haul on day seven",
            "Claim on consecutive days to build a streak; the longer you keep it going, the more the rewards grow. Find it in Settings, or it pops up when there's one waiting",
          ],
        },
        {
          heading: "New here?",
          items: [
            "New trainers now get a quick 'How to play' guide on their first visit — the whole game in about thirty seconds. You can reopen it any time from Settings",
          ],
        },
      ],
    },
    {
      version: "0.7.0",
      subtitle: "Your progress now actually saves",
      date: "2026-07-17",
      highlight: true,
      sections: [
        {
          heading: "💾 Saving",
          items: [
            "Your game was not saving while you were battling. Since battling is basically the whole game, that meant a lot of you were losing entire sessions. Worse, the Elite Four never pauses long enough for the old code to save even once, so clearing it could vanish completely. This was our bug, it was as bad as it sounds, and it is fixed",
            "Saving now happens constantly and automatically, whatever you are doing. It is not something you should ever have to think about",
            "We also save the moment you close the tab or switch away on your phone, so the last few seconds are not lost",
            "The 'Unsaved' label is gone, and so is the save indicator entirely. When saving works, you should not need to watch it",
            "If your progress genuinely cannot be saved, the game now says so plainly, tells you what to do, and reports it to us automatically. Before, every problem just said 'Offline' — even when your internet was perfectly fine",
          ],
        },
        {
          heading: "Fixes",
          items: [
            "If two people used the same browser, the second could have their save overwritten by the first person's game. Saves now know who they belong to and will never load into the wrong account",
            "Pokemon at level 100 kept stacking EXP forever behind the scenes. Left long enough it would have permanently broken cloud saving for our longest-playing trainers — one of you was hours away from it. EXP now stops at the level 100 mark, where it stops meaning anything anyway",
            "Playing on two devices at once could silently throw away one side's progress. The server now settles it properly instead of letting both think they won",
          ],
        },
      ],
    },
    {
      version: "0.6.0",
      subtitle: "Giveaways, What's New, and a few things that were quietly broken",
      date: "2026-07-17",
      highlight: true,
      sections: [
        {
          heading: "🎁 Giveaways",
          items: [
            "Free prize draws are here — Master Balls, cash, and rare Pokemon, straight into your save",
            "One entry per trainer, no cost, no catch. Find them in Settings > Giveaways",
            "Winners are picked from a published random seed, so anyone can check the draw was fair — the seed is shown on every finished giveaway",
            "Results and winners stay up after the draw, and we announce them in global chat",
          ],
        },
        {
          heading: "What's new, in-game",
          items: [
            "This window! It shows up once after each update with only what changed since you were last here, and you can reopen the full history any time from Settings > What's new",
          ],
        },
        {
          heading: "Fixes",
          items: [
            "Super Repel and Max Repel did NOTHING. They were sold in five marts for $500 and $700 and had no effect whatsoever — if you bought one, you were robbed, and we are sorry. Both now work, and last 1,000 and 2,000 battles respectively",
            "Exp. Share said it shares 3% EXP. It actually shares 25% — it has always been eight times better than we told you. The description now says so",
            "Auto-catch went silently dead when you ran out of Poke Balls and never told you. It now warns you the moment it happens",
            "Buying 99 Poke Balls took 98 clicks. There are now +10 and Max buttons (and shift-click for +10)",
          ],
        },
      ],
    },
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
