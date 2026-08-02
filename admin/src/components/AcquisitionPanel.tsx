import { useEffect, useMemo, useState } from "react";
import { api, type Acquisition } from "../api";

// Where new players come from.
//
// ── WHY COVERAGE IS THE FIRST THING ON THE PANEL ────────────────────
// Attribution starts on the day it ships. For weeks afterwards most signups
// have no origin recorded, and every chart below is a view of the minority
// that does. A channel split rendered without that caveat is not merely
// incomplete — it invites a decision ("cut the Reddit spend, it's all direct
// traffic") that the underlying data cannot support. So the denominator leads,
// and every share on the panel is stated as a share of the ATTRIBUTED subset,
// never of all signups.
//
// ── WHY THE CHANNEL SPLIT IS A BAR, NOT A PIE ───────────────────────
// The question is "which of these is biggest, and by how much", and a stacked
// bar answers it at a glance while also showing the whole. It also survives a
// single channel holding 95% of the volume, which is the shape this data
// actually has early on — a pie of that becomes one circle and five slivers.

const CHANNEL_META: Record<string, { label: string; color: string; blurb: string }> = {
  organic:  { label: "Organic search", color: "#34d399", blurb: "Search engines and answer engines — people looking for a game like this." },
  social:   { label: "Social",         color: "#60a5fa", blurb: "Discord, Reddit, X, YouTube and friends — someone shared a link." },
  referral: { label: "Referral",       color: "#a78bfa", blurb: "Another site linked here: a blog, a wiki, a game directory." },
  paid:     { label: "Paid",           color: "#fbbf24", blurb: "Tagged with a paid medium (cpc, display, affiliate…)." },
  email:    { label: "Email",          color: "#f472b6", blurb: "Newsletter and campaign mail." },
  direct:   { label: "Direct",         color: "#94a3b8", blurb: "No referrer and no tags: typed the URL, a bookmark, or a client that strips the referrer." },
};

function meta(channel: string) {
  return CHANNEL_META[channel] ?? { label: channel, color: "#64748b", blurb: "" };
}

/** A share, rounded — except that anything above zero never rounds TO zero.
 *  "0%" beside a count of 1 reads as a rendering bug, and at the volumes this
 *  panel starts at (one email signup out of 214) it would be the common case. */
function pct(n: number, total: number): string {
  if (n <= 0) return "0%";
  const p = (n / total) * 100;
  return p < 1 ? "<1%" : `${p.toFixed(0)}%`;
}

