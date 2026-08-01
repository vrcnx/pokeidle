import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Analytics } from "../api";
import { navigateTo, type Page } from "../App";

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

type HeroSeries = "dau" | "logins" | "signups" | "pvp" | "trades" | "lastSeen";

// Series semantics, because three of these look interchangeable and
// are not:
//   dau      — REAL daily actives, from the DailyActive event table.
//              Only offered once that table has rows; a day missing
//              from it means "we were not recording", not "nobody
//              played", so it is never zero-filled.
//   logins   — true count of login events (Session.createdAt).
//              Undercounts engagement: one long session = one login.
//   lastSeen — players grouped by the day they were LAST online. This
//              is a churn distribution and rises toward today by
//              construction. It was previously shipped as the hero
//              "Daily Active" chart, which was a confident wrong
//              answer to the main question on the page. Kept, but
//              labelled honestly and carrying an inline caveat.
const HERO_OPTIONS: { key: HeroSeries; label: string; color: string; note?: string }[] = [
  // Real DAU, from the DailyActive event table. Only offered once the
  // table has rows — until then the option is hidden rather than
  // rendering an empty chart that looks like zero players.
  { key: "dau",      label: "Daily Active", color: "var(--brand)"      },
  { key: "logins",   label: "Logins",      color: "var(--brand-hover)" },
  { key: "signups",  label: "Signups",     color: "#a5b4fc"            },
  { key: "pvp",      label: "PvP Matches", color: "#fbbf24"            },
  { key: "trades",   label: "Trades",      color: "#f472b6"            },
  { key: "lastSeen", label: "Last seen",   color: "#94a3b8",
    note: "Players grouped by the day they were last online — a churn view, not activity. Rises toward today by construction." },
];

const HERO_STORAGE_KEY = "pokeidle.analytics.heroSeries";

