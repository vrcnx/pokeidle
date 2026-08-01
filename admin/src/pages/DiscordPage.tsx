import { useEffect, useState } from "react";
import { api, type DiscordStats, type DiscordLinkRow } from "../api";
import { DiscordRewardPanel } from "../components/DiscordRewardPanel";
import { XpPanel } from "../components/XpPanel";
import { confirm, notify } from "../components/Confirm";
import { DataTable } from "../components/DataTable";

// The Discord control room: is the bot alive, how many people have linked,
// what are the role thresholds catching, and who is linked to what.
//
// ── WHY LIVENESS IS THE FIRST THING ON THE PAGE ─────────────────────
// Every other number here is meaningless if the bot is not running, and "the
// bot is down" is invisible from inside the game — the game server never talks
// to Discord, so nothing else on this dashboard would ever go red. A stale
// heartbeat is the only signal there is, so it goes at the top.

/** Relative time, in the tense an operator reads it in. */
function ago(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * The bot reconciles every 5 minutes, so a heartbeat older than ~12 is a
 * process that has stopped rather than one that is between passes. Two missed
 * intervals plus slack — tight enough to notice a crash, loose enough that a
 * redeploy does not page anybody.
 */
const STALE_MS = 12 * 60_000;

function BotHealth({ stats }: { stats: DiscordStats }) {
  const last = stats.bot.lastSeenAt;
  const age = last ? Date.now() - new Date(last).getTime() : Infinity;
  const state = !last ? "never" : age < STALE_MS ? "up" : "stale";
  const s = stats.bot.status;

  return (
    <section className={`card dc-health dc-health--${state}`}>
      <div className="dc-health-main">
        <span className={`dc-dot dc-dot--${state}`} />
        <div>
          <strong>
            {state === "up" ? "Bot is running" : state === "stale" ? "Bot has stopped checking in" : "Bot has never checked in"}
          </strong>
          <div className="dim small">
            {state === "never"
              ? "Deploy the bot and set BOT_TOKEN on both services. It reports in on its first role sync."
              : `Last heartbeat ${ago(last)}${state === "stale" ? " — expected every 5 minutes. Check the bot's logs." : ""}`}
          </div>
        </div>
      </div>
      {s && state === "up" && (
        <div className="dc-health-stats dim small">
          <span>{s.guildMembers ?? 0} in server</span>
          <span>{s.linkedMembers ?? 0} linked</span>
          <span>last pass +{s.rolesGranted ?? 0} / −{s.rolesRemoved ?? 0}</span>
        </div>
      )}
    </section>
  );
}

function Tile({ label, value, hint, tone }: { label: string; value: string | number; hint?: string; tone?: string }) {
  return (
    <div className={`card dc-tile${tone ? ` dc-tile--${tone}` : ""}`}>
      <span className="dc-tile-label">{label}</span>
      <strong className="dc-tile-value">{value}</strong>
      {hint && <span className="dim small">{hint}</span>}
    </div>
  );
}

function Thresholds({ stats, onSaved }: { stats: DiscordStats; onSaved: () => void }) {
  const [ace, setAce] = useState(stats.roles.aceTrainerMinLevel);
  const [champ, setChamp] = useState(stats.roles.championMinMatches);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await api.putDiscordConfig({
        // Unchanged — the reward is owned by the panel below, and sending its
        // current value here is what lets one endpoint serve both without the
        // two forms clobbering each other.
        linkRewardEnabled: stats.reward.enabled,
        aceTrainerMinLevel: ace,
        championMinMatches: champ,
      });
      void notify("Thresholds saved. They take effect on the bot's next role sync.");
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  const dirty = ace !== stats.roles.aceTrainerMinLevel || champ !== stats.roles.championMinMatches;

  return (
    <section className="card">
      <h2>Role thresholds</h2>
      <p className="dim small">
        Who the bot automatically gives <strong>Ace Trainer</strong> and{" "}
        <strong>Champion</strong> to. Trainer goes to everyone who links.
      </p>
      {err && <div className="page-err">{err}</div>}

      <div className="dc-threshold-row">
        <label className="gv-field">
          <span>Ace Trainer — minimum account level</span>
          <input
            type="number" min={1} value={ace}
            onChange={(e) => setAce(Math.max(1, Number(e.target.value) || 1))}
          />
        </label>
        {/* The count is the whole point of showing this here rather than in an
            env var: a threshold you cannot see the effect of is a guess. */}
        <div className="dim small dc-threshold-hint">
          Currently <strong>{stats.roles.aceTrainer}</strong> of {stats.links.total} linked
          {stats.links.total === 1 ? " account qualifies" : " accounts qualify"}.
          {stats.links.total > 0 && stats.roles.aceTrainer === stats.links.total && (
            <> Everyone who's linked has it — consider raising the bar.</>
          )}
        </div>
      </div>

      <div className="dc-threshold-row">
        <label className="gv-field">
          <span>Champion — minimum rated matches</span>
          <input
            type="number" min={1} value={champ}
            onChange={(e) => setChamp(Math.max(1, Number(e.target.value) || 1))}
          />
        </label>
        <div className="dim small dc-threshold-hint">
          {stats.roles.champion
            ? <>Currently <strong>@{stats.roles.champion}</strong>
                {!stats.roles.championLinked && <> — but they haven't linked Discord, so nobody holds the role.</>}</>
            : <>Nobody qualifies, so the role is unassigned. Lower this if PvP hasn't picked up yet.</>}
        </div>
      </div>

      <footer className="gv-create-foot">
        <button className="btn-primary" disabled={busy || !dirty} onClick={save}>
          {busy ? "Saving…" : "Save thresholds"}
        </button>
      </footer>
    </section>
  );
}

function LinkedAccounts() {
  const [rows, setRows] = useState<DiscordLinkRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const load = (query = q) => {
    api.discordLinks(query)
      .then((d) => { setRows(d.links); setTotal(d.total); setErr(null); })
      .catch((e) => setErr((e as Error).message));
  };
  useEffect(() => { load(""); }, []);

  const unlink = async (r: DiscordLinkRow) => {
    if (!await confirm(
      `Unlink @${r.username} from Discord?\n\n`
      + `They'll lose Trainer (and any other bot role) on the next sync, and can `
      + `re-link with /link at any time.\n\nThis does NOT ban them or touch their save.`
    )) return;
    try { await api.discordUnlink(r.discordId); load(); }
    catch (e) { setErr((e as Error).message); }
  };

  return (
    <section className="card">
      <header className="dc-links-head">
        <div>
          <h2>Linked accounts</h2>
          <p className="dim small">{total} total</p>
        </div>
        <input
          className="dc-search"
          value={q}
          placeholder="Search username or Discord ID…"
          onChange={(e) => { setQ(e.target.value); }}
          onKeyDown={(e) => { if (e.key === "Enter") load(); }}
        />
      </header>
      {err && <div className="page-err">{err}</div>}

      <DataTable
        rows={rows}
        getKey={(r) => r.discordId}
        defaultSort={{ key: "linkedAt", dir: "desc" }}
        empty={<>Nobody has linked yet. Players run <code>/link</code> in Discord to start.</>}
        columns={[
          {
            key: "username",
            header: "Trainer",
            sort: (r) => r.username,
            render: (r) => (
              <>
                <strong>@{r.username}</strong>
                {/* A banned account holds no bot roles at all, so "why did
                    they lose Trainer" is answered on this row. */}
                {r.banned && <span className="tag banned">banned</span>}
              </>
            ),
          },
          { key: "accountLevel", header: "Level", align: "right", sort: (r) => r.accountLevel, render: (r) => r.accountLevel.toLocaleString() },
          { key: "discordId", header: "Discord ID", sort: (r) => r.discordId, render: (r) => <span className="g-mono small">{r.discordId}</span> },
          { key: "linkedAt", header: "Linked", sort: (r) => r.linkedAt, render: (r) => <span className="dim small">{ago(r.linkedAt)}</span> },
          { key: "lastSeenAt", header: "Last seen", sort: (r) => r.lastSeenAt, render: (r) => <span className="dim small">{ago(r.lastSeenAt)}</span> },
          {
            key: "actions", header: "", align: "right", stopClick: true,
            render: (r) => <button className="btn-ghost btn-tiny" onClick={() => unlink(r)}>Unlink</button>,
          },
        ]}
      />
    </section>
  );
}

export function DiscordPage() {
  const [stats, setStats] = useState<DiscordStats | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    api.discordStats()
      .then((d) => { setStats(d); setErr(null); })
      .catch((e) => setErr((e as Error).message));
  };
  useEffect(() => {
    load();
    // The heartbeat is the point of the page, so it refreshes on its own.
    // 30s rather than the bot's 5-minute cadence: an operator watching this
    // page during a deploy wants to see it come back, not wait a pass.
    const t = window.setInterval(load, 30_000);
    return () => window.clearInterval(t);
  }, []);

  return (
    <div className="page discord-page">
      <header className="page-head">
        <h1>Discord</h1>
        <p className="dim">
          Account linking, roles, rewards and the community bot. The game server
          never talks to Discord — it publishes state and the bot acts on it.
        </p>
      </header>

      {err && <div className="page-err">{err}</div>}
      {!stats && !err && <div className="page-loading">Loading…</div>}

      {stats && (
        <>
          <BotHealth stats={stats} />

          <div className="dc-tiles">
            <Tile label="LINKED ACCOUNTS" value={stats.links.total} hint={`+${stats.links.last7d} this week`} />
            <Tile label="LINKED TODAY" value={stats.links.last24h} />
            <Tile
              label="ACE TRAINER"
              value={stats.roles.aceTrainer}
              hint={`level ${stats.roles.aceTrainerMinLevel}+`}
            />
            <Tile
              label="CHAMPION"
              value={stats.roles.champion ? `@${stats.roles.champion}` : "—"}
              hint={stats.roles.champion && !stats.roles.championLinked ? "not linked" : undefined}
              tone={stats.roles.champion && !stats.roles.championLinked ? "warn" : undefined}
            />
            <Tile
              label="LINK REWARDS PAID"
              value={stats.reward.granted}
              hint={stats.reward.pending > 0 ? `${stats.reward.pending} awaiting next save` : "all delivered"}
            />
            <Tile label="GIVEAWAYS IN DISCORD" value={stats.giveaways.announced} hint={`${stats.giveaways.entries} entries`} />
            <Tile
              label="BUG REPORTS"
              value={stats.bugReports.total}
              hint={`${stats.bugReports.open} open`}
              tone={stats.bugReports.open > 0 ? "warn" : undefined}
            />
            <Tile label="TRADE LISTINGS" value={stats.trade.listings7d} hint="last 7 days" />
            <Tile
              label="XP MEMBERS"
              value={stats.xp.members}
              hint={stats.xp.topLabel ? `top: ${stats.xp.topLabel} (Lv ${stats.xp.topLevel})` : undefined}
            />
          </div>

          <DiscordRewardPanel onSaved={load} />
          <Thresholds stats={stats} onSaved={load} />
          <XpPanel onSaved={load} />
          <LinkedAccounts />
        </>
      )}
    </div>
  );
}
