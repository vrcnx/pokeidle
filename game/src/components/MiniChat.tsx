import { useEffect, useRef, useState } from "react";
import { api, type ChatMessage } from "../net/api";
import { getSocket } from "../net/socket";
import { useAuth } from "../auth/AuthContext";
import { openPublicTrainerCard } from "./TrainerCardModal";
import { useOnlineCount } from "../state/presence";
import { censor, hasProfanity, isProfanityFilterOn, subscribeProfanityFilter } from "../utils/profanity";
import { useMuteList } from "../utils/mute";
import { EmojiPicker } from "./EmojiPicker";
import { openGiveaways } from "./GiveawayModal";
import { isSystemKind, SYSTEM_CARD_META } from "../utils/systemChatCards";
import { AuctionBoard } from "./AuctionBoard";
import { PollCard } from "./PollCard";
import { useGame } from "../state/GameContext";
import { SaveStatusDot } from "./ChannelHeader";
import { useT } from "../i18n/useT";

// Compact chat panel for the left column. Two tabs:
//   Global    — server-wide chat (channelId = "global")
//   Auctions  — the auction board (AuctionBoard.tsx), not a chat feed.
//               Replaces the old free-text "offering X for Y" trade-offer
//               cards with picking a specific Pokemon and real bidding —
//               see server/src/routes/auctions.ts + lib/auctionSettlement.ts.
type Tab = "global" | "trade";

