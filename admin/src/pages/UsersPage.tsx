import { useEffect, useMemo, useState } from "react";
import { api, type AdminUser, type UserSession, type UserMessage, type UserTrade } from "../api";
import { Combobox } from "../components/Combobox";
import {
  POKEMON_LIST,
  ITEM_LIST,
  pokemonSpriteUrl,
  itemSpriteUrl,
  pokemonStaticSpriteUrl,
  createPokemon,
} from "../data/gameCatalog";

// ─── User list page ────────────────────────────────────────────────────
// Two views in one component, switched by `selected` state:
//   - List view (default): paginated, searchable user table
//   - Detail view: full-page tabbed management panel for one user
// Clicking a row navigates to detail; the "Back to users" button on
// the detail view returns to the list, preserving search + page state.
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

  // Detail view — full page replaces the list.
  if (selected) {
    return (
      <UserDetailFullPage
        id={selected}
        onBack={() => setSelected(null)}
        onChange={reload}
      />
    );
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="page">
      <header className="page-head">
        <h1>Users <span className="dim">({data?.total ?? "…"})</span></h1>
        <p className="dim">Search by username, email or display name. Click a row to open the full management page.</p>
      </header>

      <div className="users-toolbar">
        <input
          className="search-input"
          placeholder="Search…"
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
            <tr
              key={u.id}
              onClick={() => setSelected(u.id)}
              style={{ cursor: "pointer" }}
            >
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
              <td className="dim small">{new Date(u.createdAt).toLocaleDateString()}</td>
              <td className="dim small">{new Date(u.lastSeenAt).toLocaleDateString()}</td>
              <td><button className="btn-ghost btn-small" onClick={(e) => { e.stopPropagation(); setSelected(u.id); }}>Open</button></td>
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
    </div>
  );
}

// ─── Save-edit constants ────────────────────────────────────────────────
const GYM_IDS = ["brock", "misty", "surge", "erika", "koga", "sabrina", "blaine", "giovanni"] as const;
const GYM_NAMES: Record<string, string> = {
  brock: "Brock", misty: "Misty", surge: "Lt. Surge", erika: "Erika",
  koga: "Koga", sabrina: "Sabrina", blaine: "Blaine", giovanni: "Giovanni",
};
const E4_IDS = ["lorelei", "bruno", "agatha", "lance"] as const;
const E4_NAMES: Record<string, string> = {
  lorelei: "Lorelei", bruno: "Bruno", agatha: "Agatha", lance: "Lance",
};

// Edit-state shape for the save patch (mirrors PATCHABLE_KEYS on the server).
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

type DetailTab = "profile" | "pokemon" | "items" | "progress" | "messages" | "trades" | "sessions" | "raw";

