import { useEffect, useMemo, useRef, useState } from "react";
import { HubViews } from "./HubModal";
import { api, type ChatMessage, type FriendEntry, type FriendList, type MeProfile } from "../net/api";
import { getSocket } from "../net/socket";
import { useAuth } from "../auth/AuthContext";
import { useModalEnter } from "../utils/animate";
import { openPublicTrainerCard } from "./TrainerCardModal";
import { useMuteList } from "../utils/mute";
import { EmojiPicker } from "./EmojiPicker";
import { openGiveaways } from "./GiveawayModal";
import { isSystemKind, SYSTEM_CARD_META } from "../utils/systemChatCards";
import { PollCard } from "./PollCard";
import { obtainableCount } from "../utils/obtainable";
import { useT } from "../i18n/useT";

// Denominator for another trainer's public dex count. The server clamps the
// figure it serves (server/src/lib/level.ts MAX_TOTAL_DEX); this must be the
// same ceiling or the directory renders things like "288/245". It was a
// literal 245 in two places, which is exactly how it drifted the first time.
const DEX_TOTAL = obtainableCount();

// Social drawer rebuilt on the shared `.g-modal` shell. Two tabs:
//   Chat    — channels list (Global + DMs) + thread + composer
//   Friends — add form + incoming / pending / accepted lists

type Tab = "chat" | "friends" | "directory";
type ChannelKey = string; // "global" or "dm:<userIdA>:<userIdB>"

function dmChannel(a: string, b: string): ChannelKey {
  const [x, y] = [a, b].sort();
  return `dm:${x}:${y}`;
}

/**
 * The Social PANE — chat, friends and the trainer directory.
 *
 * `fill` in the hub's terms: it lays out to the pane's full height and
 * scrolls its own message list, because an outer scroll would put the
 * composer below the fold. That is the whole reason HubSectionContent has
 * the flag at all.
 *
 * Its tab row was already the shared .g-tab — it is the only one of the four
 * sections that arrived speaking the design system — so it only had to move
 * out of a modal header and into the shared .hub-views row.
 */
