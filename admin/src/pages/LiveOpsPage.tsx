import { useEffect, useMemo, useState } from "react";
import { api, type LiveOps, type LiveOpsActivityItem } from "../api";

type FeedFilter = "all" | "chat" | "signup" | "trade" | "pvp";

// Real-time operator view. Polls /api/admin/live-ops every 5s by
// default. Shows three panels:
//   1. KPI strip — online count, sessions, signups (30m), chat (30m)
//   2. Online users list (left)
//   3. Activity feed (right) — unified chat/signup/trade/PvP stream
export function LiveOpsPage() {
  const [data, setData] = useState<LiveOps | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [poll, setPoll] = useState(true);
  const [filter, setFilter] = useState<FeedFilter>("all");
  const [search, setSearch] = useState("");

  const load = (silent = false) => {
    api.liveOps()
      .then((d) => { setData(d); setErr(null); })
      .catch((e) => { if (!silent) setErr(e.message); });
  };

  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!poll) return;
    const t = setInterval(() => load(true), 5000);
    return () => clearInterval(t);
  }, [poll]);

  // Merge the four activity buckets into one chronological feed.
  const feed = useMemo(() => {
    if (!data) return [];
    const items: LiveOpsActivityItem[] = [
      ...data.activity.chat,
      ...data.activity.signups,
      ...data.activity.trades,
      ...data.activity.pvp,
    ];
    items.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    const f = filter === "all" ? items : items.filter((i) => i.kind === filter);
    if (!search) return f;
    const q = search.toLowerCase();
    return f.filter((i) =>
      (i.content ?? "").toLowerCase().includes(q)
      || (i.user?.username ?? "").toLowerCase().includes(q)
      || (i.user?.name ?? "").toLowerCase().includes(q)
    );
  }, [data, filter, search]);

  if (err) return <div className="page-err">Error: {err}</div>;
  if (!data) return <div className="page-loading">Loading live ops…</div>;

  const online = data.online.filter((u) => u.user);
  const totalSessions = data.online.reduce((sum, u) => sum + u.sessionCount, 0);
  const chat30 = data.activity.chat.length;
  const signups30 = data.activity.signups.length;
  const trades30 = data.activity.trades.length;
  const pvp30 = data.activity.pvp.length;

  return (
    <div className="page liveops-page">
      <header className="page-head">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16 }}>
          <div>
            <h1>Live ops</h1>
            <p className="dim">Real-time snapshot of connected players + last 30 minutes of activity.</p>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <span className={`liveops-status ${poll ? "on" : "off"}`}>
              <span className="liveops-status-dot" />
              {poll ? "Live · polling 5s" : "Paused"}
            </span>
            <button className="btn-ghost btn-small" onClick={() => setPoll((p) => !p)}>
              {poll ? "Pause" : "Resume"}
            </button>
          </div>
        </div>
      </header>

      {/* KPI strip */}
      <section className="analytics-grid liveops-kpi-row">
        <article className="kpi-card kpi-card--hero" style={{ gridColumn: "span 4" }}>
          <span className="kpi-label">Online now</span>
          <strong className="kpi-value kpi-value--xl">{online.length.toLocaleString()}</strong>
          <span className="kpi-sub">{totalSessions.toLocaleString()} session{totalSessions === 1 ? "" : "s"}</span>
        </article>
        <article className="kpi-card" style={{ gridColumn: "span 2" }}>
          <span className="kpi-label">Chat · 30m</span>
          <strong className="kpi-value">{chat30.toLocaleString()}</strong>
        </article>
        <article className="kpi-card" style={{ gridColumn: "span 2" }}>
          <span className="kpi-label">Signups · 30m</span>
          <strong className="kpi-value">{signups30.toLocaleString()}</strong>
        </article>
        <article className="kpi-card" style={{ gridColumn: "span 2" }}>
          <span className="kpi-label">Trades · 30m</span>
          <strong className="kpi-value">{trades30.toLocaleString()}</strong>
        </article>
        <article className="kpi-card" style={{ gridColumn: "span 2" }}>
          <span className="kpi-label">PvP · 30m</span>
          <strong className="kpi-value">{pvp30.toLocaleString()}</strong>
        </article>
      </section>

      <div className="liveops-grid">
        {/* Online users */}
        <section className="card liveops-online-card">
          <h2>Online users <span className="dim small">· {online.length}</span></h2>
          {online.length === 0
            ? <p className="dim small">Nobody is connected right now.</p>
            : (
              <ul className="liveops-online-list">
                {online.map((o) => o.user && (
                  <li key={o.userId} className="liveops-online-row">
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
                      {o.user.isAdmin && <span className="tag admin">ADMIN</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )
          }
        </section>

        {/* Activity feed */}
        <section className="card liveops-feed-card">
          <header className="liveops-feed-head">
            <h2>Activity feed <span className="dim small">· last 30 min</span></h2>
            <div className="seg-tabs">
              {(["all", "chat", "signup", "trade", "pvp"] as const).map((k) => (
                <button
                  key={k}
                  className={`seg-tab ${filter === k ? "active" : ""}`}
                  onClick={() => setFilter(k)}
                >
                  {k}
                </button>
              ))}
            </div>
          </header>
          <input
            className="search-input"
            placeholder="Search content or trainer…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ marginBottom: 10 }}
          />
          {feed.length === 0
            ? <p className="dim small">No activity matches your filters.</p>
            : (
              <ul className="liveops-feed">
                {feed.map((it) => (
                  <li key={`${it.kind}:${it.id}`} className="liveops-feed-row">
                    <span className={`liveops-feed-kind kind-${it.kind}`}>
                      {it.kind}
                    </span>
                    <span className="liveops-feed-body">
                      <FeedRowBody item={it} />
                    </span>
                    <span className="dim small liveops-feed-time">
                      {ageOf(it.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )
          }
        </section>
      </div>
    </div>
  );
}

function FeedRowBody({ item }: { item: LiveOpsActivityItem }) {
  if (item.kind === "chat") {
    return (
      <>
        <strong>@{item.user?.username}</strong>{" "}
        <span className="dim small">in {item.channelId === "global" ? "Global" : item.channelId?.startsWith("area:") ? item.channelId.slice(5) : "DM"}</span>
        <span className="liveops-feed-content">{item.content}</span>
      </>
    );
  }
  if (item.kind === "signup") {
    return (
      <>
        <strong>@{item.user?.username}</strong> joined the game.
      </>
    );
  }
  if (item.kind === "trade") {
    const [a, b] = item.species ?? [];
    return (
      <>Trade completed — {a ?? "?"} <span className="dim">↔</span> {b ?? "?"}</>
    );
  }
  if (item.kind === "pvp") {
    return <>PvP match ended {item.winnerUserId ? "with a winner" : "in a draw"}.</>;
  }
  return null;
}

function ageOf(iso: string): string {
  const sec = Math.max(0, Math.round((Date.now() - +new Date(iso)) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}
