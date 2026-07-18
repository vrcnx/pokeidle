import { useEffect, useRef, useState } from "react";
import { api, type ChatMessage } from "../net/api";
import { getSocket } from "../net/socket";
import { useAuth } from "../auth/AuthContext";
import { sendTradeInvite } from "../state/trade";
import { openPublicTrainerCard } from "./TrainerCardModal";
import { useOnlineCount } from "../state/presence";
import { censor, hasProfanity, isProfanityFilterOn, subscribeProfanityFilter } from "../utils/profanity";
import { useMuteList } from "../utils/mute";
import { pushToast } from "./Toast";
import { EmojiPicker } from "./EmojiPicker";

// Compact chat panel for the left column. Two tabs:
//   Global — server-wide chat (channelId = "global")
//   Trade  — server-wide trade-offer board (channelId = "trade"). Ordinary
//            chat works here too, but players can also post a structured
//            "offering X for Y" card via the Offer button, which anyone
//            can click to open a real trade invite with the poster.
//            Replaces the old per-location "Local" tab — town-specific
//            chat rooms saw almost no use (a handful of messages a week
//            across every town combined, vs hundreds in Global) and this
//            is a much higher-value use of the second tab slot.
type Tab = "global" | "trade";

const GLOBAL = "global";
const TRADE = "trade";

// Account-level tiers for the Lv chip in chat. Bands of 50 levels
// each, capped at "champion" for anything past 200. Each tier maps to
// a CSS modifier class that swaps the chip's colour (see app.css).
function levelTierClass(level: number): string {
  if (level >= 200) return "lv-tier-champion";
  if (level >= 150) return "lv-tier-master";
  if (level >= 100) return "lv-tier-elite";
  if (level >= 50)  return "lv-tier-veteran";
  return "lv-tier-rookie";
}