// ─── User detail (full page) ──────────────────────────────────────────
function UserDetailFullPage({ id, onBack, onChange }: { id: string; onBack: () => void; onChange: () => void }) {
  const [tab, setTab] = useState<DetailTab>("profile");
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<SaveEdit>({});
  const [savingMsg, setSavingMsg] = useState<string | null>(null);

  const reload = () => {
    api.getUser(id).then((u) => {
      setData(u);
      setEdit({});
    }).catch((e) => setErr(e.message));
  };
  useEffect(reload, [id]);

  if (err) return (
    <div className="page">
      <DetailHeader onBack={onBack} />
      <div className="page-err">{err}</div>
    </div>
  );
  if (!data) return (
    <div className="page">
      <DetailHeader onBack={onBack} />
      <p className="dim">Loading…</p>
    </div>
  );

  const banned = data.bannedUntil && new Date(data.bannedUntil).getTime() > Date.now();
  const save = data.saveData ? (() => { try { return JSON.parse(data.saveData); } catch { return null; } })() : null;

  const saveEdit = async () => {
    if (Object.keys(edit).length === 0) return;
    setBusy(true);
    setSavingMsg(null);
    try {
      const res = await api.savePatch(id, edit as Record<string, unknown>);
      setSavingMsg(`Saved (${res.keys.join(", ")}). v${res.saveVersion}`);
      reload();
      onChange();
    } catch (e) {
      setSavingMsg(`Error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const dirty = Object.keys(edit).length > 0;

  return (
    <div className="page user-detail-page">
      <DetailHeader onBack={onBack} />
      <header className="user-detail-head">
        <div>
          <h1>{data.name ?? data.username}</h1>
          <div className="dim">@{data.username} · {data.email}</div>
        </div>
        <div className="user-detail-status">
          {data.isAdmin && <span className="tag admin">ADMIN</span>}
          {banned && <span className="tag banned">BANNED</span>}
          <span className="dim small">v{data.saveVersion}</span>
        </div>
      </header>

      <nav className="detail-tabs detail-tabs-page" role="tablist">
        {(["profile", "pokemon", "items", "progress", "messages", "trades", "sessions", "raw"] as DetailTab[]).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={`detail-tab ${tab === t ? "active" : ""}`}
            onClick={() => setTab(t)}
          >
            {t === "profile" ? "Profile"
              : t === "pokemon" ? `Pokémon · ${(save?.party?.length ?? 0)}+${(save?.box?.length ?? 0)}`
              : t === "items" ? `Items · ${Object.keys(save?.inventory ?? {}).length}`
              : t === "progress" ? "Progress"
              : t === "messages" ? "Messages"
              : t === "trades" ? "Trades"
              : t === "sessions" ? "Sessions"
              : "Raw"}
          </button>
        ))}
      </nav>

      <div className="detail-body detail-body-page">
        {tab === "profile" && (
          <ProfileTab data={data} banned={banned} busy={busy} setBusy={setBusy} reload={reload} onChange={onChange} onClose={onBack} />
        )}
        {tab === "pokemon" && save && (
          <PokemonTab save={save} edit={edit} onEdit={setEdit} />
        )}
        {tab === "items" && save && (
          <ItemsTab save={save} edit={edit} onEdit={setEdit} userId={id} reload={reload} />
        )}
        {tab === "progress" && save && (
          <ProgressTab save={save} edit={edit} onEdit={setEdit} />
        )}
        {tab === "messages" && (
          <MessagesTab userId={id} />
        )}
        {tab === "trades" && (
          <TradesTab userId={id} />
        )}
        {tab === "sessions" && (
          <SessionsTab userId={id} />
        )}
        {tab === "raw" && save && (
          <RawSaveTab save={save} />
        )}
        {!save && (tab === "pokemon" || tab === "items" || tab === "progress" || tab === "raw") && (
          <p className="dim">No save data — user hasn't started the game yet.</p>
        )}
      </div>

      {dirty && tab !== "messages" && tab !== "sessions" && tab !== "raw" && (
        <div className="detail-savebar detail-savebar-page">
          <span className="dim small">{savingMsg ?? `Unsaved changes (${Object.keys(edit).join(", ")})`}</span>
          <button className="btn-ghost" onClick={() => { setEdit({}); setSavingMsg(null); }} disabled={busy}>Discard</button>
          <button className="btn-primary" onClick={saveEdit} disabled={busy}>{busy ? "Saving…" : "Save changes"}</button>
        </div>
      )}
      {!dirty && savingMsg && (
        <div className="detail-savebar detail-savebar-page"><span className="dim small">{savingMsg}</span></div>
      )}
    </div>
  );
}

// Tiny back-link header used at the top of the user detail page.
function DetailHeader({ onBack }: { onBack: () => void }) {
  return (
    <button className="detail-back" onClick={onBack}>← Back to users</button>
  );
}

// ─── Profile tab — top-level account actions ────────────────────────────
function ProfileTab({ data, banned, busy, setBusy, reload, onChange, onClose }: {
  data: any; banned: boolean; busy: boolean;
  setBusy: (v: boolean) => void; reload: () => void; onChange: () => void; onClose: () => void;
}) {
  const [resetMsg, setResetMsg] = useState<string | null>(null);

  const promote = async () => {
    setBusy(true);
    try { await api.setAdmin(data.id, !data.isAdmin); reload(); onChange(); }
    finally { setBusy(false); }
  };
  const ban = async () => {
    const reason = window.prompt("Ban reason (optional):") ?? null;
    const until = new Date(Date.now() + 7 * 86400000).toISOString();
    setBusy(true);
    try { await api.ban(data.id, until, reason); reload(); onChange(); }
    finally { setBusy(false); }
  };
  const unban = async () => {
    setBusy(true);
    try { await api.ban(data.id, null, null); reload(); onChange(); }
    finally { setBusy(false); }
  };
  const resetSave = async () => {
    if (!window.confirm(`Reset ${data.username}'s save? This cannot be undone.`)) return;
    setBusy(true);
    try { await api.resetSave(data.id); reload(); onChange(); }
    finally { setBusy(false); }
  };
  const deleteUser = async () => {
    if (!window.confirm(`Permanently delete ${data.username}? This cascades to friends, chat, sessions.`)) return;
    setBusy(true);
    try { await api.deleteUser(data.id); onClose(); onChange(); }
    finally { setBusy(false); }
  };
  const sendPasswordReset = async () => {
    if (!window.confirm(
      `Send a password-reset email to ${data.email}?\n\n`
      + `They'll receive a one-shot link (1 hour expiry) to choose a new password. `
      + `You will not be able to see their new password.`
    )) return;
    setBusy(true);
    setResetMsg(null);
    try {
      const redirectTo = window.prompt(
        "Redirect URL (game frontend reset page):",
        "https://pokeidle.com/reset-password",
      );
      if (!redirectTo) { setBusy(false); return; }
      const res = await api.sendPasswordReset(data.id, redirectTo);
      setResetMsg(`Reset email sent to ${res.sentTo}.`);
    } catch (e) {
      setResetMsg(`Error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="detail-stats">
        <div><span>Account Lv</span><strong>{data.accountLevel}</strong></div>
        <div><span>Pokédex</span><strong>{data.pokedexCaughtCount}/151</strong></div>
        <div><span>Caught levels</span><strong>{data.totalCaughtLevels}</strong></div>
        <div><span>Save version</span><strong>{data.saveVersion}</strong></div>
        <div><span>Created</span><strong>{new Date(data.createdAt).toLocaleString()}</strong></div>
        <div><span>Last seen</span><strong>{new Date(data.lastSeenAt).toLocaleString()}</strong></div>
        <div><span>Email verified</span><strong>{data.emailVerified ? "Yes" : "No"}</strong></div>
        <div><span>Friends</span><strong>{(data._count?.friendsRequested ?? 0) + (data._count?.friendsReceived ?? 0)}</strong></div>
        <div><span>Messages sent</span><strong>{data._count?.messages ?? 0}</strong></div>
      </div>

      {banned && (
        <div className="ban-banner">
          <strong>Banned until {new Date(data.bannedUntil).toLocaleString()}</strong>
          {data.banReason && <div className="dim">{data.banReason}</div>}
        </div>
      )}

      <section className="profile-section">
        <h3>Account</h3>
        <div className="profile-actions">
          <button className="btn-secondary" onClick={promote} disabled={busy}>
            {data.isAdmin ? "Demote from admin" : "Promote to admin"}
          </button>
          {banned ? (
            <button className="btn-secondary" onClick={unban} disabled={busy}>Unban</button>
          ) : (
            <button className="btn-warn" onClick={ban} disabled={busy}>Ban (7 days)</button>
          )}
          <button className="btn-warn" onClick={sendPasswordReset} disabled={busy}>Send password reset</button>
        </div>
        {resetMsg && <p className="profile-msg dim small">{resetMsg}</p>}
        <p className="dim small">
          We can't view passwords — they're hashed one-way. The reset email lets the user pick a new one themselves.
        </p>
      </section>

      <section className="profile-section">
        <h3>Save data</h3>
        <div className="profile-actions">
          <button className="btn-warn" onClick={resetSave} disabled={busy}>Reset save</button>
          <button className="btn-danger" onClick={deleteUser} disabled={busy}>Delete user</button>
        </div>
        <p className="dim small">
          Reset save wipes their progress (party, box, items, money) but keeps the account.
          Delete user is permanent and cascades to friends, chat messages, sessions.
        </p>
      </section>
    </>
  );
}

// ─── Pokémon tab — party + box editor + give-mon ────────────────────────
function PokemonTab({ save, edit, onEdit }: {
  save: any; edit: SaveEdit; onEdit: (e: SaveEdit) => void;
}) {
  const live = useMemo(() => ({
    party: edit.party ?? (save.party ?? []),
    box: edit.box ?? (save.box ?? []),
  }), [edit, save]);

  // Helpers
  const updateMon = (where: "party" | "box", idx: number, patch: Record<string, unknown>) => {
    const next = [...live[where]];
    next[idx] = { ...next[idx], ...patch };
    onEdit({ ...edit, [where]: next });
  };
  const removeMon = (where: "party" | "box", idx: number) => {
    const p = live[where][idx];
    if (!window.confirm(`Remove ${p?.nickname ?? p?.name ?? "this Pokémon"} from ${where}?`)) return;
    const next = live[where].filter((_: any, i: number) => i !== idx);
    onEdit({ ...edit, [where]: next });
  };

  // Give-mon form — adds a fresh Pokémon to party or box. The species
  // picker is a searchable combobox sourced from the game's pokemonTable
  // (re-exported via gameCatalog), so the admin doesn't have to memorise
  // any of the ~200 slugs. The game's reducer re-derives stats / moves
  // / max HP from the species catalog on the user's next save load, so
  // we only need the bare minimum here.
  const [give, setGive] = useState<{
    where: "party" | "box";
    species: { speciesKey: string; name: string; id: number; types: string[] } | null;
    speciesQuery: string;
    level: number;
    isShiny: boolean;
  }>({
    where: "party",
    species: null,
    speciesQuery: "",
    level: 5,
    isShiny: false,
  });
  const giveMon = () => {
    if (!give.species) {
      window.alert("Pick a Pokémon first.");
      return;
    }
    const sp = give.species;
    const level = clamp(give.level, 1, 100);
    // Use the game's createPokemon factory so the new mon has correctly
    // derived stats / max HP / totalExp / starting moveset / nature /
    // ability — all matching what the game would produce for a freshly
    // caught wild encounter at this level. Without this the player's
    // client would render with wrong HP / Attack until they manually
    // re-saved.
    //
    // Use a string-collision-safe id rather than the game's numeric
    // counter — we don't have access to nextPokemonId from the user's
    // save here, and the game accepts arbitrary string ids.
    const fakeNumericId = Date.now() + Math.floor(Math.random() * 1000);
    const mon = {
      ...createPokemon(sp.speciesKey, level, fakeNumericId, give.isShiny),
      id: `admin_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    };
    if (give.where === "party") {
      if (live.party.length >= 6) { window.alert("Party is full (6)."); return; }
      onEdit({ ...edit, party: [...live.party, mon] });
    } else {
      onEdit({ ...edit, box: [...live.box, mon] });
    }
    setGive({ ...give, species: null, speciesQuery: "" });
  };

  return (
    <>
      <section className="profile-section">
        <h3>Party <span className="dim small">({live.party.length}/6)</span></h3>
        <div className="poke-grid">
          {live.party.map((p: any, idx: number) => (
            <PokemonRow key={p.id ?? idx} mon={p} onEdit={(patch) => updateMon("party", idx, patch)} onRemove={() => removeMon("party", idx)} />
          ))}
          {live.party.length === 0 && <div className="dim small">No party.</div>}
        </div>
      </section>

      <section className="profile-section">
        <h3>Box <span className="dim small">({live.box.length}/600)</span></h3>
        <details className="poke-box-details">
          <summary className="dim small">{live.box.length === 0 ? "Box is empty." : `Show ${live.box.length} stored Pokémon`}</summary>
          <div className="poke-grid" style={{ marginTop: 8 }}>
            {/* Static sprites in the box — animated GIFs across hundreds
                of mons would chew CPU while the panel sits open. Party
                still uses the animated set. */}
            {live.box.map((p: any, idx: number) => (
              <PokemonRow key={p.id ?? idx} mon={p} onEdit={(patch) => updateMon("box", idx, patch)} onRemove={() => removeMon("box", idx)} useStaticSprite />
            ))}
          </div>
        </details>
      </section>

      <section className="profile-section">
        <h3>Give Pokémon</h3>
        <div className="give-mon">
          <select
            value={give.where}
            onChange={(e) => setGive({ ...give, where: e.target.value as "party" | "box" })}
          >
            <option value="party">Party</option>
            <option value="box">Box</option>
          </select>
          <Combobox
            value={give.speciesQuery}
            onChange={(text) => setGive({ ...give, speciesQuery: text, species: null })}
            onSelect={(sp) => setGive({ ...give, species: sp, speciesQuery: `${sp.name} (#${sp.id})` })}
            options={POKEMON_LIST}
            placeholder="Search Pokémon by name or slug…"
            getKey={(sp) => sp.speciesKey}
            getSearchText={(sp) => `${sp.name} ${sp.speciesKey} ${sp.types.join(" ")}`}
            renderOption={(sp) => (
              <div className="combobox-pokemon">
                <img
                  src={pokemonStaticSpriteUrl(sp.id)}
                  alt=""
                  width={32}
                  height={32}
                  loading="lazy"
                  style={{ imageRendering: "pixelated" }}
                />
                <div className="combobox-pokemon-info">
                  <strong>{sp.name}</strong>
                  <small className="dim">#{sp.id} · {sp.speciesKey}</small>
                </div>
                <div className="combobox-pokemon-types">
                  {sp.types.map((t) => <span key={t} className={`type-chip type-${t.toLowerCase()}`}>{t}</span>)}
                </div>
              </div>
            )}
          />
          <label className="give-level">
            Lv
            <input
              type="number"
              min={1}
              max={100}
              value={give.level}
              onChange={(e) => setGive({ ...give, level: parseInt(e.target.value, 10) || 1 })}
            />
          </label>
          <label className="give-shiny">
            <input
              type="checkbox"
              checked={give.isShiny}
              onChange={(e) => setGive({ ...give, isShiny: e.target.checked })}
            />
            Shiny
          </label>
          <button className="btn-primary btn-small" onClick={giveMon} disabled={!give.species}>Give</button>
        </div>
        <p className="dim small">
          Adds a fresh Pokémon with perfect IVs and the given level. Stats re-derive from the species catalog on the user's next save load.
        </p>
      </section>
    </>
  );
}

function PokemonRow({ mon, onEdit, onRemove, useStaticSprite }: {
  mon: any;
  onEdit: (patch: Record<string, unknown>) => void;
  onRemove: () => void;
  useStaticSprite?: boolean;
}) {
  // Box uses the static PNG (cheap to render hundreds at once); party
  // uses the animated Gen-V GIF. pokemonStaticSpriteUrl needs a numeric
  // dex id, so map slug→id via POKEMON_LIST.
  const dexId = useStaticSprite
    ? POKEMON_LIST.find((p) => p.speciesKey === mon.speciesKey)?.id ?? null
    : null;
  const spriteUrl = useStaticSprite
    ? (dexId != null ? pokemonStaticSpriteUrl(dexId) : "")
    : pokemonSpriteUrl(mon.speciesKey, false, !!mon.isShiny);
  return (
    <div className="poke-card">
      <div className="poke-card-head">
        <div className="poke-card-sprite-wrap">
          {spriteUrl ? (
            <img
              className="poke-card-sprite"
              src={spriteUrl}
              alt=""
              loading="lazy"
              style={{ imageRendering: "pixelated" }}
            />
          ) : (
            <div className="poke-card-sprite missing" title="Sprite unavailable">?</div>
          )}
        </div>
        <div className="poke-card-name">
          <strong>{mon.nickname ?? mon.name ?? mon.speciesKey}</strong>
          {mon.isShiny && <span className="poke-shiny" title="Shiny">★</span>}
          <div className="dim small mono">{mon.speciesKey}</div>
        </div>
        <button className="btn-ghost btn-tiny" onClick={onRemove} title="Remove">×</button>
      </div>
      <div className="poke-card-body">
        <label>
          <span>Lv</span>
          <input type="number" min={1} max={100} value={mon.level ?? 1} onChange={(e) => onEdit({ level: clamp(parseInt(e.target.value, 10) || 1, 1, 100) })} />
        </label>
        <label>
          <span>Nickname</span>
          <input type="text" maxLength={32} value={mon.nickname ?? ""} onChange={(e) => onEdit({ nickname: e.target.value || undefined })} />
        </label>
        <label>
          <span>Held item</span>
          <input
            type="text"
            value={mon.heldItem ?? ""}
            onChange={(e) => onEdit({ heldItem: e.target.value || null })}
            placeholder="(none)"
          />
        </label>
        <label className="poke-shiny-toggle">
          <input type="checkbox" checked={!!mon.isShiny} onChange={(e) => onEdit({ isShiny: e.target.checked })} />
          <span>Shiny</span>
        </label>
      </div>
    </div>
  );
}

// ─── Items tab — inventory with item picker ────────────────────────────
function ItemsTab({ save, edit, onEdit, userId, reload }: {
  save: any; edit: SaveEdit; onEdit: (e: SaveEdit) => void;
  userId: string; reload: () => void;
}) {
  const live = useMemo(() => edit.inventory ?? (save.inventory ?? {}), [edit, save]);
  const [pickedItem, setPickedItem] = useState<typeof ITEM_LIST[number] | null>(null);
  const [pickedQuery, setPickedQuery] = useState("");
  const [newQty, setNewQty] = useState(1);
  const [grantBusy, setGrantBusy] = useState(false);
  const [grantMsg, setGrantMsg] = useState<string | null>(null);

  const setItem = (itemId: string, qty: number) => {
    const next = { ...live };
    if (qty <= 0) delete next[itemId];
    else next[itemId] = Math.max(0, Math.min(999_999, Math.floor(qty)));
    onEdit({ ...edit, inventory: next });
  };

  // "Grant immediately" path uses the focused /items endpoint, which
  // applies + persists in one shot. Useful when the admin just wants
  // to hand someone an item without going through the patch save flow.
  const grantNow = async () => {
    if (!pickedItem) {
      window.alert("Pick an item first.");
      return;
    }
    setGrantBusy(true);
    setGrantMsg(null);
    try {
      await api.setUserItem(userId, pickedItem.id, newQty);
      setGrantMsg(`Set ${pickedItem.name} → ${newQty}.`);
      setPickedItem(null);
      setPickedQuery("");
      setNewQty(1);
      reload();
    } catch (e) {
      setGrantMsg(`Error: ${(e as Error).message}`);
    } finally {
      setGrantBusy(false);
    }
  };

  // Match inventory entries up with catalog metadata so we can show
  // the item's display name + sprite next to the slug. Falls back to
  // the raw slug when an unknown item id is in the user's save.
  const itemMeta = useMemo(() => {
    const map = new Map<string, typeof ITEM_LIST[number]>();
    for (const it of ITEM_LIST) map.set(it.id, it);
    return map;
  }, []);
  const sortedEntries = Object.entries(live).sort(([a], [b]) => {
    const ma = itemMeta.get(a)?.name ?? a;
    const mb = itemMeta.get(b)?.name ?? b;
    return ma.localeCompare(mb);
  });

  return (
    <>
      <section className="profile-section">
        <h3>Inventory <span className="dim small">({sortedEntries.length} items)</span></h3>
        <div className="inv-grid">
          {sortedEntries.map(([itemId, qty]) => {
            const meta = itemMeta.get(itemId);
            return (
              <div className="inv-cell" key={itemId}>
                <img
                  className="inv-sprite"
                  src={itemSpriteUrl(itemId, meta?.spriteOverride)}
                  alt=""
                  loading="lazy"
                  width={24}
                  height={24}
                  style={{ imageRendering: "pixelated" }}
                />
                <div className="inv-name">
                  <strong>{meta?.name ?? itemId}</strong>
                  <span className="dim small mono">{itemId}</span>
                </div>
                <input
                  type="number"
                  min={0}
                  max={999_999}
                  value={qty as number}
                  onChange={(e) => setItem(itemId, parseInt(e.target.value, 10) || 0)}
                />
                <button className="btn-ghost btn-tiny" onClick={() => setItem(itemId, 0)} title="Remove">×</button>
              </div>
            );
          })}
          {sortedEntries.length === 0 && <div className="dim small">Inventory is empty.</div>}
        </div>
        <p className="dim small">
          Edits join the pending patch — hit "Save changes" at the bottom.
          Or use "Grant now" below to set an item quantity instantly without going through the save flow.
        </p>
      </section>

      <section className="profile-section">
        <h3>Grant item now</h3>
        <div className="inv-grant">
          <Combobox
            value={pickedQuery}
            onChange={(text) => { setPickedQuery(text); setPickedItem(null); }}
            onSelect={(it) => { setPickedItem(it); setPickedQuery(it.name); }}
            options={ITEM_LIST}
            placeholder="Search items by name, slug, or category…"
            getKey={(it) => it.id}
            getSearchText={(it) => `${it.name} ${it.id} ${it.category}`}
            renderOption={(it) => (
              <div className="combobox-item">
                <img
                  src={itemSpriteUrl(it.id, it.spriteOverride)}
                  alt=""
                  width={24}
                  height={24}
                  loading="lazy"
                  style={{ imageRendering: "pixelated" }}
                />
                <div className="combobox-item-info">
                  <strong>{it.name}</strong>
                  <small className="dim">{it.category} · {it.id}</small>
                </div>
              </div>
            )}
          />
          <input
            type="number"
            min={0}
            max={999_999}
            value={newQty}
            onChange={(e) => setNewQty(parseInt(e.target.value, 10) || 0)}
          />
          <button className="btn-primary btn-small" onClick={grantNow} disabled={grantBusy || !pickedItem}>
            {grantBusy ? "Setting…" : "Grant"}
          </button>
        </div>
        {grantMsg && <p className="profile-msg dim small">{grantMsg}</p>}
      </section>
    </>
  );
}

// ─── Progress tab — money, badges, E4, champion ────────────────────────
function ProgressTab({ save, edit, onEdit }: { save: any; edit: SaveEdit; onEdit: (e: SaveEdit) => void }) {
  const live = useMemo(() => ({
    money: edit.money ?? (save.money ?? 0),
    victoryTokens: edit.victoryTokens ?? (save.victoryTokens ?? 0),
    championDefeated: edit.championDefeated ?? (save.championDefeated ?? false),
    defeatedGyms: (edit.defeatedGyms ?? save.defeatedGyms ?? []) as string[],
    defeatedEliteFour: (edit.defeatedEliteFour ?? save.defeatedEliteFour ?? []) as string[],
  }), [edit, save]);

  const toggleGym = (gid: string) => {
    const cur = new Set(live.defeatedGyms);
    if (cur.has(gid)) cur.delete(gid); else cur.add(gid);
    onEdit({ ...edit, defeatedGyms: Array.from(cur) });
  };
  const toggleE4 = (eid: string) => {
    const cur = new Set(live.defeatedEliteFour);
    if (cur.has(eid)) cur.delete(eid); else cur.add(eid);
    onEdit({ ...edit, defeatedEliteFour: Array.from(cur) });
  };

  return (
    <>
      <section className="profile-section">
        <h3>Currency</h3>
        <div className="progress-currency">
          <label>
            <span>Money</span>
            <input type="number" min={0} max={999_999_999} value={live.money}
              onChange={(e) => onEdit({ ...edit, money: Math.max(0, Math.min(999_999_999, parseInt(e.target.value, 10) || 0)) })} />
          </label>
          <label>
            <span>Victory tokens</span>
            <input type="number" min={0} value={live.victoryTokens}
              onChange={(e) => onEdit({ ...edit, victoryTokens: Math.max(0, parseInt(e.target.value, 10) || 0) })} />
          </label>
        </div>
      </section>

      <section className="profile-section">
        <h3>Gym badges</h3>
        <div className="progress-checks">
          {GYM_IDS.map((g) => (
            <label key={g} className="progress-check">
              <input type="checkbox" checked={live.defeatedGyms.includes(g)} onChange={() => toggleGym(g)} />
              <span>{GYM_NAMES[g]}</span>
            </label>
          ))}
        </div>
      </section>

      <section className="profile-section">
        <h3>Elite Four & Champion</h3>
        <div className="progress-checks">
          {E4_IDS.map((e) => (
            <label key={e} className="progress-check">
              <input type="checkbox" checked={live.defeatedEliteFour.includes(e)} onChange={() => toggleE4(e)} />
              <span>{E4_NAMES[e]}</span>
            </label>
          ))}
          <label className="progress-check">
            <input type="checkbox" checked={live.championDefeated} onChange={() => onEdit({ ...edit, championDefeated: !live.championDefeated })} />
            <span>Champion</span>
          </label>
        </div>
      </section>
    </>
  );
}

// ─── Messages tab — every chat message this user has sent ──────────────
function MessagesTab({ userId }: { userId: string }) {
  const [messages, setMessages] = useState<UserMessage[]>([]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setBusy(true);
    api.userMessages(userId, 200)
      .then((d) => setMessages(d.messages))
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(false));
  }, [userId]);

  const channelLabel = (chan: string) => {
    if (chan === "global") return "Global";
    if (chan.startsWith("area:")) return `Area · ${chan.slice(5)}`;
    if (chan.startsWith("dm:")) return "DM";
    return chan;
  };

  if (busy) return <p className="dim">Loading messages…</p>;
  if (err) return <div className="page-err">{err}</div>;
  if (messages.length === 0) return <p className="dim">No messages.</p>;

  return (
    <div className="messages-list">
      {messages.map((m) => (
        <div key={m.id} className="message-row">
          <div className="message-meta">
            <span className={`channel-tag ${m.channelId.startsWith("dm:") ? "dm" : m.channelId === "global" ? "global" : "area"}`}>
              {channelLabel(m.channelId)}
            </span>
            <span className="dim small">{new Date(m.createdAt).toLocaleString()}</span>
          </div>
          <div className="message-content">{m.content}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Trades tab — completed-trade history (both sides) ─────────────────
function TradesTab({ userId }: { userId: string }) {
  const [trades, setTrades] = useState<UserTrade[]>([]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setBusy(true);
    api.userTrades(userId)
      .then((d) => setTrades(d.trades))
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(false));
  }, [userId]);

  if (busy) return <p className="dim">Loading trades…</p>;
  if (err) return <div className="page-err">{err}</div>;
  if (trades.length === 0) return <p className="dim">No trade history. Records start populating with the next trade after this commit deploys.</p>;

  return (
    <div className="trades-list">
      {trades.map((t) => {
        // The "self" side is whichever record column matches this user.
        // Render as: you sent X → them sent Y, with both species + level
        // and the counterpart's username.
        const youAreA = t.userAId === userId;
        const youSent = youAreA
          ? { species: t.userASentSpecies, level: t.userASentLevel, mon: safeParseMon(t.userASentMon) }
          : { species: t.userBSentSpecies, level: t.userBSentLevel, mon: safeParseMon(t.userBSentMon) };
        const theySent = youAreA
          ? { species: t.userBSentSpecies, level: t.userBSentLevel, mon: safeParseMon(t.userBSentMon) }
          : { species: t.userASentSpecies, level: t.userASentLevel, mon: safeParseMon(t.userASentMon) };
        const partnerName = youAreA ? t.userBUsername : t.userAUsername;

        return (
          <div key={t.id} className="trade-row">
            <div className="trade-row-meta">
              <span className="dim small">{new Date(t.createdAt).toLocaleString()}</span>
              <span className="dim small">↔ <strong>{partnerName}</strong></span>
            </div>
            <div className="trade-row-mons">
              <TradeMonCard label="Sent" mon={youSent.mon} fallbackSpecies={youSent.species} fallbackLevel={youSent.level} />
              <span className="trade-arrow" aria-hidden>⇄</span>
              <TradeMonCard label="Received" mon={theySent.mon} fallbackSpecies={theySent.species} fallbackLevel={theySent.level} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function safeParseMon(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

function TradeMonCard({ label, mon, fallbackSpecies, fallbackLevel }: {
  label: string;
  mon: any;
  fallbackSpecies: string;
  fallbackLevel: number;
}) {
  const speciesKey = mon?.speciesKey ?? fallbackSpecies;
  const level = mon?.level ?? fallbackLevel;
  const isShiny = !!mon?.isShiny;
  const url = pokemonSpriteUrl(speciesKey, false, isShiny);
  return (
    <div className="trade-mon">
      <span className="trade-mon-label dim small">{label}</span>
      <div className="trade-mon-sprite-wrap">
        {url ? (
          <img className="trade-mon-sprite" src={url} alt="" loading="lazy" style={{ imageRendering: "pixelated" }} />
        ) : (
          <span className="dim small">?</span>
        )}
      </div>
      <div className="trade-mon-info">
        <strong>
          {mon?.nickname ?? mon?.name ?? speciesKey}
          {isShiny && <span className="poke-shiny" title="Shiny">★</span>}
        </strong>
        <small className="dim">Lv {level} · {speciesKey}</small>
      </div>
    </div>
  );
}

// ─── Sessions tab — Better Auth session rows ───────────────────────────
function SessionsTab({ userId }: { userId: string }) {
  const [sessions, setSessions] = useState<UserSession[]>([]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setBusy(true);
    api.userSessions(userId)
      .then((d) => setSessions(d.sessions))
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(false));
  }, [userId]);

  if (busy) return <p className="dim">Loading sessions…</p>;
  if (err) return <div className="page-err">{err}</div>;
  if (sessions.length === 0) return <p className="dim">No active or recent sessions. Better Auth removes expired rows automatically.</p>;

  return (
    <table className="sessions-table">
      <thead>
        <tr><th>Created</th><th>Last seen</th><th>IP</th><th>Country</th><th>User agent</th><th>Expires</th></tr>
      </thead>
      <tbody>
        {sessions.map((s) => (
          <tr key={s.id}>
            <td className="dim small">{new Date(s.createdAt).toLocaleString()}</td>
            <td className="dim small">{new Date(s.updatedAt).toLocaleString()}</td>
            <td className="mono">{s.ipAddress ?? "—"}</td>
            <td className="dim small">{s.country ?? "—"}</td>
            <td className="dim small ua-cell" title={s.userAgent ?? ""}>{shortenUA(s.userAgent)}</td>
            <td className="dim small">{new Date(s.expiresAt).toLocaleDateString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function shortenUA(ua: string | null): string {
  if (!ua) return "—";
  // Brief OS + browser hint — full UA is in the title tooltip.
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "?";
  const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "?";
  return `${os} · ${br}`;
}

// ─── Raw save tab — pre-formatted dump for full visibility ─────────────
function RawSaveTab({ save }: { save: any }) {
  const json = JSON.stringify(save, null, 2);
  const copy = () => {
    navigator.clipboard.writeText(json).then(
      () => window.alert("Save JSON copied to clipboard."),
      () => window.alert("Couldn't copy — your browser blocked clipboard write."),
    );
  };
  return (
    <>
      <div className="raw-toolbar">
        <button className="btn-ghost btn-small" onClick={copy}>Copy JSON</button>
        <span className="dim small">{(json.length / 1024).toFixed(1)} KB</span>
      </div>
      <pre className="raw-save">{json}</pre>
    </>
  );
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
