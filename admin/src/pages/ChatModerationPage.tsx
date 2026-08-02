import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { confirm, notify } from "../components/Confirm";
import { api, type ChatMessage } from "../api";
import { navigateTo } from "../App";
import { getSocket } from "../net/socket";
import { PageActions, PageNote } from "../components/PageChrome";
import { SectionHead } from "../components/Section";

// Chat moderation.
//
// ── WHAT WAS WRONG WITH IT ──────────────────────────────────────────
// The page did the two things a moderator needs — watch live, search
// history — and made them mutually exclusive. Two modes, two toolbars, two
// delete handlers, two empty states, no shared state: switching from Live to
// Search to look up the person you were just watching threw away the channel
// you were in and the feed you were reading.
//
// Worse, neither mode could delete more than one message at a time, each
// behind its own confirm dialog. Clearing a thirty-message flood was sixty
// clicks. The only shortcut on offer was "Clear public chat", which deletes
// every message in every public channel — so the realistic options were an
// unusable amount of clicking or nuking the server's entire chat history.
// That is not a moderation tool; it is a moderation tool and an emergency
// stop with nothing in between.
//
// ── WHAT IT IS NOW ──────────────────────────────────────────────────
// One list, one row component, one set of actions, in both modes. Selection
// with shift-range and a single confirm for the batch. A per-user sweep for
// the flood case. Keyboard: j/k to move, x to select, Enter to open the
// author, Backspace to delete. Mode, channel and author filter all survive
// the switch between live and search.

type Mode = "live" | "search";
type ChannelFilter = "all" | "global" | "trade" | "area" | "dm" | string;

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

// Mirrors game/src/components/MiniChat.tsx's tier bands exactly, so an admin
// watching live chat sees the same level-tier colours players do.
function levelTierClass(level: number): string {
  if (level >= 200) return "lv-tier-champion";
  if (level >= 150) return "lv-tier-master";
  if (level >= 100) return "lv-tier-elite";
  if (level >= 50) return "lv-tier-veteran";
  return "lv-tier-rookie";
}

const LIVE_CACHE_CAP = 200;