export function MiniChat() {
  const { me } = useAuth();

  const [tab, setTab] = useState<Tab>("global");
  const [messagesByChannel, setMessagesByChannel] = useState<Record<string, ChatMessage[]>>({});
  const [draft, setDraft] = useState("");
  const [offerMode, setOfferMode] = useState(false);
  const [offering, setOffering] = useState("");
  const [wanting, setWanting] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);
  const onlineCount = useOnlineCount();
  const mute = useMuteList();
  void mute.version; // re-render when mute list changes

  // Wire both always-on channels once. Global and Trade are auto-joined
  // server-side on every connection, so this is just history + listeners.
  useEffect(() => {
    if (!me) return;
    const sock = getSocket();
    if (!sock.connected) sock.connect();

    const onMessage = (msg: ChatMessage) => {
      setMessagesByChannel((prev) => {
        const list = prev[msg.channelId] ?? [];
        if (list.some((x) => x.id === msg.id)) return prev;
        return { ...prev, [msg.channelId]: [...list, msg].slice(-50) };
      });
    };
    // Server fires chat:cleared after an admin wipes the public chat.
    // Drop our cached messages for the affected scope ("public" =
    // global + trade + every area:* channel) so the UI flushes
    // immediately without needing a refresh. DM caches are kept intact.
    const onCleared = (payload: { scope: string }) => {
      if (payload?.scope !== "public") return;
      setMessagesByChannel((prev) => {
        const next: Record<string, ChatMessage[]> = {};
        for (const [chan, list] of Object.entries(prev)) {
          if (chan === GLOBAL || chan === TRADE || chan.startsWith("area:")) continue;
          next[chan] = list;
        }
        return next;
      });
    };
    sock.on("chat:message", onMessage);
    sock.on("chat:cleared", onCleared);
    sock.emit("chat:join", { channelId: GLOBAL });
    sock.emit("chat:join", { channelId: TRADE });

    api.chatHistory(GLOBAL, 30)
      .then((res) => setMessagesByChannel((prev) => ({ ...prev, [GLOBAL]: res.messages })))
      .catch(() => undefined);
    api.chatHistory(TRADE, 30)
      .then((res) => setMessagesByChannel((prev) => ({ ...prev, [TRADE]: res.messages })))
      .catch(() => undefined);

    return () => {
      sock.off("chat:message", onMessage);
      sock.off("chat:cleared", onCleared);
    };
  }, [me]);

  const activeChannel = tab === "global" ? GLOBAL : TRADE;
  const messages = messagesByChannel[activeChannel] ?? [];

  // Auto-scroll on new message in the active tab.
  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, activeChannel]);

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    const content = draft.trim();
    if (!content) return;
    getSocket().emit("chat:send", { channelId: activeChannel, content });
    setDraft("");
  };

  const postOffer = (e: React.FormEvent) => {
    e.preventDefault();
    const o = offering.trim();
    const w = wanting.trim();
    if (!o || !w) return;
    getSocket().emit(
      "chat:send",
      {
        channelId: TRADE,
        content: `Offering ${o} for ${w}`,
        kind: "tradeOffer",
        meta: { offering: o, wanting: w },
      },
      (r: { ok: boolean; error?: string }) => {
        if (!r.ok) pushToast({ kind: "warn", text: `Couldn't post offer${r.error ? `: ${r.error}` : "."}` });
      },
    );
    setOffering("");
    setWanting("");
    setOfferMode(false);
  };

  const openTrade = (userId: string, username: string) => {
    sendTradeInvite(userId, (r) => {
      if (!r.ok) pushToast({ kind: "warn", text: r.error ?? `Couldn't send a trade invite to ${username}.` });
      else pushToast({ kind: "success", text: `Trade invite sent to ${username}.` });
    });
  };

  if (!me) return null;
  const placeholder = tab === "global" ? "Message Global…" : "Message Trade…";

  return (
    <section className="mini-chat ctx-section">
      <div className="mini-chat-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "global"}
          className={`mini-chat-tab ${tab === "global" ? "active" : ""}`}
          onClick={() => setTab("global")}
        >
          <span className="mini-chat-dot" /> Global
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "trade"}
          className={`mini-chat-tab ${tab === "trade" ? "active" : ""}`}
          onClick={() => setTab("trade")}
          title="Post and browse trade offers"
        >
          <span className="mini-chat-dot trade" /> Trade
        </button>
        <span
          className="mini-chat-online"
          title={`${onlineCount} player${onlineCount === 1 ? "" : "s"} online`}
          aria-label={`${onlineCount} online`}
        >
          <span className="mini-chat-online-dot" />
          {onlineCount}
        </span>
      </div>
      <div className="mini-chat-list" ref={listRef}>
        {messages.length === 0 && <div className="dim small mini-chat-empty">No messages yet.</div>}
        {messages.map((m) => {
          const mine = m.user.id === me.id;
          if (!mine && (m.kind ?? "user") !== "announcement" && (m.kind ?? "user") !== "giveaway" && mute.isMuted(m.user.username)) {
            return null;
          }
          if (m.kind === "announcement" || m.kind === "giveaway") {
            return <SystemCard key={m.id} message={m} />;
          }
          if (m.kind === "tradeOffer") {
            return (
              <TradeOfferCard
                key={m.id}
                message={m}
                mine={mine}
                onOpenTrade={() => openTrade(m.user.id, m.user.username)}
              />
            );
          }
          return (
            <div key={m.id} className={`mini-chat-msg ${mine ? "mine" : ""}`}>
              <button
                type="button"
                className="mini-chat-author mini-chat-author-link"
                title={mine ? "Your trainer" : `View ${m.user.username}'s trainer card`}
                onClick={() => {
                  if (mine) return;
                  openPublicTrainerCard(m.user.username);
                }}
              >
                {m.user.name ?? m.user.username}
                <span className={`mini-chat-lv ${levelTierClass(m.user.accountLevel)}`}>
                  Lv {m.user.accountLevel}
                </span>
              </button>
              <ChatBody content={m.content} />
            </div>
          );
        })}
      </div>
      {tab === "trade" && offerMode ? (
        <form className="mini-chat-offer-form" onSubmit={postOffer}>
          <input
            type="text"
            value={offering}
            onChange={(e) => setOffering(e.target.value)}
            placeholder="Offering…"
            maxLength={120}
            autoFocus
          />
          <input
            type="text"
            value={wanting}
            onChange={(e) => setWanting(e.target.value)}
            placeholder="For…"
            maxLength={120}
          />
          <div className="mini-chat-offer-actions">
            <button type="button" className="g-btn-ghost g-btn-small" onClick={() => setOfferMode(false)}>Cancel</button>
            <button type="submit" className="g-btn-primary g-btn-small" disabled={!offering.trim() || !wanting.trim()}>Post</button>
          </div>
        </form>
      ) : (
        <form className="mini-chat-input" onSubmit={send}>
          {tab === "trade" && (
            <button
              type="button"
              className="mini-chat-offer-btn"
              onClick={() => setOfferMode(true)}
              title="Post a trade offer card"
            >🔄 Offer</button>
          )}
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={placeholder}
            maxLength={500}
          />
          <EmojiPicker onPick={(e) => setDraft((d) => (d + e).slice(0, 500))} />
        </form>
      )}
    </section>
  );
}

