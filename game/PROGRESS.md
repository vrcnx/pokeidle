# Pokémon Idle — rebuild status

This is the working rebuild based on the recovered bundle in `../recovered/`. Most of the gameplay loop is now wired end-to-end and verified in-browser.

## What works today

- Boots and renders cleanly. Type-check passes (`npm run typecheck`); production build succeeds (`npm run build`).
- **Starter selection** — pick from Bulbasaur / Charmander / Squirtle, with a 1/4096 shiny roll.
- **Idle wild battles** — auto-runs encounters on the current route, ticks turns at chosen speed (×1 / ×2 / ×5).
- **Wild battle rewards** — money (`10 + level * 4`) on every wild win; counted toward route progression.
- **Trainer battles** — full per-route trainer rosters extracted from the bundle. Challenge from the Location panel; battles step through trainer's full team; auto-switch + manual switch on faint; prize money on win, money loss on white-out.
- **Gym leader battles** — Challenge from the Location panel when at a gym city. Defeat awards a badge → unlocks routes that gate on `badgesRequired`. Earns a Victory Token.
- **Damage formula** — full Gen 3-style: physical/special split, STAB, type effectiveness, crits (1/16), random 0.85–1.0 spread.
- **Type chart** — verbatim from the original.
- **Stat formulas** — IV-based; `calcHpStat` / `calcStat` match the original's badge-boost-disabled formula.
- **Move effects** — recoil, recharge, self-destruct, multi-turn lock, crash-on-miss, status stat changes.
- **Catching** — manual via ball buttons, or automatic per-route per-species rules. Uses the original ball modifier formula.
- **Auto-catch settings** — full UI: per-species rules per route, plus global defaults. Modes: `always`, `shiny_only`, `level_threshold`, `pokedex_new`. Bulk enable/disable on a route.
- **Party / Box** — switch active Pokémon, swap to/from box, sort, release.
- **Faint switch modal** — when active Pokémon faints in any battle phase, prompts the player to pick from healthy party members. Simulation pauses until a choice is made.
- **Travel / unlock** — map panel; locations unlock from `battlesAtLocation`, badges, or champion-defeated triggers.
- **Shop** — buy balls, repels, honey, evolution stones using the per-location inventories with their unlock thresholds.
- **Bag** — use stones on party Pokémon (triggers proper evolution); apply repels/honey to specific species on the current route; see active effects with battles remaining.
- **Evolution** — level-based evolution auto-triggers when conditions are met (animated transition modal). Stone evolutions trigger from the Bag.
- **Pokémon Center healing** — visit any town's Location panel → click "Heal at Pokémon Center" for a brief animated heal.
- **Raid system** — once Champion is defeated, raid panel exposes 5 legendaries (Articuno/Zapdos/Moltres/Mewtwo/Mew) at fixed levels, with a 10-minute cooldown.
- **Pokémon League** — Indigo Plateau gauntlet of Lorelei → Bruno → Agatha → Lance → Champion Blue, fought back-to-back with no healing. Unlocks at 8 badges. Reducer chains them via `bossQueue`.
- **Reward Shop** — spend Victory Tokens (earned from gym wins + champion) on Exp Share, evolution stones, Link Cable.
- **Once-per-trainer** — defeated trainers are tracked in `defeatedTrainers` and grey out in the Location panel (re-fightable only after a Reset).
- **Catch-during-trainer-battle** — guarded; ball buttons hide and a "Trainer battle — can't catch." message shows.
- **Pokédex** — seen/caught/shiny tracking with sprite grid view.
- **Move replacement on level up** — modal prompts the player to choose which move to forget when a 5th is learned (instead of silent replacement).
- **Changelog modal** — auto-shows on first load of a new version, with the in-game changelog from the original (currently v0.4.0).
- **Save / load** — to localStorage under `pokemon-idle-save`. The save format is **compatible with your live save** at pkmn-idle.com — back up your localStorage there if you want to import.
- **Mobile responsive** — under 720px width: stacked battle arena, scrollable tab bar, smaller fonts.
- **Persistence** is debounced to idle/victory phases (no mid-battle saves).

