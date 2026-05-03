import { useEffect, useMemo, useState } from "react";
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

// ─── Save-edit constants ────────────────────────────────────────────────
// Hardcoded so the admin can toggle them without depending on the game's
// data files. Names match the gym/eliteFour ids exported by the game.
const GYM_IDS = ["brock", "misty", "surge", "erika", "koga", "sabrina", "blaine", "giovanni"] as const;
const GYM_NAMES: Record<string, string> = {
  brock: "Brock", misty: "Misty", surge: "Lt. Surge", erika: "Erika",
  koga: "Koga", sabrina: "Sabrina", blaine: "Blaine", giovanni: "Giovanni",
};
const E4_IDS = ["lorelei", "bruno", "agatha", "lance"] as const;
const E4_NAMES: Record<string, string> = {
  lorelei: "Lorelei", bruno: "Bruno", agatha: "Agatha", lance: "Lance",
};

interface PartialPokemon {
  id?: string;
  speciesKey: string;
  nickname?: string;
  level: number;
  isShiny?: boolean;
}

// Local edit state — tracks pending mutations against the loaded save.
// A single "Save changes" submits the diff (the admin doesn't need to
// re-send untouched fields; the server merges).
interface SaveEdit {
  money?: number;
  victoryTokens?: number;
  inventory?: Record<string, number>;
  defeatedGyms?: string[];
  defeatedEliteFour?: string[];
  championDefeated?: boolean;
  party?: any[];
  box?: any[];
}

