// Dev-only harness for the welcome-back dialog.
//
// ── WHY ─────────────────────────────────────────────────────────────
// Reaching this screen for real requires a signed-in session, a save, an away
// period long enough to pay out, an unclaimed daily and a version bump since
// the player's last visit. That is not a loop anyone can iterate a layout in,
// and a dialog nobody can look at is a dialog nobody fixes.
//
// It mounts the REAL <WelcomeBackDialog/> with the real stylesheet — same JSX,
// same CSS, same conditionals. Only the stores and the network are replaced,
// which is exactly the split the component was refactored for.
//
// Never part of a production build: Vite only bundles entries reachable from
// index.html, and nothing in the app imports this.
//
//   cd game && npm run dev  →  http://localhost:5173/welcome-preview.html

import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { WelcomeBackDialog } from "./components/WelcomeBackModal";
import type { WelcomeBackData } from "./state/welcomeBack";
import type { Announcement, AwayProgress, DailyStatus, PublicGiveaway } from "./net/api";
import type { ChangelogEntry } from "./types";
import "./app.css";

const AWAY: AwayProgress = {
  minMs: 5 * 60_000,
  capMs: 8 * 3_600_000,
  awaySince: new Date(Date.now() - 11 * 3_600_000).toISOString(),
  elapsedMs: 11 * 3_600_000 + 14 * 60_000,
  creditedMs: 8 * 3_600_000,
  capped: true,
  moneyPerHour: 1_450,
  money: 11_600,
  claimable: true,
};

const DAILY: DailyStatus = {
  claimedToday: false,
  streak: 4,
  longestStreak: 12,
  streakIfClaimed: 5,
  todayReward: { label: "5,000 · 3× Great Ball", money: 5000, items: { "great-ball": 3 } } as any,
  nextClaimInMs: 0,
};

const NEWS: ChangelogEntry[] = [{
  version: "0.9.5",
  date: new Date().toISOString().slice(0, 10),
  subtitle: "Auctions",
  highlight: true,
  sections: [{
    heading: "New",
    items: [
      "Auction house — bid on other trainers' Pokémon with real proxy bidding.",
      "Away earnings now grow with every Gym Badge you hold.",
    ],
  }, {
    heading: "Fixed",
    items: [
      "Trades no longer reset shop prices.",
      "Battles could softlock when both Pokémon fainted on the same turn.",
    ],
  }],
}] as any;

const ANNOUNCE: Announcement = {
  id: "an1", type: "maintenance",
  message: "Server restart at 22:00 UTC — battles pause for about five minutes.",
  href: null, linkLabel: null,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 6 * 3_600_000).toISOString(),
};

const gw = (over: Partial<PublicGiveaway>): PublicGiveaway => ({
  id: "g1", title: "Master Ball Friday", description: "", status: "open",
  createdAt: new Date().toISOString(), startsAt: null,
  endsAt: new Date(Date.now() + 2 * 86400000).toISOString(), drawnAt: null,
  winnerCount: 3, minAccountLevel: null, prizes: [], prizeSummary: "1× Master Ball",
  entryCount: 412, hasEntered: false, youWon: false,
  ...over,
} as PublicGiveaway);