export function AcquisitionPanel({ days = 30 }: { days?: number }) {
  const [data, setData] = useState<Acquisition | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.acquisition(days)
      .then((d) => { if (!cancelled) { setData(d); setErr(null); } })
      .catch((e) => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, [days]);

  const coverage = useMemo(() => {
    if (!data || data.signups === 0) return 0;
    return (data.attributed / data.signups) * 100;
  }, [data]);

  if (err) return <div className="card"><p className="dim small">Acquisition unavailable: {err}</p></div>;
  if (!data) return <div className="card"><p className="dim small">Loading acquisition…</p></div>;

  // Nothing recorded at all. Say so plainly, and say what to expect — an empty
  // chart here would read as "nobody signed up", which is a different and
  // alarming claim.
  if (!data.collectingSince) {
    return (
      <article className="card acq-empty">
        <h3>Not collecting yet</h3>
        <p className="dim">
          Signup origin is recorded from the first new account after this shipped.
          {data.signups > 0
            ? ` ${data.signups.toLocaleString()} people signed up in the last ${data.windowDays} days, none of them with an origin on file.`
            : " No signups in the window yet."}
        </p>
        <p className="dim small">
          Existing accounts are never backfilled — where they came from is not
          knowable after the fact, and inventing a value would be worse than an
          empty panel.
        </p>
      </article>
    );
  }

  const totalAttributed = Math.max(1, data.attributed);

  return (
    <div className="acq">
      {/* ── Coverage ─────────────────────────────────────────────── */}
      <article className="card acq-coverage">
        <div className="acq-coverage__head">
          <div>
            <span className="kpi-label">Attribution coverage</span>
            <strong className="kpi-value">{coverage.toFixed(0)}%</strong>
            <span className="kpi-sub">
              {data.attributed.toLocaleString()} of {data.signups.toLocaleString()} signups · last {data.windowDays}d
            </span>
          </div>
          <span className="tag" title={`First recorded ${new Date(data.collectingSince).toLocaleString()}`}>
            Collecting since {new Date(data.collectingSince).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          </span>
        </div>
        <div className="progress">
          <div className="progress__fill" style={{ width: `${Math.min(100, coverage)}%` }} />
        </div>
        <p className="dim small acq-caveat">
          Everything below is a share of the {data.attributed.toLocaleString()} attributed
          signups, not of all {data.signups.toLocaleString()}.
          {coverage < 60 && " Treat the split as directional until coverage rises."}
        </p>
      </article>

      {/* ── Channels ─────────────────────────────────────────────── */}
      <article className="card">
        <header className="card-head">
          <div>
            <h2>Channels</h2>
            <p>How attributed signups classify.</p>
          </div>
        </header>

        {data.channels.length === 0 ? (
          <p className="dim small">No attributed signups in this window.</p>
        ) : (
          <>
            <div className="acq-stack" role="img"
                 aria-label={data.channels.map((c) => `${meta(c.channel).label} ${c.signups}`).join(", ")}>
              {data.channels.map((c) => (
                <span
                  key={c.channel}
                  className="acq-stack__seg"
                  style={{
                    width: `${(c.signups / totalAttributed) * 100}%`,
                    background: meta(c.channel).color,
                  }}
                  title={`${meta(c.channel).label}: ${c.signups.toLocaleString()}`}
                />
              ))}
            </div>
            <ul className="acq-legend">
              {data.channels.map((c) => (
                <li key={c.channel} title={meta(c.channel).blurb}>
                  <i className="acq-dot" style={{ background: meta(c.channel).color }} />
                  <span className="acq-legend__label">{meta(c.channel).label}</span>
                  <span className="acq-legend__pct tabular">{pct(c.signups, totalAttributed)}</span>
                  <span className="acq-legend__n tabular dim">{c.signups.toLocaleString()}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </article>

      {/* ── Sources ──────────────────────────────────────────────── */}
      <article className="card">
        <header className="card-head">
          <div>
            <h2>Top sources</h2>
            <p>The referring site, or the utm_source when the link was tagged.</p>
          </div>
        </header>
        <SourceList
          rows={data.sources.map((s) => ({ key: s.source, label: s.source, badge: meta(s.channel).label, color: meta(s.channel).color, n: s.signups }))}
          total={totalAttributed}
          empty="No sources yet."
        />
      </article>

      {/* ── Campaigns ────────────────────────────────────────────── */}
      <article className="card">
        <header className="card-head">
          <div>
            <h2>Campaigns</h2>
            <p>Links you tagged with utm_campaign.</p>
          </div>
        </header>
        {data.campaigns.length === 0 ? (
          <p className="dim small">
            No tagged links yet. Append <code>?utm_source=…&amp;utm_campaign=…</code> to a
            link before you post it and its signups show up here.
          </p>
        ) : (
          <SourceList
            rows={data.campaigns.map((c) => ({
              key: `${c.campaign}-${c.source}`,
              label: c.campaign,
              badge: c.medium ? `${c.source} · ${c.medium}` : c.source,
              color: "var(--brand)",
              n: c.signups,
            }))}
            total={totalAttributed}
            empty=""
          />
        )}
      </article>

      {/* ── Landing pages ────────────────────────────────────────── */}
      <article className="card">
        <header className="card-head">
          <div>
            <h2>Landing pages</h2>
            <p>The first page of the visit that became a signup.</p>
          </div>
        </header>
        <SourceList
          rows={data.landingPages.map((p) => ({ key: p.path, label: p.path, badge: null, color: "#64748b", n: p.signups }))}
          total={totalAttributed}
          empty="No landing pages recorded."
        />
      </article>
    </div>
  );
}

/** Ranked list with an inline bar. Same shape for sources, campaigns and
 *  landing pages, because they are the same question asked of three columns
 *  and three bespoke tables would be three things to keep aligned. */
function SourceList({ rows, total, empty }: {
  rows: { key: string; label: string; badge: string | null; color: string; n: number }[];
  total: number;
  empty: string;
}) {
  if (rows.length === 0) return empty ? <p className="dim small">{empty}</p> : null;
  // Scaled to the biggest row, not to the total: with one source at 80% every
  // other bar would be invisible, and the ranking is the point.
  const top = Math.max(1, ...rows.map((r) => r.n));
  return (
    <ul className="acq-rows">
      {rows.map((r) => (
        <li key={r.key} className="acq-row">
          <span className="acq-row__label" title={r.label}>{r.label}</span>
          {r.badge && <span className="acq-row__badge" style={{ color: r.color }}>{r.badge}</span>}
          <span className="acq-row__bar">
            <i style={{ width: `${(r.n / top) * 100}%`, background: r.color }} />
          </span>
          <span className="acq-row__n tabular">{r.n.toLocaleString()}</span>
          <span className="acq-row__pct tabular dim">{pct(r.n, total)}</span>
        </li>
      ))}
    </ul>
  );
}
