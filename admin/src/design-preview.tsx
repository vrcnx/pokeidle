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

Object.assign(api, {
  analytics: async () => ANALYTICS,
  acquisition: async () => ACQUISITION,
  me: async () => ({ id: "u1", username: "phoenix", isAdmin: true }),
  // Enough for the command palette to render its player rows, including a
  // banned one — the row that carries an extra hint and is the easiest to
  // overflow.
  listUsers: async (q: string) => {
    const all = [
      { id: "1", username: "sak4i", accountLevel: 3615, bannedUntil: null },
      { id: "2", username: "stratus_varius", accountLevel: 1119, bannedUntil: null },
      { id: "3", username: "averyverylongtrainernamethatwraps", accountLevel: 902, bannedUntil: null },
      { id: "4", username: "koruem2", accountLevel: 611, bannedUntil: new Date().toISOString() },
    ].filter((u) => u.username.includes(q.toLowerCase()));
    return { total: all.length, page: 0, pageSize: 6, users: all as any };
  },
});

// ── Harness chrome ──────────────────────────────────────────────────
// The real shell, so pages are judged inside the layout they ship in.

import { AnalyticsPage } from "./pages/AnalyticsPage";
import { CommandPalette } from "./components/CommandPalette";
import { useScrollbarWidthVar } from "./useScrollbarWidth";

const PAGES: { key: string; label: string; render: () => JSX.Element }[] = [
  { key: "analytics", label: "Analytics", render: () => <AnalyticsPage /> },
];

function Harness() {
  const [page] = useState(PAGES[0]);
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
            <button className="admin-nav-item active">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M3 3v18h18" /><path d="M7 14l3-3 3 3 5-5" /></svg>
              <span className="admin-nav-item-label">Analytics</span>
            </button>
            <button className="admin-nav-item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M3 12h4l3 8 4-16 3 8h4" /></svg>
              <span className="admin-nav-item-label">Live ops</span>
            </button>
          </div>
          <div className="admin-nav-group">
            <span className="admin-nav-heading">People</span>
            <button className="admin-nav-item">
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

createRoot(document.getElementById("root")!).render(
  <StrictMode><Harness /></StrictMode>,
);
