// Dev-only harness that mounts REAL pages with mock data.
//
// ── WHY ─────────────────────────────────────────────────────────────
// The dashboard is behind an admin session, so the only way to look at a page
// was to sign in — which isn't always possible, and is never possible for
// whoever is reviewing a diff. The previous harness was hand-written HTML that
// imitated the pages, and imitation is worth very little: it tells you the
// primitives look fine while the actual page can be broken in ways the mock
// never reproduces.
//
// This mounts the genuine components. Same JSX, same CSS, same conditionals —
// only the network is replaced. `api` is a plain object export, so its methods
// are patched here before anything renders; no bundler aliasing, no DI, and
// nothing about the components changes to accommodate being previewed.
//
// Never part of a production build: Vite only bundles entries reachable from
// index.html, and nothing in the app imports this.
//
//   cd admin && npm run dev  →  http://localhost:5174/design-preview.html

import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, type Analytics } from "./api";
import "./app.css";

// ── Mock data ───────────────────────────────────────────────────────
// Shaped like a real, awkward dataset rather than a tidy one: a heavily
// skewed level distribution (this game's real max is 18,810 against a mean of
// 59), a sparse DAU series that starts mid-window because collection began
// then, and retention that is null for the cohorts predating it. Tidy data
// hides exactly the layout bugs a preview exists to catch.

function daySeries(days: number, base: number, jitter: number, trend = 0): Record<string, number> {
  const out: Record<string, number> = {};
  const now = Date.now();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now - i * 86400000).toISOString().slice(0, 10);
    const wave = Math.sin(i / 3.5) * jitter;
    out[d] = Math.max(0, Math.round(base + wave + (days - i) * trend));
  }
  return out;
}

const ANALYTICS: Analytics = {
  totals: {
    users: 2442, bannedUsers: 14, admins: 3, friendships: 1876,
    chatMessagesTotal: 48219, chatMessages7d: 1204,
    pvpMatchesTotal: 55, pvpMatches7d: 4,
    tradesTotal: 3181, trades7d: 96,
    bugReportsOpen: 7, errorsLast24h: 23,
    pokemonCaughtSum: 412885, pokemonLevelsSum: 9134772,
  },
  activity: { activeDay: 341, activeWeek: 892, activeMonth: 1544, signups7d: 128, signups30d: 517 },
  averages: { pokedexCaught: 84, accountLevel: 59 },
  signupSeries: daySeries(30, 16, 7, 0.2),
  lastSeenSeries: daySeries(30, 30, 18, 1.4),
  loginSeries: daySeries(30, 260, 70),
  // Starts partway through the window — collection began mid-month, and a day
  // missing from this table means "we weren't recording", not "nobody played".
  dauSeries: daySeries(18, 320, 60),
  dauCollectingSince: new Date(Date.now() - 18 * 86400000).toISOString(),
  retention: { d1: 41.2, d7: 18.4, d30: null, cohortSizes: { d1: 1204, d7: 902, d30: 0 } },
  pvpSeries: daySeries(30, 1, 2),
  tradeSeries: daySeries(30, 13, 9),
  levelBuckets: [
    { label: "1-9", count: 1180 }, { label: "10-24", count: 512 },
    { label: "25-49", count: 289 }, { label: "50-99", count: 214 },
    { label: "100-249", count: 128 }, { label: "250-499", count: 82 },
    { label: "500-999", count: 21 }, { label: "1000+", count: 16 },
  ],
  leaderboards: {
    pokedex: [
      { id: "1", username: "sak4i", name: "Sak4i", accountLevel: 3615, pokedexCaughtCount: 151 },
      { id: "2", username: "stratus_varius", name: "StratusVarius", accountLevel: 1119, pokedexCaughtCount: 148 },
      { id: "3", username: "averyverylongtrainername", name: null, accountLevel: 902, pokedexCaughtCount: 141 },
      { id: "4", username: "koruem2", name: "Koruem", accountLevel: 611, pokedexCaughtCount: 133 },
      { id: "5", username: "phoenix", name: "Phoenix", accountLevel: 87, pokedexCaughtCount: 84 },
    ],
    sigmaLevels: [
      { id: "1", username: "sak4i", name: "Sak4i", accountLevel: 3615, totalCaughtLevels: 184220 },
      { id: "2", username: "tokyofuck", name: null, accountLevel: 2011, totalCaughtLevels: 98110 },
      { id: "3", username: "stratus_varius", name: "StratusVarius", accountLevel: 1119, totalCaughtLevels: 61044 },
      { id: "4", username: "koruem2", name: "Koruem", accountLevel: 611, totalCaughtLevels: 30871 },
      { id: "5", username: "phoenix", name: "Phoenix", accountLevel: 87, totalCaughtLevels: 8120 },
    ],
  },
};

