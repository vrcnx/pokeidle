import { useEffect, useMemo, useState } from "react";
import { api, type Analytics } from "../api";

// Live snapshot of the Pokémon Idle game economy + community. Six
// KPI rows (24 stats) headline the page, followed by four time-series
// charts (signups, DAU, PvP matches, trades), a level histogram, and
// two leaderboards. All charts share the same hand-rolled SVG
// renderer below — no chart library.
export function AnalyticsPage() {
  const [data, setData] = useState<Analytics | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<number | null>(null);

  const load = () => {
    api.analytics()
      .then((d) => { setData(d); setErr(null); setLastFetched(Date.now()); })
      .catch((e) => setErr(e.message));
  };
  useEffect(() => { load(); }, []);

  if (err) return <div className="page-err">Error: {err}</div>;
  if (!data) return <div className="page-loading">Loading analytics…</div>;

  // Series helpers — reshape each {date → count} object into ordered
  // [days[], counts[]] tuples for the chart renderer.
  const series = (s: Record<string, number>): { days: string[]; counts: number[] } => {
    const days = Object.keys(s).sort();
    return { days, counts: days.map((d) => s[d]) };
  };
  const sign = series(data.signupSeries);
  const dau  = series(data.dauSeries);
  const pvp  = series(data.pvpSeries);
  const trd  = series(data.tradeSeries);

  const totalSignups7d = sign.counts.slice(-7).reduce((a, b) => a + b, 0);
  const peakDau7d = Math.max(...dau.counts.slice(-7), 0);

  return (
    <div className="page">
      <header className="page-head">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16 }}>
          <div>
            <h1>Analytics</h1>
            <p className="dim">Live snapshot of player activity, engagement, and the in-game economy.</p>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            {lastFetched && (
              <span className="dim small">
                Updated {formatRelative(lastFetched)}
              </span>
            )}
            <button className="btn-secondary btn-small" onClick={load} title="Re-fetch analytics">
              Refresh
            </button>
          </div>
        </div>
      </header>

      {/* PEOPLE */}
      <SectionLabel>People</SectionLabel>
      <div className="kpi-grid">
        <Kpi label="Total players"   value={data.totals.users.toLocaleString()} />
        <Kpi label="Active today"    value={data.activity.activeDay.toLocaleString()}   sub={`${data.activity.activeWeek.toLocaleString()} this week`} />
        <Kpi label="Active 30d"      value={data.activity.activeMonth.toLocaleString()} />
        <Kpi label="Signups (7d)"    value={data.activity.signups7d.toLocaleString()}   sub={`${data.activity.signups30d.toLocaleString()} this month`} />
        <Kpi label="Friendships"     value={data.totals.friendships.toLocaleString()} />
        <Kpi label="Banned"          value={data.totals.bannedUsers.toLocaleString()}   sub={data.totals.bannedUsers === 0 ? "All clear" : undefined} />
      </div>

      {/* ENGAGEMENT */}
      <SectionLabel>Engagement</SectionLabel>
      <div className="kpi-grid">
        <Kpi label="Chat (all-time)" value={data.totals.chatMessagesTotal.toLocaleString()} sub={`${data.totals.chatMessages7d.toLocaleString()} in 7d`} />
        <Kpi label="PvP matches"     value={data.totals.pvpMatchesTotal.toLocaleString()}   sub={`${data.totals.pvpMatches7d.toLocaleString()} in 7d`} />
        <Kpi label="Trades"          value={data.totals.tradesTotal.toLocaleString()}       sub={`${data.totals.trades7d.toLocaleString()} in 7d`} />
        <Kpi label="Avg Lv"          value={data.averages.accountLevel.toString()}          sub="Account level" />
        <Kpi label="Avg Pokédex"     value={`${data.averages.pokedexCaught} / 151`} />
        <Kpi label="Σ caught"        value={data.totals.pokemonCaughtSum.toLocaleString()}  sub="Across all players" />
      </div>

      {/* PLATFORM HEALTH */}
      <SectionLabel>Platform health</SectionLabel>
      <div className="kpi-grid">
        <Kpi label="Admins"        value={data.totals.admins.toLocaleString()} />
        <Kpi label="Open bugs"     value={data.totals.bugReportsOpen.toLocaleString()}  sub={data.totals.bugReportsOpen === 0 ? "Empty queue" : undefined} />
        <Kpi label="Errors (24h)"  value={data.totals.errorsLast24h.toLocaleString()}   sub={data.totals.errorsLast24h === 0 ? "Quiet" : undefined} />
        <Kpi label="Σ Pokémon Lv"  value={data.totals.pokemonLevelsSum.toLocaleString()} sub="Total levels caught" />
      </div>

      {/* CHARTS */}
      <SectionLabel>Trends · 30 days</SectionLabel>
      <div className="chart-grid">
        <section className="card chart-card">
          <h2>Signups <span className="dim small">· {totalSignups7d} in 7d</span></h2>
          <LineChart days={sign.days} counts={sign.counts} color="#6366f1" />
        </section>
        <section className="card chart-card">
          <h2>Daily active <span className="dim small">· peak {peakDau7d} this week</span></h2>
          <LineChart days={dau.days} counts={dau.counts} color="#34d399" />
        </section>
        <section className="card chart-card">
          <h2>PvP matches <span className="dim small">· {data.totals.pvpMatches7d} in 7d</span></h2>
          <LineChart days={pvp.days} counts={pvp.counts} color="#fbbf24" />
        </section>
        <section className="card chart-card">
          <h2>Trades completed <span className="dim small">· {data.totals.trades7d} in 7d</span></h2>
          <LineChart days={trd.days} counts={trd.counts} color="#f472b6" />
        </section>
      </div>

      <section className="card">
        <h2>Account-level distribution</h2>
        <Histogram buckets={data.levelBuckets ?? []} />
      </section>

      <div className="chart-grid">
        <section className="card chart-card">
          <h2>Top 10 · Pokédex completion</h2>
          <table className="leaderboard">
            <thead>
              <tr><th style={{ width: 36 }}>#</th><th>Trainer</th><th style={{ width: 80, textAlign: "right" }}>Lv</th><th style={{ width: 96, textAlign: "right" }}>Caught</th></tr>
            </thead>
            <tbody>
              {data.leaderboards.pokedex.map((u, i) => (
                <tr key={u.id}>
                  <td className="dim tabular">{i + 1}</td>
                  <td><strong>{u.name ?? u.username}</strong> <span className="dim">@{u.username}</span></td>
                  <td className="tabular" style={{ textAlign: "right" }}>{u.accountLevel}</td>
                  <td className="tabular" style={{ textAlign: "right" }}>{u.pokedexCaughtCount}<span className="dim"> / 151</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="card chart-card">
          <h2>Top 10 · Σ Pokémon levels</h2>
          <table className="leaderboard">
            <thead>
              <tr><th style={{ width: 36 }}>#</th><th>Trainer</th><th style={{ width: 80, textAlign: "right" }}>Lv</th><th style={{ width: 96, textAlign: "right" }}>Σ Lv</th></tr>
            </thead>
            <tbody>
              {data.leaderboards.sigmaLevels.map((u, i) => (
                <tr key={u.id}>
                  <td className="dim tabular">{i + 1}</td>
                  <td><strong>{u.name ?? u.username}</strong> <span className="dim">@{u.username}</span></td>
                  <td className="tabular" style={{ textAlign: "right" }}>{u.accountLevel}</td>
                  <td className="tabular" style={{ textAlign: "right" }}>{u.totalCaughtLevels.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

// ─── Section label ────────────────────────────────────────────────────
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 style={{
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: "0.9px",
      textTransform: "uppercase",
      color: "var(--text-muted)",
      margin: "20px 4px 12px",
    }}>
      {children}
    </h2>
  );
}

// ─── KPI tile ─────────────────────────────────────────────────────────
function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="kpi">
      <span className="kpi-label">{label}</span>
      <strong className="kpi-value">{value}</strong>
      {sub && <span className="kpi-sub">{sub}</span>}
    </div>
  );
}

// ─── Hand-rolled SVG line chart ───────────────────────────────────────
function LineChart({ days, counts, color }: { days: string[]; counts: number[]; color: string }) {
  const W = 600;
  const H = 160;
  const PAD_L = 32;
  const PAD_R = 8;
  const PAD_T = 10;
  const PAD_B = 22;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const max = Math.max(1, ...counts);
  const points = useMemo(() =>
    counts.map((c, i) => {
      const x = PAD_L + (counts.length === 1 ? 0 : (i / (counts.length - 1)) * innerW);
      const y = PAD_T + innerH - (c / max) * innerH;
      return { x, y, c, day: days[i] };
    }),
    [days, counts, innerW, innerH, max],
  );
  const linePath = points.length === 0
    ? ""
    : "M " + points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L ");
  const areaPath = points.length === 0
    ? ""
    : `${linePath} L ${points[points.length - 1].x.toFixed(1)},${PAD_T + innerH} L ${points[0].x.toFixed(1)},${PAD_T + innerH} Z`;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
    y: PAD_T + innerH - t * innerH,
    label: Math.round(t * max).toString(),
  }));

  // Replace # with safe id segment for SVG <linearGradient>.
  const gradId = `grad-${color.replace(/[^a-z0-9]/gi, "")}`;
  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" preserveAspectRatio="none">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD_L} y1={t.y} x2={W - PAD_R} y2={t.y} stroke="rgba(255,255,255,0.05)" strokeWidth={1} />
            <text x={PAD_L - 6} y={t.y + 3} textAnchor="end" className="chart-axis">{t.label}</text>
          </g>
        ))}
        <path d={areaPath} fill={`url(#${gradId})`} />
        <path d={linePath} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={2.5} fill={color} className="chart-dot">
            <title>{`${p.day}: ${p.c}`}</title>
          </circle>
        ))}
        {points.length > 0 && (
          <>
            <text x={points[0].x} y={H - 6} textAnchor="start" className="chart-axis">{shortDate(points[0].day)}</text>
            <text x={(points[0].x + points[points.length - 1].x) / 2} y={H - 6} textAnchor="middle" className="chart-axis">
              {shortDate(points[Math.floor(points.length / 2)].day)}
            </text>
            <text x={points[points.length - 1].x} y={H - 6} textAnchor="end" className="chart-axis">{shortDate(points[points.length - 1].day)}</text>
          </>
        )}
      </svg>
    </div>
  );
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatRelative(ts: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
}

// ─── Histogram ────────────────────────────────────────────────────────
function Histogram({ buckets }: { buckets: { label: string; count: number }[] }) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <div className="histogram">
      {buckets.map((b) => (
        <div className="histogram-col" key={b.label}>
          <div className="histogram-bar-wrap">
            <div
              className="histogram-bar"
              style={{ height: `${(b.count / max) * 100}%` }}
              title={`${b.label}: ${b.count}`}
            />
            <span className="histogram-count">{b.count}</span>
          </div>
          <span className="histogram-label">{b.label}</span>
        </div>
      ))}
      {buckets.length === 0 && <span className="dim small">No data.</span>}
    </div>
  );
}
