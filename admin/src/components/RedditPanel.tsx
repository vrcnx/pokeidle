import { useEffect, useState } from "react";
import { api, type RedditConfig, type RedditAnalytics, type GiveawayPrizeInput } from "../api";
import { PrizeBuilder } from "./PrizeBuilder";
import { notify } from "./Confirm";

// The Reddit post reward.
//
// ══ THIS PANEL IS THE VERIFICATION ══════════════════════════════════
//
// The promotion pays out on a link that nothing checks — no fetch, no Reddit
// API, no proof the claimant wrote the post (see server/src/lib/redditReward.ts
// for why). Every other reward in this dashboard is a settings page for
// something the server already polices. This one is not: the server enforces
// "once per account" and "once per link" and then trusts the rest, so the only
// thing standing between the promotion and a farm is somebody reading this
// page.
//
// That is why the analytics are not on a separate tab. The switch, the totals,
// the age-of-account column and the links themselves are one screen, because
// the decision they support — "is this still worth running?" — needs all of
// them at once.
//
// ── WHAT THE COLUMNS ARE FOR ────────────────────────────────────────
//   age at claim   A real player posts about a game they have been playing.
//                  A farm claims from an account minutes old. This is the
//                  single most useful number here.
//   subreddit      A spread of subreddits is people talking. One subreddit
//                  over and over, or a pile of "(no subreddit)" short links,
//                  is one person with a script.
//   per day        A bump is word of mouth. A wall is not.

