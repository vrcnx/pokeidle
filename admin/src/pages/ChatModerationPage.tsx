import { useEffect, useMemo, useState } from "react";
import { api, type ChatMessage } from "../api";

type Filter = "all" | "global" | "area" | "dm" | string;

function prettyChannel(id: string): string {
  if (id === "global") return "Global";
  if (id.startsWith("area:")) return id.slice(5);
  if (id.startsWith("dm:")) return "DM";
  return id;
}
function channelClass(id: string): string {
  if (id === "global") return "global";
  if (id.startsWith("area:")) return "area";
  if (id.startsWith("dm:")) return "dm";
  return "other";
}

export function ChatModerationPage() {
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  const [channelFacets, setChannelFacets] = useState<{ id: string; count: number }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);

  const [channel, setChannel] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [username, setUsername] = useState("");
  const [limit, setLimit] = useState(100);

  const reload = (silent = false) => {
    if (!silent) setBusy(true);
    api.recentChat(limit, {
      channel: channel === "all" ? undefined : channel,
      q: q || undefined,
      username: username || undefined,
    })
      .then((d) => { setMsgs(d.messages); setChannelFacets(d.channels); setErr(null); })
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    const t = setTimeout(() => reload(), q || username ? 280 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, q, username, limit]);

  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(() => reload(true), 8000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, channel, q, username, limit]);

  const del = async (id: string) => {
    if (!window.confirm("Delete this message?")) return;
    await api.deleteChat(id).catch((e) => setErr(e.message));
    setMsgs((m) => m.filter((x) => x.id !== id));
  };

  const clearAll = async () => {
    if (!window.confirm(
      "Clear ALL messages in the public live chat (global + all area channels)?\n\n"
      + "This deletes them from the database and wipes them from every connected "
      + "player's screen. DMs are not affected. This cannot be undone."
    )) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api.clearAllChat();
      setMsgs([]);
      window.alert(`Cleared ${res.deleted} message${res.deleted === 1 ? "" : "s"}.`);
    } catch (e: any) {
      setErr(e?.message ?? "clear failed");
    } finally {
      setBusy(false);
    }
  };

  const highlight = useMemo(() => {
    if (!q) return (s: string) => s;
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(${escaped})`, "ig");
    return (s: string) => s.split(re).map((part, i) =>
      part.toLowerCase() === q.toLowerCase()
        ? <mark key={i} className="chat-match">{part}</mark>
        : <span key={i}>{part}</span>
    );
  }, [q]);

  const topUsers = useMemo(() => {
    const map = new Map<string, { count: number; username: string; name: string | null; isAdmin: boolean }>();
    for (const m of msgs) {
      const prev = map.get(m.user.id);
      if (prev) prev.count += 1;
      else map.set(m.user.id, { count: 1, username: m.user.username, name: m.user.name, isAdmin: m.user.isAdmin });
    }
    return Array.from(map.entries())
      .map(([id, info]) => ({ id, ...info }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
  }, [msgs]);

  return (
    <div className="page chat-mod-page">
      <header className="page-head">
        <h1>Chat moderation</h1>
        <p className="dim">Inspect public live chat across global + area channels. DMs only show via username filter.</p>
      </header>

      {err && <div className="page-err">{err}</div>}

      <section className="chat-filter-bar">
        <div className="seg-tabs">
          <button className={`seg-tab ${channel === "all"    ? "active" : ""}`} onClick={() => setChannel("all")}>All</button>
          <button className={`seg-tab ${channel === "global" ? "active" : ""}`} onClick={() => setChannel("global")}>Global</button>
          <button className={`seg-tab ${channel === "area"   ? "active" : ""}`} onClick={() => setChannel("area")}>Area</button>
          <button className={`seg-tab ${channel === "dm"     ? "active" : ""}`} onClick={() => setChannel("dm")}>DM</button>
        </div>
        <input
          className="search-input"
          placeholder="Search message text…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ minWidth: 220 }}
        />
        <input
          className="search-input"
          placeholder="Filter by trainer username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          style={{ minWidth: 200 }}
        />
        <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} title="Result limit">
          <option value={50}>50</option>
          <option value={100}>100</option>
          <option value={200}>200</option>
          <option value={500}>500</option>
        </select>
        <label className="chat-toggle" title="Re-fetch every 8 seconds while this page is open">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          Live
        </label>
        <button className="btn-ghost btn-small" onClick={() => reload()} disabled={busy}>Refresh</button>
        <button className="btn-danger btn-small" onClick={clearAll} disabled={busy}>Clear public chat</button>
      </section>

      <div className="chat-mod-grid">
        <section className="chat-mod-main">
          <header className="chat-mod-stats">
            <span><strong className="tabular">{msgs.length}</strong> message{msgs.length === 1 ? "" : "s"}</span>
            {channel !== "all" && <span className="dim">· filter: {channel}</span>}
            {q && <span className="dim">· "{q}"</span>}
            {username && <span className="dim">· @{username}</span>}
          </header>
          {msgs.length === 0 && !busy && (
            <div className="chat-empty">No messages match your filters.</div>
          )}
          <ul className="chat-mod-list">
            {msgs.map((m) => (
              <li key={m.id} className="chat-mod-row">
                <div className="chat-mod-row-meta">
                  <span className={`channel-tag ${channelClass(m.channelId)}`} title={m.channelId}>
                    {prettyChannel(m.channelId)}
                  </span>
                  <span className="dim small">
                    {new Date(m.createdAt).toLocaleString([], {
                      month: "short", day: "numeric",
                      hour: "2-digit", minute: "2-digit",
                    })}
                  </span>
                </div>
                <div className="chat-mod-row-trainer">
                  <strong>{m.user.name ?? m.user.username}</strong>
                  <span className="dim small">@{m.user.username}</span>
                  {m.user.isAdmin && <span className="tag admin">ADMIN</span>}
                </div>
                <div className="chat-mod-row-body">{highlight(m.content)}</div>
                <div className="chat-mod-row-actions">
                  <button
                    className="btn-ghost btn-tiny"
                    onClick={() => setUsername(m.user.username)}
                    title="Filter by this trainer"
                  >Filter</button>
                  <button
                    className="btn-danger btn-tiny"
                    onClick={() => del(m.id)}
                  >Delete</button>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <aside className="chat-mod-side">
          <section className="card chat-side-card">
            <h2>Active channels</h2>
            {channelFacets.length === 0
              ? <p className="dim small">No data.</p>
              : (
                <ul className="chat-channel-list">
                  {channelFacets.map((f) => (
                    <li
                      key={f.id}
                      className={`chat-channel-row ${channel === f.id ? "selected" : ""}`}
                      onClick={() => setChannel(f.id)}
                    >
                      <span className={`channel-tag ${channelClass(f.id)}`}>{prettyChannel(f.id)}</span>
                      <span className="tabular dim">{f.count}</span>
                    </li>
                  ))}
                </ul>
              )
            }
          </section>

          <section className="card chat-side-card">
            <h2>Top chatters <span className="dim small">· in view</span></h2>
            {topUsers.length === 0
              ? <p className="dim small">No data.</p>
              : (
                <ul className="chat-top-users">
                  {topUsers.map((u) => (
                    <li key={u.id} className="chat-top-user-row" onClick={() => setUsername(u.username)}>
                      <span className="chat-top-name">
                        <strong>{u.name ?? u.username}</strong>
                        <span className="dim small">@{u.username}</span>
                      </span>
                      <span className="tabular dim">{u.count}</span>
                    </li>
                  ))}
                </ul>
              )
            }
          </section>
        </aside>
      </div>
    </div>
  );
}