export function AnalyticsPage() {
  const [data, setData] = useState<Analytics | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<number | null>(null);
  const [heroSeries, setHeroSeries] = useState<HeroSeries>(() => {
    try {
      const v = localStorage.getItem(HERO_STORAGE_KEY);
      // Anyone who used the old dashboard has "dau" persisted here, and
      // that key no longer exists. Land them on the honest replacement
      // rather than silently falling back — they picked a trend to watch
      // and should get the closest truthful one.
      if (v === "dau") return "logins";
      return v && HERO_OPTIONS.some((o) => o.key === v) ? (v as HeroSeries) : "logins";
    } catch { return "logins"; }
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

  // DAU only exists from the day the DailyActive table started
  // recording. Offering the option before then would chart an empty
  // series that reads as "zero players", so hide it until it is real.
  const dauReady = !!data.dauSeries && Object.keys(data.dauSeries).length > 0;
  const heroOptions = HERO_OPTIONS.filter((o) => o.key !== "dau" || dauReady);

  const seriesFor = (k: HeroSeries) => {
    switch (k) {
      case "dau":      return seriesFromMap(data.dauSeries ?? {});
      case "logins":   return seriesFromMap(data.loginSeries);
      case "signups":  return seriesFromMap(data.signupSeries);
      case "pvp":      return seriesFromMap(data.pvpSeries);
      case "trades":   return seriesFromMap(data.tradeSeries);
      case "lastSeen": return seriesFromMap(data.lastSeenSeries);
    }
  };
  const logins = seriesFromMap(data.loginSeries);
  // Guard against a persisted choice that is no longer offered (e.g.
  // "dau" saved before the table existed, or keys from an old build).
  const effectiveHero: HeroSeries =
    heroOptions.some((o) => o.key === heroSeries) ? heroSeries : "logins";
  const heroChart = seriesFor(effectiveHero);
  const heroOption = HERO_OPTIONS.find((o) => o.key === effectiveHero)!;
  const heroColor = heroOption.color;

  // "Active today" is a rolling 24h count (lastSeenAt >= now-24h) and is
  // honest on its own. Its old delta was not: it averaged the last-seen
  // buckets — which are a churn distribution, not activity — and then
  // included today in its own baseline while comparing a rolling window
  // against calendar days. It printed a large ▲ every single day.
  //
  // There is no per-day active history to compare against yet, so
  // instead of inventing one we show stickiness: what share of the last
  // 7 days' actives showed up today. That is a real ratio computed from
  // two rolling windows already in the payload, and it reads the way an
  // operator wants — "are my weekly players showing up daily?".
  const activeToday = data.activity.activeDay;
  const activeWeek = data.activity.activeWeek;
  const stickiness = activeWeek > 0 ? (activeToday / activeWeek) * 100 : 0;

  const totalUsers = data.totals.users;
  const avgLevel = data.averages.accountLevel;

  const r = data.retention;
  const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(0)}%`);

  return (
    <div className="page analytics-cadence">
      <header className="page-head">
        <div>
          <h1>Overview</h1>
          <p>
            Every figure is derived at read time — there is no analytics table
            to drift out of sync with the game.
          </p>
        </div>
        <div className="page-head-actions">
          {lastFetched && <span className="dim small">Updated {formatRelative(lastFetched)}</span>}
          <span className="tag">Last 30 days</span>
          <button className="btn-secondary btn-small" onClick={load}>Refresh</button>
        </div>
      </header>

      {/* Signal bar — the three numbers that mean "go and do something".
          These were a 370x433 column beside the chart: an enormous amount of
          screen for three values whose main job is to say whether they are
          zero. As one row they stay glanceable and the chart gets its width
          back. */}
      <SignalBar
        items={[
          { label: "Errors · 24h", value: data.totals.errorsLast24h, state: data.totals.errorsLast24h > 0 ? "danger" : "ok", page: "errors" },
          { label: "Open bugs", value: data.totals.bugReportsOpen, state: data.totals.bugReportsOpen > 0 ? "warn" : "ok", page: "bugs" },
          { label: "Banned", value: data.totals.bannedUsers, state: "neutral", page: "users" },
        ]}
      />

      {/* One uniform strip. Activity and retention belong on the same line —
          they answer the same question, "are people here and do they come
          back" — and splitting them across a hero tile, four compacts and a
          separate retention band made three sizes of the same object while
          costing a whole row of height. */}
      <section className="kpi-strip">
        <Kpi label="Active today" value={activeToday.toLocaleString()} accent
             sub={activeWeek > 0 ? `${stickiness.toFixed(0)}% of weekly` : undefined}
             hint="Rolling 24h. Stickiness is the share of the last 7 days' actives who showed up today." />
        <Kpi label="Active 7d"  value={data.activity.activeWeek.toLocaleString()} />
        <Kpi label="Active 30d" value={data.activity.activeMonth.toLocaleString()} />
        <Kpi label="Signups 7d" value={data.activity.signups7d.toLocaleString()}
             sub={`${data.activity.signups30d.toLocaleString()} in 30d`} />
        {/* Retention reads as unknown rather than as zero when the check day
            predates collection — 0% would claim every player churned. */}
        <Kpi label="D1 retention"  value={r ? pct(r.d1) : "—"}  sub={r ? `${r.cohortSizes.d1} cohort` : "not collecting"}
             hint="Share of the cohort that signed up 2 days ago and came back the next day. The best single predictor of whether the game compounds." />
        <Kpi label="D7 retention"  value={r ? pct(r.d7) : "—"}  sub={r ? `${r.cohortSizes.d7} cohort` : "not collecting"} />
        <Kpi label="D30 retention" value={r ? pct(r.d30) : "—"} sub={r && r.cohortSizes.d30 === 0 ? "no cohort" : "collecting"} />
        <Kpi label="Total players" value={totalUsers.toLocaleString()} sub={`avg Lv ${avgLevel}`} />
      </section>

      {/* Primary chart, now full width. It is the centrepiece of the page and
          it was rendering into 764px because a column of three numbers sat
          beside it. */}
      <section className="card chart-card chart-card--primary">
        <header className="card-head">
          <div>
            <h2>{heroOption.label}</h2>
            <p>{heroOption.note ?? "Daily totals across the last 30 days."}</p>
          </div>
          <div className="seg-toggle" role="tablist" aria-label="Series">
            {heroOptions.map((o) => (
              <button
                key={o.key}
                role="tab"
                aria-selected={effectiveHero === o.key}
                className={`seg-tab ${effectiveHero === o.key ? "active" : ""}`}
                onClick={() => setHeroSeries(o.key)}
                title={o.note}
              >
                {o.label}
              </button>
            ))}
          </div>
        </header>
        <LineChart days={heroChart.days} counts={heroChart.counts} color={heroColor} height={300} />
      </section>

      {/* Three up. PvP, trades and the level curve are peers — none earns half
          the page, and side by side they can be read against one another. */}
      <section className="grid grid-3 analytics-row">
        <article className="card chart-card">
          <header className="card-head">
            <div>
              <h2>PvP matches</h2>
              <p>{data.totals.pvpMatches7d.toLocaleString()} in 7d · {data.totals.pvpMatchesTotal.toLocaleString()} all-time</p>
            </div>
          </header>
          <LineChart days={seriesFromMap(data.pvpSeries).days} counts={seriesFromMap(data.pvpSeries).counts} color="#fbbf24" height={150} />
        </article>
        <article className="card chart-card">
          <header className="card-head">
            <div>
              <h2>Trades</h2>
              <p>{data.totals.trades7d.toLocaleString()} in 7d · {data.totals.tradesTotal.toLocaleString()} all-time</p>
            </div>
          </header>
          <LineChart days={seriesFromMap(data.tradeSeries).days} counts={seriesFromMap(data.tradeSeries).counts} color="#14b8a6" height={150} />
        </article>
        <article className="card chart-card">
          <header className="card-head">
            <div>
              <h2>Level distribution</h2>
              <p>{totalUsers.toLocaleString()} players · avg Lv {avgLevel}</p>
            </div>
          </header>
          <Histogram buckets={data.levelBuckets ?? []} highlightLevel={avgLevel} />
        </article>
      </section>

      <section className="grid grid-3 analytics-row">
        <article className="card">
          <header className="card-head"><div><h2>Top Pokédex</h2></div></header>
          <ol className="leaderboard__list">
            {data.leaderboards.pokedex.map((u, i) => (
              <li key={u.id} className="leaderboard__row">
                <span className="leaderboard__rank">{i + 1}</span>
                <span className="leaderboard__name">
                  <strong>{u.name ?? u.username}</strong><small className="dim">@{u.username}</small>
                </span>
                <ProgressBar pct={(u.pokedexCaughtCount / 151) * 100} />
                <span className="leaderboard__value tabular">{u.pokedexCaughtCount}<span className="dim"> / 151</span></span>
              </li>
            ))}
          </ol>
        </article>

        <article className="card">
          <header className="card-head"><div><h2>Top trainers by Σ levels</h2></div></header>
          <ol className="leaderboard__list">
            {data.leaderboards.sigmaLevels.map((u, i, arr) => {
              const top = arr[0]?.totalCaughtLevels ?? 1;
              return (
                <li key={u.id} className="leaderboard__row">
                  <span className="leaderboard__rank">{i + 1}</span>
                  <span className="leaderboard__name">
                    <strong>{u.name ?? u.username}</strong><small className="dim">@{u.username}</small>
                  </span>
                  <ProgressBar pct={(u.totalCaughtLevels / Math.max(1, top)) * 100} />
                  <span className="leaderboard__value tabular">{u.totalCaughtLevels.toLocaleString()}</span>
                </li>
              );
            })}
          </ol>
        </article>

        <article className="card">
          <header className="card-head"><div><h2>Catalog &amp; community</h2></div></header>
          <ul className="stat-list__list">
            <StatRow label="Avg Pokédex" valueText={`${data.averages.pokedexCaught} / 151`}>
              <ProgressBar pct={(data.averages.pokedexCaught / 151) * 100} />
            </StatRow>
            <StatRow label="Σ Pokémon caught" valueText={data.totals.pokemonCaughtSum.toLocaleString()} />
            <StatRow label="Σ Pokémon levels" valueText={data.totals.pokemonLevelsSum.toLocaleString()} />
            <StatRow label="Friendships"      valueText={data.totals.friendships.toLocaleString()} />
            <StatRow label="Chat · 7d"        valueText={`${data.totals.chatMessages7d.toLocaleString()} / ${data.totals.chatMessagesTotal.toLocaleString()}`} />
          </ul>
        </article>
      </section>
    </div>
  );
}

/** One tile in the KPI strip. Uniform by construction — every headline number
 *  on this page is the same object and should be the same size. */
function Kpi({ label, value, sub, hint, accent }: {
  label: string; value: string; sub?: string; hint?: string; accent?: boolean;
}) {
  return (
    <article className={`kpi${accent ? " kpi--accent" : ""}`} title={hint}>
      <span className="kpi-label">{label}</span>
      <strong className="kpi-value">{value}</strong>
      {sub && <span className="kpi-sub">{sub}</span>}
    </article>
  );
}

/** Compact clickable status row: the numbers that mean "go and do something".
 *  Each one navigates to the page that can action it, because a count with no
 *  route to the thing it counts makes the operator go and find it by hand. */
function SignalBar({ items }: {
  items: { label: string; value: number; state: "danger" | "warn" | "ok" | "neutral"; page: Page }[];
}) {
  return (
    <div className="signal-bar">
      {items.map((it) => (
        <button
          key={it.label}
          className={`signal signal--${it.state}`}
          onClick={() => navigateTo(it.page)}
        >
          <span className="signal-dot" aria-hidden />
          <span className="signal-label">{it.label}</span>
          <strong className="signal-value">{it.value.toLocaleString()}</strong>
        </button>
      ))}
    </div>
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
      {/* Explicit CSS height. `.chart-svg` sets `height: auto`, which with
          preserveAspectRatio="none" derives the height from the viewBox
          ratio — so the wider the card, the taller the chart. Once the
          primary chart went full-width that turned a requested 300px into
          554px and pushed the rest of the page off the fold. */}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="chart-svg"
        preserveAspectRatio="none"
        style={{ height: H }}
      >
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