export function SocialPane() {
  const { me } = useAuth();
  const [tab, setTab] = useState<Tab>("chat");
  const [friends, setFriends] = useState<FriendList | null>(null);
  const [activeChannel, setActiveChannel] = useState<ChannelKey>("global");
  const [messagesByChannel, setMessagesByChannel] = useState<Record<ChannelKey, ChatMessage[]>>({});
  const [presence, setPresence] = useState<Record<string, boolean>>({});
  // Last-seen index per channel — anything past it counts as unread.
  // Channels the player has never opened during this session start at 0
  // so any incoming message is flagged. The Global channel is auto-marked
  // read on mount since that's the default landing channel.
  const [lastReadByChannel, setLastReadByChannel] = useState<Record<ChannelKey, number>>({});
  const messagesRef = useRef<HTMLDivElement | null>(null);
  // Whether the user is pinned to the bottom of the current thread. Starts
  // true (a freshly opened thread lands on the newest message) and flips to
  // false when they scroll up to read history — so an incoming message no
  // longer yanks them back down mid-read. Reset on channel switch.
  const stickToBottomRef = useRef(true);

  const refreshFriends = async () => {
    try {
      const list = await api.listFriends();
      setFriends(list);
    } catch { /* */ }
  };

  // Mount IS "opened" now: the hub renders a section only while it is the
  // active one, so this component's lifetime is exactly the window in which
  // a fresh friends list matters.
  useEffect(() => {
    refreshFriends();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!me) return;
    const sock = getSocket();
    if (!sock.connected) sock.connect();

    const onMessage = (msg: ChatMessage) => {
      setMessagesByChannel((m) => {
        const cur = m[msg.channelId] ?? [];
        if (cur.some((c) => c.id === msg.id)) return m;
        // Cap each channel's history at 200. Mirrors MiniChat's smaller
        // 50-message cap; the full social panel keeps a longer scrollback
        // since it's the dedicated chat surface, but still bounded so a
        // long-running session doesn't grow unbounded.
        const next = [...cur, msg];
        return { ...m, [msg.channelId]: next.length > 200 ? next.slice(-200) : next };
      });
    };
    const onPresence = (p: { userId: string; online: boolean }) => {
      setPresence((s) => ({ ...s, [p.userId]: p.online }));
    };
    const onConnect = () => {
      sock.emit("chat:join", { channelId: "global" });
    };
    sock.on("chat:message", onMessage);
    sock.on("presence:update", onPresence);
    sock.on("connect", onConnect);
    sock.emit("chat:join", { channelId: "global" });

    return () => {
      sock.off("chat:message", onMessage);
      sock.off("presence:update", onPresence);
      sock.off("connect", onConnect);
    };
  }, [me]);

  useEffect(() => {
    if (!activeChannel) return;
    let cancelled = false;
    api.chatHistory(activeChannel, 50)
      .then((res) => {
        if (cancelled) return;
        setMessagesByChannel((m) => ({ ...m, [activeChannel]: res.messages }));
      })
      .catch(() => undefined);
    const sock = getSocket();
    if (sock.connected) sock.emit("chat:join", { channelId: activeChannel });
    return () => { cancelled = true; };
  }, [activeChannel]);

  // Channel switch → always jump to the newest message.
  useEffect(() => {
    stickToBottomRef.current = true;
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeChannel]);

  // New messages → only auto-scroll if the user is still at the bottom.
  useEffect(() => {
    const el = messagesRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messagesByChannel]);

  // Mark the active channel read whenever its message list grows OR the
  // user switches to it. Setting lastRead = list.length means every new
  // message lands as unread for ONE render, then we update it on the
  // next pass — which is fine because the channel is visibly open.
  useEffect(() => {
    const len = (messagesByChannel[activeChannel] ?? []).length;
    setLastReadByChannel((prev) =>
      prev[activeChannel] === len ? prev : { ...prev, [activeChannel]: len }
    );
  }, [activeChannel, messagesByChannel]);

  // The entrance animation belongs to the hub frame now — one dialog, one
  // entrance. A second one here would play a modal-open animation on a pane
  // that is already on screen.
  const t = useT();

  if (!me) return null;

  const incomingCount = friends?.incoming.length ?? 0;

  return (
    <div className="social-pane">
        <HubViews>
          <div className="g-tabs" role="tablist" aria-label={t("Social")}>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "chat"}
              className={`g-tab ${tab === "chat" ? "active" : ""}`}
              onClick={() => setTab("chat")}
            >
              {t("Chat")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "friends"}
              className={`g-tab ${tab === "friends" ? "active" : ""}`}
              onClick={() => setTab("friends")}
            >
              {t("Friends")}
              {incomingCount > 0 && <span className="g-tab-pill">{incomingCount}</span>}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "directory"}
              className={`g-tab ${tab === "directory" ? "active" : ""}`}
              onClick={() => setTab("directory")}
            >
              {t("Trainers")}
            </button>
          </div>
        </HubViews>

        {tab === "chat" && (
          <ChatTab
            me={me}
            friends={friends}
            activeChannel={activeChannel}
            setActiveChannel={setActiveChannel}
            messages={messagesByChannel[activeChannel] ?? []}
            messagesRef={messagesRef}
            stickToBottomRef={stickToBottomRef}
            presence={presence}
            unreadFor={(key) => {
              const total = (messagesByChannel[key] ?? []).length;
              const seen = lastReadByChannel[key] ?? 0;
              return Math.max(0, total - seen);
            }}
          />
        )}
        {tab === "friends" && (
          <FriendsTab
            friends={friends}
            refresh={refreshFriends}
            presence={presence}
            startDmWith={(userId) => {
              setActiveChannel(dmChannel(me.id, userId));
              setTab("chat");
            }}
          />
        )}
        {tab === "directory" && <DirectoryTab />}
    </div>
  );
}

