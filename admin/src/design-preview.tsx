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
Object.assign(api, {
  analytics: async () => ANALYTICS,
  me: async () => ({ id: "u1", username: "phoenix", isAdmin: true }),
});

// ── Harness chrome ──────────────────────────────────────────────────
// The real shell, so pages are judged inside the layout they ship in.

import { AnalyticsPage } from "./pages/AnalyticsPage";

const PAGES: { key: string; label: string; render: () => JSX.Element }[] = [
  { key: "analytics", label: "Analytics", render: () => <AnalyticsPage /> },
];

function Harness() {
  const [page] = useState(PAGES[0]);
  return (
    <div className="admin-shell" data-collapsed="false">
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
          <button className="topbar-icon-btn topbar-rail-toggle" aria-label="Collapse sidebar">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg>
          </button>
          <span className="topbar-crumb">{page.label}</span>
          {/* Same slots the real shell renders, so a page previewed here puts
              its chrome exactly where it will in the app. */}
          <span id="topbar-page-note" className="topbar-note" />
          <span className="topbar-spacer" />
          <div id="topbar-page-actions" className="topbar-page-actions" />
          <div className="topbar-actions"><span className="topbar-env is-prod"><span>Preview</span></span></div>
        </header>
        <main className="admin-main">{page.render()}</main>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><Harness /></StrictMode>,
);