// Patch before any component mounts. `api` is a plain object, so this needs no
// build-time indirection.
// Partial coverage on purpose: attribution starts the day it ships, so for
// weeks the panel's real job is to be honest about what it does NOT know. A
// tidy 100%-covered mock would never exercise the caveat.
const ACQUISITION = {
  windowDays: 30,
  signups: 517,
  attributed: 214,
  collectingSince: new Date(Date.now() - 11 * 86400000).toISOString(),
  channels: [
    { channel: "social", signups: 96 },
    { channel: "direct", signups: 61 },
    { channel: "organic", signups: 38 },
    { channel: "referral", signups: 14 },
    { channel: "paid", signups: 4 },
    { channel: "email", signups: 1 },
  ],
  sources: [
    { source: "discord.com", channel: "social", signups: 54 },
    { source: "direct", channel: "direct", signups: 61 },
    { source: "google.com", channel: "organic", signups: 31 },
    { source: "reddit.com", channel: "social", signups: 28 },
    { source: "youtube.com", channel: "social", signups: 11 },
    { source: "a-very-long-referring-hostname-that-should-truncate.example.com", channel: "referral", signups: 6 },
    { source: "chatgpt.com", channel: "organic", signups: 5 },
    { source: "t.co", channel: "social", signups: 3 },
  ],
  campaigns: [
    { campaign: "summer-launch", source: "discord.com", medium: "social", signups: 22 },
    { campaign: "r-pokemon-post", source: "reddit.com", medium: null, signups: 9 },
    { campaign: "yt-devlog-3", source: "youtube.com", medium: "cpc", signups: 4 },
  ],
  landingPages: [
    { path: "/", signups: 181 },
    { path: "/link-discord", signups: 24 },
    { path: "/reset-password", signups: 3 },
  ],
};

// Live ops, generated at call time so the ages tick and the pulse chart is
// exercised. Chat is deliberately AT its cap of 50 while the true count is
// 214 — the truncation case is the one the page has to handle honestly, and a
// mock that never saturates would never show it.
const NAMES = ["sak4i", "stratus_varius", "koruem2", "tokyofuck", "phoenix", "averyverylongtrainername", "ash_k", "misty"];
function liveOpsMock() {
  const now = Date.now();
  const pick = (i: number) => NAMES[i % NAMES.length];
  const at = (minsAgo: number) => new Date(now - minsAgo * 60_000 - (minsAgo % 7) * 3000).toISOString();
  const chat = Array.from({ length: 50 }, (_, i) => ({
    id: `c${i}`, kind: "chat" as const,
    // Bunched into the last 12 minutes: 50 rows is the cap, so the sample
    // cannot reach further back than that and the chart must say so.
    createdAt: at(i * 0.24),
    channelId: i % 4 === 0 ? "global" : i % 4 === 1 ? "area:Viridian Forest" : "dm:abc",
    content: i % 5 === 0
      ? "does anyone have a spare thunderstone, i'll trade a shiny eevee for it honestly"
      : "gg",
    user: { id: `u${i}`, username: pick(i), name: null },
  }));
  const signups = Array.from({ length: 6 }, (_, i) => ({
    id: `s${i}`, kind: "signup" as const, createdAt: at(i * 4 + 1),
    user: { id: `n${i}`, username: `newbie${i}`, name: null },
  }));
  const trades = Array.from({ length: 9 }, (_, i) => ({
    id: `t${i}`, kind: "trade" as const, createdAt: at(i * 3 + 0.5),
    species: [["Pikachu", "Eevee", "Gengar"][i % 3], ["Charmander", "Snorlax", "Abra"][i % 3]],
  }));
  const pvp = Array.from({ length: 4 }, (_, i) => ({
    id: `p${i}`, kind: "pvp" as const, createdAt: at(i * 6 + 2),
    winnerUserId: i % 3 === 0 ? null : "u1",
  }));
  return {
    online: Array.from({ length: 14 }, (_, i) => ({
      userId: `o${i}`,
      sessionCount: i === 2 ? 3 : i === 5 ? 2 : 1,
      user: {
        id: `o${i}`, username: pick(i), name: i % 3 === 0 ? null : pick(i),
        accountLevel: [3615, 87, 12, 611, 1119, 4, 902, 45][i % 8],
        lastSeenAt: new Date(now).toISOString(),
        pokedexCaughtCount: 84,
        isAdmin: i === 4,
        bannedUntil: i === 7 ? new Date(now + 86400000).toISOString() : null,
      },
    })),
    activity: { chat, signups, trades, pvp },
    counts: { chat: 214, signups: 6, trades: 9, pvp: 4 },
    caps: { chat: 50, signups: 20, trades: 20, pvp: 20 },
    windowMinutes: 30,
    serverTime: new Date(now).toISOString(),
  };
}

