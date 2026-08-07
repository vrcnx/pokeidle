import { useEffect, useState } from "react";
import { api, type ReferralAnalytics } from "../api";

// How the referral programme is actually going.
//
// ── WHY "DO THEY PLAY" IS THE HEADLINE AND VOLUME IS NOT ────────────
// The programme pays a tradeable Master Ball on SIGNUP, with no eligibility
// gate — a deliberate call, made with the risk understood (see
// server/src/lib/referrals.ts). That decision moves the question this panel
// has to answer. It is not "how many referrals"; a farm and a genuinely good
// week produce the same bar chart, and a number that cannot tell them apart
// is worse than no number because it invites the wrong conclusion twice.
//
// What separates them is whether the referred accounts PLAY. So the share of
// referred accounts past the early levels leads, and it is stated NEXT TO the
// same share for everybody else — because neither figure means anything
// alone. Referred players tracking the site-wide number is growth. Referred
// accounts sitting at level 0 while the site-wide number is healthy is a farm.
// A gap in the other direction means the programme is bringing in better
// players than the front page does, which is worth knowing too.
//
// ── AND WHY THE TOP TABLE SHOWS TWO COLUMNS ─────────────────────────
// Same reason. "Brought 40" is not a finding. "Brought 40, of whom 1 plays"
// is, and it names the account.

/** A share, rounded, where anything above zero never rounds TO zero — "0%"
 *  beside a count of 1 reads as a rendering bug. */
function pct(n: number, total: number): string {
  if (total <= 0) return "—";
  if (n <= 0) return "0%";
  const p = (n / total) * 100;
  return p < 1 ? "<1%" : `${p.toFixed(0)}%`;
}

export function ReferralAnalyticsPanel({ days = 30 }: { days?: number }) {
  const [data, setData] = useState<ReferralAnalytics | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.referralAnalytics(days)
      .then((d) => { if (!cancelled) { setData(d); setErr(null); } })
      .catch((e) => { if (!cancelled) setErr((e as Error).message); });
    return () => { cancelled = true; };
  }, [days]);

  if (err) return <section className="card"><div className="page-err">{err}</div></section>;
  if (!data) return <section className="card"><p className="dim small">Loading referrals…</p></section>;
  if (data.notReady) {
    return (
      <section className="card">
        <h2>Referrals</h2>
        <p className="dim small">
          The referral tables aren't deployed yet. This panel will fill in once they are.
        </p>
      </section>
    );
  }

  const q = data.quality;
  const referredShare = q.referredTotal > 0 ? q.referredPlayed / q.referredTotal : 0;
  const everyoneShare = q.everyoneTotal > 0 ? q.everyonePlayed / q.everyoneTotal : 0;
  // Only call it either way once there is enough to call. At single-digit
  // referrals the ratio swings on one account, and a verdict drawn from that
  // is noise wearing a conclusion's clothes.
  const enough = q.referredTotal >= 20;
  const verdict = !enough ? null
    : referredShare >= everyoneShare * 0.8 ? "healthy"
    : referredShare >= everyoneShare * 0.4 ? "mixed"
    : "suspect";

  const series = Object.entries(data.perDay).sort(([a], [b]) => a.localeCompare(b));
  const peak = Math.max(1, ...series.map(([, n]) => n));

  return (
    <section className="card">
      <h2>Referrals</h2>
      <p className="dim small">
        Players sharing a <code>?ref=</code> link. Paid on signup with no eligibility
        gate, so the number that matters is whether the accounts play.
      </p>

      {/* THE HEADLINE, and its control group beside it. */}
      <div className="grid grid-3" style={{ marginTop: 14 }}>
        <div className="kpi">
          <span className="kpi-label">Referred accounts that play</span>
          <strong className="kpi-value">{pct(q.referredPlayed, q.referredTotal)}</strong>
          <span className="dim small">
            {q.referredPlayed} of {q.referredTotal} past level {data.playedLevel}
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Everyone else, for comparison</span>
          <strong className="kpi-value">{pct(q.everyonePlayed, q.everyoneTotal)}</strong>
          <span className="dim small">
            {q.everyonePlayed} of {q.everyoneTotal} accounts
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Reading</span>
          <strong className="kpi-value">
            {verdict === "healthy" ? "Healthy"
              : verdict === "mixed" ? "Worth a look"
              : verdict === "suspect" ? "Suspect"
              : "Too early"}
          </strong>
          <span className="dim small">
            {verdict === "healthy" ? "Referred players behave like everyone else."
              : verdict === "mixed" ? "Referred accounts play noticeably less."
              : verdict === "suspect" ? "Referred accounts barely play — check the table below."
              : `Needs ~20 referrals to mean anything; there are ${q.referredTotal}.`}
          </span>
        </div>
      </div>

      <div className="grid grid-3" style={{ marginTop: 12 }}>
        <div className="kpi">
          <span className="kpi-label">Referrals · last {data.days}d</span>
          <strong className="kpi-value">{data.total}</strong>
          <span className="dim small">{data.totalAllTime} all time</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Master Balls paid</span>
          <strong className="kpi-value">{data.grants}</strong>
          <span className="dim small">one per referral, to the cap</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Milestones reached</span>
          <strong className="kpi-value">{data.milestones}</strong>
          <span className="dim small">$1,000,000 + a shiny each</span>
        </div>
      </div>

      {/* Per-day, as bars. The shape that matters is a SPIKE — a farm is a
          day, not a trend — so the bars are read against the window's peak
          rather than a rolling average that would smooth the spike away. */}
      {data.total > 0 && (
        <div className="ref-spark" style={{ marginTop: 16 }} aria-hidden>
          {series.map(([day, n]) => (
            <span
              key={day}
              className="ref-spark-bar"
              style={{ height: `${Math.max(2, (n / peak) * 100)}%` }}
              title={`${day}: ${n}`}
            />
          ))}
        </div>
      )}

      <h3 style={{ marginTop: 18 }}>Top referrers · last {data.days} days</h3>
      {data.top.length === 0 ? (
        <p className="dim small">No referrals in this window.</p>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Trainer</th>
              <th style={{ textAlign: "right" }}>Brought</th>
              <th style={{ textAlign: "right" }}>Of those, playing</th>
              <th style={{ textAlign: "right" }}>Share</th>
            </tr>
          </thead>
          <tbody>
            {data.top.map((r) => {
              // The row worth looking at: several referrals, none of them
              // playing. Flagged rather than sorted to the top, because the
              // list is ordered by volume on purpose — an operator scanning
              // it is asking "who is biggest", and the flag answers "and is
              // any of it real" without reordering the answer to the first.
              const suspect = r.count >= 5 && r.played === 0;
              return (
                <tr key={r.userId} className={suspect ? "row-warn" : undefined}>
                  <td>{r.username}{suspect && <span className="tag" style={{ marginLeft: 8 }}>none playing</span>}</td>
                  <td style={{ textAlign: "right" }}>{r.count}</td>
                  <td style={{ textAlign: "right" }}>{r.played}</td>
                  <td style={{ textAlign: "right" }}>{pct(r.played, r.count)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
