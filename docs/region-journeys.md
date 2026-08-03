# Every region its own journey

A design for pani's proposal, worked out against the actual data and built so
that adding Hoenn, Sinnoh and Unova costs region content and nothing else.

## The complaint is correct

Checked, not assumed:

* Kanto's encounters start at **Lv 2**. Johto's lowest encounter *anywhere*
  is **Lv 40**. Route 29 — the first route in Johto — is Lv 40-42 Pidgey,
  Sentret, Hoothoot, Hoppip.
* Wooper evolves at **20**, Hoppip at **18**. A caught Lv 40 Wooper is twenty
  levels past its evolution, so it evolves on the spot and registers Quagsire
  for free. The Pokédex example in the report is arithmetic, not a hunch.

So: Johto is not a journey, it is a level-inflated version of a journey, and
the inflation is what breaks the dex grind.

## Two things the proposal doesn't account for

**Johto IS the endgame farm.** Kanto tops out at Lv 60; Johto runs to Lv 80.
"Revert the enemy Pokémon level increase" as stated deletes the only
high-level content in the game and collapses every established player's EXP
and money income. It cannot ship in that form.

**Nothing records where a Pokémon was caught.** `Pokemon` has `caughtAt` (a
timestamp) and no origin. Region-locking is unenforceable on the ~2,463
existing saves — there is no data to classify a box of Pidgey by.

## The unifying idea

Both halves of the proposal fall out of **one flag per player per region**:

> Has this player completed this region?

    UNCOMPLETED  →  JOURNEY MODE   natural levels, region-locked team
    COMPLETED    →  FARM MODE      today's high levels, no restrictions

That is why this is worth building rather than patching. The level change and
the usage restriction stop being two features that have to be balanced
against each other and become two readings of the same state. An established
player's Johto is untouched — they completed it, so it stays a Lv 40-80 farm.
A new player's Johto is a real region. Nobody's income moves.

Completion is already tracked: `defeatedChampions: string[]`.

## Origin, and the legacy rule

Add to `Pokemon`:

    /** Region this was caught in. Absent on every Pokemon caught before
     *  journeys existed — see the legacy rule. */
    caughtIn?: RegionId;

Stamped at creation from `regionForLocation(state.currentLocation)`. Optional,
exactly like `gender` and `caughtAt`, so no migration and no backfill.

**The legacy rule is the important decision.** `caughtIn: undefined` must NOT
mean "unrestricted", tempting as that is. If it did, every existing player
would walk their existing box into Hoenn and flatten it — which is precisely
the "future regions become irrelevant" failure the report is about.

Instead, a legacy Pokémon is treated as native to **every region that existed
when journeys shipped** (Kanto and Johto):

* Nobody loses access to anything they already have.
* Kanto and Johto behave for existing players exactly as they do today.
* Hoenn onwards is a genuine fresh start for everyone, new and old.

That single asymmetry is what makes the feature work for the players who
already finished the game.

## The rule

One predicate, and everything else reads it:

    canUseInRegion(mon, regionId, state):
      if regionCompleted(regionId, state)        return true   // farm mode
      if mon.caughtIn === regionId               return true   // native
      if mon.caughtIn === undefined
         && LEGACY_REGIONS.has(regionId)         return true   // grandfathered
      return false

The mirror the report asks for — a Pokémon caught in an uncompleted region
cannot be taken *out* of it — is the same predicate evaluated against the
destination, so it needs no second rule. A Johto-caught Pokémon fails
`canUseInRegion(mon, "kanto")` while Johto is uncompleted, which is what stops
the Exp. Share round-trip.

`LEGACY_REGIONS` is frozen at ship time and never grows. That is the whole
mechanism for keeping future regions meaningful.

## Where levels come from

Johto's encounters are authored at inflated levels only, so journey mode needs
a second band. Three options, in order of preference:

1. **Pull canon levels from PokéAPI** (`gold-silver` / `crystal` location-area
   encounters). Best fidelity, and the tooling already exists — see
   `game/scripts/pull-tms.mjs` for the same shape of vendored snapshot plus
   generator.
2. Hand-author a `journeyLevel` band per encounter. 215 entries for Johto
   alone, and every future region pays it again.
3. Derive by scaling the existing band down by route unlock order. Cheap,
   arbitrary, and it will read as arbitrary.

Option 1. It is the same job as the TM machine list and the same script
pattern, and it is the only one that stays cheap when Hoenn arrives.

## Enforcement, in the order it should be built

The predicate is the whole feature; everything below is presentation.

1. `caughtIn` stamped on new catches. **Inert** — nothing reads it yet. Safe
   to ship on its own, and it starts accumulating real data immediately, which
   every later step depends on.
2. `regionCompleted` + `canUseInRegion` + tests.
3. Journey-mode encounter levels (the PokéAPI pull).
4. UI: the party and PC mark a Pokémon that cannot be used where you are
   standing, with the reason. Travel offers to swap rather than refusing —
   a blocked button with no remedy is the failure mode this codebase keeps
   hitting.
5. Completion bonus. Something permanent and legible per region cleared —
   +10% EXP, +10% money, +5% catch rate, cumulative across regions. It is
   what stops the design reading as a pure nerf.
6. Free choice of starting region. Largely independent; needs the unlock graph
   to stop assuming Kanto is first.

## Open questions

* **PvP.** Region rules should almost certainly NOT apply — the ladder is
  level-capped and cross-region by nature. Worth stating explicitly so it is
  a decision rather than an oversight.
* **Auctions and trades.** Buying a Johto-native Pokémon while Johto is
  uncompleted hands you something you cannot use. Either stamp traded
  Pokémon as legacy on receipt, or show the restriction on the listing. The
  first is simpler and hard to abuse — you still had to pay for it.
* **Raids.** Raid Island belongs to no region. Treat it as always-completed.