Object.assign(api, {
  analytics: async () => ANALYTICS,
  acquisition: async () => ACQUISITION,
  // `__failLiveOps = true` in the console makes every poll reject, which is
  // the only way to see the stale/disconnected states the page was rebuilt
  // for. Those states are unreachable from a mock that always succeeds, and
  // an error path nobody can look at is an error path nobody has checked.
  liveOps: async () => {
    if ((window as any).__failLiveOps) throw new Error("simulated: network unreachable");
    return liveOpsMock();
  },
  // The user detail page. Includes a save so the Pokémon/Items/Progress tabs
  // render rather than falling through to "hasn't started the game yet".
  getUser: async (id: string) => ({
    id, username: "koruem2", name: "Koruem", email: "koruem@example.com",
    accountLevel: 611, pokedexCaughtCount: 133, totalCaughtLevels: 20100,
    isAdmin: false, emailVerified: false,
    bannedUntil: new Date(Date.now() + 5 * 86400000).toISOString(),
    banReason: "Chat abuse — repeated slurs in Global",
    createdAt: new Date(Date.now() - 240 * 86400000).toISOString(),
    lastSeenAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    saveVersion: 812,
    _count: { friendsRequested: 4, friendsReceived: 7, messages: 1284 },
    saveData: JSON.stringify({
      money: 148_200, victoryTokens: 12,
      inventory: { "poke-ball": 42, "great-ball": 12, "master-ball": 1, "rare-candy": 7 },
      defeatedGyms: ["brock", "misty", "surge"],
      defeatedEliteFour: [], championDefeated: false,
      party: [
        { id: "m1", speciesKey: "pikachu", name: "Pikachu", level: 62, isShiny: true, maxHp: 180, currentHp: 180 },
        { id: "m2", speciesKey: "gengar", name: "Gengar", level: 58, isShiny: false, maxHp: 172, currentHp: 90 },
      ],
      box: [{ id: "m3", speciesKey: "eevee", name: "Eevee", level: 15, isShiny: false }],
    }),
  }),
  // Chat: a mix of ordinary messages, a system card, a long message, and one
  // person posting five in a row — the flood the bulk tools exist for.
  recentChat: async (_limit = 100, opts?: any) => {
    const now = Date.now();
    const mk = (i: number, over: Record<string, unknown> = {}) => ({
      id: `m${i}`,
      channelId: i % 7 === 0 ? "trade" : i % 5 === 0 ? "area:Viridian Forest" : "global",
      content: i % 6 === 0
        ? "does anyone want to trade a thunderstone? i have a spare shiny eevee and honestly i just want to finish the dex before the weekend"
        : `message ${i}`,
      createdAt: new Date(now - i * 47_000).toISOString(),
      user: { id: `u${i % 5}`, username: ["sak4i", "spammer", "koruem2", "phoenix", "newbie"][i % 5], name: null, isAdmin: i % 5 === 3, accountLevel: [3615, 4, 611, 87, 12][i % 5] },
      ...over,
    });
    const rows = [
      mk(0, { kind: "announcement", content: "Server maintenance at 22:00 UTC.", user: { id: "u3", username: "phoenix", name: "Phoenix", isAdmin: true, accountLevel: 87 } }),
      // Five in a row from one account — the sweep case.
      ...Array.from({ length: 5 }, (_, i) => mk(i + 1, {
        id: `spam${i}`, content: "FREE MASTER BALLS >> pokeidle-gift.example.com",
        user: { id: "u1", username: "spammer", name: null, isAdmin: false, accountLevel: 4 },
      })),
      ...Array.from({ length: 24 }, (_, i) => mk(i + 6)),
    ];
    const filtered = opts?.username
      ? rows.filter((r) => r.user.username.toLowerCase() === String(opts.username).toLowerCase())
      : opts?.q
        ? rows.filter((r) => r.content.toLowerCase().includes(String(opts.q).toLowerCase()))
        : rows;
    return {
      messages: filtered as any,
      channels: [
        { id: "global", count: 214 },
        { id: "trade", count: 41 },
        { id: "area:Viridian Forest", count: 18 },
        { id: "dm:abc", count: 6 },
      ],
    };
  },
  deleteChat: async () => ({ ok: true as const }),
  bulkDeleteChat: async (ids: string[]) => ({ ok: true as const, deleted: ids.length }),
  clearAllChat: async () => ({ ok: true as const, deleted: 279 }),

  // Bug reports: one of each status, one from Discord (no user agent, no
  // game state), and one with a long description.
  listBugReports: async (status = "") => {
    const all = [
      { id: "b1", status: "open", title: "Battle softlocks when the opponent faints on the same turn",
        reporterName: "sak4i", source: "game", page: "/battle",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131",
        description: "If both Pokemon faint on the same turn the battle screen stays on 'choosing move' forever and I have to reload. Happened three times today, always with Explosion.",
        context: JSON.stringify({ level: 3615, location: "Victory Road", party: 6 }) },
      { id: "b2", status: "open", title: "Shop prices reset after trading",
        reporterName: "koruem2", source: "discord", page: "https://discord.com/channels/1/2/3",
        userAgent: null, description: "prices go back to default after a trade completes", context: null },
      { id: "b3", status: "investigating", title: "Pokedex count off by one",
        reporterName: "phoenix", source: "game", page: "/pokedex",
        userAgent: "Mozilla/5.0 (Macintosh) Safari/17", description: "Says 84 but I count 85.",
        context: JSON.stringify({ caught: 84 }) },
      { id: "b4", status: "resolved", title: "Away rewards not claimable on mobile",
        reporterName: "newbie", source: "game", page: "/", userAgent: "Mozilla/5.0 (iPhone)",
        description: "Button did nothing.", context: null, adminNotes: "Fixed in 1.4.2 — the tap target was under the safe-area inset." },
      { id: "b5", status: "wontfix", title: "Add Gen 2",
        reporterName: "stratus_varius", source: "game", page: null, userAgent: null,
        description: "please", context: null },
    ].map((r, i) => ({
      ...r, reporterId: `u${i}`, adminNotes: (r as any).adminNotes ?? null,
      discordMessageId: r.source === "discord" ? "123" : null,
      createdAt: new Date(Date.now() - (i + 1) * 5 * 3600e3).toISOString(),
      updatedAt: new Date(Date.now() - (i + 1) * 3600e3).toISOString(),
    }));
    const rows = status ? all.filter((r) => r.status === status) : all;
    return {
      reports: rows as any,
      counts: { all: all.length, open: 2, investigating: 1, resolved: 1, wontfix: 1 },
    };
  },
  updateBugReport: async () => ({ ok: true as const }),

  listAudit: async () => ({
    entries: [
      { id: "a1", action: "user.ban", createdAt: new Date(Date.now() - 12 * 60e3).toISOString(),
        admin: { id: "u3", username: "phoenix" }, target: { id: "u1", username: "spammer" },
        meta: { until: "2026-08-09T00:00:00Z", reason: "Advertising" } },
      { id: "a2", action: "chat.bulkDelete", createdAt: new Date(Date.now() - 13 * 60e3).toISOString(),
        admin: { id: "u3", username: "phoenix" }, target: null,
        meta: { requested: 5, deleted: 5 } },
      { id: "a3", action: "user.promote", createdAt: new Date(Date.now() - 4 * 3600e3).toISOString(),
        admin: { id: "u9", username: "cnx" }, target: { id: "u2", username: "koruem2" }, meta: {} },
      { id: "a4", action: "chat.delete", createdAt: new Date(Date.now() - 26 * 3600e3).toISOString(),
        admin: { id: "u3", username: "phoenix" }, target: { id: "cm_9f2", username: "?" }, meta: null },
      { id: "a5", action: "user.save_patch", createdAt: new Date(Date.now() - 50 * 3600e3).toISOString(),
        admin: { id: "u9", username: "cnx" }, target: { id: "u0", username: "sak4i" },
        meta: { keys: ["inventory", "money"], saveVersion: 812 } },
    ] as any,
  }),

  // Errors: a repeating one (so the grouped view has something to group), a
  // client exception and a server crash.
  listErrors: async (kind = "") => {
    const mk = (i: number, k: "server" | "client", msg: string) => ({
      id: `e${i}`, kind: k, message: msg,
      stack: `Error: ${msg}\n    at applyChoice (pvp.ts:412:19)\n    at Socket.<anonymous> (socket.ts:1284:7)`,
      source: k === "server" ? "pvp.applyChoice" : "MiniChat.render",
      userId: i % 2 ? "u1" : null, username: i % 2 ? "sak4i" : null,
      url: k === "client" ? "https://pokeidle.com/battle" : null,
      userAgent: k === "client" ? "Mozilla/5.0 (Windows NT 10.0) Chrome/131" : null,
      meta: { battleId: `b_${i}` },
      createdAt: new Date(Date.now() - i * 11 * 60_000).toISOString(),
    });
    const all = [
      ...Array.from({ length: 6 }, (_, i) => mk(i, "server", "Push after end of read stream")),
      mk(6, "client", "Cannot read properties of undefined (reading 'speciesKey')"),
      mk(7, "server", "P2002 unique constraint failed on the fields: (`userId`,`day`)"),
    ];
    const rows = kind ? all.filter((e) => e.kind === kind) : all;
    return { total: 231, limit: 100, truncated: true, errors: rows as any };
  },
  listErrorGroups: async () => ({
    groups: [
      { fingerprint: "f1", kind: "server", message: "Push after end of read stream", count: 184,
        lastSeen: new Date(Date.now() - 60_000).toISOString(), firstSeen: new Date(Date.now() - 9 * 86400000).toISOString(), sampleId: "e0" },
      { fingerprint: "f2", kind: "client", message: "Cannot read properties of undefined (reading 'speciesKey')", count: 41,
        lastSeen: new Date(Date.now() - 26 * 60_000).toISOString(), firstSeen: new Date(Date.now() - 3 * 86400000).toISOString(), sampleId: "e6" },
      { fingerprint: "f3", kind: "server", message: "P2002 unique constraint failed", count: 6,
        lastSeen: new Date(Date.now() - 4 * 3600e3).toISOString(), firstSeen: new Date(Date.now() - 86400000).toISOString(), sampleId: "e7" },
    ] as any,
  }),

  // Rewards + broadcasts.
  // Shape matches AdminGiveaway. One drawn giveaway carries a winner whose
  // grant FAILED (claimedAt null) — the state the page has to render
  // differently from a clean payout, and the one a tidy mock never produces.
  listGiveawaysAdmin: async () => {
    const entry = (i: number, isWinner = false, claimed = true) => ({
      id: `e${i}`, userId: `u${i}`, username: `trainer${i}`, isWinner,
      claimedAt: isWinner && claimed ? new Date().toISOString() : null,
      prizeDelivered: isWinner && claimed && i % 2 === 0,
    });
    return {
      giveaways: [
        { id: "g1", title: "Launch week Master Ball", description: "One per trainer.",
          status: "open", winnerCount: 3, minAccountLevel: null, drawSeed: null,
          prizes: [{ kind: "item", itemId: "masterball", quantity: 1 }],
          prizeSummary: "1x Master Ball", entryCount: 12,
          entries: Array.from({ length: 12 }, (_, i) => entry(i)),
          createdAt: new Date(Date.now() - 2 * 86400000).toISOString(),
          startsAt: null, endsAt: null, drawnAt: null,
          announceToDiscord: true, discordChannelId: null, discordMessageId: "1" },
        { id: "g2", title: "Shiny Mew draw", description: "",
          status: "drawn", winnerCount: 2, minAccountLevel: 25, drawSeed: "a91f…",
          prizes: [{ kind: "pokemon", label: "Shiny Mew Lv50", mon: {} }],
          prizeSummary: "Shiny Mew Lv50", entryCount: 8,
          entries: [entry(0, true, true), entry(1, true, false), ...Array.from({ length: 6 }, (_, i) => entry(i + 2))],
          createdAt: new Date(Date.now() - 9 * 86400000).toISOString(),
          startsAt: null, endsAt: null, drawnAt: new Date(Date.now() - 8 * 86400000).toISOString(),
          announceToDiscord: false, discordChannelId: null, discordMessageId: null },
        { id: "g3", title: "Draft — weekend event", description: "",
          status: "draft", winnerCount: 5, minAccountLevel: null, drawSeed: null,
          prizes: [{ kind: "money", amount: 50000 }],
          prizeSummary: "50,000 money", entryCount: 0, entries: [],
          createdAt: new Date(Date.now() - 3600e3).toISOString(),
          startsAt: null, endsAt: null, drawnAt: null,
          announceToDiscord: false, discordChannelId: null, discordMessageId: null },
      ] as any,
    };
  },
  // Shape matches AdminPoll exactly: options are plain strings and each vote
  // is a row carrying optionIndex. Getting this wrong is not a harmless mock
  // detail — an options array of objects renders as "Objects are not valid as
  // a React child" and takes the whole page down.
  listPollsAdmin: async () => {
    const mkVotes = (counts: number[]) =>
      counts.flatMap((n, idx) =>
        Array.from({ length: n }, (_, k) => ({ userId: `u${idx}_${k}`, username: `voter${idx}_${k}`, optionIndex: idx })));
    const v1 = mkVotes([7, 4, 2]);
    const v2 = mkVotes([9, 1]);
    return {
      polls: [
        { id: "p1", question: "Which region should we add next?", status: "open",
          options: ["Johto", "Hoenn", "Sinnoh"], votes: v1, voteCount: v1.length,
          createdAt: new Date(Date.now() - 86400000).toISOString() },
        { id: "p2", question: "Keep 5x speed for everyone?", status: "closed",
          options: ["Yes", "No"], votes: v2, voteCount: v2.length,
          createdAt: new Date(Date.now() - 12 * 86400000).toISOString() },
      ] as any,
    };
  },
  listAnnouncements: async () => {
    const live = {
      id: "an1", type: "maintenance",
      message: "Server restart at 22:00 UTC — battles will be paused for ~5 minutes.",
      href: null, linkLabel: null,
      createdAt: new Date(Date.now() - 3600e3).toISOString(),
      expiresAt: new Date(Date.now() + 6 * 3600e3).toISOString(),
    };
    return {
      live: live as any,
      recent: [
        { ...live, active: true, startsAt: null },
        // Deliberately covers each of the three non-LIVE states rowStatus can
        // report: scheduled, expired, ended.
        { id: "an2", type: "event", message: "Double XP all weekend!", href: null, linkLabel: null,
          createdAt: new Date(Date.now() - 2 * 3600e3).toISOString(),
          startsAt: new Date(Date.now() + 24 * 3600e3).toISOString(), expiresAt: null, active: true },
        { id: "an3", type: "giveaway", message: "Master Ball giveaway is live", href: "/giveaways", linkLabel: "Enter",
          createdAt: new Date(Date.now() - 5 * 86400000).toISOString(),
          startsAt: null, expiresAt: new Date(Date.now() - 86400000).toISOString(), active: true },
        { id: "an4", type: "info", message: "Welcome to the beta.", href: null, linkLabel: null,
          createdAt: new Date(Date.now() - 30 * 86400000).toISOString(),
          startsAt: null, expiresAt: null, active: false },
      ] as any,
    };
  },

  // A live 8-player bracket covering every match state the card renders:
  // decided, in progress, ready, overdue, and waiting on an earlier round.
  // Plus a completed event with a champion and one still taking entries.
  listTournaments: async () => {
    const P = (seed: number, username: string) => ({ kind: "player", userId: `u${seed}`, username, seed });
    const names = ["sak4i", "stratus_varius", "koruem2", "phoenix", "tokyofuck", "newbie", "ash_k", "misty"];
    const soon = Date.now() + 5 * 3600e3;
    const past = Date.now() - 2 * 3600e3;
    const bracket = {
      rounds: [
        { index: 0, matches: [
          { id: "m1", a: P(1, names[0]), b: P(8, names[7]), winnerId: "u1", winBy: "battle", deadlineAt: past },
          { id: "m2", a: P(4, names[3]), b: P(5, names[4]), winnerId: "u5", winBy: "walkover", deadlineAt: past,
            note: "u4 never came online inside the window" },
          { id: "m3", a: P(2, names[1]), b: P(7, names[6]), battleId: "b_991", deadlineAt: soon },
          // Overdue and still unplayed — the row the triage strip exists for.
          { id: "m4", a: P(3, names[2]), b: P(6, names[5]), deadlineAt: past },
        ] },
        { index: 1, matches: [
          { id: "m5", a: P(1, names[0]), b: { kind: "winnerOf", matchId: "m2" }, deadlineAt: soon },
          { id: "m6", a: { kind: "winnerOf", matchId: "m3" }, b: { kind: "winnerOf", matchId: "m4" } },
        ] },
        { index: 2, matches: [
          { id: "m7", a: { kind: "winnerOf", matchId: "m5" }, b: { kind: "winnerOf", matchId: "m6" } },
        ] },
      ],
    };
    const entries = names.map((u, i) => ({
      id: `e${i}`, userId: `u${i + 1}`, username: u, seed: i + 1,
      ratingAtSeed: 1500 - i * 37, eliminated: i === 3 || i === 7,
    }));
    return {
      tournaments: [
        { id: "t1", name: "Launch Week Cup", format: "single-elimination", status: "live",
          levelCap: 50, roundWindowMinutes: 1440, autoRun: true, championUsername: null,
          createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
          entries, bracket: JSON.stringify(bracket) },
        { id: "t2", name: "Sign-ups open — Weekend Clash", format: "single-elimination", status: "open",
          levelCap: null, roundWindowMinutes: 720, autoRun: true, championUsername: null,
          createdAt: new Date(Date.now() - 3600e3).toISOString(),
          entries: entries.slice(0, 5).map((e) => ({ ...e, seed: null, ratingAtSeed: null, eliminated: false })),
          bracket: null },
        { id: "t3", name: "Beta Invitational", format: "single-elimination", status: "completed",
          levelCap: 100, roundWindowMinutes: 2880, autoRun: true, championUsername: "sak4i",
          createdAt: new Date(Date.now() - 21 * 86400000).toISOString(),
          entries, bracket: JSON.stringify(bracket) },
      ] as any,
    };
  },

  listSnapshots: async () => ({
    snapshots: [
      { id: "s1", saveVersion: 812, reason: "auto", createdAt: new Date(Date.now() - 3600e3).toISOString(),
        summary: { level: 611, badges: 3, caught: 133, money: 148200, bytes: 92_000 } },
      { id: "s2", saveVersion: 799, reason: "pre-restore", createdAt: new Date(Date.now() - 9 * 3600e3).toISOString(),
        summary: { level: 604, badges: 3, caught: 131, money: 121400, bytes: 90_100 } },
    ],
  }),
  me: async () => ({ id: "u1", username: "phoenix", isAdmin: true }),
  // Feeds both the command palette and the Users table. Deliberately awkward:
  // a very long display name, a very long email, a banned account, an admin,
  // and a level in the thousands next to one in single digits — the rows most
  // likely to break a column's width assumptions.
  listUsers: async (q: string, page = 0, pageSize = 25, opts?: any) => {
    const base = [
      { id: "1", username: "sak4i", name: "Sak4i", email: "sak4i@example.com", accountLevel: 3615, pokedexCaughtCount: 151, totalCaughtLevels: 184220, isAdmin: false, bannedUntil: null, banReason: null },
      { id: "2", username: "stratus_varius", name: "StratusVarius", email: "stratus.varius+pokeidle@some-very-long-mail-domain.example.com", accountLevel: 1119, pokedexCaughtCount: 148, totalCaughtLevels: 61044, isAdmin: false, bannedUntil: null, banReason: null },
      { id: "3", username: "averyverylongtrainername", name: "A Very Long Display Name That Should Truncate", email: "long@example.com", accountLevel: 902, pokedexCaughtCount: 141, totalCaughtLevels: 30871, isAdmin: false, bannedUntil: null, banReason: null },
      { id: "4", username: "koruem2", name: "Koruem", email: "koruem@example.com", accountLevel: 611, pokedexCaughtCount: 133, totalCaughtLevels: 20100, isAdmin: false, bannedUntil: new Date(Date.now() + 5 * 86400000).toISOString(), banReason: "Chat abuse" },
      { id: "5", username: "phoenix", name: "Phoenix", email: "phoenixvandale@gmail.com", accountLevel: 87, pokedexCaughtCount: 84, totalCaughtLevels: 8120, isAdmin: true, bannedUntil: null, banReason: null },
      { id: "6", username: "newbie", name: null, email: "newbie@example.com", accountLevel: 2, pokedexCaughtCount: 3, totalCaughtLevels: 14, isAdmin: false, bannedUntil: null, banReason: null },
    ].map((u, i) => ({
      ...u,
      createdAt: new Date(Date.now() - (i + 1) * 9 * 86400000).toISOString(),
      lastSeenAt: new Date(Date.now() - i * 1.7 * 86400000).toISOString(),
    }));
    const term = q.trim().toLowerCase();
    let rows = term
      ? base.filter((u) => u.username.includes(term) || u.email.includes(term) || (u.name ?? "").toLowerCase().includes(term))
      : base;
    if (opts?.filter === "banned") rows = rows.filter((u) => u.bannedUntil);
    if (opts?.filter === "admins") rows = rows.filter((u) => u.isAdmin);
    return {
      total: rows.length, page, pageSize,
      users: rows.slice(page * pageSize, (page + 1) * pageSize) as any,
      counts: {
        all: base.length,
        banned: base.filter((u) => u.bannedUntil).length,
        admins: base.filter((u) => u.isAdmin).length,
      },
    };
  },
});

