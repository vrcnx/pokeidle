import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, type Analytics } from "../api";
import { navigateTo, type Page } from "../App";
import { PageActions, PageNote } from "../components/PageChrome";
import { AcquisitionPanel } from "../components/AcquisitionPanel";
import { ReferralAnalyticsPanel } from "../components/ReferralAnalyticsPanel";
import { Kpi, SectionHead } from "../components/Section";

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

  return (
    <div className="page analytics-cadence">
      {/* Title and actions live in the topbar. The bar already names the page,
          so a .page-head here was the same word twice plus ~100px of height
          before any data. */}
      <PageNote>Derived at read time — no analytics table to drift.</PageNote>
      <PageActions>
        {lastFetched && <span className="dim small">Updated {formatRelative(lastFetched)}</span>}
        <span className="tag">Last 30 days</span>
        <button className="btn-secondary btn-small" onClick={load}>Refresh</button>
      </PageActions>

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

      <SectionHead
        title="Audience"
        blurb="Who is playing, and whether they come back."
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
        {/* Three distinct unknowns, never collapsed into "0%": no collection at
            all, a check-day that predates collection, and an empty cohort. 0%
            would claim every player churned, which is a different and much
            worse statement than "we do not know yet". */}
        <RetentionKpi label="D1 retention"  value={r?.d1  ?? null} size={r?.cohortSizes.d1  ?? null}
          hint="Share of the cohort that signed up 2 days ago and came back the next day. The best single predictor of whether the game compounds." />
        <RetentionKpi label="D7 retention"  value={r?.d7  ?? null} size={r?.cohortSizes.d7  ?? null} />
        <RetentionKpi label="D30 retention" value={r?.d30 ?? null} size={r?.cohortSizes.d30 ?? null} />
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

      <SectionHead
        title="Acquisition"
        blurb="Where new players come from — referring sites, campaigns and landing pages."
      />
      <AcquisitionPanel days={30} />

      {/* Directly under acquisition, because a referral IS an acquisition
          channel — the one where the game pays for the signup, which is
          exactly why it gets its own panel rather than a row in the table
          above. */}
      <ReferralAnalyticsPanel days={30} />

      <SectionHead
        title="Engagement"
        blurb="What players do once they are here, and how far they get."
      />

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
          <LineChart days={seriesFromMap(data.pvpSeries).days} counts={seriesFromMap(data.pvpSeries).counts} color="#fbbf24" height={150} compact />
        </article>
        <article className="card chart-card">
          <header className="card-head">
            <div>
              <h2>Trades</h2>
              <p>{data.totals.trades7d.toLocaleString()} in 7d · {data.totals.tradesTotal.toLocaleString()} all-time</p>
            </div>
          </header>
          <LineChart days={seriesFromMap(data.tradeSeries).days} counts={seriesFromMap(data.tradeSeries).counts} color="#14b8a6" height={150} compact />
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

      <SectionHead
        title="Community"
        blurb="Leaderboards and catalogue totals."
      />

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

/**
 * A retention tile.
 *
 * Every value here can legitimately be unknown, and the reasons differ, so it
 * never prints a number it cannot stand behind:
 *   no retention object   -> not collecting yet
 *   null with a cohort    -> the check day predates collection ("collecting")
 *   null with no cohort   -> nobody signed up that day ("no cohort")
 * Printing 0% for any of those would read as total churn.
 */
function RetentionKpi({ label, value, size, hint }: {
  label: string; value: number | null; size: number | null; hint?: string;
}) {
  if (size === null) return <Kpi label={label} value="—" sub="not collecting" hint={hint} />;
  if (value === null) {
    return <Kpi label={label} value={size === 0 ? "—" : "…"} sub={size === 0 ? "no cohort" : "collecting"} hint={hint} />;
  }
  return <Kpi label={label} value={`${value.toFixed(0)}%`} sub={`${size.toLocaleString()} cohort`} hint={hint} />;
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

/**
 * Line chart.
 *
 * ── WHY IT MEASURES ITS OWN WIDTH ───────────────────────────────────
 * The previous version drew into a fixed 600-unit viewBox and stretched it to
 * the container with `preserveAspectRatio="none"`. At full width that is a
 * 1.85x horizontal scale applied to EVERYTHING — so the axis labels were
 * literally stretched, and every vertical stroke came out 1.85x thicker than
 * every horizontal one. It is the reason the chart looked wrong in a way that
 * was hard to name.
 *
 * Measuring the container and drawing in real pixels costs a ResizeObserver
 * and removes the whole class of problem: text is text, 1px is 1px.
 */
function LineChart({ days, counts, color, height = 240, compact = false }: {
  days: string[]; counts: number[]; color: string; height?: number; compact?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [W, setW] = useState(600);

  // getBoundingClientRect on layout + a window resize listener, NOT a
  // ResizeObserver. RO is the tidier API and it does not fire at all in some
  // embedded/headless browser contexts — observed here, where even a manually
  // constructed observer on this exact element never produced a callback. The
  // failure mode is silent and total: the chart keeps its 600px default
  // forever and every label renders 1.85x too large. A resize listener covers
  // every case this layout actually has, since the wrap only changes width
  // when the window does.
  useLayoutEffect(() => {
    const measure = () => {
      const w = Math.round(wrapRef.current?.getBoundingClientRect().width ?? 0);
      if (w > 0) setW((prev) => (Math.abs(prev - w) > 1 ? w : prev));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const H = height;
  const PAD_L = compact ? 34 : 46;
  const PAD_R = 12;
  const PAD_T = 14;
  const PAD_B = 26;
  const innerW = Math.max(1, W - PAD_L - PAD_R);
  const innerH = Math.max(1, H - PAD_T - PAD_B);

  const rawMax = Math.max(1, ...counts);
  // A ceiling on a round number, with headroom. Scaling to the exact peak puts
  // the highest point flush against the top edge, which reads as clipped, and
  // labels an axis with arbitrary values like 266 and 133.
  const { max, ticks } = useMemo(() => niceScale(rawMax, compact ? 3 : 5), [rawMax, compact]);

  const xAt = (i: number) => PAD_L + (counts.length <= 1 ? innerW / 2 : (i / (counts.length - 1)) * innerW);
  const yAt = (v: number) => PAD_T + innerH - (v / max) * innerH;

  const points = useMemo(
    () => counts.map((c, i) => ({ x: xAt(i), y: yAt(c), c, day: days[i] })),
    [days, counts, innerW, innerH, max, W],
  );

  const linePath = points.length === 0 ? "" : "M " + points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L ");
  const areaPath = points.length === 0 ? "" :
    `${linePath} L ${points[points.length - 1].x.toFixed(1)},${(PAD_T + innerH).toFixed(1)} L ${points[0].x.toFixed(1)},${(PAD_T + innerH).toFixed(1)} Z`;

  // 7-day moving average. Labelled in the legend below — an unexplained dashed
  // line is just noise the reader has to ignore.
  const movAvgPath = useMemo(() => {
    if (counts.length === 0) return "";
    const pts = counts.map((_, i) => {
      const slice = counts.slice(Math.max(0, i - 6), i + 1);
      return { x: xAt(i), y: yAt(slice.reduce((a, b) => a + b, 0) / slice.length) };
    });
    return "M " + pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L ");
  }, [counts, innerW, innerH, max, W]);

  // Roughly every Nth day, always including the last, so the axis reads as a
  // date range rather than three lonely labels.
  const xLabelEvery = Math.max(1, Math.ceil(counts.length / (compact ? 3 : 6)));
  const gradId = `grad-${color.replace(/[^a-z0-9]/gi, "")}-${compact ? "c" : "p"}`;

  const [hover, setHover] = useState<number | null>(null);
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = e.clientX - rect.left - PAD_L;
    const i = Math.round((rel / innerW) * (counts.length - 1));
    setHover(i >= 0 && i < counts.length ? i : null);
  };

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <svg
        className="chart-svg"
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0.01" />
          </linearGradient>
        </defs>

        {/* Gridlines first, so the data draws over them. The old ones were at
            0.04 alpha, which is invisible — a gridline you cannot see is not a
            gridline, and without them a reader cannot judge a value at all. */}
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD_L} y1={yAt(t)} x2={W - PAD_R} y2={yAt(t)}
              stroke="rgba(255,255,255,0.07)" strokeWidth={1} shapeRendering="crispEdges"
            />
            <text x={PAD_L - 8} y={yAt(t) + 3.5} textAnchor="end" className="chart-axis">
              {formatTick(t)}
            </text>
          </g>
        ))}
        {/* Baseline gets a stronger rule — zero is a real boundary. */}
        <line
          x1={PAD_L} y1={PAD_T + innerH} x2={W - PAD_R} y2={PAD_T + innerH}
          stroke="rgba(255,255,255,0.14)" strokeWidth={1} shapeRendering="crispEdges"
        />

        <path d={areaPath} fill={`url(#${gradId})`} />
        <path d={movAvgPath} fill="none" stroke={color} strokeWidth={1.25} strokeDasharray="4 4" opacity={0.45} />
        <path d={linePath} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

        {/* Dots only when they are not going to collide. At 30 points across a
            compact card they merge into a dotted line. */}
        {!compact && points.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={2.5} fill={color} className="chart-dot" />
        ))}

        {hover !== null && points[hover] && (
          <g className="chart-hover">
            <line
              x1={points[hover].x} y1={PAD_T} x2={points[hover].x} y2={PAD_T + innerH}
              stroke="rgba(255,255,255,0.22)" strokeWidth={1}
            />
            <circle cx={points[hover].x} cy={points[hover].y} r={4} fill={color} stroke="var(--surface-1)" strokeWidth={2} />
          </g>
        )}

        {points.map((p, i) =>
          i % xLabelEvery === 0 || i === points.length - 1 ? (
            <text
              key={`x${i}`}
              x={p.x}
              y={H - 7}
              textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}
              className="chart-axis"
            >
              {shortDate(p.day)}
            </text>
          ) : null,
        )}
      </svg>

      <div className="chart-legend">
        <span className="chart-legend__item">
          <i className="chart-legend__swatch" style={{ background: color }} /> Daily
        </span>
        <span className="chart-legend__item">
          <i className="chart-legend__swatch chart-legend__swatch--dashed" style={{ borderColor: color }} /> 7-day average
        </span>
        <span className="chart-legend__read">
          {hover !== null && points[hover]
            ? <><strong>{points[hover].c.toLocaleString()}</strong> on {shortDate(points[hover].day)}</>
            : <span className="dim">Hover for a day</span>}
        </span>
      </div>
    </div>
  );
}

