import { useEffect, useMemo, useRef, useState } from "react";
import { api, type LiveOps, type LiveOpsActivityItem } from "../api";
import { navigateTo } from "../App";
import { PageActions, PageNote } from "../components/PageChrome";
import { Kpi, SectionHead } from "../components/Section";

// The operator's "what is happening right now" page.
//
// ── THE PROBLEM THIS REBUILD FIXES ──────────────────────────────────
// The old page had two defects that mattered more than its layout:
//
//   1. It reported the LENGTH of the activity lists as its headline numbers.
//      Those lists are capped server-side (50 chat, 20 each of the rest), so
//      a busy half hour read as exactly "50" — pinned to the cap and
//      indistinguishable from a quiet one. An incident looked smaller than
//      it was, which is the worst direction for a monitoring page to be
//      wrong in. The server now returns true counts; the lists are labelled
//      as the recent sample they always were.
//
//   2. Polling failures were swallowed (`load(true)` discarded the error).
//      A page showing twenty-minute-old numbers under a green "Live ·
//      polling 5s" chip is worse than a page showing an error — the operator
//      concludes nothing is happening. Failures are now counted and the
//      status chip degrades: live → stale → disconnected, with the age of
//      the data on it.
//
// ── ON THE PULSE CHART ──────────────────────────────────────────────
// Built only over the span the sample actually covers. When a list is at its
// cap, everything older than its oldest returned row is missing, so charting
// the full 30 minutes would draw a cliff that looks like the game went quiet.
// The chart states its own span instead.

type FeedKind = "chat" | "signup" | "trade" | "pvp";
type FeedFilter = "all" | FeedKind;

const KIND_COLOR: Record<FeedKind, string> = {
  chat:   "#34d399",
  signup: "#818cf8",
  trade:  "#2dd4bf",
  pvp:    "#fbbf24",
};

const POLL_OPTIONS = [
  { ms: 3000,  label: "3s" },
  { ms: 5000,  label: "5s" },
  { ms: 15000, label: "15s" },
  { ms: 60000, label: "1m" },
];

/** After this many consecutive failed polls the page stops claiming to be
 *  live. Two rather than one: a single dropped request during a deploy is
 *  normal and self-heals before anyone could read a warning about it. */
const STALE_AFTER_FAILURES = 2;

