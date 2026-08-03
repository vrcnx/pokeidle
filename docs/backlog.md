# Backlog — player requests, with what each one actually needs

Written at the end of a long session, so the findings below (particularly
the two blockers) are not re-discovered from scratch. Every item here is a
real request; none of them needs clarification from the reporter.

Ordered by "how much is in the way", not by how much anyone wants it.

---

## 1. Discord rewards should say to use `/link`

**Smallest of the set.** The rewards promo card offers a Master Ball for
linking a Discord account and never says the linking is done with `/link` in
the server. Almost certainly copy-only, in the promo definition
(`server/src/lib/promos.ts` — `discordLinkPromo()`), which already carries a
`blurb` and a `cta`.

Check whether the CTA currently deep-links to the link page; if it does, the
sentence needs to cover both routes ("in the game, or `/link` in Discord").

---

## 2. "Go" button on locations in the species modal

`DexSpeciesModal` lists "where to find" rows with a route name, a level range
and an encounter chance. They are not actionable, so a player who has just
learned where a Pokémon lives has to close the modal and go find the route
on the Map.

`RouteCardList` already has the travel dispatch to copy:
`dispatch({ type: "TRAVEL", payload: { locationId } })`, gated on
`state.unlockedLocations.includes(id)`. A locked route should show why it is
locked rather than a dead button.

---

## 3. Hovering an unseen Pokémon should show its encounter data

The reporter's argument is the load-bearing part: **this is not hidden
information.** Clicking the sprite already shows the encounter chance and
level range; only the NAME is hidden. So the hover showing bare `???` hides
nothing — it just makes you click.

- Wild Pokémon panel: `???` → `??? · 3.5%`
- Map tab: `???` → `??? · Lv40–42 · 4%` (that tab rounds its chances)

Both live in `WildPokemonSection` / `RouteCard`, and both already compute the
percentage for the seen case — the unseen branch simply drops it.

**And a real bug in the same report:** using Honey on an unseen species
reveals its NAME in the Bag. That is the one thing the dex is meant to
withhold, and it leaks everywhere else it is hidden. Look at the active
effects list — it names the target species (`pokemonTable[eff.speciesKey].name`)
with no seen check. Should read `???` for an unseen species.

---

## 4. Honey / Repel should not deplete outside the area they were used

Two halves, and the second is arguably worth more than the first.

**(a) Don't tick down elsewhere.** An effect is per-species AND per-route
(`eff.speciesKey`, `eff.routeKey`), so the data to decide this already
exists. The consumption happens wherever `battlesRemaining` is decremented —
it needs to skip effects whose `routeKey` is not the current location.

**(b) Let the player cancel one.** Sak4i: "I click the wrong thing and have
to wait 500 matches to switch." Today there is Pause and nothing else, so a
mis-click is a 500-battle sentence. Needs a `CANCEL_EFFECT` action and a
control on the effect card in the Bag (the card already has Pause/Resume
there — `.bag-effect-foot`).

Decide deliberately whether cancelling refunds the item. Not refunding is
simpler and defensible; refunding invites use-then-cancel abuse only if the
effect did something first, which it did.

---

## 5. Map search box

`RouteCardList` already filters by region and now groups by city. A name
filter over `routesInRegion` is small. One decision: whether searching looks
across ALL regions or only the open one. Searching the open region only is
consistent with the tabs; searching everything is more useful and needs the
result to say which region each hit is in.

---

## 6. Pokémon gender — BLOCKER for #7

**`gender` does not exist on the `Pokemon` type.** Only `nature?` does. This
is not a filter feature, it is a data-model change, and it has to land before
the gender half of the auto-capture request can:

- a field on `Pokemon`
- generation in `createPokemon`, from per-species gender ratios — **check
  whether the species table carries a ratio at all**; if not, that data has
  to come from somewhere
- display in the detail sheet
- and an answer for every Pokémon already caught, which will have none.
  Same shape as `caughtAt`: optional field, and everything that reads it has
  to tolerate `undefined` rather than assuming a default

---

## 7. Auto-capture: advanced filters — BLOCKED

Nature, IV range, gender, and combining them. The reporter is right that it
touches no rates and therefore no balance.

**The blocker is the signature.** Today:

```ts
shouldAutoCatch(state, routeKey, speciesKey, level, isShiny)
```

It receives a species key and a level. It **cannot see IVs or nature** — the
encounter object never reaches it. So this needs:

1. the encounter threaded through from the battle loop (`useBattleLoop`
   already holds `enemy`, which has `ivs` and `nature`)
2. `CatchSettings` extended from a single `mode` string to a set of
   criteria that AND together — the current shape is one-rule-only and the
   request is explicitly about combining
3. gender, which does not exist yet (see #6)

Do it in that order. Building the settings UI first would look finished
while filtering on nothing.

Keep the existing `alwaysCatchShinies` override ahead of everything, for the
reason written in `catching.ts`: a per-route rule silently ate every shiny
once already, and that report is why the shiny gate fires first.

---

## 8. Manage Moves: drag to reorder

From pani. Drag moves to reorder instead of Move Up / Move Down, and drag
from "Available Moves" onto a slot to fill or replace it.

The drag controller is already touch-friendly and in use in two places
(`useDragAndDrop`, party rows and PC cells) — reuse it rather than adding a
library. Needs an id-addressed reorder action, not index-addressed: the same
reasoning as `RELEASE_MANY` (see `bulkRelease.test.ts`), because the list
being dragged is the list being mutated.