// ── Harness chrome ──────────────────────────────────────────────────
// The real shell, so pages are judged inside the layout they ship in.

import { AnalyticsPage } from "./pages/AnalyticsPage";
import { LiveOpsPage } from "./pages/LiveOpsPage";
import { UsersPage } from "./pages/UsersPage";
import { ChatModerationPage } from "./pages/ChatModerationPage";
import { ReportsPage } from "./pages/ReportsPage";
import { RewardsPage } from "./pages/RewardsPage";
import { BroadcastsPage } from "./pages/BroadcastsPage";
import { TournamentsPage } from "./pages/TournamentsPage";
import { CommandPalette } from "./components/CommandPalette";
import { useScrollbarWidthVar } from "./useScrollbarWidth";

const PAGES: { key: string; label: string; render: () => JSX.Element }[] = [
  { key: "analytics", label: "Analytics", render: () => <AnalyticsPage /> },
  { key: "liveops",   label: "Live ops",  render: () => <LiveOpsPage /> },
  { key: "users",     label: "Users",     render: () => <UsersPage /> },
  { key: "chat",      label: "Chat",      render: () => <ChatModerationPage /> },
  { key: "bugs",      label: "Reports",   render: () => <ReportsPage tab="bugs" /> },
  { key: "errors",    label: "Errors",    render: () => <ReportsPage tab="errors" /> },
  { key: "audit",     label: "Audit",     render: () => <ReportsPage tab="audit" /> },
  { key: "giveaways", label: "Rewards",   render: () => <RewardsPage tab="giveaways" /> },
  { key: "massgift",  label: "Mass gift", render: () => <RewardsPage tab="massgift" /> },
  { key: "announce",  label: "Broadcasts",render: () => <BroadcastsPage tab="announcements" /> },
  { key: "polls",     label: "Polls",     render: () => <BroadcastsPage tab="polls" /> },
  { key: "tournaments", label: "Tournaments", render: () => <TournamentsPage /> },
];

