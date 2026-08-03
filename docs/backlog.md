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

**The TM Mart.** TMs were briefly stocked permanently, town by town, themed
to each gym. It read nicely and it was the wrong shape: a permanent shelf
makes every TM a question of money alone, and the route that hides one stops
mattering the moment your wallet is big enough. They all moved to one page
that rotates six a day.

DEALT, NOT DRAWN. The first version drew independently each day and was
measured over a simulated year: every machine came around, but a specific one
could be 28 days out — a slot machine, not a shop. The pool is now shuffled
once per cycle and dealt six a day, so every machine appears exactly once
every eight days, the wait is always knowable, and the page shows it.

The rotation is enforced in the reducer, not the page. `itemsCatalog` gives
every machine `buyPrice: null` — a price there would say "available" about
something available one day in eight, and quote half the asking price on the
route machines, which cost double at the counter. Without that, the rotation
would have been a decoration on one screen.

**Auctions sell machines too**, and the page was rebuilt around it.

The old one put a complete bid form on every card: six listings meant six
"Your maximum" inputs, six Bid buttons and six "How bidding works" links
stacked down the page, with the Pokémon at 24px. It is master/detail now — a
card compares, the third column commits. The listing flow used half the
dialog for a scrollbar-in-a-scrollbar picker with no search and left the
other half black; both steps use the full width now, and the suggested price
is clamped to the floor it used to fall below.

Two things were found by looking at the live page rather than by a test: a
seven-figure lot rendered `$4,000,0001h 25m` (a flex `gap` collapses once the
row overflows, and a price has no upper bound — so nothing shares its line
now), and the third column went on saying "Pick a lot" while the body was
showing the sell flow.

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

**The TM screens are verified on the live site.** The local dev server sits
behind a sign-in with no test account, but main auto-deploys, so everything
was checked on production instead. Confirmed by looking:

  · TM Mart — the six-slot counter, the restock clock, "0/59" collected,
    per-type disc sprites, "39 of yours can learn it — Mewtwo, Gengar, +36",
    route machines at double price with "half this price if you walk"
  · Buying flips the card to "Owned — Teach…" and the counter to 1/59
  · The Teach picker — the move's numbers, and every party member listed
    with the reason ("Knows 4 moves — pick one to replace")
  · Manage Moves — the All / Level-up / TM/HM filter appears only once a
    machine move is in the pool; the machine move carries a gold dashed
    border and reads "Pwr — · 90% · TM06" rather than "Lv.undefined"; the
    collapsed "Needs a machine you don't have 13" lists the rest

The item text is right where it matters most: the Teach dialog reads "Badly
poisons the target", not "poisons". That is the runtime describer reading the
live move table — PokéAPI files Toxic's ailment as plain poison, and a
description generated from it would have promised the weaker status.

**The auction listing round-trip is verified too**, on production, with a
machine listed at an unpayable price for the shortest duration and pulled
straight back: list → escrowed out of the bag and shown as an item lot
badged "Your listing" → the panel renders machine facts with no IV bars and
no bid box on your own lot → pull → the lot disappears and the machine
returns to the bag. That is the create/escrow/browse/cancel/restore cycle
end to end, which was the least-tested code in the feature.

Still not exercised: teaching into a FREE slot (every party member had four
moves), and a settlement that actually completes — that needs a second
account and a real bid.

**A purchase can be lost if you leave immediately.** Buying a TM, then
navigating away within a few seconds, lost it: the save had not autosaved and
the reload adopted the cloud copy. Nothing to do with machines — the same is
true of any purchase — but it is worth knowing that a $60,000 TM is only as
safe as the next autosave.

**Three level-up moves do nothing.** `lightScreen`, `reflect` and `rest`
are in the level-up pool with no `effect` attached, so they cost a turn and
have no result. Found while deciding which machines were shippable. They
need real mechanics (side conditions, in-battle healing) rather than a data
fix, which is why they are noted rather than patched.