// System-voice card — server announcements and giveaway results. Posted
// through the acting admin's real account server-side (for audit), but
// rendered here with no author click-through and no Lv chip: it isn't a
// personal chat message, it's a broadcast.
function SystemCard({ message }: { message: ChatMessage }) {
  const isGiveaway = message.kind === "giveaway";
  return (
    <div className="mini-chat-system-card">
      <span className="mini-chat-system-icon">{isGiveaway ? "🎉" : "📢"}</span>
      <div>
        <strong className="mini-chat-system-label">{isGiveaway ? "Giveaway" : "Announcement"}</strong>
        <div className="mini-chat-system-body">{message.content}</div>
      </div>
    </div>
  );
}

// Trade-offer card — a real player's post, still attributable and
// clickable (unlike a system card), plus an action to open a trade
// invite with them directly instead of having to DM/ask around.
function TradeOfferCard({
  message, mine, onOpenTrade,
}: {
  message: ChatMessage;
  mine: boolean;
  onOpenTrade: () => void;
}) {
  return (
    <div className="mini-chat-trade-card">
      <div className="mini-chat-trade-head">
        <button
          type="button"
          className="mini-chat-author mini-chat-author-link"
          title={mine ? "Your trainer" : `View ${message.user.username}'s trainer card`}
          onClick={() => { if (!mine) openPublicTrainerCard(message.user.username); }}
        >
          {message.user.name ?? message.user.username}
        </button>
        {mine
          ? <span className="dim small mini-chat-trade-mine">Your offer</span>
          : <button type="button" className="mini-chat-trade-open" onClick={onOpenTrade}>Open Trade</button>
        }
      </div>
      <div className="mini-chat-trade-body">
        <span className="mini-chat-trade-row"><strong>Offering</strong> {message.meta?.offering ?? "—"}</span>
        <span className="mini-chat-trade-row"><strong>For</strong> {message.meta?.wanting ?? "—"}</span>
      </div>
    </div>
  );
}

// Renders the message body honouring the profanity filter setting.
// When the global filter is on AND the message contains profanity,
// renders a censored version with a "show original" affordance the
// player can click to toggle.
function ChatBody({ content }: { content: string }) {
  const [filterOn, setFilterOn] = useState(() => isProfanityFilterOn());
  const [revealed, setRevealed] = useState(false);
  useEffect(() => subscribeProfanityFilter(setFilterOn), []);

  const dirty = hasProfanity(content);
  const showCensored = filterOn && dirty && !revealed;

  return (
    <span className="mini-chat-body">
      {showCensored ? censor(content) : content}
      {filterOn && dirty && (
        <button
          type="button"
          className="mini-chat-reveal"
          onClick={() => setRevealed((v) => !v)}
          title={revealed ? "Hide profanity" : "Show original message"}
        >
          {revealed ? "hide" : "show"}
        </button>
      )}
    </span>
  );
}