/**
 * A ceiling on a round number, plus evenly spaced ticks up to it.
 *
 * Scaling to the exact peak labels the axis with whatever the data happened to
 * be — 266 and 133 — and pins the highest point to the top edge so it reads as
 * clipped. Rounding up to a 1/2/5 x 10^n step gives an axis a person can read
 * a value off.
 */
function niceScale(rawMax: number, targetTicks: number): { max: number; ticks: number[] } {
  const rough = rawMax / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(rough, 1e-9))));
  const norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const max = Math.max(step, Math.ceil(rawMax / step) * step);
  const ticks: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) ticks.push(Math.round(v));
  return { max, ticks };
}

function formatTick(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(v % 1_000 === 0 ? 0 : 1)}k`;
  return String(v);
}

/**
 * Level distribution.
 *
 * ── WHY IT IS A LOG SCALE ───────────────────────────────────────────
 * Linear was unreadable on the real data. The 0-9 bucket holds 1,939 of 2,444
 * players, so every other bar was under 7% of the height and eleven of the
 * twelve columns rendered as identical slivers — the chart said "most players
 * are low level", which anyone could already guess, and nothing else.
 *
 * A log scale is the standard answer to a distribution spanning three orders
 * of magnitude, and it makes the tail legible: 227 at level 110+ and 7 at
 * 70-79 become visibly different bars. It IS harder to read proportions off,
 * which is why the axis says so and every bar keeps its raw count on top.
 */
function Histogram({ buckets, highlightLevel }: { buckets: { label: string; count: number }[]; highlightLevel?: number }) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const logMax = Math.log10(max + 1);
  // Highlight the bucket containing the average level.
  const highlightIdx = highlightLevel == null ? -1 : Math.min(buckets.length - 1, Math.floor(highlightLevel / 10));

  if (buckets.length === 0) return <p className="dim small">No data.</p>;

  return (
    <div className="histogram-wrap">
      <div className="histogram">
        {buckets.map((b, i) => {
          // +1 so an empty bucket is 0 rather than -Infinity, and a floor so a
          // non-zero bucket always draws something a reader can see and hover.
          const pct = b.count === 0 ? 0 : Math.max(3, (Math.log10(b.count + 1) / logMax) * 100);
          return (
            <div className={`histogram-col ${i === highlightIdx ? "highlighted" : ""}`} key={b.label}>
              <div className="histogram-bar-wrap">
                <span className="histogram-count">{b.count.toLocaleString()}</span>
                <div
                  className="histogram-bar"
                  style={{ height: `${pct}%` }}
                  title={`Level ${b.label}: ${b.count.toLocaleString()} players`}
                />
              </div>
              <span className="histogram-label">{b.label}</span>
            </div>
          );
        })}
      </div>
      <p className="histogram-note dim small">
        Log scale — the lowest bucket holds most of the population, so a linear
        axis flattens every other bar to nothing.
      </p>
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