## What's still simplified / deferred

| Item | Status | Notes |
|---|---|---|
| Frame-by-frame battle animations | **Skipped** | Original drove animations through `pendingEvents` / `CONSUME_EVENT`. The current implementation resolves each turn atomically and writes messages to `battleLog`. **Functionally equivalent**, visually less rich. Restoring is a contained change in `EXECUTE_TURN` + a `useEffect` ticker. |
| Stat-stage retention | Per-battle | Stat stages reset on switch / new encounter (matches the original). |
| Held items | Not implemented | Original didn't have these per the bundle. |
| Trainer rematch / rotation | Not implemented | Original didn't seem to rotate trainer teams after badges. |

## Architecture

```
src/
  data/                # all game data, typed (Pokemon, moves, routes, encounters, trainers, ...)
  types/index.ts       # GameState shape and Action discriminated union
  utils/
    battle.ts          # damage formula, turn execution, AI move pick
    catching.ts        # catch probability, auto-ball selection
    catchSettings.ts   # resolve per-route/per-species rules
    encounters.ts      # weighted encounter roll w/ repel/honey
    items.ts           # ball / consumable / stone helpers
    moves.ts           # learnsets, evolution chains
    pokemon.ts         # createPokemon factory, shiny roll
    sprites.ts         # PokeAPI / Showdown URL builders
    stats.ts           # stat / IV / EXP math
    trainerFactory.ts  # build opposing team, lookup gym leader
    typing.ts          # type chart resolver
    unlocks.ts         # location unlock evaluator
  state/
    GameContext.tsx    # provider + load/save + useGame hook
    reducer.ts         # ~50 actions, central state machine
    initialState.ts    # default new game state
  hooks/
    useBattleLoop.ts   # the simulation tick (encounters + turns at the right cadence)
    useEvolutionTrigger.ts  # watches party for level-evolution conditions
  components/
    App + GameShell    # top-level layout + tabs
    BattlePanel        # arena, balls, controls, log
    BattleLog          # auto-scrolling log
    PartyPanel         # party with switch / box
    BoxPanel           # box with sort / release
    BagPanel           # use stones + repels/honey, see active effects
    LocationPanel      # heal, challenge trainers / gym
    MapPanel           # travel
    ShopPanel          # buy items
    PokedexPanel       # seen/caught/shiny grid
    CatchSettingsPanel # per-species rules UI
    RaidPanel          # legendary raid launcher (after champion)
    StarterSelect      # initial choice
    PokemonCard        # shared card with HP bar
    LevelUpModal       # prompt to forget a move
    EvolutionModal     # animated species transition
    HealingModal       # Pokemon Center cutscene
    FaintSwitchModal   # pick next Pokémon when active faints
    ChangelogModal     # what's-new on version bump
```

## How to run

```
npm install
npm run dev      # http://localhost:5173
npm run build
npm run typecheck
```

To wipe a stuck save: open devtools → Application → Local Storage → delete the `pokemon-idle-save` key, or click the **Reset** button in the header.

## Where to look in the recovered bundle if you want to compare

- `../recovered/assets/index.beautified.js` — full bundled app, prettified, 21,615 lines.
- Function `Sg` (~line 18140) — original turn execution. **Mine is in `src/utils/battle.ts`.**
- Function `Yh` (~line 14761) — original reducer. **Mine is `src/state/reducer.ts`.**
- Function `Gh` (~line 15572) — original Provider. **Mine is `src/state/GameContext.tsx`.**

## Verified gameplay loop

End-to-end, in-browser: starter pick → wild battle on Route 1 → catches Weedle/Pidgey/Pikachu → level-up modal fires → Bulbasaur faints → faint-switch modal works → travel to Viridian City via Map → Location panel lists Giovanni + 4 trainers with full teams → trainer battle phase activates with proper "X wants to battle!" log → switch on faint mid-trainer-battle → money / battle counts updated.

Test it yourself: `cd game && npm run dev` and open http://localhost:5173.