function ChatTab({
  me, friends, activeChannel, setActiveChannel, messages, messagesRef, stickToBottomRef, presence, unreadFor,
}: {
  me: MeProfile;
  friends: FriendList | null;
  activeChannel: ChannelKey;
  setActiveChannel: (c: ChannelKey) => void;
  messages: ChatMessage[];
  messagesRef: React.MutableRefObject<HTMLDivElement | null>;
  stickToBottomRef: React.MutableRefObject<boolean>;
  presence: Record<string, boolean>;
  unreadFor: (key: ChannelKey) => number;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const mute = useMuteList();
  void mute.version; // re-renders when mute list changes
  const t = useT();

  // ChatTab unmounts when the user switches to Friends/Trainers, so the
  // parent's channel/message scroll effects don't fire on re-entry — the
  // fresh messages div would otherwise land at the top. Snap to the newest
  // message (and re-pin) whenever the Chat tab mounts.
  useEffect(() => {
    stickToBottomRef.current = true;
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const channels = useMemo(() => {
    const list: { key: ChannelKey; label: string; sub?: "online" | "offline"; userId?: string }[] = [
      { key: "global", label: t("Global") },
    ];
    if (friends) {
      for (const f of friends.accepted) {
        list.push({
          key: dmChannel(me.id, f.id),
          label: f.name ?? f.username,
          sub: presence[f.id] ? "online" : "offline",
          userId: f.id,
        });
      }
    }
    return list;
  }, [friends, me.id, presence]);

  const send = async () => {
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    const sock = getSocket();
    sock.emit("chat:send", { channelId: activeChannel, content }, (_res: any) => {
      setSending(false);
    });
    setDraft("");
  };

  const activeLabel = channels.find((c) => c.key === activeChannel)?.label ?? t("Channel");

  return (
    <div className="g-chat-shell">
      <aside className="g-chat-sidebar">
        <div className="g-chat-sidebar-head">{t("Channels")}</div>
        {channels.map((c) => {
          const unread = c.key === activeChannel ? 0 : unreadFor(c.key);
          return (
            <button
              key={c.key}
              type="button"
              className={`g-chat-channel ${c.key === activeChannel ? "active" : ""}`}
              onClick={() => setActiveChannel(c.key)}
            >
              <span className="g-chat-channel-label">{c.label}</span>
              {unread > 0 && (
                <span
                  className="g-chat-unread-badge"
                  aria-label={`${unread} unread message${unread === 1 ? "" : "s"}`}
                >
                  {unread > 99 ? "99+" : unread}
                </span>
              )}
              {c.sub && (
                <span className={`g-chat-channel-dot ${c.sub === "online" ? "on" : "off"}`} />
              )}
            </button>
          );
        })}
      </aside>
      <main className="g-chat-main">
        <div className="g-chat-thread-head">
          <strong>{activeLabel}</strong>
          {activeChannel === "global"
            ? <span className="dim">{t("Server-wide chat")}</span>
            : <span className="dim">{t("Direct message")}</span>}
        </div>
        <div
          className="g-chat-messages"
          ref={messagesRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickToBottomRef.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {messages.length === 0 && (
            <div className="g-chat-empty">{t("No messages yet — say hi!")}</div>
          )}
          {messages.map((m) => {
            const mine = m.user.id === me.id;
            const isSystem = isSystemKind(m.kind);
            const muted = !mine && !isSystem && mute.isMuted(m.user.username);
            if (muted) return null;
            if (isSystem) {
              const { icon, label } = SYSTEM_CARD_META[m.kind ?? ""] ?? SYSTEM_CARD_META.announcement;
              if (m.kind === "pollOpen" && m.meta?.pollId) {
                return (
                  <div key={m.id} className="g-chat-msg-system">
                    <span className="g-chat-msg-system-icon">{icon}</span>
                    <div>
                      <strong className="g-chat-msg-system-label">{label}</strong>
                      <PollCard pollId={m.meta.pollId} />
                    </div>
                  </div>
                );
              }
              return (
                <div key={m.id} className="g-chat-msg-system">
                  <span className="g-chat-msg-system-icon">{icon}</span>
                  <div>
                    <strong className="g-chat-msg-system-label">{label}</strong>
                    <div className="g-chat-msg-system-body">{m.content}</div>
                    {m.kind === "giveawayOpen" && (
                      <button
                        type="button"
                        className="g-chat-msg-system-action"
                        onClick={() => openGiveaways(m.meta?.giveawayId)}
                      >
                        {t("View Giveaway")}
                      </button>
                    )}
                    {m.kind === "shiny" && m.meta?.username && (
                      <button
                        type="button"
                        className="mini-chat-system-action"
                        onClick={() => openPublicTrainerCard(m.meta!.username!)}
                      >
                        {t("View Trainer")}
                      </button>
                    )}
                    {m.kind === "gift" && m.meta?.username && (
                      <button
                        type="button"
                        className="g-chat-msg-system-action"
                        onClick={() => openPublicTrainerCard(m.meta!.username!)}
                      >
                        {t("View Trainer")}
                      </button>
                    )}
                  </div>
                </div>
              );
            }
            return (
              <div key={m.id} className={`g-chat-msg ${mine ? "mine" : ""}`}>
                <div className="g-chat-msg-head">
                  <button
                    type="button"
                    className="g-chat-msg-name-btn"
                    onClick={() => openPublicTrainerCard(m.user.username)}
                    title={`View ${m.user.username}'s trainer card`}
                  >
                    <strong>{m.user.name ?? m.user.username}</strong>
                  </button>
                  {m.user.isAdmin && (
                    <span className="g-chat-msg-admin" title={t("Admin")}>★ {t("ADMIN")}</span>
                  )}
                  <span className="g-chat-msg-lv">{t("Lv ")}{m.user.accountLevel}</span>
                  <span className="g-chat-msg-time">{new Date(m.createdAt).toLocaleTimeString()}</span>
                </div>
                <div className="g-chat-msg-body">{m.content}</div>
              </div>
            );
          })}
        </div>
        <form
          className="g-chat-input"
          onSubmit={(e) => { e.preventDefault(); send(); }}
        >
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`Message ${activeLabel}…`}
            maxLength={500}
          />
          <EmojiPicker onPick={(e) => setDraft((d) => (d + e).slice(0, 500))} />
          <button type="submit" className="g-btn-primary" disabled={!draft.trim() || sending}>{t("Send")}</button>
        </form>
      </main>
    </div>
  );
}

function FriendsTab({ friends, refresh, presence, startDmWith }: {
  friends: FriendList | null;
  refresh: () => void;
  presence: Record<string, boolean>;
  startDmWith: (userId: string) => void;
}) {
  const [usernameInput, setUsernameInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const t = useT();

  const sendRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!usernameInput.trim()) return;
    setBusy(true);
    try {
      await api.requestFriend(usernameInput.trim());
      setUsernameInput("");
      await refresh();
    } catch (err: any) {
      setError(err?.message || t("Failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="g-modal-body g-friends-body">
      <form className="g-friend-add" onSubmit={sendRequest}>
        <input
          type="text"
          placeholder={t("Add friend by username")}
          value={usernameInput}
          onChange={(e) => setUsernameInput(e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))}
          maxLength={20}
        />
        <button type="submit" className="g-btn-primary" disabled={busy}>{t("Add")}</button>
      </form>
      {error && <div className="g-error">{error}</div>}

      {friends?.incoming?.length ? (
        <section className="g-card">
          <h3>{t("Incoming requests")}</h3>
          {friends.incoming.map((f) => (
            <FriendRow
              key={f.friendshipId}
              entry={f}
              presence={presence}
              actions={[
                { label: t("Accept"), onClick: async () => { await api.acceptFriend(f.friendshipId); refresh(); }, primary: true },
                { label: t("Decline"), onClick: async () => { await api.removeFriend(f.friendshipId); refresh(); } },
              ]}
            />
          ))}
        </section>
      ) : null}

      {friends?.outgoing?.length ? (
        <section className="g-card">
          <h3>{t("Pending")}</h3>
          {friends.outgoing.map((f) => (
            <FriendRow
              key={f.friendshipId}
              entry={f}
              presence={presence}
              actions={[
                { label: t("Cancel"), onClick: async () => { await api.removeFriend(f.friendshipId); refresh(); } },
              ]}
            />
          ))}
        </section>
      ) : null}

      <section className="g-card">
        <h3>{t("Friends")}</h3>
        {friends?.accepted?.length ? (
          friends.accepted.map((f) => (
            <FriendRow
              key={f.friendshipId}
              entry={f}
              presence={presence}
              actions={[
                { label: t("Chat"), onClick: () => startDmWith(f.id), primary: true },
                { label: t("Remove"), onClick: async () => { await api.removeFriend(f.friendshipId); refresh(); } },
              ]}
            />
          ))
        ) : (
          <p className="g-help">{t("No friends yet. Add someone by username above.")}</p>
        )}
      </section>
    </div>
  );
}

function FriendRow({ entry, presence, actions }: {
  entry: FriendEntry;
  presence: Record<string, boolean>;
  actions: { label: string; onClick: () => void | Promise<void>; primary?: boolean }[];
}) {
  const online = presence[entry.id] ?? false;
  const initial = (entry.name ?? entry.username ?? "?")[0]?.toUpperCase() ?? "?";
  const t = useT();
  return (
    <div className="g-friend-row">
      <button
        type="button"
        className="g-friend-avatar"
        onClick={() => openPublicTrainerCard(entry.username)}
        title={`View ${entry.username}'s trainer card`}
        aria-label={`View ${entry.username}'s trainer card`}
      >
        {initial}
      </button>
      <button
        type="button"
        className="g-friend-info g-friend-info-btn"
        onClick={() => openPublicTrainerCard(entry.username)}
        title={`View ${entry.username}'s trainer card`}
      >
        <div className="g-friend-name">
          <strong>{entry.name ?? entry.username}</strong>
          <span className={`g-presence ${online ? "on" : "off"}`}>{online ? t("online") : t("offline")}</span>
        </div>
        <div className="g-friend-meta">
          @{entry.username} {t("· Lv")} {entry.accountLevel} · {entry.pokedexCaughtCount}/{DEX_TOTAL} {t("dex")}
        </div>
      </button>
      <div className="g-friend-actions">
        {actions.map((a) => (
          <button
            key={a.label}
            className={a.primary ? "g-btn-primary g-btn-small" : "g-btn-ghost g-btn-small"}
            onClick={() => a.onClick()}
          >
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// Trainer directory — top 30 trainers by the chosen sort (level /
// dex / Σ-levels). Click any row to open their public trainer card.
// Refetches whenever the sort changes; same cap as the server uses
// so we don't render a long stub list while loading more.
type DirectorySort = "level" | "dex" | "sigma";
function DirectoryTab() {
  const [sort, setSort] = useState<DirectorySort>("level");
  const [trainers, setTrainers] = useState<import("../net/api").PublicProfile[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const t = useT();
  useEffect(() => {
    let cancelled = false;
    setTrainers(null);
    setErr(null);
    api.trainerDirectory(sort, 30)
      .then((r) => { if (!cancelled) setTrainers(r.trainers); })
      .catch((e) => { if (!cancelled) setErr(String((e as any)?.message ?? e)); });
    return () => { cancelled = true; };
  }, [sort]);
  return (
    <div className="g-social-body trainer-directory">
      <div className="trainer-directory-controls">
        <span className="dim small">{t("Sort by:")}</span>
        <DirSortBtn label={t("Level")}          val="level"  active={sort} onPick={setSort} />
        <DirSortBtn label={t("Pokédex")}        val="dex"    active={sort} onPick={setSort} />
        <DirSortBtn label={t("Σ Mon levels")}   val="sigma"  active={sort} onPick={setSort} />
      </div>
      {trainers === null && !err && (
        <p className="dim small" style={{ padding: "0 14px" }}>{t("Loading…")}</p>
      )}
      {err && <p className="dim small" style={{ padding: "0 14px" }}>{t("Couldn't load directory.")}</p>}
      {trainers && trainers.length === 0 && (
        <p className="dim small" style={{ padding: "0 14px" }}>{t("No active trainers yet.")}</p>
      )}
      {trainers && trainers.length > 0 && (
        <ol className="trainer-directory-list">
          {trainers.map((trainer, i) => (
            <li key={trainer.id} className="trainer-directory-row">
              <span className="trainer-directory-rank">{i + 1}</span>
              <button
                type="button"
                className="trainer-directory-name g-friend-info-btn"
                onClick={() => openPublicTrainerCard(trainer.username)}
                title={`View ${trainer.username}'s trainer card`}
              >
                <strong>{trainer.name ?? trainer.username}</strong>
                <small className="dim">@{trainer.username}</small>
              </button>
              <span className="trainer-directory-stat" title={t("Account level")}>
                {t("Lv ")}<strong>{trainer.accountLevel}</strong>
              </span>
              <span className="trainer-directory-stat" title={t("Pokédex caught")}>
                <strong>{trainer.pokedexCaughtCount}</strong>/{DEX_TOTAL}
              </span>
              <span className="trainer-directory-stat" title={t("Total Pokémon levels")}>
                Σ <strong>{(trainer.totalCaughtLevels ?? 0).toLocaleString()}</strong>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function DirSortBtn({
  label, val, active, onPick,
}: {
  label: string;
  val: DirectorySort;
  active: DirectorySort;
  onPick: (v: DirectorySort) => void;
}) {
  return (
    <button
      type="button"
      className={`g-tab g-tab-small ${active === val ? "active" : ""}`}
      onClick={() => onPick(val)}
    >
      {label}
    </button>
  );
}