const GLOBAL = "global";

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
  const t = useT();

  const [tab, setTab] = useState<Tab>("global");
  const [messagesByChannel, setMessagesByChannel] = useState<Record<string, ChatMessage[]>>({});
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);
  const onlineCount = useOnlineCount();
  const { saveStatus } = useGame();
  const mute = useMuteList();
  void mute.version; // re-render when mute list changes

  // Global is auto-joined server-side on every connection, so this is
  // just history + listeners.
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
    // global + every area:* channel) so the UI flushes immediately
    // without needing a refresh. DM caches are kept intact.
    const onCleared = (payload: { scope: string }) => {
      if (payload?.scope !== "public") return;
      setMessagesByChannel((prev) => {
        const next: Record<string, ChatMessage[]> = {};
        for (const [chan, list] of Object.entries(prev)) {
          if (chan === GLOBAL || chan.startsWith("area:")) continue;
          next[chan] = list;
        }
        return next;
      });
    };
    sock.on("chat:message", onMessage);
    sock.on("chat:cleared", onCleared);
    sock.emit("chat:join", { channelId: GLOBAL });

    api.chatHistory(GLOBAL, 30)
      .then((res) => setMessagesByChannel((prev) => ({ ...prev, [GLOBAL]: res.messages })))
      .catch(() => undefined);

    return () => {
      sock.off("chat:message", onMessage);
      sock.off("chat:cleared", onCleared);
    };
  }, [me]);

  const messages = messagesByChannel[GLOBAL] ?? [];

  // Auto-scroll on new message.
  useEffect(() => {
    if (!listRef.current || tab !== "global") return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, tab]);

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    const content = draft.trim();
    if (!content) return;
    getSocket().emit("chat:send", { channelId: GLOBAL, content });
    setDraft("");
  };

  if (!me) return null;

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
          <span className="mini-chat-dot" /> {t("Global")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "trade"}
          className={`mini-chat-tab ${tab === "trade" ? "active" : ""}`}
          onClick={() => setTab("trade")}
          title={t("Browse and bid on Pokemon auctions")}
        >
          <span className="mini-chat-dot trade" /> {t("Auctions")}
        </button>
        {/* Right side of the single header row. This used to be a second
            row above — "CHAT" plus the same online count again — which spent
            44px restating what the tabs already say. The save warning moved
            down here with it, so it is finally visible on mobile too, where
            MiniChat renders without a ChannelHeader. It only appears when
            saving is actually broken; when saving works, saving is
            invisible. */}
        <span className="mini-chat-meta">
          <SaveStatusDot status={saveStatus} />
          <span
            className="mini-chat-online"
            title={`${onlineCount} player${onlineCount === 1 ? "" : "s"} online`}
            aria-label={`${onlineCount} online`}
          >
            <span className="mini-chat-online-dot" />
            {onlineCount}
          </span>
        </span>
      </div>

      {tab === "trade" ? (
        <AuctionBoard />
      ) : (
        <>
          <div className="mini-chat-list" ref={listRef}>
            {messages.length === 0 && <div className="dim small mini-chat-empty">{t("No messages yet.")}</div>}
            {messages.map((m) => {
              const mine = m.user.id === me.id;
              if (!mine && !isSystemKind(m.kind) && mute.isMuted(m.user.username)) {
                return null;
              }
              if (isSystemKind(m.kind)) {
                return <SystemCard key={m.id} message={m} />;
              }
              return (
                <div key={m.id} className={`mini-chat-msg ${mine ? "mine" : ""}`}>
                  <button
                    type="button"
                    className="mini-chat-author mini-chat-author-link"
                    title={mine ? t("Your trainer") : `View ${m.user.username}'s trainer card`}
                    onClick={() => {
                      if (mine) return;
                      openPublicTrainerCard(m.user.username);
                    }}
                  >
                    {m.user.name ?? m.user.username}
                    {/* Admin badge. The server has always sent isAdmin on every
                        chat message; it simply was not rendered here, so a dev
                        answering a question in global read as any other player.
                        Sits before the level chip because "who is this" matters
                        more than "how far along are they". */}
                    {m.user.isAdmin && (
                      <span className="mini-chat-admin" title={t("Admin")}>
                        ★ {t("ADMIN")}
                      </span>
                    )}
                    <span className={`mini-chat-lv ${levelTierClass(m.user.accountLevel)}`}>
                      {t("Lv ")}{m.user.accountLevel}
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
              placeholder={t("Message Global…")}
              maxLength={500}
            />
            <EmojiPicker onPick={(e) => setDraft((draft + e).slice(0, 500))} />
          </form>
        </>
      )}
    </section>
  );
}

// System-voice card — server announcements, giveaway results, and
// giveaway-opened notices. Posted through the acting admin's real
// account server-side (for audit), but rendered here with no author
// click-through and no Lv chip: it isn't a personal chat message, it's
// a broadcast.
function SystemCard({ message }: { message: ChatMessage }) {
  const t = useT();
  const { icon, label } = SYSTEM_CARD_META[message.kind ?? ""] ?? SYSTEM_CARD_META.announcement;
  if (message.kind === "pollOpen" && message.meta?.pollId) {
    return (
      <div className="mini-chat-system-card">
        <span className="mini-chat-system-icon">{icon}</span>
        <div>
          <strong className="mini-chat-system-label">{label}</strong>
          <PollCard pollId={message.meta.pollId} />
        </div>
      </div>
    );
  }
  return (
    <div className="mini-chat-system-card">
      <span className="mini-chat-system-icon">{icon}</span>
      <div>
        <strong className="mini-chat-system-label">{label}</strong>
        <div className="mini-chat-system-body">{message.content}</div>
        {message.kind === "giveawayOpen" && (
          <button
            type="button"
            className="mini-chat-system-action"
            onClick={() => openGiveaways(message.meta?.giveawayId)}
          >
            {t("View Giveaway")}
          </button>
        )}
        {message.kind === "gift" && message.meta?.username && (
          <button
            type="button"
            className="mini-chat-system-action"
            onClick={() => openPublicTrainerCard(message.meta!.username!)}
          >
            {t("View Trainer")}
          </button>
        )}
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
  const t = useT();
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
          title={revealed ? t("Hide profanity") : t("Show original message")}
        >
          {revealed ? t("hide") : t("show")}
        </button>
      )}
    </span>
  );
}
