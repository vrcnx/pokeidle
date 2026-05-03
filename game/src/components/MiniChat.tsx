import { useEffect, useRef, useState } from "react";
import { api, type ChatMessage } from "../net/api";
import { getSocket } from "../net/socket";
import { useAuth } from "../auth/AuthContext";
import { useGame } from "../state/GameContext";
import { routes } from "../data/routes";
import { openPublicTrainerCard } from "./TrainerCardModal";
import { censor, hasProfanity, isProfanityFilterOn, subscribeProfanityFilter } from "../utils/profanity";

// Compact chat panel for the left column. Two tabs:
//   Global — server-wide chat (channelId = "global")
//   Local  — area-specific room keyed off the player's currentLocation
//            (channelId = `area:${locationId}`). When the player moves
//            locations, we silently leave the old area room and join the
//            new one. Messages are kept per-channel so switching tabs
//            doesn't clobber the other side's history.
type Tab = "global" | "local";

const GLOBAL = "global";
const areaChannel = (locId: string) => `area:${locId}`;

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
  const { state } = useGame();
  const localChannel = areaChannel(state.currentLocation);
  const localName = routes[state.currentLocation]?.name ?? "Local";

  const [tab, setTab] = useState<Tab>("global");
  const [messagesByChannel, setMessagesByChannel] = useState<Record<string, ChatMessage[]>>({});
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);

  // Wire the global channel once.
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
    sock.on("chat:message", onMessage);
    sock.emit("chat:join", { channelId: GLOBAL });

    api.chatHistory(GLOBAL, 30)
      .then((res) => setMessagesByChannel((prev) => ({ ...prev, [GLOBAL]: res.messages })))
      .catch(() => undefined);

    return () => {
      sock.off("chat:message", onMessage);
    };
  }, [me]);

  // Join/leave the local-area channel as the player moves around. Each
  // channel's history is fetched the first time we visit it; subsequent
  // visits reuse what's cached client-side and pick up new messages via
  // the live socket stream.
  useEffect(() => {
    if (!me) return;
    const sock = getSocket();
    if (!sock.connected) sock.connect();
    sock.emit("chat:join", { channelId: localChannel });

    if (!messagesByChannel[localChannel]) {
      api.chatHistory(localChannel, 30)
        .then((res) =>
          setMessagesByChannel((prev) => ({ ...prev, [localChannel]: res.messages }))
        )
        .catch(() => undefined);
    }

    return () => {
      sock.emit("chat:leave", { channelId: localChannel });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, localChannel]);

  // Auto-scroll on new message in the active tab.
  const activeChannel = tab === "global" ? GLOBAL : localChannel;
  const messages = messagesByChannel[activeChannel] ?? [];
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

  if (!me) return null;
  const placeholder = tab === "global" ? "Message Global…" : `Message ${localName}…`;

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
          aria-selected={tab === "local"}
          className={`mini-chat-tab ${tab === "local" ? "active" : ""}`}
          onClick={() => setTab("local")}
          title={`Chat with players in ${localName}`}
        >
          <span className="mini-chat-dot local" /> {localName}
        </button>
      </div>
      <div className="mini-chat-list" ref={listRef}>
        {messages.length === 0 && <div className="dim small mini-chat-empty">No messages yet.</div>}
        {messages.map((m) => {
          const mine = m.user.id === me.id;
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
      <form className="mini-chat-input" onSubmit={send}>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          maxLength={500}
        />
      </form>
    </section>
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

