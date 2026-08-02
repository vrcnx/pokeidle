// Dev-only harness for the Hub frame and the Rewards pane.
//
// ── WHY ─────────────────────────────────────────────────────────────
// The hub is only interesting in the states that are hardest to reach: a
// pending friend request AND an uncollected reward AND a Battle section
// disabled mid-fight, all at once. Nobody can produce that combination on
// demand in a real session, which means without this page the frame would
// only ever be looked at in its easiest state.
//
// It mounts the REAL <HubFrame/> and the REAL <RewardsPane/> with the real
// stylesheets — same JSX, same CSS, same conditionals. Only the data and the
// three heavier sections are replaced: Social, Battle and Settings each need
// a signed-in session, a socket and a save, and standing in for them here is
// enough to prove the FRAME holds them. Their own contents are their own
// components' business.
//
// The lesson from controls-preview: a harness that renders something simpler
// than the app renders certifies the wrong thing. So the stand-ins are sized
// like the real panes — a tall scrolling body, a full-height chat layout —
// rather than a paragraph of lorem.
//
// Never part of a production build: Vite only bundles entries reachable from
// index.html, and nothing in the app imports this.
//
//   cd game && npm run dev  →  http://localhost:5173/hub-preview.html

import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { HubFrame, type HubSection, type HubSectionContent } from "./components/HubModal";
import { RewardsPane } from "./components/GiveawayModal";
import { TierTrack } from "./components/PvpHubModal";
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
  title: "Master Ball Giveaway",
  description: "10 winners, one Master Ball each. Entries close in 24 hours.",
  status: "open",
  createdAt: new Date(now - 2 * H).toISOString(),
  startsAt: null,
  endsAt: new Date(now + D).toISOString(),
  drawnAt: null,
  winnerCount: 10,
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

// Real production shapes: 12 winners on one row, three long usernames, rows
// with endsAt === null.
const past: PublicGiveaway[] = [
  gw({
    id: "h1", title: "Shiny Mew draw", status: "drawn",
    endsAt: new Date(now - 3 * H).toISOString(),
    drawnAt: new Date(now - 3 * H).toISOString(),
    prizes: [{ kind: "item", itemId: "masterball", quantity: 1 }],
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
  total: 16,
  prizesAwarded: 86,
  distinctWinners: 48,
  firstAt: "2026-07-17T11:37:33.170Z",
  you: { entered: 1, won: 1 },
};

/** A stand-in sized like the pane it replaces, so the frame is exercised
 *  against realistic content rather than a sentence. */
function Filler({ label, rows = 14 }: { label: string; rows?: number }) {
  return (
    <>
      <div className="hub-views">
        <div className="g-tabs" role="tablist">
          <button className="g-tab active">{label}</button>
          <button className="g-tab">Second view</button>
          <button className="g-tab">Third view</button>
        </div>
      </div>
      {/* On the frame's column system, like a real pane — a stand-in that
          renders one column would certify a layout the app never uses. */}
      <div className="hub-cols">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} style={{
            padding: "14px 16px", borderRadius: 10, background: "var(--panel-2)",
            fontSize: 12, color: "var(--text-muted)",
          }}>
            {label} card {i + 1}
          </div>
        ))}
      </div>
    </>
  );
}

/** Chat's shape: a full-height column whose middle scrolls and whose
 *  composer is pinned. This is the case `fill` exists for. */
function ChatFiller() {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div className="hub-views">
        <div className="g-tabs" role="tablist">
          <button className="g-tab active">Chat</button>
          <button className="g-tab">Friends</button>
          <button className="g-tab">Trainers</button>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 16px", display: "flex", flexDirection: "column", gap: 6 }}>
        {Array.from({ length: 40 }, (_, i) => (
          <p key={i} style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
            <strong style={{ color: "var(--text)" }}>trainer{i % 7}</strong> message {i + 1}
          </p>
        ))}
      </div>
      <div style={{ flex: "0 0 auto", display: "flex", gap: 8, padding: 12, borderTop: "1px solid var(--border)" }}>
        <input style={{ flex: 1 }} placeholder="Message Global…" />
        <button className="g-btn-primary g-btn-small">Send</button>
      </div>
    </div>
  );
}

type Case = {
  name: string;
  promos: Promo[];
  live: PublicGiveaway[];
  past: PublicGiveaway[];
  badges?: Partial<Record<HubSection, number>>;
  disabled?: Partial<Record<HubSection, string>>;
  start?: HubSection;
  /** Renders the REAL team builder in the Battle slot, so its two columns
   *  and its search box are exercised rather than assumed. */
  builder?: boolean;
};

