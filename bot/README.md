# Pokémon Idle Discord bot

Community bot for the official server: account linking, trainer cards, ladder
roles, giveaways, and a trade noticeboard.

Runs as its **own deploy**, never inside the game server process. It holds a
bearer token for `/api/bot` and nothing else — no database client, no Prisma,
no direct access to saves. Its blast radius is exactly what that API surface
allows. Same reasoning as `renderer/`.

---

## What it can and cannot do

**It cannot move Pokémon, items, or money between accounts.** There is no
endpoint for it, and there must never be. The live trade flow is in
`server/src/socket.ts`: both parties present, both locked in, one
server-canonical swap. That structure is the reason duping is impossible, and a
bot endpoint that transferred assets would be a second, weaker door into it —
reachable by anyone who phishes a Discord account.

`/trade offer` posts **text** to a noticeboard and returns a deep link. All the
discovery value, none of the custody.

**It cannot write `saveData`.** Giveaway prizes go through `enqueuePrizeGrant()`
into the `PendingGrant` inbox, and are folded into the winner's save by the save
endpoint on their next upload. See the `deliveredAt` doc comment in
`schema.prisma` before touching anything in that path — it documents an approach
that was built, shipped, destroyed real prizes, and was removed.

**It cannot read anything non-public.** Every payload comes from
`server/src/lib/botProfile.ts`, which is an explicit allowlist. No email, no
session data, no save blob, no ban reasons, no admin flags.