function UserDetailPanel({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: () => void }) {
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<SaveEdit>({});
  const [editMode, setEditMode] = useState(false);
  const [savingMsg, setSavingMsg] = useState<string | null>(null);

  const reload = () => {
    api.getUser(id).then((u) => {
      setData(u);
      setEdit({});
    }).catch((e) => setErr(e.message));
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

  const saveEdit = async () => {
    if (Object.keys(edit).length === 0) {
      setSavingMsg("No changes to save.");
      window.setTimeout(() => setSavingMsg(null), 1500);
      return;
    }
    setBusy(true);
    setSavingMsg(null);
    try {
      const res = await api.savePatch(id, edit as Record<string, unknown>);
      setSavingMsg(`Saved (${res.keys.join(", ")}). Save version → ${res.saveVersion}.`);
      reload();
      onChange();
    } catch (e) {
      const err = e as Error;
      setSavingMsg(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
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
        <div className="save-editor">
          <header className="save-editor-head">
            <h3>Save editor</h3>
            <button
              className="btn-ghost"
              onClick={() => setEditMode((v) => !v)}
            >
              {editMode ? "Hide editor" : "Show editor"}
            </button>
          </header>

          {editMode && (
            <SaveEditorBody
              save={save}
              edit={edit}
              onEdit={setEdit}
              onSave={saveEdit}
              onCancel={() => { setEdit({}); setSavingMsg(null); }}
              busy={busy}
              savingMsg={savingMsg}
            />
          )}
        </div>
      )}

      {save && (
        <details className="save-inspect">
          <summary>Save snapshot ({save.party?.length ?? 0} party · {save.box?.length ?? 0} box · {save.unlockedLocations?.length ?? 0} unlocked)</summary>
          <pre>{JSON.stringify(save, null, 2).slice(0, 4000)}</pre>
        </details>
      )}
    </aside>
  );
}

function SaveEditorBody({
  save, edit, onEdit, onSave, onCancel, busy, savingMsg,
}: {
  save: any;
  edit: SaveEdit;
  onEdit: (e: SaveEdit) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
  savingMsg: string | null;
}) {
  // The "live" value for each field — pending edit if present, otherwise
  // the last-loaded saveData value. Useful for rendering inputs that show
  // the would-be-saved value but haven't been committed yet.
  const live = useMemo(() => ({
    money: edit.money ?? (save.money ?? 0),
    victoryTokens: edit.victoryTokens ?? (save.victoryTokens ?? 0),
    championDefeated: edit.championDefeated ?? (save.championDefeated ?? false),
    inventory: edit.inventory ?? (save.inventory ?? {}),
    defeatedGyms: edit.defeatedGyms ?? (save.defeatedGyms ?? []),
    defeatedEliteFour: edit.defeatedEliteFour ?? (save.defeatedEliteFour ?? []),
    party: edit.party ?? (save.party ?? []),
    box: edit.box ?? (save.box ?? []),
  }), [edit, save]);

  const dirty = Object.keys(edit).length > 0;

  // ── Money / Tokens ──
  const setMoney = (n: number) => onEdit({ ...edit, money: Math.max(0, Math.min(999_999_999, Math.floor(n))) });
  const setTokens = (n: number) => onEdit({ ...edit, victoryTokens: Math.max(0, Math.floor(n)) });

  // ── Badges / E4 / Champion ──
  const toggleGym = (gid: string) => {
    const cur = new Set<string>(live.defeatedGyms as string[]);
    if (cur.has(gid)) cur.delete(gid); else cur.add(gid);
    onEdit({ ...edit, defeatedGyms: Array.from(cur) });
  };
  const toggleE4 = (eid: string) => {
    const cur = new Set<string>(live.defeatedEliteFour as string[]);
    if (cur.has(eid)) cur.delete(eid); else cur.add(eid);
    onEdit({ ...edit, defeatedEliteFour: Array.from(cur) });
  };
  const toggleChampion = () => onEdit({ ...edit, championDefeated: !live.championDefeated });

  // ── Inventory ──
  const setItem = (itemId: string, qty: number) => {
    const next = { ...live.inventory };
    if (qty <= 0) {
      delete next[itemId];
    } else {
      next[itemId] = Math.max(0, Math.min(999_999, Math.floor(qty)));
    }
    onEdit({ ...edit, inventory: next });
  };
  const removeItem = (itemId: string) => {
    const next = { ...live.inventory };
    delete next[itemId];
    onEdit({ ...edit, inventory: next });
  };
  const [newItemId, setNewItemId] = useState("");
  const [newItemQty, setNewItemQty] = useState(1);
  const addItem = () => {
    const id = newItemId.trim();
    if (!id) return;
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id)) {
      window.alert("Item id must be alphanumeric / underscore / dash, ≤ 40 chars.");
      return;
    }
    setItem(id, newItemQty);
    setNewItemId("");
    setNewItemQty(1);
  };

  // ── Pokémon edits ──
  const setPartyLevel = (idx: number, lvl: number) => {
    const next = [...live.party];
    next[idx] = { ...next[idx], level: clamp(Math.floor(lvl), 1, 100) };
    onEdit({ ...edit, party: next });
  };
  const setBoxLevel = (idx: number, lvl: number) => {
    const next = [...live.box];
    next[idx] = { ...next[idx], level: clamp(Math.floor(lvl), 1, 100) };
    onEdit({ ...edit, box: next });
  };
  const removeParty = (idx: number) => {
    if (!window.confirm(`Remove ${live.party[idx]?.nickname ?? live.party[idx]?.name ?? "this Pokémon"} from party?`)) return;
    const next = live.party.filter((_: any, i: number) => i !== idx);
    onEdit({ ...edit, party: next });
  };
  const removeBox = (idx: number) => {
    if (!window.confirm(`Remove ${live.box[idx]?.nickname ?? live.box[idx]?.name ?? "this Pokémon"} from box?`)) return;
    const next = live.box.filter((_: any, i: number) => i !== idx);
    onEdit({ ...edit, box: next });
  };

  return (
    <div className="save-editor-body">
      {/* Money + Tokens row */}
      <section className="save-section">
        <h4>Currency</h4>
        <div className="save-grid-2">
          <label className="save-field">
            <span>Money</span>
            <input
              type="number"
              min={0}
              max={999_999_999}
              value={live.money}
              onChange={(e) => setMoney(parseInt(e.target.value, 10) || 0)}
            />
          </label>
          <label className="save-field">
            <span>Victory tokens</span>
            <input
              type="number"
              min={0}
              value={live.victoryTokens}
              onChange={(e) => setTokens(parseInt(e.target.value, 10) || 0)}
            />
          </label>
        </div>
      </section>

      {/* Progress: badges + E4 + champion */}
      <section className="save-section">
        <h4>Progress</h4>
        <div className="save-checks">
          {GYM_IDS.map((g) => (
            <label key={g} className="save-check">
              <input
                type="checkbox"
                checked={live.defeatedGyms.includes(g)}
                onChange={() => toggleGym(g)}
              />
              <span>{GYM_NAMES[g]}</span>
            </label>
          ))}
        </div>
        <div className="save-checks save-checks-tight">
          {E4_IDS.map((e) => (
            <label key={e} className="save-check">
              <input
                type="checkbox"
                checked={live.defeatedEliteFour.includes(e)}
                onChange={() => toggleE4(e)}
              />
              <span>{E4_NAMES[e]}</span>
            </label>
          ))}
          <label className="save-check">
            <input
              type="checkbox"
              checked={live.championDefeated}
              onChange={toggleChampion}
            />
            <span>Champion</span>
          </label>
        </div>
      </section>

      {/* Inventory */}
      <section className="save-section">
        <h4>Inventory <span className="dim small">({Object.keys(live.inventory).length} items)</span></h4>
        <div className="inv-rows">
          {Object.entries(live.inventory)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([itemId, qty]) => (
              <div className="inv-row" key={itemId}>
                <span className="inv-id mono">{itemId}</span>
                <input
                  type="number"
                  min={0}
                  max={999_999}
                  value={qty as number}
                  onChange={(e) => setItem(itemId, parseInt(e.target.value, 10) || 0)}
                />
                <button className="btn-ghost btn-tiny" onClick={() => removeItem(itemId)}>×</button>
              </div>
            ))}
          {Object.keys(live.inventory).length === 0 && (
            <div className="dim small">Inventory is empty.</div>
          )}
        </div>
        <div className="inv-add">
          <input
            type="text"
            placeholder="item id (e.g. pokeball)"
            value={newItemId}
            onChange={(e) => setNewItemId(e.target.value)}
          />
          <input
            type="number"
            min={1}
            max={999_999}
            value={newItemQty}
            onChange={(e) => setNewItemQty(parseInt(e.target.value, 10) || 1)}
          />
          <button className="btn-primary btn-small" onClick={addItem}>Add</button>
        </div>
      </section>

      {/* Party */}
      <section className="save-section">
        <h4>Party <span className="dim small">({live.party.length}/6)</span></h4>
        <div className="poke-rows">
          {live.party.map((p: PartialPokemon, idx: number) => (
            <div className="poke-row" key={p.id ?? idx}>
              <span className="poke-name">
                {p.nickname && <strong>{p.nickname}</strong>}
                <span className="dim small">{" "}{p.speciesKey}{p.isShiny ? " ✨" : ""}</span>
              </span>
              <label className="poke-level">
                <span>Lv</span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={p.level}
                  onChange={(e) => setPartyLevel(idx, parseInt(e.target.value, 10) || 1)}
                />
              </label>
              <button className="btn-ghost btn-tiny" onClick={() => removeParty(idx)}>×</button>
            </div>
          ))}
          {live.party.length === 0 && <div className="dim small">No party.</div>}
        </div>
      </section>

      {/* Box (collapsed by default for huge boxes) */}
      <section className="save-section">
        <h4>Box <span className="dim small">({live.box.length}/600)</span></h4>
        <details className="poke-box-details">
          <summary className="dim small">{live.box.length === 0 ? "Box is empty." : `Show ${live.box.length} Pokémon`}</summary>
          <div className="poke-rows" style={{ marginTop: 8 }}>
            {live.box.map((p: PartialPokemon, idx: number) => (
              <div className="poke-row" key={p.id ?? idx}>
                <span className="poke-name">
                  {p.nickname && <strong>{p.nickname}</strong>}
                  <span className="dim small">{" "}{p.speciesKey}{p.isShiny ? " ✨" : ""}</span>
                </span>
                <label className="poke-level">
                  <span>Lv</span>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={p.level}
                    onChange={(e) => setBoxLevel(idx, parseInt(e.target.value, 10) || 1)}
                  />
                </label>
                <button className="btn-ghost btn-tiny" onClick={() => removeBox(idx)}>×</button>
              </div>
            ))}
          </div>
        </details>
      </section>

      {/* Save bar */}
      <div className="save-editor-foot">
        <div className="save-editor-msg dim small">{savingMsg ?? (dirty ? "Unsaved changes." : "")}</div>
        <button className="btn-ghost" onClick={onCancel} disabled={busy || !dirty}>Discard</button>
        <button className="btn-primary" onClick={onSave} disabled={busy || !dirty}>
          {busy ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
  );
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
