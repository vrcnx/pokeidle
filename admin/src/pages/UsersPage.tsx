import { useEffect, useState } from "react";
import { api, type AdminUser } from "../api";

export function UsersPage() {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ total: number; users: AdminUser[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const PAGE_SIZE = 25;

  const reload = () => {
    setBusy(true);
    setErr(null);
    api.listUsers(q, page, PAGE_SIZE)
      .then((d) => setData({ total: d.total, users: d.users }))
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(false));
  };
  useEffect(reload, [q, page]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="page">
      <header className="page-head">
        <h1>Users <span className="dim">({data?.total ?? "…"})</span></h1>
      </header>

      <div className="users-toolbar">
        <input
          className="search-input"
          placeholder="Search username, email, or display name…"
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(0); }}
        />
        <button className="btn-primary" onClick={reload} disabled={busy}>Refresh</button>
      </div>

      {err && <div className="page-err">Error: {err}</div>}

      <table className="users-table">
        <thead>
          <tr>
            <th>Username</th>
            <th>Email</th>
            <th>Lv</th>
            <th>Dex</th>
            <th>Status</th>
            <th>Created</th>
            <th>Last seen</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {(data?.users ?? []).map((u) => (
            <tr key={u.id} className={selected === u.id ? "selected" : ""}>
              <td>
                <strong>{u.name ?? u.username}</strong>
                <div className="dim small">@{u.username}</div>
              </td>
              <td className="mono">{u.email}</td>
              <td>{u.accountLevel}</td>
              <td>{u.pokedexCaughtCount}/151</td>
              <td>
                {u.isAdmin && <span className="tag admin">ADMIN</span>}
                {u.bannedUntil && new Date(u.bannedUntil).getTime() > Date.now() && <span className="tag banned">BANNED</span>}
                {!u.isAdmin && !u.bannedUntil && <span className="dim small">—</span>}
              </td>
              <td>{new Date(u.createdAt).toLocaleDateString()}</td>
              <td>{new Date(u.lastSeenAt).toLocaleDateString()}</td>
              <td><button className="btn-ghost" onClick={() => setSelected(u.id)}>Open</button></td>
            </tr>
          ))}
          {data && data.users.length === 0 && (
            <tr><td colSpan={8} className="dim center">No users match.</td></tr>
          )}
        </tbody>
      </table>

      <div className="pager">
        <button disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>‹ Prev</button>
        <span className="dim">Page {page + 1} of {totalPages}</span>
        <button disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}>Next ›</button>
      </div>

      {selected && (
        <UserDetailPanel
          id={selected}
          onClose={() => setSelected(null)}
          onChange={reload}
        />
      )}
    </div>
  );
}

function UserDetailPanel({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: () => void }) {
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reload = () => {
    api.getUser(id).then(setData).catch((e) => setErr(e.message));
  };
  useEffect(reload, [id]);

  if (err) return (
    <aside className="detail-panel"><div className="page-err">{err}</div></aside>
  );
  if (!data) return (
    <aside className="detail-panel"><p className="dim">Loading…</p></aside>
  );

  const banned = data.bannedUntil && new Date(data.bannedUntil).getTime() > Date.now();
  const save = data.saveData ? (() => { try { return JSON.parse(data.saveData); } catch { return null; } })() : null;

  const promote = async () => {
    setBusy(true);
    await api.setAdmin(id, !data.isAdmin).catch((e) => setErr(e.message));
    setBusy(false);
    reload(); onChange();
  };
  const ban = async () => {
    const reason = window.prompt("Ban reason (optional):") ?? null;
    const until = new Date(Date.now() + 7 * 86400000).toISOString();
    setBusy(true);
    await api.ban(id, until, reason).catch((e) => setErr(e.message));
    setBusy(false);
    reload(); onChange();
  };
  const unban = async () => {
    setBusy(true);
    await api.ban(id, null, null).catch((e) => setErr(e.message));
    setBusy(false);
    reload(); onChange();
  };
  const resetSave = async () => {
    if (!window.confirm(`Reset ${data.username}'s save? This cannot be undone.`)) return;
    setBusy(true);
    await api.resetSave(id).catch((e) => setErr(e.message));
    setBusy(false);
    reload(); onChange();
  };
  const deleteUser = async () => {
    if (!window.confirm(`Permanently delete ${data.username}? This cascades to friends, chat, sessions.`)) return;
    setBusy(true);
    await api.deleteUser(id).catch((e) => setErr(e.message));
    setBusy(false);
    onClose(); onChange();
  };

  return (
    <aside className="detail-panel">
      <header className="detail-head">
        <div>
          <h2>{data.name ?? data.username}</h2>
          <div className="dim small">@{data.username} · {data.email}</div>
        </div>
        <button className="btn-ghost" onClick={onClose}>×</button>
      </header>

      <div className="detail-stats">
        <div><span>Account Lv</span><strong>{data.accountLevel}</strong></div>
        <div><span>Pokédex</span><strong>{data.pokedexCaughtCount}/151</strong></div>
        <div><span>Caught levels</span><strong>{data.totalCaughtLevels}</strong></div>
        <div><span>Created</span><strong>{new Date(data.createdAt).toLocaleDateString()}</strong></div>
        <div><span>Last seen</span><strong>{new Date(data.lastSeenAt).toLocaleString()}</strong></div>
        <div><span>Friends</span><strong>{data._count?.friendsRequested + data._count?.friendsReceived}</strong></div>
        <div><span>Messages sent</span><strong>{data._count?.messages}</strong></div>
        <div><span>Save version</span><strong>{data.saveVersion}</strong></div>
      </div>

      {banned && (
        <div className="ban-banner">
          <strong>Banned until {new Date(data.bannedUntil).toLocaleString()}</strong>
          {data.banReason && <div className="dim">{data.banReason}</div>}
        </div>
      )}

      <div className="detail-actions">
        <button className="btn-primary" onClick={promote} disabled={busy}>
          {data.isAdmin ? "Demote from admin" : "Promote to admin"}
        </button>
        {banned ? (
          <button className="btn-secondary" onClick={unban} disabled={busy}>Unban</button>
        ) : (
          <button className="btn-warn" onClick={ban} disabled={busy}>Ban (7 days)</button>
        )}
        <button className="btn-warn" onClick={resetSave} disabled={busy}>Reset save</button>
        <button className="btn-danger" onClick={deleteUser} disabled={busy}>Delete user</button>
      </div>

      {save && (
        <details className="save-inspect">
          <summary>Save snapshot ({save.party?.length ?? 0} party · {save.box?.length ?? 0} box · {save.unlockedLocations?.length ?? 0} unlocked)</summary>
          <pre>{JSON.stringify(save, null, 2).slice(0, 4000)}</pre>
        </details>
      )}
    </aside>
  );
}