**It reads message text in exactly one channel.** Bug-report ingest
(`DISCORD_BUG_CHANNEL_ID`) is the sole exception to "Discord is a rendering
surface" — everything else is slash commands in, cards out. Unset that id and
the bot never looks at a message. See [Bug reports](#bug-reports).

---

## Setup

### 1. Create the Discord application

1. <https://discord.com/developers/applications> → **New Application**
2. **Bot** → copy the token into `DISCORD_BOT_TOKEN`
3. **Bot → Privileged Gateway Intents** → enable **Server Members Intent**

   Required. Without it `guild.members.fetch()` returns only cached members and
   role sync would silently cover a fraction of the server. The reconciler
   detects this and logs it rather than reconciling a partial list.

   Also enable **Message Content Intent** *if* you want Discord bug reports
   ingested (`DISCORD_BUG_CHANNEL_ID`). That is the only feature that reads
   message text; leave the channel id unset and the bot never looks at a
   message. See "Bug reports" below.
4. **OAuth2 → URL Generator** → scopes `bot` + `applications.commands`,
   permission **Manage Roles**. Open the generated URL and invite it.
5. **Server Settings → Roles** → drag the bot's own role **above** Trainer,
   Champion and Ace Trainer. Discord refuses any role change at or above the
   bot's highest role; the reconciler logs a clear message if you skip this.

### 2. Configure

```bash
cp .env.example .env
```

Fill in `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`,
`API_BASE`, and `BOT_TOKEN`. Channel ids come from right-clicking a channel with
Developer Mode on.

The same `BOT_TOKEN` value must be set on the game server. Generate it once:

```bash
openssl rand -hex 32
```

Every script below loads `.env` automatically via Node's built-in
`--env-file-if-exists`, so no `dotenv` dependency and no shell `export` dance.
`-if-exists` rather than `--env-file` is deliberate: the Docker image ships no
`.env` and takes its config from the platform, and a hard `--env-file` would
turn that into a boot crash.

A **blank** value is not the same as a missing one. `--env-file-if-exists` will
happily load a file where `DISCORD_BOT_TOKEN=` has nothing after the `=`, and
you get "need DISCORD_BOT_TOKEN…" from a file that plainly contains the key.
Check the values, not just the keys:

```bash
node --env-file-if-exists=.env -e "for (const k of ['DISCORD_BOT_TOKEN','DISCORD_CLIENT_ID','DISCORD_GUILD_ID','API_BASE','BOT_TOKEN']) console.log(process.env[k]?.trim() ? 'set  ' : 'EMPTY', k)"
```

Once the token and guild id are in, the **channel ids fill themselves**:

```bash
npm run channels            # list every channel with its id
npm run channels -- --write # write the four the bot uses into .env
```

The alternative is enabling Developer Mode and hand-copying four snowflakes,
which is four chances to put the mod-log id in the bug-channel slot and not
find out until a bug report lands in the wrong place. The bot's token can
already read the channel list, so this is the same information without the
transcription step. It rewrites only the keys it owns and leaves the rest of
the file — comments and secrets included — untouched.

### 3. Register slash commands

```bash
npm run deploy-commands
```

Run this after any change to `src/commands.ts`. It is deliberately **not** run
at boot: command registration is a rate-limited write to Discord's API, and
doing it on every process start means a crash-restart loop hammers it. It also
decouples "what commands exist" from "which build is deployed", so a rollback
does not silently re-register an older command set.

Commands are registered per-guild, so they appear instantly (global commands
take up to an hour to propagate).

### 4. Run

```bash
npm run dev     # tsx watch
npm start       # compiled
```

---

## The link flow

There is no Discord identity on `User` and there should not be. The binding
lives in its own table, `DiscordLink`, one-to-one in both directions, enforced
by the database.

```
  Player                     Bot                  Game server            Site
    │                         │                        │                   │
    │  /link                  │                        │                   │
    ├────────────────────────▶│                        │                   │
    │                         │ POST /api/bot/link/start                   │
    │                         ├───────────────────────▶│                   │
    │                         │   { code, expiresAt }  │                   │
    │                         │◀───────────────────────┤                   │
    │   DM: "ABC234"          │                        │                   │
    │◀────────────────────────┤                        │                   │
    │                                                                      │
    │  opens pokeidle.com/link-discord, signed in, enters the code         │
    ├─────────────────────────────────────────────────────────────────────▶│
    │                                          POST /api/discord/link/redeem
    │                                                  │◀──────────────────┤
    │                                          writes DiscordLink row      │
    │                         │                        │                   │
    │        Trainer role, on the reconciler's next pass (≤5 min)          │
    │◀────────────────────────┤                        │                   │
```

**Why the code travels Discord → player → site, and not the other way.** The
game session is the strong credential (Better Auth, first-party cookie, single
active session). The Discord side only has to prove possession of a secret we
sent to exactly one Discord user in a DM. Minting on the site and typing into
Discord looks symmetrical and is worse — it puts the secret into a channel
where one mistyped command posts it publicly.

**Codes** are 6 characters from a 26-symbol alphabet with every lookalike
removed (no `O`/`0`, no `I`/`1`/`L`, no `U`/`V`), single-use, 10-minute TTL,
held in memory. A lost code costs one re-run of `/link` — that is the entire
failure mode, which is why it is not a database table with a sweeper.

**`/unlink` works from DMs**, on purpose. Someone who has lost access to their
game account still needs to free their Discord account; requiring a signed-in
session to unlink would strand exactly the people who need it.

---

## Commands

| Command | Who | Visibility |
|---|---|---|
| `/link` | anyone | ephemeral + DM |
| `/unlink` | anyone (works in DMs) | ephemeral |
| `/profile [trainer]` | anyone | public |
| `/rank [trainer]` | anyone | public |
| `/leaderboard [limit]` | anyone | public |
| `/team [trainer]` | anyone | public |
| `/mon <slot>` | **self only** | ephemeral |
| `/dex [trainer]` | anyone | public |
| `/prizes` | **self only** | ephemeral |
| `/trade offer <offering> <wanting>` | linked | posts to `#trade-chat` |
| `/tournament list\|info <id>` | anyone | public |
| `/giveaway start\|draw\|status` | staff roles | public / ephemeral |

`/team` works on anyone — it is the same information as the in-game trainer
card, and a showcase command that only worked on yourself has no reason to
exist in `#showcase`. `/mon` is self-only because IVs and EVs are build
information the game does not publish for other players; a Discord command that
did would hand out a ladder advantage the game withholds.

Unlinked users get "run `/link` first" as an instruction, never a bare error.

`/tournament` is **read-only, and there is no `join` subcommand on purpose**.
Entering a bracket commits you to being online inside a round window, and a
no-show hands a real opponent a walkover (`server/src/lib/tournamentRunner.ts`).
A one-tap Discord button makes that commitment far too cheap; opening the game
to enter is friction doing useful work.

It works for unlinked members too — the bracket is public, and only the "your
pairing" section needs to know who is asking. That is what makes it usable in
`#ladder-talk` rather than only in DMs.

### Why `/tournament info` exists at all

The runner drives brackets **asynchronously**: a round stays open for
`roundWindowMinutes` (default 1440 — a full day) and starts each pairing the
moment both players happen to be online together, because a synchronous
16-player draw needs 16 people in the same 20 minutes and this game has ~34
accounts online in a given hour.

That design has one hole, and it is not in the runner: a player cannot act on a
pairing they do not know about, and the game can only tell them once they are
already online — which is precisely the state the async window exists to work
around. `/tournament info` is where that closes. It reports who you were drawn
against and renders the deadline as a live Discord countdown, which is also why
these two surfaces are embeds rather than rendered cards: "in 4 hours" baked
into a PNG is wrong by the time anyone scrolls past it.

---

## Role sync

The bot polls `GET /api/bot/roles/desired` every 5 minutes and reconciles.

| Role | Rule |
|---|---|
| **Trainer** | every linked, unbanned account |
| **Ace Trainer** | account level ≥ `DISCORD_ACE_TRAINER_LEVEL` (default 25) |
| **Champion** | current #1 on the ladder, with ≥ `DISCORD_CHAMPION_MIN_MATCHES` rated matches |

**Account level, not PvP rating**, for Ace Trainer. `server/src/routes/pvp.ts`
documents why: the leaderboard's `minMatches` default had to drop from 5 to 1
because the maximum `matchesPlayed` across every row in production was 1 — the
stricter filter returned an empty board. A rating-gated role would be a reward
nobody can earn, awarded by a job that always finds nobody, which looks exactly
like a broken job.

**Reconcile, not events.** An event-driven version loses a message every time
the bot redeploys, Discord rate-limits, or the process restarts mid-handler —
and a lost event leaves a wrong role in place permanently, with nothing that
will ever notice. A reconciler that misses a pass is stale for one interval and
then correct. Champion handover needs no memory of the previous holder: it is a
removal and a grant in the same pass.

**The scope rule.** The bot only ever removes roles listed in `managedRoles`,
which the server sends and which is exactly `[Trainer, Champion, Ace Trainer]`.
The naive reconciler — "remove every role not in the desired set" — would strip
Moderator, Admin, and every self-assigned role in `#get-roles` from every linked
member on its first pass. `server/tests/discordRoles.test.ts` pins that list.

A banned account holds **no** managed roles, including Trainer. Its link row is
kept, so the ban stays appealable and the Discord account cannot immediately
rebind to a fresh alt.

---

## Cards

Almost everything the bot shows is a **rendered PNG**, not an embed — an
embed's field layout reflows differently on desktop, mobile and compact mode
and cannot be controlled; a card is identical everywhere.

Sprites come from the PokeAPI set on jsDelivr, so there are no assets to host.
The URL rules are copied into `src/sprites.ts` with the reasons intact
(GitHub raw serves `.gif` as `text/plain`; jsDelivr 403s named filenames, so
sprites are keyed on the **numeric dex id**).

That id is why `src/data/*.json` exists. The save blob carries only
`speciesKey`, and the game server has no species table by design — so the
mapping ships as a generated snapshot:

```bash
npm run snapshot     # regenerate after species/items/moves change in game/
```

Same pattern, and same reason, as `admin/scripts/snapshot.mts`. Re-run it when
the game adds content; until you do, a new species renders without a sprite and
a new move renders as a prettified id rather than its real name.

To see what the cards look like without a Discord server:

```bash
npm run samples      # writes bot/samples/*.png
```

The sample data is deliberately awkward — a long nickname, a shiny, an unranked
player, a stuck prize — because tidy data hides exactly the layout bugs this
catches. Layout is not typecheckable; look at the PNGs.

**Fonts are not optional.** `node:20-bookworm-slim` ships with none and
`@napi-rs/canvas` draws text with whatever the OS has, so without
`fonts-dejavu-core` (installed by the Dockerfile) every card renders perfectly
except that all the text is blank — silently, and only in production. Colour
emoji are deliberately *not* installed; cards keep emoji out of rendered text
and put them in the message body, where Discord renders them.

Every card also repeats its key facts in the message body. A card is an image:
not selectable, not translatable, invisible to a screen reader.

---

## The link reward

Configured in the **admin dashboard** → Giveaways → *Discord link reward*,
using the same prize picker as a giveaway. Not an environment variable: it is
promotion content an operator changes as a judgement call, and env would put it
behind a redeploy, somewhere the dashboard cannot show it.

A separate on/off switch means a promotion can be **paused without losing its
prize** — clearing the prize to disable it is how you turn it back on with the
wrong thing in it.

The prize is named in the `/link` DM (so it can actually persuade someone to
link) and confirmed on the `/link-discord` page after redeeming. It pays through
the `PendingGrant` inbox like every other grant, so it lands on the player's
next save upload and cannot be raced away.

**Idempotency uses no extra table.** `PendingGrant` is append-only and indexed
on `(source, sourceId)`, so the grant *is* the receipt: a reward is refused
when a `discord-link` grant already exists for the game account (`userId`) **or**
the Discord account (`sourceId`). That blocks unlink-then-relink in both
directions and survives restarts, because the rows are never deleted. The
obvious alternative — a `rewardedAt` column on `DiscordLink` — fails, because
that row is deleted on `/unlink`.

What it does **not** block is N throwaway Discord accounts paired with N
throwaway game accounts — nothing short of an eligibility gate does, and this
shipped without one on purpose to keep the promotion frictionless. If the
ledger shows farming:

```sql
SELECT date_trunc('day',"createdAt"), count(*) FROM "PendingGrant"
WHERE source = 'discord-link' GROUP BY 1 ORDER BY 1 DESC;
```

…set `DISCORD_LINK_REWARD_MIN_LEVEL` above 0 on the game server. That gate is
the one part that stays in env, deliberately: the prize is content, but the gate
is a policy lever and should be harder to move than a text box on a page anyone
with admin can reach.

---

## Giveaways

Two ways in, one implementation.

**From Discord:** `/giveaway start` creates a **real `Giveaway` row** and posts
a card with an Enter button. `/giveaway draw` calls the **real
`drawGiveaway()`**.

**From the admin dashboard:** tick **Announce in Discord** when creating a
giveaway (optionally with a channel id; blank uses the bot's default). The bot
polls every 30 seconds, posts the card, and posts the result once it is drawn —
from either side.

The server never calls Discord for this. It sets a flag; the bot polls. Same
split as role sync, and for the same reason: a Discord outage has nothing to
fail here. `Giveaway.discordMessageId` and `discordResultsAt` are the
idempotency markers — without them a timer-driven poll re-posts on every tick.
The bot posts **first** and marks **second**: a crash in between costs one
duplicate message a human can delete, where the other order costs a giveaway
that is never announced at all.

This is not the shortest implementation, and that is the point. A bot-local
giveaway would have quietly lost: the atomic `drawnAt: null` compare-and-swap
that makes a double-draw impossible, the seeded deterministic pick that makes
the result verifiable after the fact, the paid-but-unrecorded handling that
stops an operator re-granting a prize that already landed, and the admin
dashboard's owed-vs-delivered view.

Entrants must be linked, checked at **entry** rather than at draw — discovering
it at draw time means re-rolling a winner in public, which is indistinguishable
from rigging it.

Prizes are JSON, validated server-side by the same schema the admin dashboard
uses:

```json
[{"kind":"item","itemId":"masterball","quantity":1}]
[{"kind":"money","amount":50000}]
```

**Delivery is deferred.** The prize lands on the winner's next save upload, not
at draw time. The bot says so in the announcement and DMs each winner, and
`/prizes` shows the state, because a winner who is not currently playing would
otherwise read an empty bag as a broken giveaway.

A "stuck" prize is almost always a full box. `checkPrizesDeliverable()` cannot
detect that and does not try — it is prize-intrinsic by design and never
consults the recipient's save, because a transient condition reported as a
failure leads an operator to re-grant and double-pay. `/prizes` surfacing
`attempts` **is** the mechanism.

Outcomes are posted to `#mod-log` with the draw seed. The durable audit is
`AdminAudit` on the game server either way.

---

## Bug reports

Set `DISCORD_BUG_CHANNEL_ID` and posts in that channel land in the admin
dashboard's existing bug triage queue, tagged **Discord**, with a jump link back
to the original message.

Both channel shapes work:

| Channel type | One report is | Title comes from |
|---|---|---|
| text channel | one message | the first line, or a truncation of the body |
| forum | one thread | the thread title the reporter chose |

Reporters who have linked their game account are attributed to it, so the row
shows `ash (@someone)` and triage can go and look at their save. Unlinked
reporters still work; they are just named by their Discord handle.

**This is the only feature that reads message text.** It needs the
MessageContent privileged intent, and it means player-written Discord text now
lives in the game database — a deliberate reversal of the original "no Discord
message content in the game DB" rule, because the whole value of a bug report
*is* its text. It is bounded to the one configured channel: every other channel,
every DM, every bot message and every reply is ignored. Leave the channel id
unset and none of it happens.

Noise control: replies are skipped (they are follow-up discussion, not new
reports) and anything under ten characters is dropped, because bug channels are
full of "+1" and "same here".

**Idempotency is `discordMessageId UNIQUE`.** The bot listens live *and* sweeps
the last 50 messages on boot, so a report posted while it was redeploying is not
lost — which means the same message is submitted more than once by design. The
duplicate is refused by the database and reported as success, so a restart is
quiet rather than a wall of errors.

If reports arrive with blank descriptions, the MessageContent intent is off.
Discord returns an empty string rather than an error, so the bot detects that
case and logs it loudly.

---

## Rotating `BOT_TOKEN`

The token is a bearer secret shared between the game server and this bot. It is
never logged on either side.

1. Generate: `openssl rand -hex 32` (must be ≥ 32 characters — the server
   refuses anything shorter and answers 401 to everything, which looks exactly
   like a wrong token).
2. Set `BOT_TOKEN` in the **game server** env. Restart it.
3. Set the same value in the **bot** env. Restart it.

Between steps 2 and 3 the bot's commands answer *"I'm not authorised to talk to
the game server"* and role sync skips its passes. Nothing player-facing breaks
and nothing is lost — role sync is a reconciler, so the first pass after the
restart corrects any drift.

Do the game server first. The other order leaves a window where the bot holds a
token the server has not accepted yet, which is the same outage with a worse
name.

To disable the bot API entirely, blank `BOT_TOKEN` on the game server and
restart. It fails closed.

---

## Layout

```
bot/
├── src/
│   ├── index.ts           gateway client, interaction routing, shutdown
│   ├── bugReports.ts      the one feature that reads message text
│   ├── config.ts          env parsing — validated loudly at boot
│   ├── api.ts             the ONLY place that calls the game server
│   ├── commands.ts        slash command definitions
│   ├── handlers.ts        command + button handlers
│   ├── embeds.ts          embed builders
│   ├── roleSync.ts        the reconciler
│   ├── giveawaySync.ts    polls for admin-dashboard giveaways
│   ├── sprites.ts         sprite URLs + catalog lookups
│   ├── cards/             PNG renderers
│   └── deployCommands.ts  one-shot command registration
├── Dockerfile
└── railway.json
```

Server-side counterparts:

| File | What |
|---|---|
| `server/src/routes/bot.ts` | the `/api/bot` surface + `BOT_TOKEN` gate |
| `server/src/routes/discord.ts` | the session-authed redeem half |
| `server/src/lib/botProfile.ts` | save-shape knowledge, in one place |
| `server/src/lib/discordLink.ts` | link codes + binding rules |
| `server/src/lib/discordRoles.ts` | desired role computation |
| `game/src/auth/LinkDiscordScreen.tsx` | the `/link-discord` page |
| `game/src/hooks/useTradeDeepLink.ts` | `?trade=<username>` handling |
