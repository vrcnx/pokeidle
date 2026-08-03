# Backlog — player requests

Everything that was on this list has shipped. Kept as a record of what was
built and, where it matters, the finding that shaped it — several of these
turned out to be different problems from the ones reported.

## Done

**Discord rewards say `/link`.** The blurb said "link your account" without
saying how, and the how is a slash command in another application.

**"Go" on a species' locations.** The dex sheet named the exact route and
then made you close it, open the Map and find that route by name.

**Unseen Pokémon show encounter data.** Not hidden information — clicking
already revealed it, so `???` on hover only cost a click. `??? · 3.5%` in the
wild panel, `??? · Lv40-42 · 4%` on the Map. The name is still withheld.

**Honey revealed an unseen species' NAME in the Bag.** A real bug found
inside that QoL report. The one thing the dex withholds everywhere else.

**Honey/Repel only burn where they apply**, and can be cancelled. An effect
is per-species AND per-route, so wandering off used to burn 500 battles of
something that never fired. Pause kept a mis-click; Cancel ends it.

**Map search**, across every region rather than the open tab.

**Pokémon gender** as a real field. Derived from IVs rather than rolled — an
extra `Math.random()` in `createPokemon` shifts the shared stream and breaks
seeded tests elsewhere. Backfilled on load for existing Pokémon rather than
defaulted, because "all male" would show a male Chansey.

**Auto-catch filters** — nature, IV%, gender, combined. The blocker was the
signature: `shouldAutoCatch` never received the encounter, so it could not
see IVs or nature at all. An unjudgeable filter PASSES, deliberately.

**Manage Moves drag** — and the fix that made it work at all: `updateTarget`
only ran inside a `requestAnimationFrame`, so any drag released before a
frame landed dropped nothing. That was the whole drag system, not just moves.

**PC sorts by catch date**, and filters by "holding an item".

**Rename is a button.** It was the dialog's `<h2>`, which also repeated the
name and level from the line below it.

**Auctions** — full Pokémon detail on listings (the data was always sent),
a suggested opening price that deliberately does NOT prefill the field, and
its own page in the hub instead of a tab inside the chat panel.

**TMs and HMs.** Asked for by a player making a competitive-scene argument:
EVs, IVs and Natures are all optimisable, and move selection — "just as
important" — was not. 53 TMs and 6 HMs, from the Gen 5 machine list.

Three findings shaped it:

*The roster ends at Genesect (#649)*, which is exactly the Gen 5 national
dex — so `black-2-white-2` is the one version group where every species the
game has exists AND has complete machine data. Nothing guessed.

*42 of the 101 machines were left out*, each with the reason recorded in
`game/scripts/gen-tms.mjs`. The battle engine has a fixed vocabulary of
effects and no screens, hazards, Protect, Substitute, mid-turn switching,
healing, or power that varies with happiness / weight / held items. Shipping
Light Screen as a TM would have sold a no-op — and there is proof it would
have gone unnoticed: `lightScreen`, `reflect` and `rest` are in the LEVEL-UP
pool today with no effect attached and do nothing in battle. That is a
separate bug, still open.

*Damaging moves could not change stats at all.* `executeTurn` handled
`statChange` only in the branch for status moves; the effect switch that runs
after damage had no case for it, so the effect was read and dropped. No move
in the table had that shape, so nothing exercised it — which is why it was
invisible rather than harmless. It blocked the entire `damage-lower` /
`damage-raise` half of the TM list. Psychic, Shadow Ball, Overheat and eleven
others work because it exists now.

Machines are REUSABLE and capped at one per player: the scarcity is finding
one, not rationing charges. Marts sell the setup toolkit (each town stocking
what it is known for), every route hides exactly one attacking TM and nothing
else drops it, and raids pay out the HMs and the heaviest TMs.

## Not a backlog item, but outstanding

**Prod migrations: already applied — this entry was wrong.**
Checked against the live database rather than assumed:

    20260801230000_add_signup_attribution   applied 2026-08-02 01:03  (17 rows)
    20260802220000_discord_link_codes       applied 2026-08-02 21:44  (0 rows)

`prisma migrate status` reports all 31 applied. The deploy pipeline runs
`migrate deploy`, so anything merged is live before anyone thinks to run it
by hand. Nothing to do.

**And do not run `npm run db:migrate` against production.** That script is
`prisma migrate dev`, which is the DEVELOPMENT command — on schema drift it
offers to reset the database, i.e. drop everything. `.env` here points at the
Railway production instance, so the command in the previous version of this
note was a data-loss hazard, not a chore.

The safe pair against a live database:

    npx prisma migrate status     # read-only, says what is pending
    npx prisma migrate deploy     # applies pending only, never resets

`db:push` is already refused by the package script, for the same reason.

**The silver bottle cap's two-step dialog shipped unverified.** The code
builds and typechecks; the step itself was never seen rendering. Worth a
look the next time anyone is in the Bag.

**The TM dialogs are partly verified now.** The local dev server sits behind
a sign-in with no test account, but main auto-deploys, so the shipped work
was checked on the live site instead: TM cards render with per-type disc
sprites, the right names, and the single-buy card with no quantity stepper.

Still unseen on screen: the Teach picker, the Manage Moves source filter,
and the TM Mart page itself. Worth a look at:

  · Bag → TMs → Teach on a Pokémon with a free slot vs one with four moves
  · Manage Moves → the All / Level-up / TM/HM filter, and the collapsed
    "needs a machine you don't have" list
  · TM Mart → the six-slot counter, the restock clock, and "Not today"

**Three level-up moves do nothing.** `lightScreen`, `reflect` and `rest`
are in the level-up pool with no `effect` attached, so they cost a turn and
have no result. Found while deciding which machines were shippable. They
need real mechanics (side conditions, in-battle healing) rather than a data
fix, which is why they are noted rather than patched.
