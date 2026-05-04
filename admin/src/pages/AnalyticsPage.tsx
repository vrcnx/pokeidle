import { useEffect, useMemo, useState } from "react";
import { api, type Analytics } from "../api";

// Live snapshot of player activity. Built on hand-rolled SVG charts
// (no chart library) — keeps the bundle small and the visual style
// consistent with the rest of the dashboard. Three charts:
//   1. Daily signups (last 30d) — shows growth over time
//   2. Daily active users (last 30d) — overlays activity on top
//   3. Account-level distribution histogram — shows progression spread
export function AnalyticsPage() {
  const [data, setData] = useState<Analytics | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.analytics().then(setData).catch((e) => setErr(e.message));
  }, []);

  if (err) return <div className="page-err">Error: {err}</div>;
  if (!data) return <div className="page-loading">Loading analytics…</div>;

  // Reshape series into ordered arrays for the line-chart helpers.
  const signupDays = Object.keys(data.signupSeries).sort();
  const signupCounts = signupDays.map((d) => data.signupSeries[d]);
  const dauDays = Object.keys(data.dauSeries ?? {}).sort();
  const dauCounts = dauDays.map((d) => (data.dauSeries ?? {})[d]);
  const totalSignups7d = signupCounts.slice(-7).reduce((a, b) => a + b, 0);
  const totalDau7d = Math.max(...dauCounts.slice(-7), 0);

  return (
    <div className="page">
      <header className="page-head">
        <h1>Analytics</h1>
        <p className="dim">Live snapshot of player activity and engagement.</p>
      </header>

      <div className="kpi-grid">
        <Kpi label="Total players" value={data.totals.users.toLocaleString()} />
        <Kpi label="Active today" value={data.activity.activeDay.toLocaleString()} sub={`${data.activity.activeWeek} this week`} />
        <Kpi label="Active 30d" value={data.activity.activeMonth.toLocaleString()} />
        <Kpi label="Signups (7d)" value={data.activity.signups7d.toLocaleString()} sub={`${totalSignups7d} from chart`} />
        <Kpi label="Friendships" value={data.totals.friendships.toLocaleString()} />
        <Kpi label="Chat messages" value={data.totals.chatMessagesTotal.toLocaleString()} sub={`${data.totals.chatMessages7d} in 7d`} />
        <Kpi label="Banned" value={data.totals.bannedUsers.toLocaleString()} />
        <Kpi label="Admins" value={data.totals.admins.toLocaleString()} />
      </div>

      <div className="chart-grid">
        <section className="card chart-card">
          <h2>Signups · 30 days</h2>
          <LineChart days={signupDays} counts={signupCounts} color="#60a5fa" />
        </section>
        <section className="card chart-card">
          <h2>Daily active · 30 days <span className="dim small">(peak {totalDau7d})</span></h2>
          <LineChart days={dauDays} counts={dauCounts} color="#34d399" />
        </section>
      </div>

      <section className="card">
        <h2>Account-level distribution</h2>
        <Histogram buckets={data.levelBuckets ?? []} />
      </section>

      <section className="card">
        <h2>Player averages</h2>
        <div className="kv">
          <div><span>Avg account level</span><strong>{data.averages.accountLevel}</strong></div>
          <div><span>Avg Pokédex caught</span><strong>{data.averages.pokedexCaught} / 151</strong></div>
        </div>
      </section>

      <section className="card">
        <h2>Top 10 — Pokédex completion</h2>
        <table className="leaderboard">
          <thead>
            <tr><th>#</th><th>Trainer</th><th>Account Lv</th><th>Caught</th></tr>
          </thead>
          <tbody>
            {data.leaderboards.pokedex.map((u, i) => (
              <tr key={u.id}>
                <td>{i + 1}</td>
                <td><strong>{u.name ?? u.username}</strong> <span className="dim">@{u.username}</span></td>
                <td>{u.accountLevel}</td>
                <td>{u.pokedexCaughtCount} / 151</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

// ─── SVG line chart ───────────────────────────────────────────────────
// Hand-rolled line chart — small, zero dependencies, follows the
// dashboard's visual language. Renders a smooth path with a subtle
// gradient fill underneath. Hover dots appear via CSS on points.
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

  // 4 horizontal gridlines + matching y-axis labels.
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
    y: PAD_T + innerH - t * innerH,
    label: Math.round(t * max).toString(),
  }));

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" preserveAspectRatio="none">
        <defs>
          <linearGradient id={`grad-${color.slice(1)}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD_L} y1={t.y} x2={W - PAD_R} y2={t.y} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
            <text x={PAD_L - 6} y={t.y + 3} textAnchor="end" className="chart-axis">{t.label}</text>
          </g>
        ))}
        <path d={areaPath} fill={`url(#grad-${color.slice(1)})`} />
        <path d={linePath} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={2.5} fill={color} className="chart-dot">
            <title>{`${p.day}: ${p.c}`}</title>
          </circle>
        ))}
        {/* x-axis labels — first, midpoint, last only (avoid clutter) */}
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
  // "2026-05-04" → "May 4"
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ─── Histogram — bucketed counts ──────────────────────────────────────
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

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="kpi">
      <span className="kpi-label">{label}</span>
      <strong className="kpi-value">{value}</strong>
      {sub && <span className="kpi-sub">{sub}</span>}
    </div>
  );
}