// Every combination worth looking at. The dialog's whole job is to hold a
// VARIABLE set of sections together — and to decide whether the second column
// exists at all — so a harness that only ever shows the full one proves
// nothing about the rest.
type Case = { name: string; data: WelcomeBackData; announcement?: Announcement | null; giveaways?: PublicGiveaway[] | null };
const CASES: Case[] = [
  { name: "Everything", data: { away: AWAY, daily: DAILY, news: NEWS, gifts: ["a Master Ball", "50,000"], returning: true },
    announcement: ANNOUNCE, giveaways: [gw({ youWon: true, status: "drawn", title: "Shiny Mew draw", prizeSummary: "Shiny Mew Lv50" }), gw({})] },
  { name: "Rewards only (1 col)", data: { away: AWAY, daily: DAILY, news: [], gifts: [], returning: true } },
  { name: "Won a giveaway", data: { away: null, daily: DAILY, news: [], gifts: [], returning: true },
    giveaways: [gw({ id: "g9", youWon: true, status: "drawn", title: "Shiny Mew draw", prizeSummary: "Shiny Mew Lv50" })] },
  { name: "Open giveaway", data: { away: AWAY, daily: null, news: [], gifts: [], returning: true }, giveaways: [gw({})] },
  { name: "Announcement", data: { away: null, daily: DAILY, news: [], gifts: [], returning: true }, announcement: ANNOUNCE },
  { name: "News only", data: { away: null, daily: null, news: NEWS, gifts: [], returning: true } },
  { name: "Away only", data: { away: AWAY, daily: null, news: [], gifts: [], returning: true } },
  { name: "Daily claimed", data: { away: null, daily: { ...DAILY, claimedToday: true, streak: 5, streakIfClaimed: 6, nextClaimInMs: 7 * 3_600_000 + 20 * 60_000 }, news: [], gifts: [], returning: true } },
  { name: "First visit", data: { away: null, daily: { ...DAILY, streak: 0, longestStreak: 0, streakIfClaimed: 1 }, news: [], gifts: [], returning: false } },
  { name: "Short away, day 7", data: { away: { ...AWAY, capped: false, elapsedMs: 47 * 60_000, money: 1_130 }, daily: { ...DAILY, streak: 6, streakIfClaimed: 7 }, news: [], gifts: [], returning: true } },
  { name: "Long name gift", data: { away: null, daily: null, news: [], gifts: ["3× Rare Candy, 2× Master Ball, 120,000 and a Shiny Charizard Lv100"], returning: true } },
];

function Harness() {
  const [i, setI] = useState(0);
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState(false);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg, #06070a)" }}>
      <div style={{
        position: "fixed", top: 0, left: 0, right: 0, zIndex: 500,
        display: "flex", gap: 6, flexWrap: "wrap", padding: 8,
        background: "rgba(0,0,0,0.75)", backdropFilter: "blur(6px)",
      }}>
        {CASES.map((c, idx) => (
          <button
            key={c.name}
            onClick={() => { setI(idx); setClosed(false); }}
            style={{
              padding: "5px 10px", fontSize: 12, borderRadius: 6, cursor: "pointer",
              border: "1px solid " + (i === idx ? "#fbbf24" : "rgba(255,255,255,0.14)"),
              background: i === idx ? "rgba(251,191,36,0.16)" : "transparent",
              color: i === idx ? "#fbbf24" : "#cbd5e1",
            }}
          >{c.name}</button>
        ))}
        <button
          onClick={() => setBusy((b) => !b)}
          style={{
            padding: "5px 10px", fontSize: 12, borderRadius: 6, cursor: "pointer",
            border: "1px solid rgba(255,255,255,0.14)", background: "transparent", color: "#cbd5e1",
          }}
        >{busy ? "busy: on" : "busy: off"}</button>
      </div>

      {closed
        ? <p style={{ paddingTop: 80, textAlign: "center", color: "#64748b" }}>
            Closed. Pick a case above to reopen.
          </p>
        : <WelcomeBackDialog
            key={i}
            data={CASES[i].data}
            announcement={CASES[i].announcement ?? null}
            giveaways={CASES[i].giveaways ?? null}
            busy={busy}
            onFinish={() => setClosed(true)}
            onClose={() => setClosed(true)}
            onOpenChangelog={() => setClosed(true)}
            onOpenGiveaway={() => setClosed(true)}
          />}
    </div>
  );
}

const el = document.getElementById("root")!;
const g = window as unknown as { __wbRoot?: ReturnType<typeof createRoot> };
g.__wbRoot ??= createRoot(el);
// ?strict=0 renders without StrictMode. The app itself uses StrictMode, and
// its double-invoked effects change how mount animations behave — being able
// to toggle it is how the invisible-dialog bug below was pinned down.
const strict = new URLSearchParams(location.search).get("strict") !== "0";
g.__wbRoot.render(strict ? <StrictMode><Harness /></StrictMode> : <Harness />);
