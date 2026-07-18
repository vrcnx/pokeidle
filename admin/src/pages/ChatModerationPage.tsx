import { useEffect, useMemo, useRef, useState } from "react";
import { api, type ChatMessage } from "../api";
import { navigateTo } from "../App";
import { getSocket } from "../net/socket";

type Filter = "all" | "global" | "area" | "dm" | string;
type Mode = "live" | "search";

function prettyChannel(id: string): string {
  if (id === "global") return "Global";
  if (id === "trade") return "Trade";
  if (id.startsWith("area:")) return id.slice(5);
  if (id.startsWith("dm:")) return "DM";
  return id;
}
function channelClass(id: string): string {
  if (id === "global") return "global";
  if (id === "trade") return "trade";
  if (id.startsWith("area:")) return "area";
  if (id.startsWith("dm:")) return "dm";
  return "other";
}
function isSystemKind(kind: string | undefined): boolean {
  return kind === "announcement" || kind === "giveaway" || kind === "giveawayOpen" || kind === "gift";
}
const SYSTEM_TAG_META: Record<string, { tagClass: string; label: string }> = {
  giveawayOpen: { tagClass: "giveaway", label: "🎁 GIVEAWAY OPEN" },
  giveaway: { tagClass: "giveaway", label: "🎉 GIVEAWAY DRAWN" },
  gift: { tagClass: "gift", label: "🎀 GIFT" },
  announcement: { tagClass: "announcement", label: "📢 ANNOUNCEMENT" },
};

// Mirrors game/src/components/MiniChat.tsx's tier bands exactly, so an
// admin watching live chat sees the same level-tier colors players do.
function levelTierClass(level: number): string {
  if (level >= 200) return "lv-tier-champion";
  if (level >= 150) return "lv-tier-master";
  if (level >= 100) return "lv-tier-elite";
  if (level >= 50) return "lv-tier-veteran";
  return "lv-tier-rookie";
}

export function ChatModerationPage() {
  const [mode, setMode] = useState<Mode>("live");
  return (
    <div className="page chat-mod-page">
      <header className="page-head">
        <h1>Chat</h1>
        <p className="dim">Live view of player chat, plus full-history search.</p>
      </header>
      <div className="seg-tabs" role="tablist" aria-label="View mode" style={{ marginBottom: 16 }}>
        <button
          role="tab" aria-selected={mode === "live"}
          className={`seg-tab ${mode === "live" ? "active" : ""}`}
          onClick={() => setMode("live")}
        >Live</button>
        <button
          role="tab" aria-selected={mode === "search"}
          className={`seg-tab ${mode === "search" ? "active" : ""}`}
          onClick={() => setMode("search")}
        >Search</button>
      </div>
      {mode === "live" ? <LiveChat /> : <ChatSearch />}
    </div>
  );
}

// ─── Live view — real chat window, socket-pushed ───────────────────────
//
// Global is always joined (the server auto-joins every socket to it on
// connect). Area rooms are single-occupancy per socket server-side — a
// socket switching areas silently drops the previous one, the same rule
// a player's own client lives under — so re-selecting an area always
// re-emits chat:join, even if we've visited it before. History for a
// channel is only fetched once and cached thereafter; live messages
// append on top of it, de-duped by id the same way MiniChat does.
const LIVE_CACHE_CAP = 200;