export function RedditPanel() {
  const [cfg, setCfg] = useState<RedditConfig | null>(null);
  const [stats, setStats] = useState<RedditAnalytics | null>(null);
  const [prizes, setPrizes] = useState<GiveawayPrizeInput[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [showPrizes, setShowPrizes] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<"all" | "pending" | "fresh">("pending");

  const load = () => {
    api.getRedditConfig()
      .then((d) => { setCfg(d); setPrizes(d.prizes as GiveawayPrizeInput[]); setEnabled(d.enabled); setErr(null); })
      .catch((e) => setErr((e as Error).message));
    api.redditAnalytics(30).then(setStats).catch(() => undefined);
  };
  useEffect(load, []);

  const save = async (nextEnabled: boolean) => {
    setBusy(true); setErr(null);
    try {
      const d = await api.putRedditConfig({
        enabled: nextEnabled,
        // OMITTED when empty rather than sent as [], because PrizeListSchema
        // is .min(1) — an empty array is a schema violation that would surface
        // as a bare "invalid body" instead of the real reason, and it means a
        // save can never clobber a configured prize with nothing.
        ...(prizes.length > 0 ? { prizes } : {}),
      });
      setCfg(d); setEnabled(d.enabled);
      void notify(d.enabled
        ? "Reddit reward is ON. Nothing verifies the links — check the claims below."
        : "Reddit reward is OFF. Existing claims are kept.");
    } catch (e) {
      // Reset to what the SERVER believes, not what was clicked. Leaving the
      // toggle on the attempted state after a rejection is how an operator
      // walks away thinking an unverified payout is switched off when it is
      // not.
      setEnabled(cfg?.enabled ?? false);
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  const review = async (userId: string, status: "ok" | "rejected" | "pending") => {
    try {
      await api.reviewRedditPost(userId, status);
      setStats((s) => s && {
        ...s,
        claims: s.claims.map((c) => (c.userId === userId ? { ...c, status } : c)),
      });
      // The pending count lives on the config card, so it has to be refetched
      // rather than guessed at from the row we just changed.
      api.getRedditConfig().then(setCfg).catch(() => undefined);
    } catch (e) {
      void notify(`Couldn't record that: ${(e as Error).message}`);
    }
  };

  const claims = (stats?.claims ?? []).filter((c) =>
    filter === "all" ? true
    : filter === "pending" ? c.status === "pending"
    : c.hoursOld < 24,
  );

  const peakDay = stats?.perDay.reduce((m, d) => Math.max(m, d.n), 0) ?? 0;

  return (
    <section className="card gv-discord-reward">
      <header className="gv-dr-head">
        <div>
          <h2>Reddit post reward</h2>
          <p className="dim small">
            Players paste a link to a post about the game and are paid for it.{" "}
            <strong>Nothing verifies the link.</strong> One claim per account and
            one per link are enforced; everything else is this page.
          </p>
        </div>
        <div className="gv-dr-state">
          {/* Nothing until the server has answered — a tag that reads OFF for a
              moment on a promotion that is on is the same confusion in
              miniature. */}
          {cfg && (
            <span className={`tag ${enabled ? "gv-status--open" : ""}`}>
              {enabled ? "ON" : "OFF"}
            </span>
          )}
        </div>
      </header>

      {err && <div className="page-err">{err}</div>}

      {cfg && (
        <p className="dim small">
          {cfg.totalClaims} claim{cfg.totalClaims === 1 ? "" : "s"}
          {" · "}{cfg.totalGrants} paid
          {cfg.pendingReview > 0 && (
            <> {" · "}<strong>{cfg.pendingReview} awaiting review</strong></>
          )}
          {cfg.updatedBy ? ` · last changed by ${cfg.updatedBy}` : ""}
        </p>
      )}

      <div className="gv-dr-actions">
        <label className="gv-field gv-check">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy}
            onChange={(e) => { setEnabled(e.target.checked); void save(e.target.checked); }}
          />
          <span>
            Pay for Reddit posts
            {/* OFF until switched on, unlike referrals. Referrals are
                self-limiting — somebody has to create an account for a payout.
                This pays for a text box. */}
            <span className="dim small"> — off unless you turn it on</span>
          </span>
        </label>

        <button type="button" className="btn" onClick={() => setShowPrizes((v) => !v)}>
          {showPrizes ? "Hide prize" : "Set prize"}
        </button>
      </div>

      {showPrizes && (
        <div className="gv-dr-prize">
          {/* The SAME builder the giveaway form uses. That matters most for a
              Pokémon prize: it builds a real mon with the real stat formula,
              and a second hand-rolled picker is how you hand out a Lv50
              Charizard with 24 HP. */}
          <PrizeBuilder prizes={prizes} setPrizes={setPrizes} />
          <button type="button" className="btn btn-primary" disabled={busy}
                  onClick={() => void save(enabled)}>
            Save prize
          </button>
        </div>
      )}

      {/* ── What it has actually done ──────────────────────────────── */}
      {stats && (
        <>
          {/* `kpi` / `grid grid-3`, the dashboard's own classes — the same
              ones ReferralAnalyticsPanel uses. A parallel set of stat classes
              would look almost right and drift on the next theme change. */}
          <div className="grid grid-3" style={{ marginTop: 14 }}>
            <div className="kpi">
              <span className="kpi-label">Claims, all time</span>
              <strong className="kpi-value">{stats.total}</strong>
              <span className="dim small">{stats.windowed} in the last {stats.days} days</span>
            </div>
            <div className="kpi">
              {/* The headline farm signal — a real player posts about a game
                  they have been playing. */}
              <span className="kpi-label">From accounts under a day old</span>
              <strong className="kpi-value">{stats.freshAccounts}</strong>
              <span className="dim small">of {stats.windowed} in the window</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Busiest day</span>
              <strong className="kpi-value">{peakDay}</strong>
              <span className="dim small">
                {(stats.byStatus.rejected ?? 0)} rejected all time
              </span>
            </div>
          </div>

          {stats.perSubreddit.length > 0 && (
            <div className="rdt-subs">
              <h3>Where they are posting</h3>
              <ul>
                {stats.perSubreddit.slice(0, 8).map((s) => (
                  <li key={s.subreddit}>
                    <span>{s.subreddit === "(no subreddit)" ? s.subreddit : `r/${s.subreddit}`}</span>
                    <span className="dim">{s.n}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="rdt-list-head">
            <h3>Claims</h3>
            <div className="seg-toggle">
              {(["pending", "fresh", "all"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`seg-tab ${filter === f ? "active" : ""}`}
                  onClick={() => setFilter(f)}
                >
                  {f === "pending" ? "Unreviewed" : f === "fresh" ? "New accounts" : "All"}
                </button>
              ))}
            </div>
          </div>

          {claims.length === 0 ? (
            <p className="dim small">Nothing here.</p>
          ) : (
            <table className="rdt-table">
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Age at claim</th>
                  <th>Post</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {claims.map((c) => (
                  <tr key={c.userId} className={c.hoursOld < 24 ? "is-fresh" : ""}>
                    <td>
                      {c.username}
                      {c.banned && <span className="tag">banned</span>}
                      <span className="dim small"> Lv{c.accountLevel}</span>
                    </td>
                    <td className={c.hoursOld < 24 ? "rdt-warn" : ""}>
                      {c.hoursOld < 24 ? `${c.hoursOld}h` : `${Math.round(c.hoursOld / 24)}d`}
                    </td>
                    <td>
                      {/* noreferrer as well as noopener: this is an untrusted
                          link a player supplied, and there is no reason to tell
                          the destination where the admin dashboard is. */}
                      <a href={c.url} target="_blank" rel="noreferrer noopener">{c.url}</a>
                    </td>
                    <td>{c.status}{c.reviewedBy ? <span className="dim small"> by {c.reviewedBy}</span> : null}</td>
                    <td className="rdt-actions">
                      <button type="button" className="btn" onClick={() => void review(c.userId, "ok")}>OK</button>
                      <button type="button" className="btn" onClick={() => void review(c.userId, "rejected")}>Reject</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <p className="dim small">
            Rejecting records a judgement — it does <strong>not</strong> take the prize
            back. The grant went through the delivery inbox like every other payout and
            may already be in the player's save; clawing it back from here would be an
            admin-triggered save write, which is the thing that destroyed real prizes
            once and was removed. Use the account tools for a repeat offender.
          </p>
        </>
      )}
    </section>
  );
}