const CASES: Case[] = [
  { name: "Everything waiting", promos: [promo(), SECOND], live: [gw(), gw({ id: "g2", title: "Evolution Stone Bundle", hasEntered: true, endsAt: new Date(now + 40 * 60_000).toISOString() })], past, badges: { rewards: 2, social: 3 }, start: "rewards" },
  { name: "Battle (default)", promos: [promo()], live: [gw()], past, badges: { rewards: 1 }, start: "pvp" },
  { name: "Battle disabled", promos: [], live: [], past, disabled: { pvp: "You're already in a PvP battle" }, badges: { social: 1 }, start: "social" },
  { name: "Social (fill)", promos: [], live: [], past, badges: { social: 12 }, start: "social" },
  { name: "Settings", promos: [], live: [], past, start: "settings" },
  { name: "Rewards — nothing free", promos: [], live: [], past: [], start: "rewards" },
  { name: "Rewards — long archive", promos: [promo({ state: "claimed", cta: null, note: "Already collected — thanks for joining." })], live: [], past: [...past, ...past.map((p, i) => ({ ...p, id: `x${i}` })), ...past.map((p, i) => ({ ...p, id: `y${i}` }))], start: "rewards" },
  { name: "Team builder", promos: [], live: [], past: [], start: "pvp", builder: true },
  { name: "Big badge (99+)", promos: [promo()], live: [gw()], past, badges: { social: 128, rewards: 1 }, start: "rewards" },
];

