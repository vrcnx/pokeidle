import { useEffect, useMemo, useRef, useState } from "react";
import { api, type AdminUser, type UserSession, type UserMessage, type UserTrade, type UserSortKey, type UserFilter, type SaveSnapshotRow } from "../api";
import { Combobox } from "../components/Combobox";
import {
  POKEMON_LIST,
  ITEM_LIST,
  pokemonSpriteUrl,
  itemSpriteUrl,
  pokemonStaticSpriteUrl,
  createPokemon,
  deriveStatsForLevel,
  type IVs,
  type Stats,
} from "../data/gameCatalog";

// ─── User list page ────────────────────────────────────────────────────
// Two views in one component, switched by `selected` state:
//   - List view (default): paginated, searchable user table
//   - Detail view: full-page tabbed management panel for one user
// Clicking a row navigates to detail; the "Back to users" button on
// the detail view returns to the list, preserving search + page state.
export function UsersPage({
  focusUserId,
  initialQuery,
}: {
  /** Set when another page navigated here to act on a specific player
   *  (e.g. "Ban" from a chat message). Opens their detail directly. */
  focusUserId?: string;
  /** Set when another page navigated here with a search intent. */
  initialQuery?: string;
} = {}) {
  const [q, setQ] = useState(initialQuery ?? "");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ total: number; users: AdminUser[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(focusUserId ?? null);
  const [sort, setSort] = useState<UserSortKey>("createdAt");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [filter, setFilter] = useState<UserFilter>("all");
  // Checkbox selection for bulk actions. Keyed by id, and deliberately
  // NOT cleared on page change so the operator can gather offenders
  // across pages before acting once.
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [bulkErr, setBulkErr] = useState<string | null>(null);
  const PAGE_SIZE = 25;

  const toggleSort = (key: UserSortKey) => {
    if (sort === key) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSort(key);
      // Text sorts read naturally A→Z; numeric/date sorts are almost
      // always "biggest/newest first" when you first click them.
      setDir(key === "username" ? "asc" : "desc");
    }
    setPage(0);
  };

  // Re-focus when the operator drills in again from another page while
  // Users is already mounted — a second "Ban" click from chat must move
  // to the new player rather than sit on the previous one.
  useEffect(() => {
    if (focusUserId) setSelected(focusUserId);
  }, [focusUserId]);
  useEffect(() => {
    if (initialQuery !== undefined) { setQ(initialQuery); setPage(0); }
  }, [initialQuery]);

  // Monotonic request id. Every keystroke fires a request, and they can
  // resolve out of order — typing "ash" issues a/as/ash, and if "a"
  // (25 rows) lands after "ash" (2 rows) the table paints results that
  // do not match what the box says. Stamping each request and ignoring
  // any response that is not the newest makes the last keystroke always
  // win, regardless of what the network does.
  const reqSeq = useRef(0);

  const reload = () => {
    const seq = ++reqSeq.current;
    setBusy(true);
    setErr(null);
    api.listUsers(q, page, PAGE_SIZE, { sort, dir, filter })
      .then((d) => {
        if (seq !== reqSeq.current) return;   // superseded — drop it
        setData({ total: d.total, users: d.users });
      })
      .catch((e) => {
        if (seq !== reqSeq.current) return;
        setErr(e.message);
      })
      .finally(() => {
        if (seq !== reqSeq.current) return;   // don't un-busy for a stale one
        setBusy(false);
      });
  };

  // Debounce typing so we issue one request per pause rather than one
  // per character. Page changes are deliberate clicks, so those go
  // through immediately.
  useEffect(() => {
    const t = window.setTimeout(reload, q ? 250 : 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, page, sort, dir, filter]);

  const pageIds = (data?.users ?? []).map((u) => u.id);
  const pageAllChecked = pageIds.length > 0 && pageIds.every((id) => checked.has(id));
  const pageSomeChecked = pageIds.some((id) => checked.has(id));

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
        <div className="seg-tabs" role="tablist" aria-label="Filter users">
          {(["all", "banned", "admins"] as UserFilter[]).map((f) => (
            <button
              key={f}
              role="tab"
              aria-selected={filter === f}
              className={`seg-tab ${filter === f ? "active" : ""}`}
              onClick={() => { setFilter(f); setPage(0); }}
            >
              {f === "all" ? "All" : f === "banned" ? "Banned" : "Admins"}
            </button>
          ))}
        </div>
        <button className="btn-primary" onClick={reload} disabled={busy}>Refresh</button>
      </div>

      {err && <div className="page-err">Error: {err}</div>}
      {bulkErr && <div className="page-err">{bulkErr}</div>}

      {checked.size > 0 && (
        <BulkBar
          count={checked.size}
          onClear={() => setChecked(new Set())}
          onBan={async (days, reason) => {
            setBulkErr(null);
            const until = new Date(Date.now() + days * 86400000).toISOString();
            try {
              const res = await api.bulkBan([...checked], until, reason);
              setChecked(new Set());
              reload();
              if (res.skippedSelf) {
                setBulkErr("Your own account was in the selection and was skipped.");
              }
            } catch (e) {
              setBulkErr(`Bulk ban failed: ${(e as Error).message}`);
            }
          }}
          onUnban={async () => {
            setBulkErr(null);
            try {
              await api.bulkBan([...checked], null, null);
              setChecked(new Set());
              reload();
            } catch (e) {
              setBulkErr(`Bulk unban failed: ${(e as Error).message}`);
            }
          }}
        />
      )}

      <table className="users-table">
        <thead>
          <tr>
            <th className="users-check-col">
              <input
                type="checkbox"
                aria-label="Select all on this page"
                checked={pageAllChecked}
                ref={(el) => { if (el) el.indeterminate = pageSomeChecked && !pageAllChecked; }}
                onChange={(e) => {
                  const ids = (data?.users ?? []).map((u) => u.id);
                  setChecked((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) ids.forEach((id) => next.add(id));
                    else ids.forEach((id) => next.delete(id));
                    return next;
                  });
                }}
              />
            </th>
            <SortTh label="Username"  col="username"           sort={sort} dir={dir} onSort={toggleSort} />
            <th>Email</th>
            <SortTh label="Lv"        col="accountLevel"       sort={sort} dir={dir} onSort={toggleSort} />
            <SortTh label="Dex"       col="pokedexCaughtCount" sort={sort} dir={dir} onSort={toggleSort} />
            <th>Status</th>
            <SortTh label="Created"   col="createdAt"          sort={sort} dir={dir} onSort={toggleSort} />
            <SortTh label="Last seen" col="lastSeenAt"         sort={sort} dir={dir} onSort={toggleSort} />
            <th></th>
          </tr>
        </thead>
        <tbody>
          {(data?.users ?? []).map((u) => (
            <tr
              key={u.id}
              onClick={() => setSelected(u.id)}
              style={{ cursor: "pointer" }}
              className={checked.has(u.id) ? "is-checked" : ""}
            >
              <td className="users-check-col" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  aria-label={`Select ${u.username}`}
                  checked={checked.has(u.id)}
                  onChange={(e) => {
                    setChecked((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(u.id); else next.delete(u.id);
                      return next;
                    });
                  }}
                />
              </td>
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
            <tr><td colSpan={9} className="dim center">No users match.</td></tr>
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

// Sortable column header. Sorting is server-side (an allow-listed
// orderBy), so this only owns the affordance + which way the arrow
// points. Rendered as a real button so it is keyboard-reachable.
function SortTh({
  label, col, sort, dir, onSort,
}: {
  label: string;
  col: UserSortKey;
  sort: UserSortKey;
  dir: "asc" | "desc";
  onSort: (c: UserSortKey) => void;
}) {
  const active = sort === col;
  return (
    <th
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      className={active ? "sort-th is-active" : "sort-th"}
    >
      <button type="button" className="sort-th-btn" onClick={() => onSort(col)}>
        {label}
        <span className="sort-th-arrow" aria-hidden>
          {active ? (dir === "asc" ? "▲" : "▼") : "↕"}
        </span>
      </button>
    </th>
  );
}

// Bulk action bar — appears only when rows are selected.
//
// Ban only. Bulk delete is deliberately absent: delete cascades and is
// unrecoverable, so one mis-clicked checkbox would be unrecoverable
// across N accounts. Bans are reversible, which is exactly what makes
// them safe to do in bulk.
function BulkBar({
  count, onClear, onBan, onUnban,
}: {
  count: number;
  onClear: () => void;
  onBan: (days: number, reason: string | null) => void;
  onUnban: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => void | Promise<void>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };
  return (
    <div className="bulk-bar" role="region" aria-label="Bulk actions">
      <strong className="tabular">{count}</strong>
      <span>selected</span>
      <button className="linklike" onClick={onClear}>Clear</button>
      <div className="bulk-bar-actions">
        <button
          className="btn-danger btn-small"
          disabled={busy}
          onClick={() => {
            const reason = window.prompt(
              `Ban ${count} account${count === 1 ? "" : "s"} for 7 days?

` +
              `Reason (optional) — OK to ban, Cancel to abort.`
            );
            if (reason === null) return;   // Cancel must abort, not ban
            void run(() => onBan(7, reason.trim() || null));
          }}
        >Ban 7 days</button>
        <button
          className="btn-ghost btn-small"
          disabled={busy}
          onClick={() => {
            if (!window.confirm(`Unban ${count} account${count === 1 ? "" : "s"}?`)) return;
            void run(onUnban);
          }}
        >Unban</button>
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

// Best-effort "what did this edit actually gift them" summary, so the
// announce checkbox starts pre-filled instead of blank. Only looks at
// party/box: a newly-added mon (id not present before) or an existing
// mon whose isShiny flipped false->true. Anything else in the patch
// (money, inventory bulk-edit, progress flags) isn't gift-shaped, so
// this falls back to "" and the operator types their own line if they
// still want to announce it.
function suggestGiftMessage(save: any, edit: SaveEdit, username: string): string {
  const parts: string[] = [];
  for (const key of ["party", "box"] as const) {
    const after = edit[key];
    if (!after) continue;
    const before = (save?.[key] ?? []) as any[];
    const beforeById = new Map(before.map((m) => [m.id, m]));
    for (const mon of after) {
      const prior = beforeById.get(mon.id);
      const label = mon.nickname ?? mon.name ?? mon.speciesKey;
      if (!prior) {
        parts.push(`gifted @${username} a ${mon.isShiny ? "Shiny " : ""}${label} (Lv${mon.level})`);
      } else if (!prior.isShiny && mon.isShiny) {
        parts.push(`made @${username}'s ${label} shiny`);
      }
    }
  }
  if (parts.length === 0) return "";
  const joined = parts.join(" and ") + "!";
  // Matches the server's own 300-char cap (postGiftAnnouncement) — truncate
  // here too so a big batch gift doesn't silently lose its ending server-side
  // with no warning to the operator.
  return joined.length > 300 ? joined.slice(0, 299) + "…" : joined;
}

// ─── User detail (full page) ──────────────────────────────────────────
function UserDetailFullPage({ id, onBack, onChange }: { id: string; onBack: () => void; onChange: () => void }) {
  const [tab, setTab] = useState<DetailTab>("profile");
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<SaveEdit>({});
  const [savingMsg, setSavingMsg] = useState<string | null>(null);
  const [announceOn, setAnnounceOn] = useState(false);
  const [announceText, setAnnounceText] = useState("");
  const [announceTouched, setAnnounceTouched] = useState(false);

  const reload = () => {
    api.getUser(id).then((u) => {
      setData(u);
      setEdit({});
      setAnnounceOn(false);
      setAnnounceText("");
      setAnnounceTouched(false);
    }).catch((e) => setErr(e.message));
  };
  useEffect(reload, [id]);

  // All hooks (including this one) must stay above the early returns
  // below — a hook count that differs between renders crashes React
  // ("Rendered fewer hooks than expected"). Safe to compute even while
  // data is still null; save just stays null until it loads.
  const save = data?.saveData ? (() => { try { return JSON.parse(data.saveData); } catch { return null; } })() : null;
  const suggestedAnnounce = useMemo(
    () => (save && data ? suggestGiftMessage(save, edit, data.username) : ""),
    [save, edit, data],
  );
  // Keep the announce text in sync with the live suggestion until the
  // operator types their own — otherwise a stale suggestion (e.g. "gifted
  // a Pikachu") can survive further edits that remove that mon, posting a
  // factually false public gift card. Also drop the announce entirely if
  // the edit stops being gift-shaped (e.g. only a money/progress change
  // remains), since a "gift" card shouldn't describe a non-gift edit.
  useEffect(() => {
    if (!announceTouched) setAnnounceText(suggestedAnnounce);
    if (!suggestedAnnounce) setAnnounceOn(false);
  }, [suggestedAnnounce, announceTouched]);

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

  const [saveErr, setSaveErr] = useState<string | null>(null);
  const saveEdit = async () => {
    if (Object.keys(edit).length === 0) return;
    setBusy(true);
    setSavingMsg(null);
    setSaveErr(null);
    try {
      // Sends the saveVersion THIS PAGE loaded with, not a version
      // re-read at request time — lets the server tell a genuinely
      // stale edit apart from a fresh one instead of silently
      // overwriting whatever the player's own live client saved in
      // between (see save-patch's doc comment on the server).
      const res = await api.savePatch(id, edit as Record<string, unknown>, announceOn ? announceText : undefined, data.saveVersion);
      setSavingMsg(`Saved (${res.keys.join(", ")}). v${res.saveVersion}`);
      reload();
      onChange();
    } catch (e) {
      setSaveErr((e as Error).message);
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
          <ItemsTab save={save} edit={edit} onEdit={setEdit} userId={id} username={data.username} reload={reload} />
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

      {saveErr && (
        <div className="profile-action-err" role="alert">
          <span>{saveErr}</span>
          <button type="button" className="profile-action-err-x" onClick={() => setSaveErr(null)} aria-label="Dismiss">×</button>
        </div>
      )}
      {dirty && tab !== "messages" && tab !== "sessions" && tab !== "raw" && (
        <div className="detail-savebar detail-savebar-page detail-savebar-with-announce">
          {/* Only offered when the pending edit is actually gift-shaped
              (a new/shiny-flipped Pokémon) — a generic money/progress
              correction shouldn't be announceable as a "gift" card. */}
          {suggestedAnnounce && (
            <label className="gift-announce-toggle">
              <input
                type="checkbox"
                checked={announceOn}
                onChange={(e) => setAnnounceOn(e.target.checked)}
              />
              🎁 Announce in chat
            </label>
          )}
          {announceOn && suggestedAnnounce && (
            <input
              className="gift-announce-input"
              type="text"
              value={announceText}
              onChange={(e) => { setAnnounceText(e.target.value); setAnnounceTouched(true); }}
              placeholder="What should the chat card say?"
              maxLength={300}
            />
          )}
          <span className="dim small" style={{ marginLeft: "auto" }}>
            {savingMsg ?? `Unsaved changes (${Object.keys(edit).join(", ")})`}
          </span>
          <button className="btn-ghost" onClick={() => { setEdit({}); setSavingMsg(null); setAnnounceOn(false); setAnnounceText(""); setAnnounceTouched(false); }} disabled={busy}>Discard</button>
          <button className="btn-primary" onClick={saveEdit} disabled={busy || (announceOn && !announceText.trim())}>
            {busy ? "Saving…" : "Save changes"}
          </button>
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
  // Surfaced by run() when any destructive action rejects. Rendered at
  // the top of the profile tab, not buried next to one button, because
  // the operator needs to see it wherever they clicked from.
  const [actionErr, setActionErr] = useState<string | null>(null);

  // Every destructive action funnels through here. Previously each was
  // `try { ... } finally { setBusy(false) }` with NO catch — so a
  // rejected request propagated as an unhandled rejection, rendered
  // nothing, and left the operator staring at a button that had just
  // un-greyed itself. A failed ban was pixel-identical to a successful
  // one. Now a failure always says so.
  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(true);
    setActionErr(null);
    try {
      await fn();
    } catch (e) {
      setActionErr(`${label} failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const promote = () =>
    run(data.isAdmin ? "Demote" : "Promote", async () => {
      await api.setAdmin(data.id, !data.isAdmin);
      reload(); onChange();
    });

  const ban = () => {
    // window.prompt returns null on Cancel and "" on OK-with-no-text.
    // The old code did `window.prompt(...) ?? null`, which maps BOTH to
    // null and then banned regardless — pressing Cancel on the reason
    // prompt still handed a real player a 7-day ban, with no confirm
    // step anywhere. Compare against null explicitly so Cancel aborts
    // and an empty reason still goes through (the reason is optional).
    const reason = window.prompt(
      `Ban ${data.username} for 7 days?\n\n` +
      `Reason (optional) — press OK to ban, Cancel to abort.`
    );
    if (reason === null) return;
    const until = new Date(Date.now() + 7 * 86400000).toISOString();
    return run("Ban", async () => {
      await api.ban(data.id, until, reason.trim() || null);
      reload(); onChange();
    });
  };

  const unban = () =>
    run("Unban", async () => {
      await api.ban(data.id, null, null);
      reload(); onChange();
    });

  const resetSave = () => {
    if (!window.confirm(`Reset ${data.username}'s save? This cannot be undone.`)) return;
    return run("Reset save", async () => {
      await api.resetSave(data.id);
      reload(); onChange();
    });
  };

  const deleteUser = () => {
    // Delete cascades and is unrecoverable, so a plain OK/Cancel is too
    // easy to fat-finger from a list of similar-looking rows. Require
    // the operator to type the username — the standard "type to confirm"
    // gate (GitHub repo deletion, Stripe account closure) for an action
    // with no undo.
    const typed = window.prompt(
      `Permanently DELETE ${data.username}?\n\n` +
      `This cascades to their friends, chat messages and sessions, and cannot be undone.\n\n` +
      `Type the username to confirm:`
    );
    if (typed === null) return;
    if (typed.trim() !== data.username) {
      setActionErr("Delete aborted — the username you typed did not match.");
      return;
    }
    return run("Delete", async () => {
      await api.deleteUser(data.id);
      onClose(); onChange();
    });
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
      {actionErr && (
        <div className="profile-action-err" role="alert">
          <span>{actionErr}</span>
          <button
            type="button"
            className="profile-action-err-x"
            onClick={() => setActionErr(null)}
            aria-label="Dismiss"
          >×</button>
        </div>
      )}
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

      <SaveHistorySection
        userId={data.id}
        username={data.username}
        onRestored={() => { reload(); onChange(); }}
      />
    </>
  );
}

// ─── Save history — append-only checkpoints + one-click restore ─────────
function SaveHistorySection({ userId, username, onRestored }: {
  userId: string; username: string; onRestored: () => void;
}) {
  const [rows, setRows] = useState<SaveSnapshotRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = () => {
    api.listSnapshots(userId)
      .then((d) => setRows(d.snapshots))
      .catch((e) => setErr(e.message));
  };
  useEffect(load, [userId]);

  const restore = async (snap: SaveSnapshotRow) => {
    const when = new Date(snap.createdAt).toLocaleString();
    if (!window.confirm(
      `Restore ${username} to the save from ${when} (v${snap.saveVersion})?\n\n`
      + `Their CURRENT save is checkpointed first, so this is reversible. `
      + `Any device they have open will be bumped and re-pull on its next save.`
    )) return;
    setBusyId(snap.id); setErr(null); setNote(null);
    try {
      const res = await api.restoreSnapshot(userId, snap.id);
      setNote(`Restored to v${snap.saveVersion}. New save version: ${res.saveVersion}.`);
      load();
      onRestored();
    } catch (e: any) {
      setErr(`Restore failed: ${e?.message ?? "unknown"}`);
    } finally { setBusyId(null); }
  };

  return (
    <section className="profile-section">
      <h3>Save history <span className="dim small">· {rows?.length ?? "…"}</span></h3>
      <p className="dim small">
        Automatic checkpoints (≤ 1 per 30 min, newest 24 kept). Restoring first checkpoints
        the current save, so it can be undone by restoring that.
      </p>
      {err && <div className="profile-action-err" role="alert"><span>{err}</span></div>}
      {note && <p className="profile-msg dim small">{note}</p>}
      {rows === null
        ? <p className="dim small">Loading…</p>
        : rows.length === 0
          ? <p className="dim small">No checkpoints yet — they'll accrue as the player saves.</p>
          : (
            <table className="snapshot-table">
              <thead>
                <tr><th>When</th><th>Ver</th><th>Lv</th><th>Badges</th><th>Dex</th><th>Money</th><th>Size</th><th></th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={r.reason === "pre-restore" ? "snapshot-row--prerestore" : ""}>
                    <td>
                      {new Date(r.createdAt).toLocaleString()}
                      {r.reason === "pre-restore" && <span className="snapshot-tag" title="Captured just before a restore">pre-restore</span>}
                    </td>
                    <td>{r.saveVersion}</td>
                    <td>{r.summary?.level ?? "—"}</td>
                    <td>{r.summary?.badges ?? "—"}</td>
                    <td>{r.summary?.caught ?? "—"}</td>
                    <td>{r.summary ? r.summary.money.toLocaleString() : "—"}</td>
                    <td>{r.summary ? `${Math.round(r.summary.bytes / 1024)}KB` : "—"}</td>
                    <td>
                      <button className="btn-secondary btn-tiny" onClick={() => restore(r)} disabled={busyId !== null}>
                        {busyId === r.id ? "Restoring…" : "Restore"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
    </section>
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
          <input
            type="number"
            min={1}
            max={100}
            value={mon.level ?? 1}
            onChange={(e) => {
              const level = clamp(parseInt(e.target.value, 10) || 1, 1, 100);
              // Patch the derived stats alongside the level. Writing
              // `level` on its own leaves maxHp/attack/... at their old
              // values — the game does NOT recompute them on load, and
              // validateSave only bounds-checks, so a Lv100 mon with Lv5
              // stats persists happily and loses every battle. Preserve
              // the mon's real IVs/EVs rather than assuming perfect ones.
              const derived = deriveStatsForLevel(
                mon.speciesKey,
                level,
                mon.ivs as Partial<IVs> | undefined,
                mon.evs as Partial<Stats> | undefined,
              );
              if (!derived) { onEdit({ level }); return; }  // unknown species: don't invent stats
              // Keep the HP fraction the mon had, so editing the level of
              // a hurt Pokemon does not silently full-heal or leave it on
              // more HP than its new max allows.
              const prevMax = typeof mon.maxHp === "number" && mon.maxHp > 0 ? mon.maxHp : derived.maxHp;
              const prevCur = typeof mon.currentHp === "number" ? mon.currentHp : prevMax;
              const frac = Math.max(0, Math.min(1, prevCur / prevMax));
              onEdit({
                level,
                ...derived,
                currentHp: Math.max(1, Math.round(derived.maxHp * frac)),
              });
            }}
          />
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
function ItemsTab({ save, edit, onEdit, userId, username, reload }: {
  save: any; edit: SaveEdit; onEdit: (e: SaveEdit) => void;
  userId: string; username: string; reload: () => void;
}) {
  const live = useMemo(() => edit.inventory ?? (save.inventory ?? {}), [edit, save]);
  const [pickedItem, setPickedItem] = useState<typeof ITEM_LIST[number] | null>(null);
  const [pickedQuery, setPickedQuery] = useState("");
  const [newQty, setNewQty] = useState(1);
  const [grantBusy, setGrantBusy] = useState(false);
  const [grantMsg, setGrantMsg] = useState<string | null>(null);
  const [announceOn, setAnnounceOn] = useState(false);
  const [announceText, setAnnounceText] = useState("");
  const [announceTouched, setAnnounceTouched] = useState(false);

  const setItem = (itemId: string, qty: number) => {
    const next = { ...live };
    if (qty <= 0) delete next[itemId];
    else next[itemId] = Math.max(0, Math.min(999_999, Math.floor(qty)));
    onEdit({ ...edit, inventory: next });
  };

  const suggestedGrantAnnounce = pickedItem ? `gave @${username} ${newQty}x ${pickedItem.name}!` : "";
  // Same staleness fix as the top savebar (suggestGiftMessage): keep the
  // announce text in sync with the live picked item/quantity until the
  // operator types their own, so switching items after checking the box
  // can't leave a mismatched announcement behind.
  useEffect(() => {
    if (!announceTouched) setAnnounceText(suggestedGrantAnnounce);
    if (!suggestedGrantAnnounce) setAnnounceOn(false);
  }, [suggestedGrantAnnounce, announceTouched]);

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
      await api.setUserItem(userId, pickedItem.id, newQty, announceOn ? announceText : undefined);
      setGrantMsg(`Set ${pickedItem.name} → ${newQty}.`);
      setPickedItem(null);
      setPickedQuery("");
      setNewQty(1);
      setAnnounceOn(false);
      setAnnounceText("");
      setAnnounceTouched(false);
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
          <button
            className="btn-primary btn-small"
            onClick={grantNow}
            disabled={grantBusy || !pickedItem || (announceOn && !announceText.trim())}
          >
            {grantBusy ? "Setting…" : "Grant"}
          </button>
        </div>
        <div className="gift-announce-row">
          <label className="gift-announce-toggle">
            <input
              type="checkbox"
              checked={announceOn}
              onChange={(e) => setAnnounceOn(e.target.checked)}
            />
            🎁 Announce in chat
          </label>
          {announceOn && (
            <input
              className="gift-announce-input"
              type="text"
              value={announceText}
              onChange={(e) => { setAnnounceText(e.target.value); setAnnounceTouched(true); }}
              placeholder="What should the chat card say?"
              maxLength={300}
            />
          )}
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
