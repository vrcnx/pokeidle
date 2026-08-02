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
import { CommandPalette } from "./components/CommandPalette";
import { useScrollbarWidthVar } from "./useScrollbarWidth";

const PAGES: { key: string; label: string; render: () => JSX.Element }[] = [
  { key: "analytics", label: "Analytics", render: () => <AnalyticsPage /> },
  { key: "liveops",   label: "Live ops",  render: () => <LiveOpsPage /> },
  { key: "users",     label: "Users",     render: () => <UsersPage /> },
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
        <nav className="admin-nav">
          <div className="admin-nav-group">
            <span className="admin-nav-heading">Overview</span>
            <button className={`admin-nav-item ${page.key === "analytics" ? "active" : ""}`} onClick={() => setPage(PAGES[0])}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M3 3v18h18" /><path d="M7 14l3-3 3 3 5-5" /></svg>
              <span className="admin-nav-item-label">Analytics</span>
            </button>
            <button className={`admin-nav-item ${page.key === "liveops" ? "active" : ""}`} onClick={() => setPage(PAGES[1])}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M3 12h4l3 8 4-16 3 8h4" /></svg>
              <span className="admin-nav-item-label">Live ops</span>
            </button>
          </div>
          <div className="admin-nav-group">
            <span className="admin-nav-heading">People</span>
            <button className={`admin-nav-item ${page.key === "users" ? "active" : ""}`} onClick={() => setPage(PAGES[2])}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0112 0" /></svg>
              <span className="admin-nav-item-label">Users</span>
            </button>
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
            <span className="topbar-env is-prod"><span>Preview</span></span>
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