function Harness() {
  const [i, setI] = useState(0);
  const c = CASES[i];
  const [active, setActive] = useState<HubSection>(c.start ?? "pvp");
  const [closed, setClosed] = useState(false);
  const [entering, setEntering] = useState<string | null>(null);

  const sections: Record<HubSection, HubSectionContent> = {
    pvp: c.builder ? {
      Body: () => (
        <div className="pvp-hub-pane pvp-hub-pane--editing">
          <header className="pvp2-edit-head">
            <button className="g-btn-ghost g-btn-small">{"←"} Back to Battle</button>
            <h3>Your battle team</h3>
          </header>
          {/* The builder's real markup, not the real component: it calls
              useGame() and this harness has no GameProvider. What changed
              here is the LAYOUT — two columns that fill the pane and scroll
              their own lists — so the class names are what need exercising. */}
          <div className="tb-pane">
            <div className="tb-body">
              <p className="dim small team-builder-cap">
                Levels in this match are capped to <strong>Lv 50</strong>. Your saved Pokémon are unchanged.
              </p>
              <div className="tb-cols">
                <section className="g-card team-builder-strip">
                  <h3>Your team <span className="dim small">(4/6)</span></h3>
                  <ol className="team-builder-strip-list">
                    {(["Blastoise","Darkrai","Arcanine","Deoxys",null,null] as (string|null)[]).map((n,i) => (
                      n ? (
                        <li key={n} className="team-builder-strip-item">
                          <span className="team-builder-slot">{i + 1}</span>
                          <div className="team-builder-strip-info">
                            <strong>{n}</strong>
                            <small className="dim">Lv 100 <span className="tb-capped">{"→"} 50</span></small>
                          </div>
                          <div className="team-builder-strip-actions">
                            <button className="g-btn-ghost g-btn-tiny">{"↑"}</button>
                            <button className="g-btn-ghost g-btn-tiny">{"↓"}</button>
                            <button className="g-btn-ghost g-btn-tiny">{"×"}</button>
                          </div>
                        </li>
                      ) : (
                        <li key={`e${i}`} className="team-builder-strip-item is-empty">
                          <span className="team-builder-slot">{i + 1}</span>
                          <span className="tb-slot-hint">Empty</span>
                        </li>
                      )
                    ))}
                  </ol>
                </section>
                <section className="g-card team-builder-pool">
                  <div className="tb-pool-head">
                    <h3>Pick from your party + box</h3>
                    <input type="search" className="tb-search" placeholder="Search 48 Pokémon" />
                  </div>
                  <div className="team-builder-pool-grid">
                    {Array.from({ length: 24 }, (_, i) => (
                      <button key={i} className={`team-builder-pool-card ${i < 6 ? "selected" : ""}`}>
                        <strong>Pokémon {i + 1}</strong>
                        <small className="dim">Lv {100 - i} · {i < 6 ? "party" : "box"}</small>
                      </button>
                    ))}
                  </div>
                </section>
              </div>
            </div>
            <footer className="tb-foot">
              <button className="g-btn-ghost">Cancel</button>
              <span className="tb-foot-spacer" />
              <button className="g-btn-primary">Confirm team</button>
            </footer>
          </div>
        </div>
      ),
    } : {
      // The REAL tier track, on the REAL split — the two things the Battle
      // rebuild actually added. A stand-in that skipped them would certify a
      // pane that no longer exists.
      Body: () => (
        <div className="pvp-hub-pane">
          <div className="hub-split pvp2-body">
            <section className="pvp2-arena">
            {/* Full width, like the real card. At `flex: 1` inside a narrow
                wrapper the tier bands rendered 17px each, which would have
                certified a track nobody could read. */}
            <article className="pvp-hero-trainer-card" style={{ padding: 16, display: "block", width: "100%" }}>
              {/* The real card's shape and the real production numbers:
                  rating 984, 0W 0L, one forfeit. */}
              <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                <div className="pvp2-name-row">
                  <strong className="pvp2-name">phoenix</strong>
                  <span className="pvp2-tier-chip" style={{ color: "#b07a48", boxShadow: "inset 0 0 0 1px #b07a4855" }}>BRONZE</span>
                </div>
                <div className="pvp2-rating-block">
                  <strong className="pvp2-rating" style={{ color: "#b07a48" }}>984</strong>
                  <span className="pvp2-rating-label">Rating</span>
                  <span className="pvp2-rating-peak">peak <strong>1000</strong></span>
                </div>
                <p className="pvp2-record">
                  <span className="pvp2-rec-w"><strong>0</strong>W</span>
                  <span className="pvp2-rec-l"><strong>0</strong>L</span>
                  <span className="pvp2-rec-f"><strong>1</strong>FF</span>
                </p>
                <TierTrack rating={984} unranked={false} />
              </div>
            </article>

              {/* Ranked and Practice only — Casual is gone, and Tournament
                  appears only when one is running. */}
              <div className="pvp2-modes" role="tablist">
                <button className="pvp2-mode is-active">
                  <span className="pvp2-mode-icon">{"⚔"}</span>
                  <span className="pvp2-mode-text">
                    <span className="pvp2-mode-name">Ranked</span>
                    <span className="pvp2-mode-note">Rated {"·"} Lv 50 {"·"} counts</span>
                  </span>
                </button>
                <button className="pvp2-mode">
                  <span className="pvp2-mode-icon">{"◎"}</span>
                  <span className="pvp2-mode-text">
                    <span className="pvp2-mode-name">Practice</span>
                    <span className="pvp2-mode-note">Versus AI {"·"} never rated</span>
                  </span>
                </button>
              </div>
              <div className="pvp2-arena-core">
              <div className="pvp-slab-wrap">
                <button className="pvp-slab">
                  <span className="pvp-slab-title">READY UP</span>
                  <span className="pvp-slab-sub">Ranked · Lv 50</span>
                </button>
                <p className="pvp-stake">
                  <span className="pvp-stake-win">+16</span><span className="dim">if you win</span>
                  <span className="pvp-stake-sep">·</span>
                  <span className="pvp-stake-loss">−16</span><span className="dim">if you lose</span>
                </p>
              </div>
              </div>
              <button className="pvp2-team">
                <span className="pvp2-team-head">
                  <span className="pvp2-team-title">YOUR TEAM</span>
                  <span className="pvp2-team-count">6/6 {"·"} capped at Lv 50</span>
                  <span className="pvp2-team-edit">Edit</span>
                </span>
                <span className="pvp2-team-row">
                  {Array.from({ length: 6 }, (_, i) => (
                    <span key={i} className={`pvp2-slot ${i < 5 ? "filled" : "empty"}`}>
                      {i < 5 ? <span className="pvp2-slot-lv">50</span> : <span className="pvp2-slot-dot" />}
                    </span>
                  ))}
                </span>
              </button>
            </section>
            <aside className="pvp2-side">
              <div className="pvp2-panel">
                <header className="pvp2-panel-head"><h4>LADDER</h4><span className="dim small">4 rated</span></header>
                <ul className="pvp2-podium-list">
                  {[["#1","koruem",1016],["#2","naill",1016],["#3","fabio",984]].map(([r,n,v]) => (
                    <li key={n as string} className="pvp2-podium-row">
                      <span className="pvp2-podium-rank">{r}</span>
                      <strong className="pvp2-podium-name">{n}</strong>
                      <span className="pvp2-podium-rating tabular">{v}</span>
                    </li>
                  ))}
                  <li className="pvp2-podium-row pvp2-podium-you">
                    <span className="pvp2-podium-rank">#4</span>
                    <strong className="pvp2-podium-name">phoenix</strong>
                    <span className="pvp2-podium-rating tabular">984</span>
                  </li>
                </ul>
              </div>
              <div className="pvp2-panel">
                <header className="pvp2-panel-head">
                  <h4>RECENT MATCHES</h4><span className="dim small">1W 2L</span>
                </header>
                {/* The real row markup — a panel rendering pips would certify
                    a list the app no longer has. */}
                <ul className="pvp2-match-list">
                  {([
                    ["win", "koruem", "3h ago", ""],
                    ["loss", "gustavokletke", "1d ago", "timed out"],
                    ["forfeit", "naill", "2d ago", "forfeit"],
                    ["draw", "lax22", "Jul 28", "tie"],
                  ] as Array<[string, string, string, string]>).map(([res, opp, when, why]) => (
                    <li key={opp}>
                      <button className={`pvp2-match pvp2-match--${res}`}>
                        <span className={`pvp2-match-mark pvp2-match-mark--${res}`}>
                          {res === "win" ? "W" : res === "loss" ? "L" : res === "draw" ? "D" : "F"}
                        </span>
                        <span className="pvp2-match-who">
                          <span className="pvp2-match-opp">{opp}</span>
                          <span className="pvp2-match-meta">{when}{why ? ` · ${why}` : ""}</span>
                        </span>
                        <span className="pvp2-match-play">▶</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </aside>
          </div>
          <section className="pvp-tour" style={{ display: "none" }}>
            <header className="pvp2-panel-head">
              <span className="pvp-tour-icon">🏆</span>
              <h4>TOURNAMENTS</h4>
            </header>
            <p className="dim small pvp2-empty">
              No tournament scheduled. They are bracketed events with their own prizes —
              announced in global chat when one opens.
            </p>
          </section>
        </div>
      ),
      HeaderRight: () => <span className="pvp2-elo-chip">34 matches</span>,
      note: "Ranked ladder, casual matches and tournaments.",
    },
    rewards: {
      Body: () => (
        <RewardsPane
          promos={c.promos}
          live={c.live}
          past={c.past}
          stats={stats}
          loading={false}
          error={null}
          highlightId={null}
          entering={entering}
          onEnter={(g) => { setEntering(g.id); window.setTimeout(() => setEntering(null), 900); }}
          canLoadMore={c.past.length > 3}
          moreState="idle"
          onLoadMore={() => {}}
          viewerName="koruem"
        />
      ),
      HeaderRight: () => (
        <span className="rw-record">
          <span className="rw-record-fig is-gold"><strong>{stats.you.won}</strong>win</span>
          <span className="rw-record-fig"><strong>{stats.you.entered}</strong>entry</span>
        </span>
      ),
      },
    social: { Body: ChatFiller, fill: true },
    settings: { Body: () => <Filler label="Stats" rows={20} />, note: "Your account, your game, and the knobs." },
  };

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
            onClick={() => { setI(idx); setActive(cc.start ?? "pvp"); setClosed(false); }}
            style={{
              padding: "5px 10px", fontSize: 12, borderRadius: 6, cursor: "pointer",
              border: "1px solid " + (i === idx ? "#fbbf24" : "rgba(255,255,255,0.14)"),
              background: i === idx ? "rgba(251,191,36,0.16)" : "transparent",
              color: i === idx ? "#fbbf24" : "#cbd5e1",
            }}
          >{cc.name}</button>
        ))}
      </div>

      {closed
        ? <p style={{ paddingTop: 80, textAlign: "center", color: "#64748b" }}>
            Closed. Pick a case above to reopen.
          </p>
        : <HubFrame
            key={i}
            identity={
              <div className="hub-me">
                <span className="hub-me-avatar">K</span>
                <span className="hub-me-text">
                  <span className="hub-me-name">koruem</span>
                  <span className="hub-me-meta">
                    <span>Lv <strong>514</strong></span>
                    <span className="is-gold">$129,010,829</span>
                  </span>
                </span>
              </div>
            }
            active={active}
            onSelect={setActive}
            onClose={() => setClosed(true)}
            sections={sections}
            disabled={c.disabled}
            badges={c.badges}
            title="Hub"
          />}
    </div>
  );
}

const el = document.getElementById("root")!;
const g = window as unknown as { __hubRoot?: ReturnType<typeof createRoot> };
g.__hubRoot ??= createRoot(el);
const strict = new URLSearchParams(location.search).get("strict") !== "0";
g.__hubRoot.render(strict ? <StrictMode><Harness /></StrictMode> : <Harness />);
