import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Analytics } from "../api";

// "Cadence" layout — design panel winner.
// One focal point per row. 12-column grid, 24px gutters, 32px between
// rows. Above-the-fold answers "how are we doing right now?": hero
// KPI + 4 compact KPIs + a hero chart + an alert stack. Below the fold
// is reference data (secondary trends, distribution, leaderboards).
//
// The hero chart segments DAU / Signups / PvP / Trades so we don't
// need a 2x2 chart grid — those four metrics ride one big chart and
// the operator toggles which series they want to see. PvP & Trades
// still get a dedicated secondary row so power-users can compare.

type HeroSeries = "dau" | "signups" | "pvp" | "trades";

const HERO_OPTIONS: { key: HeroSeries; label: string; color: string }[] = [
  { key: "dau",     label: "Daily Active", color: "var(--brand)"        },
  { key: "signups", label: "Signups",      color: "var(--brand-hover)"  },
  { key: "pvp",     label: "PvP Matches",  color: "#fbbf24"             },
  { key: "trades",  label: "Trades",       color: "#f472b6"             },
];

const HERO_STORAGE_KEY = "pokeidle.analytics.heroSeries";

export function AnalyticsPage() {
  const [data, setData] = useState<Analytics | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<number | null>(null);
  const [heroSeries, setHeroSeries] = useState<HeroSeries>(() => {
    try {
      const v = localStorage.getItem(HERO_STORAGE_KEY) as HeroSeries | null;
      return v && HERO_OPTIONS.some((o) => o.key === v) ? v : "dau";
    } catch { return "dau"; }
  });

  useEffect(() => {
    try { localStorage.setItem(HERO_STORAGE_KEY, heroSeries); } catch { /* */ }
  }, [heroSeries]);

  const load = () => {
    api.analytics()
      .then((d) => { setData(d); setErr(null); setLastFetched(Date.now()); })
      .catch((e) => setErr(e.message));
  };
  useEffect(() => { load(); }, []);

  if (err) return <div className="page-err">Error: {err}</div>;
  if (!data) return <div className="page-loading">Loading analytics…</div>;

  const seriesFor = (k: HeroSeries) => {
    switch (k) {
      case "dau":     return seriesFromMap(data.dauSeries);
      case "signups": return seriesFromMap(data.signupSeries);
      case "pvp":     return seriesFromMap(data.pvpSeries);
      case "trades":  return seriesFromMap(data.tradeSeries);
    }
  };
  const dau = seriesFromMap(data.dauSeries);
  const heroChart = seriesFor(heroSeries);
  const heroColor = HERO_OPTIONS.find((o) => o.key === heroSeries)!.color;

  const activeToday = data.activity.activeDay;
  const avg7dDau = dau.counts.slice(-7).reduce((a, b) => a + b, 0) / Math.max(1, dau.counts.slice(-7).length || 1);
  const deltaPct = avg7dDau > 0 ? ((activeToday - avg7dDau) / avg7dDau) * 100 : 0;

  const totalUsers = data.totals.users;
  const avgLevel = data.averages.accountLevel;

  return (
    <div className="page analytics-cadence">
      {/* Page header */}
      <header className="analytics-header">
        <div className="analytics-header__title">
          <span className="analytics-header__eyebrow">Analytics</span>
          <h1>Operator overview</h1>
        </div>
        <div className="analytics-header__meta">
          {lastFetched && (
            <span className="analytics-header__updated">Updated {formatRelative(lastFetched)}</span>
          )}
          <span className="scope-pill">Last 30 days</span>
          <button className="btn-secondary btn-small" onClick={load} title="Re-fetch analytics">
            Refresh
          </button>
        </div>
      </header>

      {/* Pulse row — 1 hero KPI + 4 compact KPIs */}
      <section className="analytics-grid pulse-row">
        <article className="kpi-card kpi-card--hero" style={{ gridColumn: "span 4" }}>
          <span className="kpi-label">Active today</span>
          <strong className="kpi-value kpi-value--xl">{activeToday.toLocaleString()}</strong>
          {avg7dDau > 0 && (
            <span className={`kpi-delta ${deltaPct >= 0 ? "up" : "down"}`}>
              {deltaPct >= 0 ? "▲" : "▼"} {Math.abs(deltaPct).toFixed(1)}% vs 7d avg
            </span>
          )}
          <Sparkline counts={dau.counts} color="var(--brand)" />
        </article>
        <KpiCompact label="Active 7d"   value={data.activity.activeWeek} />
        <KpiCompact label="Active 30d"  value={data.activity.activeMonth} />
        <KpiCompact label="Signups 7d"  value={data.activity.signups7d}  sub={`${data.activity.signups30d.toLocaleString()} in 30d`} />
        <KpiCompact label="Total users" value={totalUsers} sub={data.totals.bannedUsers > 0 ? `${data.totals.bannedUsers} banned` : undefined} />
      </section>

      {/* Primary chart + Health stack */}
      <section className="analytics-grid primary-row">
        <article className="chart-card chart-card--primary" style={{ gridColumn: "span 8" }}>
          <header className="chart-card__header">
            <h3>Trend · {HERO_OPTIONS.find((o) => o.key === heroSeries)!.label}</h3>
            <div className="seg-toggle" role="tablist" aria-label="Hero series">
              {HERO_OPTIONS.map((o) => (
                <button
                  key={o.key}
                  role="tab"
                  aria-selected={heroSeries === o.key}
                  className={`seg-tab ${heroSeries === o.key ? "active" : ""}`}
                  onClick={() => setHeroSeries(o.key)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </header>
          <div className="chart-card__body">
            <LineChart days={heroChart.days} counts={heroChart.counts} color={heroColor} height={280} />
          </div>
        </article>

        <aside className="alert-stack" style={{ gridColumn: "span 4" }}>
          <AlertCard
            label="Errors · 24h"
            value={data.totals.errorsLast24h}
            state={data.totals.errorsLast24h > 0 ? "danger" : "neutral"}
            cta="Open logs →"
          />
          <AlertCard
            label="Open bug reports"
            value={data.totals.bugReportsOpen}
            state={data.totals.bugReportsOpen > 0 ? "warn" : "neutral"}
            cta="Review →"
          />
          <AlertCard
            label="Admins · Banned"
            value={data.totals.admins}
            sub={`${data.totals.bannedUsers} banned`}
            state="neutral"
          />
        </aside>
      </section>

      {/* Secondary trends — PvP & Trades */}
      <section className="analytics-grid secondary-row">
        <article className="chart-card chart-card--compact" style={{ gridColumn: "span 6", "--chart-accent": "#fbbf24" } as React.CSSProperties}>
          <header className="chart-card__header">
            <h3>PvP matches</h3>
            <div className="chart-card__headline">
              <span><strong>{data.totals.pvpMatches7d.toLocaleString()}</strong><small className="dim"> · 7d</small></span>
              <span className="dim small">{data.totals.pvpMatchesTotal.toLocaleString()} all-time</span>
            </div>
          </header>
          <LineChart days={seriesFromMap(data.pvpSeries).days} counts={seriesFromMap(data.pvpSeries).counts} color="#fbbf24" height={160} />
        </article>
        <article className="chart-card chart-card--compact" style={{ gridColumn: "span 6", "--chart-accent": "#14b8a6" } as React.CSSProperties}>
          <header className="chart-card__header">
            <h3>Trade volume</h3>
            <div className="chart-card__headline">
              <span><strong>{data.totals.trades7d.toLocaleString()}</strong><small className="dim"> · 7d</small></span>
              <span className="dim small">{data.totals.tradesTotal.toLocaleString()} all-time</span>
            </div>
          </header>
          <LineChart days={seriesFromMap(data.tradeSeries).days} counts={seriesFromMap(data.tradeSeries).counts} color="#14b8a6" height={160} />
        </article>
      </section>

      {/* Distribution + Catalog */}
      <section className="analytics-grid distribution-row">
        <article className="chart-card" style={{ gridColumn: "span 8" }}>
          <header className="chart-card__header">
            <h3>Account level distribution</h3>
            <span className="dim small">{totalUsers.toLocaleString()} players · avg Lv {avgLevel}</span>
          </header>
          <Histogram buckets={data.levelBuckets ?? []} highlightLevel={avgLevel} />
        </article>
        <article className="stat-list" style={{ gridColumn: "span 4" }}>
          <header className="chart-card__header">
            <h3>Catalog &amp; community</h3>
          </header>
          <ul className="stat-list__list">
            <StatRow label="Avg Pokédex" valueText={`${data.averages.pokedexCaught} / 151`}>
              <ProgressBar pct={(data.averages.pokedexCaught / 151) * 100} />
            </StatRow>
            <StatRow label="Σ Pokémon caught"  valueText={data.totals.pokemonCaughtSum.toLocaleString()} />
            <StatRow label="Σ Pokémon levels"  valueText={data.totals.pokemonLevelsSum.toLocaleString()} />
            <StatRow label="Friendships"       valueText={data.totals.friendships.toLocaleString()} />
            <StatRow label="Chat · 7d"         valueText={`${data.totals.chatMessages7d.toLocaleString()} / ${data.totals.chatMessagesTotal.toLocaleString()}`} />
          </ul>
        </article>
      </section>

      {/* Leaderboards */}
      <section className="analytics-grid leaderboards-row">
        <article className="leaderboard-card" style={{ gridColumn: "span 6" }}>
          <header className="chart-card__header">
            <h3>Top Pokédex completion</h3>
          </header>
          <ol className="leaderboard__list">
            {data.leaderboards.pokedex.map((u, i) => (
              <li key={u.id} className="leaderboard__row">
                <span className="leaderboard__rank">{i + 1}</span>
                <span className="leaderboard__name"><strong>{u.name ?? u.username}</strong><small className="dim">@{u.username}</small></span>
                <ProgressBar pct={(u.pokedexCaughtCount / 151) * 100} />
                <span className="leaderboard__value tabular">{u.pokedexCaughtCount}<span className="dim"> / 151</span></span>
              </li>
            ))}
          </ol>
        </article>
        <article className="leaderboard-card" style={{ gridColumn: "span 6" }}>
          <header className="chart-card__header">
            <h3>Top trainers by Σ levels</h3>
          </header>
          <ol className="leaderboard__list">
            {data.leaderboards.sigmaLevels.map((u, i, arr) => {
              const top = arr[0]?.totalCaughtLevels ?? 1;
              return (
                <li key={u.id} className="leaderboard__row">
                  <span className="leaderboard__rank">{i + 1}</span>
                  <span className="leaderboard__name"><strong>{u.name ?? u.username}</strong><small className="dim">@{u.username}</small></span>
                  <ProgressBar pct={(u.totalCaughtLevels / Math.max(1, top)) * 100} />
                  <span className="leaderboard__value tabular">{u.totalCaughtLevels.toLocaleString()}</span>
                </li>
              );
            })}
          </ol>
        </article>
      </section>

      <footer className="analytics-footer">
        <span>Data refreshed manually · 30-day window · pokeidle.com</span>
      </footer>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────

function KpiCompact({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <article className="kpi-card" style={{ gridColumn: "span 2" }}>
      <span className="kpi-label">{label}</span>
      <strong className="kpi-value">{value.toLocaleString()}</strong>
      {sub && <span className="kpi-sub">{sub}</span>}
    </article>
  );
}

function AlertCard({
  label, value, sub, state, cta,
}: {
  label: string;
  value: number;
  sub?: string;
  state: "danger" | "warn" | "neutral";
  cta?: string;
}) {
  return (
    <article className={`alert-card alert-card--${state}`}>
      <div className="alert-card__row">
        <span className="alert-card__dot" aria-hidden />
        <span className="alert-card__label">{label}</span>
      </div>
      <strong className="alert-card__value">{value.toLocaleString()}</strong>
      {sub && <span className="alert-card__sub">{sub}</span>}
      {cta && <span className="alert-card__cta dim small">{cta}</span>}
    </article>
  );
}

function StatRow({ label, valueText, children }: { label: string; valueText: string; children?: React.ReactNode }) {
  return (
    <li className="stat-list__row">
      <div className="stat-list__main">
        <span className="stat-list__label">{label}</span>
        <span className="stat-list__value">{valueText}</span>
      </div>
      {children}
    </li>
  );
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="progress" aria-hidden>
      <div className="progress__fill" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

// ─── Charts ──────────────────────────────────────────────────────────

function seriesFromMap(s: Record<string, number>): { days: string[]; counts: number[] } {
  const days = Object.keys(s).sort();
  return { days, counts: days.map((d) => s[d]) };
}

function Sparkline({ counts, color }: { counts: number[]; color: string }) {
  if (counts.length === 0) return null;
  const W = 600;
  const H = 60;
  const PAD = 4;
  const max = Math.max(1, ...counts);
  const pts = counts.map((c, i) => {
    const x = PAD + (counts.length === 1 ? 0 : (i / (counts.length - 1)) * (W - PAD * 2));
    const y = PAD + (H - PAD * 2) - (c / max) * (H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const line = "M " + pts.join(" L ");
  const area = `${line} L ${W - PAD},${H - PAD} L ${PAD},${H - PAD} Z`;
  const id = `spark-${color.replace(/[^a-z0-9]/gi, "")}`;
  return (
    <svg className="kpi-sparkline" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LineChart({ days, counts, color, height = 240 }: { days: string[]; counts: number[]; color: string; height?: number }) {
  const W = 600;
  const H = height;
  const PAD_L = 32;
  const PAD_R = 8;
  const PAD_T = 12;
  const PAD_B = 24;
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
  const linePath = points.length === 0 ? "" : "M " + points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L ");
  const areaPath = points.length === 0 ? "" : `${linePath} L ${points[points.length - 1].x.toFixed(1)},${PAD_T + innerH} L ${points[0].x.toFixed(1)},${PAD_T + innerH} Z`;
  const ticks = [0, 0.5, 1].map((t) => ({
    y: PAD_T + innerH - t * innerH,
    label: Math.round(t * max).toString(),
  }));
  const gradId = `grad-${color.replace(/[^a-z0-9]/gi, "")}`;

  // 7-day moving average overlay.
  const movAvg = useMemo(() => {
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < counts.length; i++) {
      const lo = Math.max(0, i - 6);
      const slice = counts.slice(lo, i + 1);
      const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
      const x = PAD_L + (counts.length === 1 ? 0 : (i / (counts.length - 1)) * innerW);
      const y = PAD_T + innerH - (avg / max) * innerH;
      out.push({ x, y });
    }
    return out;
  }, [counts, innerW, innerH, max]);
  const movAvgPath = movAvg.length === 0 ? "" : "M " + movAvg.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L ");

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" preserveAspectRatio="none">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.32" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD_L} y1={t.y} x2={W - PAD_R} y2={t.y} stroke="rgba(255,255,255,0.04)" strokeWidth={1} />
            <text x={PAD_L - 6} y={t.y + 3} textAnchor="end" className="chart-axis">{t.label}</text>
          </g>
        ))}
        <path d={areaPath} fill={`url(#${gradId})`} />
        <path d={movAvgPath} fill="none" stroke={color} strokeWidth={1} strokeDasharray="3 4" opacity={0.55} />
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

function Histogram({ buckets, highlightLevel }: { buckets: { label: string; count: number }[]; highlightLevel?: number }) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  // Highlight the bucket containing the average level.
  const highlightIdx = highlightLevel == null ? -1 : Math.min(buckets.length - 1, Math.floor(highlightLevel / 10));
  return (
    <div className="histogram">
      {buckets.map((b, i) => (
        <div className={`histogram-col ${i === highlightIdx ? "highlighted" : ""}`} key={b.label}>
          <div className="histogram-bar-wrap">
            <div className="histogram-bar" style={{ height: `${(b.count / max) * 100}%` }} title={`${b.label}: ${b.count}`} />
            <span className="histogram-count">{b.count}</span>
          </div>
          <span className="histogram-label">{b.label}</span>
        </div>
      ))}
      {buckets.length === 0 && <span className="dim small">No data.</span>}
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
