// Dev-only harness for the Rewards dialog.
//
// ── WHY ─────────────────────────────────────────────────────────────
// Seeing this screen in a state worth judging needs a signed-in session, a
// DiscordConfig row with linkRewardEnabled, a live giveaway, an archive behind
// it and — for the interesting half — an account that has and has not already
// collected the promo. That is not a loop anyone can iterate a layout in.
//
// It mounts the REAL <RewardsDialog/> with the real stylesheet: same JSX, same
// CSS, same conditionals. Only the store and the network are replaced, which
// is exactly the split GiveawayModal was refactored for.
//
// Never part of a production build: Vite only bundles entries reachable from
// index.html, and nothing in the app imports this.
//
//   cd game && npm run dev  →  http://localhost:5173/rewards-preview.html

import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { RewardsDialog } from "./components/GiveawayModal";
import type { GiveawayStats, Promo, PublicGiveaway } from "./net/api";
import "./app.css";

const H = 3_600_000;
const D = 86_400_000;
const now = Date.now();

const promo = (over: Partial<Promo> = {}): Promo => ({
  id: "discord-link",
  title: "Join the Discord",
  blurb: "Link your account to the community server and the reward is yours.",
  icon: "discord",
  prizes: [{ kind: "item", itemId: "masterball", quantity: 1 }],
  state: "available",
  cta: { label: "Get the code", href: "/link-discord" },
  note: null,
  ...over,
} as Promo);

// A second promo, because the ask was explicitly "some other free promotional
// rewards in there too" and a section that only ever renders one card proves
// nothing about how two of them sit together.
const SECOND = promo({
  id: "starter-pack",
  title: "New trainer pack",
  blurb: "A hand up for anyone still on their first badge.",
  icon: "gift",
  prizes: [
    { kind: "item", itemId: "rarecandy", quantity: 5 },
    { kind: "money", amount: 25_000 },
  ],
  cta: { label: "Collect", href: "/rewards" },
} as Partial<Promo>);

const gw = (over: Partial<PublicGiveaway> = {}): PublicGiveaway => ({
  id: "g1",
  title: "Master Ball Friday",
  description: "One Master Ball each, drawn on Friday night.",
  status: "open",
  createdAt: new Date(now - 2 * H).toISOString(),
  startsAt: null,
  endsAt: new Date(now + 2 * D).toISOString(),
  drawnAt: null,
  winnerCount: 3,
  minAccountLevel: null,
  prizes: [{ kind: "item", itemId: "masterball", quantity: 1 }],
  prizeSummary: "1x masterball",
  entryCount: 412,
  hasEntered: false,
  youWon: false,
  youWonDelivered: null,
  winners: [],
  drawSeed: null,
  ...over,
} as PublicGiveaway);

// Real production shapes: 12 winners on one row, three long usernames, a
// 272-character description, and rows with endsAt === null.
const past: PublicGiveaway[] = [
  gw({
    id: "h1", title: "Shiny Mew draw", status: "drawn",
    endsAt: new Date(now - 3 * H).toISOString(),
    drawnAt: new Date(now - 3 * H).toISOString(),
    prizes: [{ kind: "pokemon", speciesId: 151, level: 50, shiny: true } as any],
    winners: ["dudsdiem", "dwellbreathe", "lilkidkolaps63", "koruem", "naill"],
    youWon: true, youWonDelivered: false,
    drawSeed: "3f9a1c0e5b7d28461ba0",
  }),
  gw({
    id: "h2", title: "Bottle cap bundle", status: "drawn",
    endsAt: new Date(now - 2 * D).toISOString(),
    drawnAt: new Date(now - 2 * D).toISOString(),
    prizes: [
      { kind: "item", itemId: "goldbottlecap", quantity: 1 },
      { kind: "item", itemId: "silverbottlecap", quantity: 2 },
    ],
    winnerCount: 12, entryCount: 33, hasEntered: true,
    winners: ["koruem", "naill", "dudsdiem", "a", "b", "c", "d", "e", "f", "g", "h", "i"],
    drawSeed: "88c1e4d2f60a9b37",
  }),
  gw({
    id: "h3", title: "Weekend money drop", status: "closed",
    endsAt: new Date(now - 9 * D).toISOString(), drawnAt: null,
    prizes: [{ kind: "money", amount: 250_000 } as any],
    winners: [], entryCount: 9,
  }),
];

