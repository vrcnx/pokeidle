import { useEffect, useState } from "react";
import { api } from "../api";

interface Msg {
  id: string;
  channelId: string;
  content: string;
  createdAt: string;
  user: { id: string; username: string; name: string | null; isAdmin: boolean };
}

export function ChatModerationPage() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reload = () => {
    setBusy(true);
    api.recentChat(100)
      .then((d) => setMsgs(d.messages))
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(false));
  };
  useEffect(reload, []);

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

  return (
    <div className="page">
      <header className="page-head">
        <h1>Chat moderation</h1>
        <p className="dim">Latest 100 messages on the global channel.</p>
      </header>

      <div className="users-toolbar">
        <button className="btn-primary" onClick={reload} disabled={busy}>Refresh</button>
        <button className="btn-danger" onClick={clearAll} disabled={busy}>
          Clear live chat
        </button>
      </div>

      {err && <div className="page-err">{err}</div>}

      <table className="chat-table">
        <thead>
          <tr><th>When</th><th>Trainer</th><th>Message</th><th></th></tr>
        </thead>
        <tbody>
          {msgs.map((m) => (
            <tr key={m.id}>
              <td className="dim small">{new Date(m.createdAt).toLocaleTimeString()}</td>
              <td>
                <strong>{m.user.name ?? m.user.username}</strong>
                <div className="dim small">@{m.user.username}{m.user.isAdmin ? " · admin" : ""}</div>
              </td>
              <td className="chat-content">{m.content}</td>
              <td><button className="btn-danger" onClick={() => del(m.id)}>Delete</button></td>
            </tr>
          ))}
          {msgs.length === 0 && (
            <tr><td colSpan={4} className="dim center">No messages yet.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
