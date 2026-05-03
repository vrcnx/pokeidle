import { useEffect, useState } from "react";
import { api, type Analytics } from "../api";

export function AnalyticsPage() {
  const [data, setData] = useState<Analytics | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.analytics().then(setData).catch((e) => setErr(e.message));
  }, []);

  if (err) return <div className="page-err">Error: {err}</div>;
  if (!data) return <div className="page-loading">Loading analytics…</div>;

  // Build a sparkline from the signup series (last 30 days, oldest first).
  const days = Object.keys(data.signupSeries).sort();
  const counts = days.map((d) => data.signupSeries[d]);
  const max = Math.max(1, ...counts);

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
        <Kpi label="Signups (7d)" value={data.activity.signups7d.toLocaleString()} />
        <Kpi label="Friendships" value={data.totals.friendships.toLocaleString()} />
        <Kpi label="Chat messages" value={data.totals.chatMessagesTotal.toLocaleString()} sub={`${data.totals.chatMessages7d} in 7d`} />
        <Kpi label="Banned" value={data.totals.bannedUsers.toLocaleString()} />
        <Kpi label="Admins" value={data.totals.admins.toLocaleString()} />
      </div>

      <section className="card">
        <h2>Signups (last 30 days)</h2>
        <div className="sparkline">
          {counts.map((c, i) => (
            <div key={days[i]} className="sparkbar" title={`${days[i]}: ${c}`}>
              <div className="sparkbar-fill" style={{ height: `${(c / max) * 100}%` }} />
            </div>
          ))}
        </div>
        <div className="sparkline-axis">
          <span>{days[0]}</span>
          <span>{days[days.length - 1]}</span>
        </div>
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

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="kpi">
      <span className="kpi-label">{label}</span>
      <strong className="kpi-value">{value}</strong>
      {sub && <span className="kpi-sub">{sub}</span>}
    </div>
  );
}