export function LiveOpsPage() {
  const [data, setData] = useState<LiveOps | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [poll, setPoll] = useState(true);
  const [pollMs, setPollMs] = useState(5000);
  const [filter, setFilter] = useState<FeedFilter>("all");
  const [search, setSearch] = useState("");
  const [onlineSearch, setOnlineSearch] = useState("");

  // Freshness tracking. `lastOk` is when the data on screen arrived, NOT when
  // we last tried — the difference is the whole point.
  const [lastOk, setLastOk] = useState<number | null>(null);
  const [failures, setFailures] = useState(0);

  // A ticking clock so "42s ago" is true while you are looking at it. Without
  // it, every relative time on the page freezes the moment polling pauses or
  // fails — exactly when the age matters most.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const load = (silent = false) => {
    api.liveOps()
      .then((d) => { setData(d); setErr(null); setFailures(0); setLastOk(Date.now()); })
      .catch((e) => {
        setFailures((f) => f + 1);
        // The first load has nothing to fall back on, so it shows the error
        // outright. Later failures keep the last good data on screen and let
        // the status chip carry the bad news.
        if (!silent) setErr(e.message);
      });
  };

  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!poll) return;
    const t = setInterval(() => load(true), pollMs);
    return () => clearInterval(t);
  }, [poll, pollMs]);

  const dataAge = lastOk === null ? null : Date.now() - lastOk;
  const status: "live" | "paused" | "stale" | "down" =
    !poll ? "paused"
    : failures >= STALE_AFTER_FAILURES * 3 ? "down"
    : failures >= STALE_AFTER_FAILURES ? "stale"
    : "live";

  // Merge the four buckets into one chronological feed.
  const allItems = useMemo(() => {
    if (!data) return [];
    const items: LiveOpsActivityItem[] = [
      ...data.activity.chat,
      ...data.activity.signups,
      ...data.activity.trades,
      ...data.activity.pvp,
    ];
    return items.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  }, [data]);

  const feed = useMemo(() => {
    const f = filter === "all" ? allItems : allItems.filter((i) => i.kind === filter);
    const q = search.trim().toLowerCase();
    if (!q) return f;
    return f.filter((i) =>
      (i.content ?? "").toLowerCase().includes(q)
      || (i.user?.username ?? "").toLowerCase().includes(q)
      || (i.user?.name ?? "").toLowerCase().includes(q));
  }, [allItems, filter, search]);

  // How far back the sample is COMPLETE. A list sitting at its cap is the top
  // of a longer list, so nothing before its oldest row is on screen; the true
  // coverage starts at the newest such boundary.
  const coverage = useMemo(() => {
    if (!data) return { since: null as number | null, truncated: false };
    let since: number | null = null;
    let truncated = false;
    const check = (list: LiveOpsActivityItem[], cap: number) => {
      if (list.length < cap) return;
      truncated = true;
      const oldest = +new Date(list[list.length - 1].createdAt);
      if (since === null || oldest > since) since = oldest;
    };
    check(data.activity.chat, data.caps.chat);
    check(data.activity.signups, data.caps.signups);
    check(data.activity.trades, data.caps.trades);
    check(data.activity.pvp, data.caps.pvp);
    return { since, truncated };
  }, [data]);

  if (err && !data) return <div className="page-err">Error: {err}</div>;
  if (!data) return <div className="page-loading">Loading live ops…</div>;

  const online = data.online.filter((u) => u.user);
  const totalSessions = data.online.reduce((sum, u) => sum + u.sessionCount, 0);
  const multiSession = online.filter((o) => o.sessionCount > 1).length;
  const win = data.windowMinutes;
  const c = data.counts;

  const onlineFiltered = (() => {
    const q = onlineSearch.trim().toLowerCase();
    if (!q) return online;
    return online.filter((o) =>
      o.user!.username.toLowerCase().includes(q)
      || (o.user!.name ?? "").toLowerCase().includes(q));
  })();

  const kindCounts: Record<FeedFilter, number> = {
    all: allItems.length,
    chat: data.activity.chat.length,
    signup: data.activity.signups.length,
    trade: data.activity.trades.length,
    pvp: data.activity.pvp.length,
  };

  return (
    <div className="page liveops-page">
      <PageNote>
        Connected players and the last {win} minutes of activity.
      </PageNote>
      <PageActions>
        <LiveStatus status={status} ageMs={dataAge} />
        <div className="seg-toggle liveops-poll" role="group" aria-label="Poll interval">
          {POLL_OPTIONS.map((o) => (
            <button
              key={o.ms}
              className={`seg-tab ${pollMs === o.ms ? "active" : ""}`}
              onClick={() => setPollMs(o.ms)}
              title={`Refresh every ${o.label}`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <button className="btn-secondary btn-small" onClick={() => setPoll((p) => !p)}>
          {poll ? "Pause" : "Resume"}
        </button>
      </PageActions>

      {/* A failing poll is not a footnote. It sits above everything, because
          every number below it is older than it looks. */}
      {(status === "stale" || status === "down") && (
        <div className="liveops-alert" role="status">
          <strong>{status === "down" ? "Not refreshing." : "Refresh failing."}</strong>{" "}
          {failures} consecutive attempt{failures === 1 ? "" : "s"} failed
          {dataAge !== null && <> — everything below is {formatAge(dataAge)} old</>}.
          {err && <span className="dim"> ({err})</span>}
          <button className="btn-ghost btn-tiny" onClick={() => load()}>Retry now</button>
        </div>
      )}

      <SectionHead
        title="Right now"
        blurb="Live connection state, straight from the socket server."
      />

      <section className="kpi-strip">
        <Kpi
          label="Online now" accent
          value={online.length.toLocaleString()}
          sub={`${totalSessions.toLocaleString()} session${totalSessions === 1 ? "" : "s"}`}
          hint="Distinct accounts with at least one open socket. Sessions counts tabs and devices, so it is always ≥ players."
        />
        <Kpi
          label="Multi-session"
          value={multiSession.toLocaleString()}
          sub={multiSession > 0 ? "players on 2+ clients" : "none"}
          hint="Players connected from more than one tab or device. Usually benign; occasionally the first sign of a shared or automated account."
        />
        <Kpi label={`Chat · ${win}m`}    value={c.chat.toLocaleString()} />
        <Kpi label={`Signups · ${win}m`} value={c.signups.toLocaleString()}
             onClick={() => navigateTo("users")} hint="Open Users" />
        <Kpi label={`Trades · ${win}m`}  value={c.trades.toLocaleString()} />
        <Kpi label={`PvP · ${win}m`}     value={c.pvp.toLocaleString()} />
      </section>

      <SectionHead
        title={`Last ${win} minutes`}
        blurb="Activity across chat, signups, trades and PvP."
      />

      <PulseChart items={allItems} since={coverage.since} windowMinutes={win} truncated={coverage.truncated} />

      <div className="liveops-grid">
        {/* ── Online ──────────────────────────────────────────────── */}
        <section className="card liveops-online-card">
          <header className="card-head">
            <div>
              <h2>Online users</h2>
              <p>{online.length.toLocaleString()} connected{onlineSearch && ` · ${onlineFiltered.length} matching`}</p>
            </div>
          </header>
          <input
            className="search-input"
            placeholder="Filter by trainer…"
            value={onlineSearch}
            onChange={(e) => setOnlineSearch(e.target.value)}
          />
          {onlineFiltered.length === 0 ? (
            <p className="dim small liveops-empty">
              {online.length === 0 ? "Nobody is connected right now." : "No connected player matches that."}
            </p>
          ) : (
            <ul className="liveops-online-list">
              {onlineFiltered.map((o) => o.user && (
                // Click-through to the player: the online list is where an
                // operator spots trouble live, and a name with no route to
                // the ban button means re-finding them by hand.
                <li key={o.userId}>
                  <button
                    className="liveops-online-row"
                    title={`Open ${o.user.username} in Users`}
                    onClick={() => navigateTo("users", { userId: o.userId })}
                  >
                    <span className="liveops-online-dot" />
                    <span className="liveops-online-name">
                      <strong>{o.user.name ?? o.user.username}</strong>
                      <span className="dim small">@{o.user.username}</span>
                    </span>
                    <span className="liveops-online-meta">
                      <span className="tabular dim">Lv{o.user.accountLevel}</span>
                      {o.sessionCount > 1 && (
                        <span className="liveops-session-badge" title={`${o.sessionCount} concurrent sessions`}>
                          {o.sessionCount}×
                        </span>
                      )}
                      {o.user.bannedUntil && new Date(o.user.bannedUntil) > new Date() && (
                        <span className="tag tag-bad">BANNED</span>
                      )}
                      {o.user.isAdmin && <span className="tag tag-brand">ADMIN</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── Feed ────────────────────────────────────────────────── */}
        <section className="card liveops-feed-card">
          <header className="card-head">
            <div>
              <h2>Activity feed</h2>
              <p>
                {coverage.truncated
                  ? <>Most recent {allItems.length} events — the window holds more.</>
                  : <>Everything in the last {win} minutes.</>}
              </p>
            </div>
            <div className="seg-toggle" role="tablist" aria-label="Filter feed">
              {(["all", "chat", "signup", "trade", "pvp"] as const).map((k) => (
                <button
                  key={k}
                  role="tab"
                  aria-selected={filter === k}
                  className={`seg-tab ${filter === k ? "active" : ""}`}
                  onClick={() => setFilter(k)}
                >
                  {k === "all" ? "All" : k[0].toUpperCase() + k.slice(1)}
                  <span className="seg-tab__n">{kindCounts[k]}</span>
                </button>
              ))}
            </div>
          </header>
          <input
            className="search-input"
            placeholder="Search message text or trainer…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {feed.length === 0 ? (
            <p className="dim small liveops-empty">
              {allItems.length === 0 ? `Nothing happened in the last ${win} minutes.` : "No activity matches your filters."}
            </p>
          ) : (
            <ul className="liveops-feed">
              {feed.map((it) => (
                <li key={`${it.kind}:${it.id}`} className="liveops-feed-row">
                  <span className={`liveops-feed-kind kind-${it.kind}`}>{it.kind}</span>
                  <span className="liveops-feed-body"><FeedRowBody item={it} /></span>
                  <time className="dim small liveops-feed-time" dateTime={it.createdAt}
                        title={new Date(it.createdAt).toLocaleString()}>
                    {formatAge(Date.now() - +new Date(it.createdAt))}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * The freshness chip.
 *
 * Four states, not two. "Live" has to mean live, so it is only shown when a
 * poll has actually succeeded recently — the previous version printed "Live ·
 * polling 5s" purely because polling was switched on, which stayed green
 * through an outage.
 */
function LiveStatus({ status, ageMs }: { status: "live" | "paused" | "stale" | "down"; ageMs: number | null }) {
  const text =
    status === "live"   ? (ageMs !== null && ageMs > 2000 ? `Live · ${formatAge(ageMs)}` : "Live")
    : status === "paused" ? "Paused"
    : status === "stale"  ? `Stale · ${ageMs !== null ? formatAge(ageMs) : "?"}`
    : "Disconnected";
  return (
    <span className={`liveops-status is-${status}`} title={
      status === "paused" ? "Auto-refresh is off." : "Age of the data on screen."
    }>
      <span className="liveops-status-dot" />
      {text}
    </span>
  );
}

/**
 * Events per minute, stacked by kind.
 *
 * ── WHY THE UNCOVERED MINUTES ARE DRAWN, NOT DROPPED ────────────────
 * The activity lists are capped, so during a busy period the oldest minutes
 * are simply absent from the payload. There were two wrong ways to handle
 * that and one right one:
 *
 *   Draw them as zero — a cliff that reads as "the game went quiet", the
 *   exact opposite of what happened (the cliff means it got BUSY).
 *
 *   Shrink the chart to the covered span — honest, but the axis silently
 *   rescales between polls, so the same chart means a different span each
 *   time you glance at it, and a 12-bar chart across a full-width card
 *   renders as a row of fat blocks.
 *
 *   Keep the axis fixed at the full window and hatch the part the sample
 *   cannot reach. The span is stable, the shape is comparable between
 *   refreshes, and "we don't have this" is visually distinct from "nothing
 *   happened here".
 */
function PulseChart({ items, since, windowMinutes, truncated }: {
  items: LiveOpsActivityItem[];
  since: number | null;
  windowMinutes: number;
  truncated: boolean;
}) {
  const { bins, max, coveredFrom } = useMemo(() => {
    const now = Date.now();
    const mins = windowMinutes;
    const bins = Array.from({ length: mins }, () => ({ chat: 0, signup: 0, trade: 0, pvp: 0, total: 0 }));
    for (const it of items) {
      const age = now - +new Date(it.createdAt);
      // Bin 0 is the OLDEST minute, so the chart reads left-to-right as time.
      const idx = mins - 1 - Math.floor(age / 60_000);
      if (idx < 0 || idx >= mins) continue;
      bins[idx][it.kind as FeedKind] += 1;
      bins[idx].total += 1;
    }
    // First bin the sample actually covers. Without truncation that is bin 0.
    const coveredFrom = since === null ? 0
      : Math.max(0, Math.min(mins - 1, mins - 1 - Math.floor((now - since) / 60_000)));
    return { bins, max: Math.max(1, ...bins.map((b) => b.total)), coveredFrom };
  }, [items, since, windowMinutes]);

  const busiest = bins.reduce((a, b) => (b.total > a.total ? b : a), bins[0]);
  const coveredMins = windowMinutes - coveredFrom;

  return (
    <article className="card liveops-pulse">
      <header className="card-head">
        <div>
          <h2>Activity pulse</h2>
          <p>
            Events per minute · peak {busiest?.total ?? 0}/min
            {truncated && <> · hatched minutes are older than the capped sample reaches ({coveredMins}m of {windowMinutes}m covered)</>}
          </p>
        </div>
        <div className="liveops-pulse__key">
          {(Object.keys(KIND_COLOR) as FeedKind[]).map((k) => (
            <span key={k}><i style={{ background: KIND_COLOR[k] }} />{k}</span>
          ))}
        </div>
      </header>
      <div className="liveops-pulse__bars" role="img"
           aria-label={`Peak ${busiest?.total ?? 0} events in a minute over the last ${coveredMins} of ${windowMinutes} minutes`}>
        {bins.map((b, i) => {
          const uncovered = i < coveredFrom;
          const agoMins = windowMinutes - 1 - i;
          return (
            <div
              className={`liveops-pulse__bar${uncovered ? " is-uncovered" : ""}`}
              key={i}
              title={uncovered
                ? `${agoMins}m ago · not in the sample (the feed is capped)`
                : `${agoMins}m ago · ${b.total} event${b.total === 1 ? "" : "s"}` +
                  (b.total ? ` (${(["chat", "signup", "trade", "pvp"] as FeedKind[])
                    .filter((k) => b[k] > 0).map((k) => `${b[k]} ${k}`).join(", ")})` : "")}
            >
              {/* An empty covered minute still renders a baseline tick. A gap
                  in the row is ambiguous — it reads as "no bar drawn here"
                  rather than "nothing happened in this minute". */}
              {uncovered ? null
                : b.total === 0
                  ? <span className="liveops-pulse__zero" />
                  : (["chat", "signup", "trade", "pvp"] as FeedKind[]).map((k) => b[k] > 0 && (
                      <span key={k} style={{ height: `${(b[k] / max) * 100}%`, background: KIND_COLOR[k] }} />
                    ))}
            </div>
          );
        })}
      </div>
      <div className="liveops-pulse__axis dim small">
        <span>{windowMinutes}m ago</span>
        <span>now</span>
      </div>
    </article>
  );
}

function FeedRowBody({ item }: { item: LiveOpsActivityItem }) {
  if (item.kind === "chat") {
    const where = item.channelId === "global" ? "Global"
      : item.channelId?.startsWith("area:") ? item.channelId.slice(5)
      : "DM";
    return (
      <>
        <strong>@{item.user?.username}</strong>{" "}
        <span className="dim small">in {where}</span>
        <span className="liveops-feed-content">{item.content}</span>
      </>
    );
  }
  if (item.kind === "signup") {
    return <><strong>@{item.user?.username}</strong> joined the game.</>;
  }
  if (item.kind === "trade") {
    const [a, b] = item.species ?? [];
    return <>Trade completed — {a ?? "?"} <span className="dim">↔</span> {b ?? "?"}</>;
  }
  if (item.kind === "pvp") {
    return <>PvP match ended {item.winnerUserId ? "with a winner" : "in a draw"}.</>;
  }
  return null;
}

function formatAge(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}