const stats: GiveawayStats = {
  total: 13,
  prizesAwarded: 68,
  distinctWinners: 39,
  firstAt: "2026-07-17T11:37:33.170Z",
  you: { entered: 8, won: 2 },
};

// Every combination worth looking at. The dialog's job is to hold a VARIABLE
// set of sections together, so a harness that only shows the full one proves
// nothing about the rest — and the two states that matter most for THIS change
// are "promo, nothing else" (the 38-hour idle stretch, which is when the free
// reward is the entire point of the screen) and "promo already collected".
type Case = {
  name: string;
  promos?: Promo[];
  live?: PublicGiveaway[];
  past?: PublicGiveaway[];
  loading?: boolean;
  error?: string;
  canLoadMore?: boolean;
};

const CASES: Case[] = [
  { name: "Everything", promos: [promo(), SECOND], live: [gw(), gw({ id: "g2", title: "Charizard raffle", hasEntered: true, endsAt: new Date(now + 40 * 60_000).toISOString() })], past, canLoadMore: true },
  { name: "Promo only (idle)", promos: [promo()], past: [] },
  { name: "Two promos, no giveaway", promos: [promo(), SECOND], past: [] },
  { name: "Promo collected", promos: [promo({ state: "claimed", cta: null, note: "Already collected — thanks for joining." })], past },
  { name: "Promo, linked already", promos: [promo({ note: "Your Discord is already linked, so this one has passed you by." })], past: [] },
  { name: "Giveaway only (no promo)", promos: [], live: [gw()], past },
  { name: "History only", promos: [], past, canLoadMore: true },
  { name: "Promo + history, none live", promos: [promo()], past },
  { name: "Completely empty", promos: [], past: [] },
  { name: "Loading", loading: true },
  { name: "Offline", error: "Couldn't load giveaways." },
];

function Harness() {
  const [i, setI] = useState(0);
  const [closed, setClosed] = useState(false);
  const [entering, setEntering] = useState<string | null>(null);
  const c = CASES[i];

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg, #06070a)" }}>
      <div style={{
        position: "fixed", top: 0, left: 0, right: 0, zIndex: 500,
        display: "flex", gap: 6, flexWrap: "wrap", padding: 8,
        background: "rgba(0,0,0,0.75)", backdropFilter: "blur(6px)",
      }}>
        {CASES.map((cc, idx) => (
          <button
            key={cc.name}
            onClick={() => { setI(idx); setClosed(false); }}
            style={{
              padding: "5px 10px", fontSize: 12, borderRadius: 6, cursor: "pointer",
              border: "1px solid " + (i === idx ? "#5eead4" : "rgba(255,255,255,0.14)"),
              background: i === idx ? "rgba(45,212,191,0.16)" : "transparent",
              color: i === idx ? "#5eead4" : "#cbd5e1",
            }}
          >{cc.name}</button>
        ))}
      </div>

      {closed
        ? <p style={{ paddingTop: 80, textAlign: "center", color: "#64748b" }}>
            Closed. Pick a case above to reopen.
          </p>
        : <RewardsDialog
            key={i}
            promos={c.promos ?? []}
            live={c.live ?? []}
            past={c.past ?? []}
            stats={stats}
            loading={!!c.loading}
            error={c.error ?? null}
            highlightId={null}
            entering={entering}
            onEnter={(g) => {
              setEntering(g.id);
              window.setTimeout(() => setEntering(null), 900);
            }}
            canLoadMore={!!c.canLoadMore}
            moreState="idle"
            viewerName="koruem"
            onLoadMore={() => {}}
            onClose={() => setClosed(true)}
          />}
    </div>
  );
}

const el = document.getElementById("root")!;
const g = window as unknown as { __rwRoot?: ReturnType<typeof createRoot> };
g.__rwRoot ??= createRoot(el);
const strict = new URLSearchParams(location.search).get("strict") !== "0";
g.__rwRoot.render(strict ? <StrictMode><Harness /></StrictMode> : <Harness />);
