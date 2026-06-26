import { useEffect, useMemo, useState } from "react";
import { api, type ChatMessage } from "../api";

// Broadcast a server-wide announcement. Drops a 📢-prefixed message
// into the global chat as a real ChatMessage (so it persists in
// history and the moderation tools) and pushes it to every connected
// socket via chat:message on the global room.
//
// The history list under the composer is just a filter on the chat
// moderation feed for messages whose body starts with the
// announcement prefix, so the admin can see what's recently gone out
// without needing a separate table.

const ANNOUNCEMENT_PREFIX = "📢 SERVER ANNOUNCEMENT — ";
const MAX_LEN = 500;

export function AnnouncementsPage() {
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [sentBanner, setSentBanner] = useState<string | null>(null);

  const reloadHistory = () => {
    api.recentChat(200, { channel: "global" })
      .then((d) => {
        setHistory(d.messages.filter((m) => m.content.startsWith(ANNOUNCEMENT_PREFIX)));
      })
      .catch((e) => setErr(e.message));
  };
  useEffect(reloadHistory, []);

  const send = async () => {
    const c = content.trim();
    if (!c) return;
    if (c.length > MAX_LEN) {
      setErr(`Too long — max ${MAX_LEN} characters (you have ${c.length}).`);
      return;
    }
    if (!window.confirm(`Send this announcement to EVERY player on the server?\n\n"${c}"\n\nIt will appear in global chat and persist in history.`)) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api.announce(c);
      setHistory((h) => [res.message, ...h]);
      setContent("");
      setSentBanner("Announcement sent.");
      setTimeout(() => setSentBanner(null), 4000);
    } catch (e: any) {
      setErr(e?.message ?? "send failed");
    } finally {
      setBusy(false);
    }
  };

  const remaining = MAX_LEN - content.length;
  const overLimit = remaining < 0;

  const presets = useMemo(() => ([
    "Server restart in 5 minutes — please save your progress.",
    "Double XP event is live! Until midnight UTC.",
    "Maintenance complete — sorry for the delay, thanks for your patience.",
    "New feature: PvP tournaments are open for sign-ups in the PvP tab.",
  ]), []);

  return (
    <div className="page announcements-page">
      <header className="page-head">
        <h1>Announcements</h1>
        <p className="dim">Broadcast a message to every player on the server. Lands in global chat with a 📢 prefix.</p>
      </header>

      {err && <div className="page-err">{err}</div>}
      {sentBanner && <div className="page-banner page-banner--good">{sentBanner}</div>}

      <section className="card announce-composer">
        <h2>Compose</h2>
        <textarea
          className="announce-input"
          placeholder="Type your announcement…"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={4}
          maxLength={MAX_LEN + 50}
        />
        <div className="announce-row">
          <div className="announce-presets">
            {presets.map((p) => (
              <button key={p} className="btn-ghost btn-tiny" onClick={() => setContent(p)}>
                {p.length > 32 ? p.slice(0, 30) + "…" : p}
              </button>
            ))}
          </div>
          <div className="announce-actions">
            <span className={`dim small ${overLimit ? "over-limit" : ""}`}>
              {remaining} characters left
            </span>
            <button
              className="btn-primary"
              onClick={send}
              disabled={busy || !content.trim() || overLimit}
            >
              {busy ? "Sending…" : "Broadcast"}
            </button>
          </div>
        </div>
      </section>

      <section className="card">
        <h2>Recent announcements <span className="dim small">· {history.length}</span></h2>
        {history.length === 0
          ? <p className="dim small">Nothing broadcast in the last 200 messages.</p>
          : (
            <ul className="announce-history">
              {history.map((m) => (
                <li key={m.id} className="announce-history-row">
                  <div className="announce-history-meta">
                    <strong>@{m.user.username}</strong>
                    <span className="dim small">{new Date(m.createdAt).toLocaleString()}</span>
                  </div>
                  <div className="announce-history-body">
                    {m.content.replace(ANNOUNCEMENT_PREFIX, "")}
                  </div>
                </li>
              ))}
            </ul>
          )
        }
      </section>
    </div>
  );
}