export function ChatModerationPage() {
  const [mode, setMode] = useState<Mode>("live");

  // ── State that OUTLIVES the mode switch ───────────────────────────
  // This is the whole reason the two modes are one component now. A
  // moderator watching #global who wants that user's history should land in
  // search already scoped to them, not back at an unfiltered firehose.
  const [channel, setChannel] = useState<ChannelFilter>("global");
  const [author, setAuthor] = useState("");

  // ── Shared moderation state ───────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState<number>(-1);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The rows currently on screen, published by whichever mode is mounted so
  // the keyboard handler and the bulk bar can act on them without either
  // mode owning a second copy of the logic.
  const [rows, setRows] = useState<ChatMessage[]>([]);
  const lastClickedRef = useRef<number>(-1);

  // Selection must not survive a change of what is on screen — a checked id
  // that is no longer visible is a row the moderator cannot see and would
  // delete anyway. Prune to what is actually displayed.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(rows.map((r) => r.id));
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [rows]);

  const toggleOne = useCallback((id: string, index: number, shiftKey: boolean) => {
    // Read the anchor HERE, not inside the updater.
    //
    // The updater does not run when setSelected is called — it runs later,
    // during the render pass. Reading lastClickedRef inside it therefore saw
    // the value assigned by THIS click, so every shift-range came out as
    // n..n and selected exactly one row. It looked like shift was being
    // ignored; it was being applied to a range of length one.
    const anchor = lastClickedRef.current;
    lastClickedRef.current = index;

    setSelected((prev) => {
      const next = new Set(prev);
      // Shift-click selects the range from the last clicked row, the
      // convention every mail client and file manager uses. Without it,
      // selecting a flood is still one click per message.
      if (shiftKey && anchor >= 0) {
        const [a, b] = [anchor, index].sort((x, y) => x - y);
        const turningOn = !prev.has(id);
        for (let i = a; i <= b; i++) {
          const rowId = rows[i]?.id;
          if (!rowId) continue;
          if (turningOn) next.add(rowId); else next.delete(rowId);
        }
      } else if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, [rows]);

  const removeLocally = useCallback((ids: Set<string>) => {
    setRows((prev) => prev.filter((m) => !ids.has(m.id)));
    setSelected(new Set());
  }, []);

  const deleteIds = useCallback(async (ids: string[], label: string) => {
    if (ids.length === 0) return;
    if (!await confirm(
      `Delete ${ids.length} message${ids.length === 1 ? "" : "s"}${label ? ` ${label}` : ""}?\n\n`
      + `This removes them from the database and from every connected player's screen. It cannot be undone.`,
    )) return;
    setBusy(true);
    setErr(null);
    try {
      // One request, one audit row. N requests would also produce N audit
      // rows for a single decision, burying every other action that hour.
      const res = ids.length === 1
        ? (await api.deleteChat(ids[0]), { deleted: 1 })
        : await api.bulkDeleteChat(ids);
      removeLocally(new Set(ids));
      void notify(`Deleted ${res.deleted} message${res.deleted === 1 ? "" : "s"}.`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [removeLocally]);

  // ── Keyboard ──────────────────────────────────────────────────────
  // A moderator clearing a flood should not have to move the mouse. The
  // handler ignores anything typed into a field, so the search boxes still
  // work normally.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (rows.length === 0) return;

      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault(); setCursor((c) => Math.min(rows.length - 1, c + 1));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault(); setCursor((c) => Math.max(0, c - 1));
      } else if (e.key === "x" && cursor >= 0) {
        e.preventDefault(); toggleOne(rows[cursor].id, cursor, e.shiftKey);
      } else if (e.key === "Enter" && cursor >= 0) {
        e.preventDefault(); navigateTo("users", { userId: rows[cursor].user.id });
      } else if ((e.key === "Backspace" || e.key === "Delete")) {
        e.preventDefault();
        const ids = selected.size > 0 ? [...selected] : cursor >= 0 ? [rows[cursor].id] : [];
        void deleteIds(ids, "");
      } else if (e.key === "Escape") {
        setSelected(new Set()); setCursor(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, cursor, selected, toggleOne, deleteIds]);

  // Keep the cursor row in view when moving by keyboard.
  useEffect(() => {
    if (cursor < 0) return;
    document.querySelector<HTMLElement>(".chat-row.is-cursor")?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  // How many of the visible rows belong to the selection's authors — the
  // flood case, where one person posted thirty of the forty rows on screen.
  const sweep = useMemo(() => {
    if (selected.size === 0) return null;
    const authors = new Set(rows.filter((r) => selected.has(r.id)).map((r) => r.user.id));
    if (authors.size !== 1) return null;
    const authorId = [...authors][0];
    const all = rows.filter((r) => r.user.id === authorId);
    if (all.length <= selected.size) return null;
    const row = rows.find((r) => r.user.id === authorId)!;
    return { username: row.user.username, ids: all.map((r) => r.id), count: all.length };
  }, [selected, rows]);

  const clearPublic = async () => {
    // Type-to-confirm, the same gate as user deletion. This wipes every
    // public message on the server; an OK/Cancel next to the ordinary
    // controls is far too easy to reach for when a flood is in progress —
    // which is exactly when someone reaches for it.
    const typed = window.prompt(
      "Clear ALL public chat?\n\n"
      + "This deletes every message in Global, Trade and every area channel, from the "
      + "database and from every connected player's screen. DMs are not affected. "
      + "It cannot be undone.\n\n"
      + "There is almost always a better tool: select the offending messages and delete "
      + "those instead.\n\n"
      + "Type CLEAR to confirm:",
    );
    if (typed === null) return;
    if (typed.trim().toUpperCase() !== "CLEAR") {
      setErr("Clear aborted — you did not type CLEAR.");
      return;
    }
    setBusy(true); setErr(null);
    try {
      const res = await api.clearAllChat();
      setRows([]);
      setSelected(new Set());
      void notify(`Cleared ${res.deleted} message${res.deleted === 1 ? "" : "s"}.`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const shared = {
    channel, setChannel, author, setAuthor,
    rows, setRows, selected, toggleOne, cursor, setCursor,
    deleteIds, busy,
  };

  return (
    <div className="page chat-mod-page">
      <PageNote>
        {mode === "live" ? "Watching live" : "Searching history"}
        {author && ` · @${author}`}
      </PageNote>
      <PageActions>
        <div className="seg-toggle" role="tablist" aria-label="View mode">
          <button role="tab" aria-selected={mode === "live"}
                  className={`seg-tab ${mode === "live" ? "active" : ""}`}
                  onClick={() => setMode("live")}>Live</button>
          <button role="tab" aria-selected={mode === "search"}
                  className={`seg-tab ${mode === "search" ? "active" : ""}`}
                  onClick={() => setMode("search")}>Search</button>
        </div>
        {/* Deliberately a quiet ghost button, not a red one sitting beside
            Refresh. It is the largest destructive action in the dashboard and
            it should take a moment of deliberate intent to reach. */}
        <button className="btn-ghost btn-small chat-clear-all" onClick={clearPublic} disabled={busy}>
          Clear<span className="chat-clear-all__long"> public chat</span>…
        </button>
      </PageActions>

      {err && <div className="page-err">{err}</div>}

      {mode === "live" ? <LiveChat {...shared} /> : <ChatSearch {...shared} />}

      {/* One bar, both modes. It was absent from both before. */}
      {selected.size > 0 && (
        <div className="bulk-bar chat-bulk-bar" role="region" aria-label="Selected messages">
          <strong className="tabular">{selected.size}</strong>
          <span>selected</span>
          <button className="linklike" onClick={() => setSelected(new Set())}>Clear</button>
          <div className="bulk-bar-actions">
            {sweep && (
              <button
                className="btn-secondary btn-small"
                disabled={busy}
                onClick={() => void deleteIds(sweep.ids, `from @${sweep.username} in this view`)}
                title="The flood case: one person posted more than you selected"
              >
                Delete all {sweep.count} from @{sweep.username}
              </button>
            )}
            <button
              className="btn-danger btn-small"
              disabled={busy}
              onClick={() => void deleteIds([...selected], "")}
            >
              Delete selected
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

interface SharedProps {
  channel: ChannelFilter;
  setChannel: (c: ChannelFilter) => void;
  author: string;
  setAuthor: (v: string) => void;
  rows: ChatMessage[];
  setRows: (r: ChatMessage[] | ((p: ChatMessage[]) => ChatMessage[])) => void;
  selected: Set<string>;
  toggleOne: (id: string, index: number, shift: boolean) => void;
  cursor: number;
  setCursor: (n: number) => void;
  deleteIds: (ids: string[], label: string) => Promise<void>;
  busy: boolean;
}

// ─── Live ───────────────────────────────────────────────────────────
//
// Global is always joined (the server auto-joins every socket on connect).
// Area rooms are single-occupancy per socket server-side — a socket switching
// areas silently drops the previous one — so re-selecting an area always
// re-emits chat:join. History is fetched once per channel and cached; live
// messages append on top, de-duped by id the same way MiniChat does.
function LiveChat(p: SharedProps) {
  const [areaOptions, setAreaOptions] = useState<{ id: string; count: number }[]>([]);
  const [byChannel, setByChannel] = useState<Record<string, ChatMessage[]>>({});
  const [connStatus, setConnStatus] = useState<"connecting" | "live" | "disconnected">("connecting");
  const [filter, setFilter] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const historyFetchedRef = useRef<Set<string>>(new Set());
  const listRef = useRef<HTMLUListElement>(null);
  const nearBottomRef = useRef(true);

  // Live mode needs a concrete channel, not a category. "all"/"area"/"dm"
  // are search filters; carrying one in from search would ask the socket to
  // join a room that does not exist.
  const activeChannel = p.channel === "all" || p.channel === "area" || p.channel === "dm"
    ? "global"
    : p.channel;

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
    // An admin-triggered clear (from this page or another admin's) should
    // wipe the same public-scope caches a player's client flushes.
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

  useEffect(() => {
    if (activeChannel.startsWith("area:")) {
      getSocket().emit("chat:join", { channelId: activeChannel });
    }
  }, [activeChannel]);

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

  const visible = useMemo(() => {
    let list = byChannel[activeChannel] ?? [];
    const f = filter.trim().toLowerCase();
    if (f) {
      list = list.filter((m) =>
        m.content.toLowerCase().includes(f)
        || m.user.username.toLowerCase().includes(f)
        || (m.user.name ?? "").toLowerCase().includes(f));
    }
    if (p.author) {
      list = list.filter((m) => m.user.username.toLowerCase() === p.author.toLowerCase());
    }
    return list;
  }, [byChannel, activeChannel, filter, p.author]);

  // Publish upward so the shared keyboard handler and bulk bar operate on
  // exactly what is on screen.
  const setRows = p.setRows;
  useEffect(() => { setRows(visible); }, [visible, setRows]);

  // Auto-scroll to the newest message, but only if the moderator was already
  // near the bottom — otherwise a live feed keeps yanking them away from the
  // scrollback they deliberately scrolled up to read.
  useEffect(() => {
    const el = listRef.current;
    if (!el || !nearBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [visible.length]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  return (
    <>
      <SectionHead
        title={prettyChannel(activeChannel)}
        blurb="Messages as they are posted, straight from the socket."
        aside={
          <span className={`liveops-status is-${connStatus === "live" ? "live" : connStatus === "connecting" ? "stale" : "down"}`}>
            <span className="liveops-status-dot" />
            {connStatus === "live" ? "Live" : connStatus === "connecting" ? "Connecting…" : "Disconnected"}
          </span>
        }
      />

      {err && <div className="page-err">{err}</div>}

      <div className="chat-toolbar">
        <div className="seg-toggle">
          <button className={`seg-tab ${activeChannel === "global" ? "active" : ""}`}
                  onClick={() => p.setChannel("global")}>Global</button>
          <button className={`seg-tab ${activeChannel === "trade" ? "active" : ""}`}
                  onClick={() => p.setChannel("trade")}>Trade</button>
          <button className={`seg-tab ${activeChannel.startsWith("area:") ? "active" : ""}`}
                  onClick={() => p.setChannel(activeChannel.startsWith("area:") ? activeChannel : areaOptions[0]?.id ?? "global")}
                  disabled={areaOptions.length === 0}
                  title={areaOptions.length === 0 ? "No area channels have recent activity yet" : undefined}>
            Area
          </button>
        </div>
        {activeChannel.startsWith("area:") && areaOptions.length > 0 && (
          <select value={activeChannel} onChange={(e) => p.setChannel(e.target.value)}>
            {areaOptions.map((a) => (
              <option key={a.id} value={a.id}>{prettyChannel(a.id)} ({a.count})</option>
            ))}
          </select>
        )}
        <input
          className="search-input chat-filter-input"
          placeholder="Filter this channel…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {p.author && (
          <button className="chat-author-chip" onClick={() => p.setAuthor("")} title="Clear author filter">
            @{p.author} <span aria-hidden>×</span>
          </button>
        )}
        <KeyHint />
      </div>

      <ul className="chat-list card" ref={listRef} onScroll={onScroll}>
        {visible.length === 0 && (
          <li className="chat-empty">
            {filter || p.author ? "No messages here match that filter." : "No messages yet in this channel."}
          </li>
        )}
        {visible.map((m, i) => (
          <MessageRow
            key={m.id} m={m} index={i}
            selected={p.selected.has(m.id)}
            isCursor={p.cursor === i}
            onToggle={p.toggleOne}
            onFocus={() => p.setCursor(i)}
            onFilterAuthor={() => p.setAuthor(m.user.username)}
            onDelete={() => void p.deleteIds([m.id], "")}
            showChannel={false}
          />
        ))}
      </ul>
    </>
  );
}

// ─── Search ─────────────────────────────────────────────────────────
function ChatSearch(p: SharedProps) {
  const [channelFacets, setChannelFacets] = useState<{ id: string; count: number }[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(100);

  const setRows = p.setRows;
  const { channel, author } = p;

  const reload = useCallback(() => {
    setLoading(true);
    api.recentChat(limit, {
      channel: channel === "all" ? undefined : channel,
      q: q || undefined,
      username: author || undefined,
    })
      .then((d) => { setRows(d.messages); setChannelFacets(d.channels); setErr(null); })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [limit, channel, q, author, setRows]);

  useEffect(() => {
    const t = setTimeout(reload, q || author ? 280 : 0);
    return () => clearTimeout(t);
  }, [reload, q, author]);

  const highlight = useMemo(() => {
    if (!q) return (s: string) => s as React.ReactNode;
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(${escaped})`, "ig");
    return (s: string) => s.split(re).map((part, i) =>
      part.toLowerCase() === q.toLowerCase()
        ? <mark key={i} className="chat-match">{part}</mark>
        : <span key={i}>{part}</span>) as React.ReactNode;
  }, [q]);

  const topUsers = useMemo(() => {
    const map = new Map<string, { count: number; username: string; name: string | null }>();
    for (const m of p.rows) {
      const prev = map.get(m.user.id);
      if (prev) prev.count += 1;
      else map.set(m.user.id, { count: 1, username: m.user.username, name: m.user.name });
    }
    return Array.from(map.entries())
      .map(([id, info]) => ({ id, ...info }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
  }, [p.rows]);

  return (
    <>
      <SectionHead
        title="History"
        blurb="Every message the server still holds, including DMs."
        aside={<span className="dim small">{loading ? "Searching…" : `${p.rows.length} shown`}</span>}
      />

      {err && <div className="page-err">{err}</div>}

      <div className="chat-toolbar">
        <div className="seg-toggle">
          {(["all", "global", "trade", "area", "dm"] as const).map((c) => (
            <button key={c} className={`seg-tab ${channel === c ? "active" : ""}`}
                    onClick={() => p.setChannel(c)}>
              {c === "all" ? "All" : prettyChannel(c)}
            </button>
          ))}
        </div>
        <input className="search-input chat-filter-input" placeholder="Search message text…"
               value={q} onChange={(e) => setQ(e.target.value)} />
        <input className="search-input chat-author-input" placeholder="Trainer username"
               value={author} onChange={(e) => p.setAuthor(e.target.value)} />
        <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} title="Result limit">
          {[50, 100, 200, 500].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <KeyHint />
      </div>

      <div className="chat-grid">
        <ul className="chat-list card">
          {p.rows.length === 0 && !loading && (
            <li className="chat-empty">No messages match your filters.</li>
          )}
          {p.rows.map((m, i) => (
            <MessageRow
              key={m.id} m={m} index={i}
              selected={p.selected.has(m.id)}
              isCursor={p.cursor === i}
              onToggle={p.toggleOne}
              onFocus={() => p.setCursor(i)}
              onFilterAuthor={() => p.setAuthor(m.user.username)}
              onDelete={() => void p.deleteIds([m.id], "")}
              highlight={highlight}
              showChannel
            />
          ))}
        </ul>

        <aside className="chat-side">
          <section className="card">
            <header className="card-head"><div><h2>Channels</h2></div></header>
            {channelFacets.length === 0
              ? <p className="dim small">No data.</p>
              : (
                <ul className="chat-facet-list">
                  {channelFacets.map((f) => (
                    <li key={f.id}>
                      <button className={`chat-facet ${channel === f.id ? "is-active" : ""}`}
                              onClick={() => p.setChannel(f.id)}>
                        <span className={`channel-tag ${channelClass(f.id)}`}>{prettyChannel(f.id)}</span>
                        <span className="tabular dim">{f.count}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
          </section>

          <section className="card">
            <header className="card-head">
              <div><h2>Top chatters</h2><p>Within the results below.</p></div>
            </header>
            {topUsers.length === 0
              ? <p className="dim small">No data.</p>
              : (
                <ul className="chat-facet-list">
                  {topUsers.map((u) => (
                    <li key={u.id}>
                      <button className={`chat-facet ${author === u.username ? "is-active" : ""}`}
                              onClick={() => p.setAuthor(u.username)}>
                        <span className="chat-facet__name">
                          <strong>{u.name ?? u.username}</strong>
                          <span className="dim small">@{u.username}</span>
                        </span>
                        <span className="tabular dim">{u.count}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
          </section>
        </aside>
      </div>
    </>
  );
}

/**
 * One message. The SAME component in live and in search — previously these
 * were two different layouts with two different action sets, so a moderator
 * had to re-learn the row every time they switched mode, and a fix to one
 * never reached the other.
 */
function MessageRow({
  m, index, selected, isCursor, onToggle, onFocus, onFilterAuthor, onDelete, highlight, showChannel,
}: {
  m: ChatMessage;
  index: number;
  selected: boolean;
  isCursor: boolean;
  onToggle: (id: string, index: number, shift: boolean) => void;
  onFocus: () => void;
  onFilterAuthor: () => void;
  onDelete: () => void;
  highlight?: (s: string) => React.ReactNode;
  showChannel: boolean;
}) {
  const isSystem = isSystemKind(m.kind);
  const tagMeta = SYSTEM_TAG_META[m.kind ?? ""];
  return (
    <li
      className={`chat-row${selected ? " is-selected" : ""}${isCursor ? " is-cursor" : ""}${isSystem ? " is-system" : ""}`}
      onMouseDown={onFocus}
    >
      <input
        type="checkbox"
        className="chat-row__check"
        aria-label={`Select message from ${m.user.username}`}
        checked={selected}
        // onClick, not onChange: onChange gives no modifier keys, and
        // shift-range is the whole point of having checkboxes here.
        onClick={(e) => { e.stopPropagation(); onToggle(m.id, index, e.shiftKey); }}
        onChange={() => { /* handled above */ }}
      />
      <div className="chat-row__main">
        <div className="chat-row__head">
          {showChannel && (
            <span className={`channel-tag ${channelClass(m.channelId)}`} title={m.channelId}>
              {prettyChannel(m.channelId)}
            </span>
          )}
          {tagMeta && <span className={`tag ${tagMeta.tagClass}`}>{tagMeta.label}</span>}
          <button className="chat-row__author" onClick={onFilterAuthor}
                  title={`Filter to @${m.user.username}`}>
            {isSystem ? "via " : ""}{m.user.name ?? m.user.username}
          </button>
          <span className="dim small">@{m.user.username}</span>
          {!isSystem && (
            <span className={`chat-lv ${levelTierClass(m.user.accountLevel)}`}>Lv {m.user.accountLevel}</span>
          )}
          {m.user.isAdmin && <span className="tag admin">ADMIN</span>}
          {m.kind === "tradeOffer" && <span className="tag trade">🔄 TRADE OFFER</span>}
          <time className="dim small chat-row__time" dateTime={m.createdAt}
                title={new Date(m.createdAt).toLocaleString()}>
            {new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </time>
        </div>
        <div className="chat-row__body">{highlight ? highlight(m.content) : m.content}</div>
      </div>
      {/* Actions appear on hover or when the row is the keyboard cursor.
          Always-visible buttons on 200 rows is 600 buttons of noise. */}
      <div className="chat-row__actions">
        <button className="btn-ghost btn-tiny"
                onClick={() => navigateTo("users", { userId: m.user.id })}
                title="Open in Users — ban, inspect save, sessions">Open</button>
        <button className="btn-danger btn-tiny" onClick={onDelete}>Delete</button>
      </div>
    </li>
  );
}

/** The shortcuts, on screen. A keyboard interface nobody knows about is a
 *  keyboard interface nobody uses. */
function KeyHint() {
  return (
    <span className="chat-keyhint dim small" title="j/k move · x select (shift for a range) · Enter open author · Backspace delete · Esc clear">
      <kbd>j</kbd><kbd>k</kbd> move <kbd>x</kbd> select <kbd>⌫</kbd> delete
    </span>
  );
}