function Harness() {
  // ?page=liveops picks one. The preview exists to be looked at, and clicking
  // through a nav to reach the page under review is friction on every reload.
  const initial = PAGES.find((p) => p.key === new URLSearchParams(location.search).get("page")) ?? PAGES[0];
  const [page, setPage] = useState(initial);
  useScrollbarWidthVar();
  return (
    <div className="admin-shell">
      <aside className="admin-sidebar" data-mobile-open="false">
        <div className="admin-brand">
          <svg className="admin-brand-mark" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="#6366f1" strokeWidth={2}>
            <circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><circle cx="12" cy="12" r="3" fill="#6366f1" />
          </svg>
          <span className="admin-brand-tag">Admin</span>
        </div>
        {/* Derived from PAGES, not hand-written. The hand-written version
            drifted the moment a page was added and left new pages
            unreachable in the harness — which is how a preview stops being
            used. */}
        <nav className="admin-nav">
          <div className="admin-nav-group">
            <span className="admin-nav-heading">Pages</span>
            {PAGES.map((pg) => (
              <button
                key={pg.key}
                className={`admin-nav-item ${page.key === pg.key ? "active" : ""}`}
                onClick={() => setPage(pg)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                  <path d="M3 3v18h18" /><path d="M7 14l3-3 3 3 5-5" />
                </svg>
                <span className="admin-nav-item-label">{pg.label}</span>
              </button>
            ))}
          </div>
        </nav>
        <div className="admin-foot">
          <span className="admin-me"><span className="admin-avatar">p</span><span className="admin-me-name">phoenix</span></span>
          <button className="admin-signout">Sign out</button>
        </div>
      </aside>
      <div className="admin-body">
        <header className="admin-topbar">
          <span className="topbar-crumb">{page.label}</span>
          {/* Same slots the real shell renders, so a page previewed here puts
              its chrome exactly where it will in the app. */}
          <span id="topbar-page-note" className="topbar-note" />
          <span className="topbar-spacer" />
          <div id="topbar-page-actions" className="topbar-page-actions" />
          <div className="topbar-actions">
            <CommandPalette
              pages={[
                { page: "analytics", label: "Analytics", group: "Overview" },
                { page: "liveops", label: "Live ops", group: "Overview" },
                { page: "users", label: "Users", group: "People" },
              ]}
              onGoPage={() => {}}
              onGoUser={() => {}}
            />
            {/* Matches the real bar, which now shows the environment chip
                only when it is NOT production. */}
            <span className="topbar-env">Preview</span>
          </div>
        </header>
        <main className="admin-main">{page.render()}</main>
      </div>
    </div>
  );
}

// The root is cached across hot reloads. Calling createRoot again on a
// container that already has one logs a React warning on EVERY edit, and a
// console full of warnings is a console where a real error goes unread —
// which defeats the point of a harness you check the console of.
const el = document.getElementById("root")!;
const g = window as unknown as { __previewRoot?: ReturnType<typeof createRoot> };
g.__previewRoot ??= createRoot(el);
g.__previewRoot.render(<StrictMode><Harness /></StrictMode>);
