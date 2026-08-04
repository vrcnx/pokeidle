# Open bug reports — status and closing notes

Written 2026-08-04. Every report below is **resolved in code**; what is left is
closing it in the tracker, which needs an admin session
(`PATCH /api/admin/bug-reports/:id`). The browser available during this work is
signed in as `tokyofuck`, a player account, so `/api/admin/*` returns
`403 forbidden`.

Each entry has the note to paste into `adminNotes` with `status: "resolved"`.

---

## 1. Backpack won't scroll with a lot of Repel / Honey

**Fixed and already live** (shipped with the Bag rebuild, in production now).

Verified on production against the real account: injected 24 active effects
into the live Bag and the effects list capped at 232px and scrolled inside
itself, while the last item in the bag (TM53 Energy Ball) stayed reachable.

> resolved — the active-effects list is bounded to two rows and scrolls inside
> itself now, so a long list of Repels can no longer push the rest of the bag
> off the bottom. Every active Repel is per-species AND per-route, so repelling
> five species across four routes made twenty entries; the count in the heading
> tells you there are more. Already live.

---

## 2. Master Ball thrown automatically (`br_3a5bc2b26425b58611`, ma62087)

**Fixed in 0.9.5**, already live.

`ballForAutoCatch`'s emergency fallback for a shiny read
`BALL_ORDER.find(b => inventory[b] > 0)`, and `BALL_ORDER` ends with
`masterball` — so with the first three exhausted, `.find` returned the Master
Ball. Pinned in `game/tests/masterBallGuard.test.ts`, which cites this report id.

> resolved — automation can never reach for the Master Ball now. The shiny
> fallback used to walk the ball list in order and that list ended with the
> Master Ball, so once your Poké/Great/Ultra Balls ran out it picked that one.
> It is only ever thrown if you choose it yourself. Fixed in 0.9.5, and there
> is a test pinning it in both directions.

---

## 3. Auction item never received (24 Jul)

**Fixed in 0.9.5**, already live. Named explicitly in commit `9881d69`
("one lost a shiny bought at auction").

Server-granted prizes were written straight into `saveData` with no
compare-and-swap, so the winner's next upload could erase them.

> resolved — server-granted items now go through a PendingGrant row and are
> folded into your save inside the same version check, so a later upload from
> another tab cannot erase them. Three players provably lost Master Balls the
> same way and one lost a shiny bought at auction; that is this. Fixed in 0.9.5.

---

## 4. Changing game speed reloads the scene text / can stall the game (pani)

**Fixed, not yet deployed** — commit `c18b6bd`, ships in 0.9.7.

> resolved — switching speed retimes what is already running instead of
> restarting it. Four separate timers were being re-armed from zero on every
> change, and because nothing advances while the battle queue is draining, that
> froze the game for as long as you kept clicking. The message box was the same
> bug: its cursor was thrown away, so the line you were reading retyped itself
> from the first character. Damage numbers and "Super effective!" banners could
> also get stuck on screen permanently — that one nobody reported, it fell out
> of reading the same code. Ships in 0.9.7.

---

## 5. Attack animations ignore game speed (pani)

**Fixed, not yet deployed** — commit `c18b6bd`, ships in 0.9.7.

> resolved — they were not playing faster at 5×, they were being cut off
> part-way: the unmount timer scaled but the ~40 keyframe rules in the
> stylesheet are fixed literals, so you were seeing the first third of a
> Flamethrower. Every effect now plays at the speed you set and shows the same
> amount of itself at 1×, 2× and 5×. Measured: fire effects showed 31% of
> themselves at 5× and 67% at 1×; both are 67% now. Ships in 0.9.7.

---

## 6. Shiny Scyther in the Pokédex but not in the PC or party

**Not a bug — and not closeable as "fixed".** Reply, do not silently resolve.

This is `mergeCloudAdvance` working as designed. `pokedexCaught` and
`shinyCaught` are monotonic and unioned from both save lineages; party and box
are spendable and taken whole from one. So a Pokémon caught on the lineage that
loses the merge leaves its dex entry behind and goes with the wallet.

The trade-off stays: unioning the box instead resurrects Pokémon the other
lineage already sold, which is a documented duplication exploit. What was
genuinely wrong is that it happened silently — fixed in `06a270f`, shipping in
0.9.7, so the game now names which Pokémon were only on the copy that lost and
says their Pokédex entries were kept on purpose.

> Thanks for this — it is not corruption, and the Pokédex entry is the clue.
> Your save exists in two places (this browser and the cloud), and when they
> disagree the game has to pick ONE for money, items and Pokémon — mixing them
> is how duplication bugs happen. Pokédex progress is never rolled back, so a
> Pokémon caught on the copy that lost leaves its dex entry behind. That is
> exactly what you are looking at. It should never have happened without
> telling you, and from 0.9.7 it does: you will be told which Pokémon went and
> why. Sorry about the Scyther.

---

## 7 & 8. Two Spanish feature requests

**Nicknames** — already in the game. Reply rather than resolve:

> Ya puedes poner apodos: abre el Pokémon en el PC y toca su nombre. ¡Gracias!

**Saved teams** — a genuine request, not a bug. Move to the backlog rather than
closing it.

---

## Unblocking this

Either grant `isAdmin` to an account whose session is available in the browser,
or paste the notes above by hand. The endpoint is:

```
PATCH https://api.pokeidle.com/api/admin/bug-reports/:id
{ "status": "resolved", "adminNotes": "..." }
```