function LiveChat() {
  const [activeChannel, setActiveChannel] = useState<string>("global");
  const [areaOptions, setAreaOptions] = useState<{ id: string; count: number }[]>([]);
  const [byChannel, setByChannel] = useState<Record<string, ChatMessage[]>>({});
  const [connStatus, setConnStatus] = useState<"connecting" | "live" | "disconnected">("connecting");
  const [err, setErr] = useState<string | null>(null);
  const historyFetchedRef = useRef<Set<string>>(new Set());
  const listRef = useRef<HTMLUListElement>(null);
  const nearBottomRef = useRef(true);

  useEffect(() => {
    const sock = getSocket();
    setConnStatus(sock.connected ? "live" : "connecting");
    const onConnect = () => setConnStatus("live");
    const onDisconnect = () => setConnStatus("disconnected");
    const onMessage = (m: ChatMessage) => {
      setByChannel((prev) => {
        const existing = prev[m.channelId] ?? [];
        if (existing.some((x) => x.id === m.id)) return prev;
        return { ...prev, [m.channelId]: [...existing, m].slice(-LIVE_CACHE_CAP) };
      });
    };
    // An admin-triggered clear (from this page or another admin's)
    // should wipe the same public-scope caches a player's own client
    // flushes — mirrors MiniChat's chat:cleared handling.
    const onCleared = ({ scope }: { scope: string }) => {
      if (scope !== "public") return;
      setByChannel((prev) => {
        const next: Record<string, ChatMessage[]> = {};
        for (const [k, v] of Object.entries(prev)) {
          if (k !== "global" && k !== "trade" && !k.startsWith("area:")) next[k] = v;
        }
        return next;
      });
    };
    sock.on("connect", onConnect);
    sock.on("disconnect", onDisconnect);
    sock.on("chat:message", onMessage);
    sock.on("chat:cleared", onCleared);
    return () => {
      sock.off("connect", onConnect);
      sock.off("disconnect", onDisconnect);
      sock.off("chat:message", onMessage);
      sock.off("chat:cleared", onCleared);
    };
  }, []);

  // (Re)join area rooms every time one becomes active. Global never
  // needs an explicit join — every socket is auto-joined server-side.
  useEffect(() => {
    if (activeChannel.startsWith("area:")) {
      getSocket().emit("chat:join", { channelId: activeChannel });
    }
  }, [activeChannel]);

  // Seed scrollback once per channel; live messages take it from there.
  useEffect(() => {
    if (historyFetchedRef.current.has(activeChannel)) return;
    historyFetchedRef.current.add(activeChannel);
    api.recentChat(100, { channel: activeChannel })
      .then((d) => {
        setByChannel((prev) => {
          const existing = prev[activeChannel] ?? [];
          const merged = [...d.messages, ...existing]
            .filter((m, i, arr) => arr.findIndex((x) => x.id === m.id) === i)
            .slice(-LIVE_CACHE_CAP);
          return { ...prev, [activeChannel]: merged };
        });
        if (activeChannel === "global") {
          setAreaOptions(d.channels.filter((c) => c.id.startsWith("area:")));
        }
      })
      .catch((e) => setErr(e.message));
  }, [activeChannel]);

  const messages = byChannel[activeChannel] ?? [];

  // Auto-scroll to the newest message, but only if the admin was
  // already near the bottom — otherwise a live feed keeps yanking them
  // away from scrollback they scrolled up to read.
  useEffect(() => {
    const el = listRef.current;
    if (!el || !nearBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const del = async (id: string) => {
    if (!window.confirm("Delete this message?")) return;
    try {
      await api.deleteChat(id);
      setByChannel((prev) => ({
        ...prev,
        [activeChannel]: (prev[activeChannel] ?? []).filter((m) => m.id !== id),
      }));
    } catch (e: any) {
      setErr(e?.message ?? "delete failed");
    }
  };

  const clearAll = async () => {
    if (!window.confirm(
      "Clear ALL messages in the public live chat (global + all area channels)?\n\n"
      + "This deletes them from the database and wipes them from every connected "
      + "player's screen. DMs are not affected. This cannot be undone."
    )) return;
    setErr(null);
    try {
      const res = await api.clearAllChat();
      setByChannel((prev) => {
        const next: Record<string, ChatMessage[]> = {};
        for (const [k, v] of Object.entries(prev)) {
          if (k !== "global" && !k.startsWith("area:")) next[k] = v;
        }
        return next;
      });
      window.alert(`Cleared ${res.deleted} message${res.deleted === 1 ? "" : "s"}.`);
    } catch (e: any) {
      setErr(e?.message ?? "clear failed");
    }
  };

  return (
    <div className="chat-live-wrap">
      {err && <div className="page-err">{err}</div>}
      <div className="chat-live-toolbar">
        <div className="seg-tabs">
          <button
            className={`seg-tab ${activeChannel === "global" ? "active" : ""}`}
            onClick={() => setActiveChannel("global")}
          >Global</button>
          <button
            className={`seg-tab ${activeChannel === "trade" ? "active" : ""}`}
            onClick={() => setActiveChannel("trade")}
          >Trade</button>
          <button
            className={`seg-tab ${activeChannel.startsWith("area:") ? "active" : ""}`}
            onClick={() => setActiveChannel((c) => (c.startsWith("area:") ? c : areaOptions[0]?.id ?? c))}
            disabled={areaOptions.length === 0}
            title={areaOptions.length === 0 ? "No area channels have recent activity yet" : undefined}
          >Area</button>
        </div>
        {activeChannel.startsWith("area:") && areaOptions.length > 0 && (
          <select value={activeChannel} onChange={(e) => setActiveChannel(e.target.value)}>
            {areaOptions.map((a) => (
              <option key={a.id} value={a.id}>{prettyChannel(a.id)} ({a.count})</option>
            ))}
          </select>
        )}
        <span className={`chat-live-status ${connStatus}`}>
          <span className="chat-live-dot" />
          {connStatus === "live" ? "Live" : connStatus === "connecting" ? "Connecting…" : "Disconnected"}
        </span>
        <button className="btn-danger btn-small" style={{ marginLeft: "auto" }} onClick={clearAll}>
          Clear public chat
        </button>
      </div>

      <ul className="chat-live-list" ref={listRef} onScroll={onScroll}>
        {messages.length === 0 && (
          <li className="chat-empty">No messages yet in this channel.</li>
        )}
        {messages.map((m) => {
          const isSystem = isSystemKind(m.kind);
          const tagMeta = SYSTEM_TAG_META[m.kind ?? ""];
          return (
            <li key={m.id} className={`chat-live-msg ${isSystem ? "system" : ""}`}>
              <div className="chat-live-msg-head">
                {tagMeta && (
                  <span className={`tag ${tagMeta.tagClass}`}>{tagMeta.label}</span>
                )}
                <button
                  className="chat-live-author"
                  onClick={() => navigateTo("users", { userId: m.user.id })}
                  title={`Open @${m.user.username} — ban, inspect save, view sessions`}
                >
                  {isSystem ? "via" : ""} {m.user.name ?? m.user.username}
                </button>
                {!isSystem && (
                  <span className={`chat-live-lv ${levelTierClass(m.user.accountLevel)}`}>
                    Lv {m.user.accountLevel}
                  </span>
                )}
                {m.user.isAdmin && <span className="tag admin">ADMIN</span>}
                {m.kind === "tradeOffer" && <span className="tag trade">🔄 TRADE OFFER</span>}
                <span className="dim small chat-live-time">
                  {new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
                <button className="chat-live-del" title="Delete this message" onClick={() => del(m.id)}>×</button>
              </div>
              <div className="chat-live-body">{m.content}</div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ─── Search view — the original filterable history table ───────────────
function ChatSearch() {
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  const [channelFacets, setChannelFacets] = useState<{ id: string; count: number }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [channel, setChannel] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [username, setUsername] = useState("");
  const [limit, setLimit] = useState(100);

  const reload = () => {
    setBusy(true);
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
      else map.set(m.user.id, { count: 1, username: m.user.username, name: m.user.name, isAdmin: !!m.user.isAdmin });
    }
    return Array.from(map.entries())
      .map(([id, info]) => ({ id, ...info }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
  }, [msgs]);

  return (
    <>
      {err && <div className="page-err">{err}</div>}

      <section className="chat-filter-bar">
        <div className="seg-tabs">
          <button className={`seg-tab ${channel === "all" ? "active" : ""}`} onClick={() => setChannel("all")}>All</button>
          <button className={`seg-tab ${channel === "global" ? "active" : ""}`} onClick={() => setChannel("global")}>Global</button>
          <button className={`seg-tab ${channel === "trade" ? "active" : ""}`} onClick={() => setChannel("trade")}>Trade</button>
          <button className={`seg-tab ${channel === "area" ? "active" : ""}`} onClick={() => setChannel("area")}>Area</button>
          <button className={`seg-tab ${channel === "dm" ? "active" : ""}`} onClick={() => setChannel("dm")}>DM</button>
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
                  {SYSTEM_TAG_META[m.kind ?? ""] && (
                    <span className={`tag ${SYSTEM_TAG_META[m.kind!].tagClass}`}>{SYSTEM_TAG_META[m.kind!].label}</span>
                  )}
                  {m.kind === "tradeOffer" && <span className="tag trade">🔄 TRADE OFFER</span>}
                </div>
                <div className="chat-mod-row-body">{highlight(m.content)}</div>
                <div className="chat-mod-row-actions">
                  <button
                    className="btn-ghost btn-tiny"
                    onClick={() => setUsername(m.user.username)}
                    title="Filter this feed to only this trainer"
                  >Filter</button>
                  <button
                    className="btn-ghost btn-tiny"
                    onClick={() => navigateTo("users", { userId: m.user.id })}
                    title={`Open ${m.user.username} in Users — ban, inspect save, view sessions`}
                  >Open user</button>
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
    </>
  );
}
