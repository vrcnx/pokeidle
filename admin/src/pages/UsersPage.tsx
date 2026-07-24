import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { confirm, notify } from "../components/Confirm";
import { api, type AdminUser, type UserSession, type UserMessage, type UserTrade, type UserSortKey, type UserFilter, type SaveSnapshotRow, type StreamKeyStatus, type StreamConfig, type StreamCommand } from "../api";
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
          onClick={async () => {
            if (!await confirm(`Unban ${count} account${count === 1 ? "" : "s"}?`)) return;
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
  const [saveErr, setSaveErr] = useState<string | null>(null);
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

  const saveEdit = async () => {
    if (Object.keys(edit).length === 0) return;
    setBusy(true);
    setSavingMsg(null);
    setSaveErr(null);
    try {
      // Send the loaded baseline for the edited keys so the server can apply
      // currencies as a delta onto the player's LATEST save (works even while
      // the player is actively autosaving — no more "save changed" 409).
      const baseVals: Record<string, unknown> = {};
      for (const k of Object.keys(edit)) baseVals[k] = (save ?? {})[k];
      const res = await api.savePatch(id, edit as Record<string, unknown>, announceOn ? announceText : undefined, data.saveVersion, baseVals);
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
          <PokemonTab save={save} edit={edit} onEdit={setEdit} userId={id} onGifted={reload} />
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

  const resetSave = async () => {
    if (!await confirm(`Reset ${data.username}'s save? This cannot be undone.`)) return;
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
    if (!await confirm(
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
    if (!await confirm(
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
function PokemonTab({ save, edit, onEdit, userId, onGifted }: {
  save: any; edit: SaveEdit; onEdit: (e: SaveEdit) => void;
  userId: string; onGifted: () => void;
}) {
  const [giveMsg, setGiveMsg] = useState<string | null>(null);
  const [giving, setGiving] = useState(false);
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
  const removeMon = async (where: "party" | "box", idx: number) => {
    const p = live[where][idx];
    if (!await confirm(`Remove ${p?.nickname ?? p?.name ?? "this Pokémon"} from ${where}?`)) return;
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
  // Gift the Pokémon via the mass-gift grant path (audience = this one
  // player) rather than staging it into the save-edit buffer + Save.
  //
  // The old flow patched the save with compare-and-swap on saveVersion, so
  // if the target had their game open it 409'd against their own live
  // autosave and the gift silently did nothing ("gift players doesn't work").
  // grantPrizesToUser increments the version without a CAS and the player's
  // client adopts it (online via the gift:received socket, offline via the
  // boot cloud-adoption sync), so the mon always lands — open tab or not.
  const giveMon = async () => {
    if (!give.species) { void notify("Pick a Pokémon first."); return; }
    const sp = give.species;
    const level = clamp(give.level, 1, 100);
    const mon = {
      ...createPokemon(sp.speciesKey, level, Date.now() % 1_000_000, give.isShiny),
      id: `admin_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    };
    setGiving(true); setGiveMsg(null);
    try {
      await api.massGift({
        audience: "selected",
        userIds: [userId],
        prizes: [{ kind: "pokemon", label: `${give.isShiny ? "Shiny " : ""}${sp.name} Lv${level}`, mon: mon as unknown as Record<string, unknown> }],
      });
      setGiveMsg(`Gifted ${give.isShiny ? "Shiny " : ""}${sp.name} (Lv${level}) — delivered live if they're online, on next load otherwise.`);
      setGive({ ...give, species: null, speciesQuery: "" });
      onGifted();
    } catch (e) {
      setGiveMsg(`Failed: ${(e as Error).message}`);
    } finally {
      setGiving(false);
    }
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
          <button className="btn-primary btn-small" onClick={giveMon} disabled={!give.species || giving}>{giving ? "Gifting…" : "Give"}</button>
        </div>
        {giveMsg && <p className="dim small" role="status" style={{ color: giveMsg.startsWith("Failed") ? "#fca5a5" : undefined }}>{giveMsg}</p>}
        <p className="dim small">
          Delivers the Pokémon directly (perfect IVs, given level) — works even while the player has their game open, unlike the Save-changes editor above. Stats re-derive from the species catalog on load.
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
      void notify("Pick an item first.");
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

  return (
    <>
      <StreamLoginCard userId={userId} />
      <h3 style={{ margin: "22px 0 8px" }}>Active sessions</h3>
      {busy ? (
        <p className="dim">Loading sessions…</p>
      ) : err ? (
        <div className="page-err">{err}</div>
      ) : sessions.length === 0 ? (
        <p className="dim">No active or recent sessions. Better Auth removes expired rows automatically.</p>
      ) : (
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
      )}
    </>
  );
}

// Stream auto-login (OBS / 24-7) management for one account. Enables a
// stable link OBS can hit to log itself into this account. The resulting
// session is RESTRICTED — it plays + saves but is blocked from account
// settings, trades and auctions — so a leaked link can't drain the
// account. Revoke by disabling (or regenerate to rotate the secret).
function StreamLoginCard({ userId }: { userId: string }) {
  const [st, setSt] = useState<StreamKeyStatus | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = () => {
    setBusy(true); setErr(null);
    api.streamKeyGet(userId)
      .then(setSt)
      .catch((e) => setErr((e as Error).message))
      .finally(() => setBusy(false));
  };
  useEffect(load, [userId]);

  const act = async (action: "enable" | "disable" | "regenerate") => {
    if (action === "disable" && !await confirm("Revoke this account's stream login? Any running OBS session will lose access on its next request.")) return;
    if (action === "regenerate" && !await confirm("Generate a new key? The old link stops working immediately — you'll need to update OBS with the new one.")) return;
    setBusy(true); setErr(null);
    try {
      const res = await api.streamKeySet(userId, action);
      setSt(res);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copy = (url: string) => {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }, () => undefined);
  };

  const active = !!st?.exists && !!st?.enabled;

  return (
    <section className="profile-section" style={{ border: "1px solid var(--border, #2a2a35)", borderRadius: 10, padding: 14 }}>
      <h3 style={{ marginTop: 0 }}>📺 Stream auto-login</h3>
      <p className="dim small" style={{ marginTop: -4 }}>
        A stable link OBS can load to auto-login this account 24/7. The session is <strong>restricted</strong>: it plays and saves, but can't touch account settings, trades, or auctions, and popups auto-dismiss. Revoke or rotate any time.
      </p>
      {err && <div className="page-err" style={{ marginBottom: 10 }}>{err}</div>}

      {busy && !st ? (
        <p className="dim">Loading…</p>
      ) : active ? (
        <>
          <label className="dim small" style={{ display: "block", marginBottom: 4 }}>OBS browser-source URL</label>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              readOnly
              value={st?.loginUrl ?? ""}
              onFocus={(e) => e.currentTarget.select()}
              className="mono"
              style={{ flex: "1 1 340px", minWidth: 0, fontSize: 12 }}
            />
            <button className="btn-secondary btn-small" onClick={() => st?.loginUrl && copy(st.loginUrl)}>{copied ? "Copied ✓" : "Copy"}</button>
          </div>
          <p className="dim small" style={{ marginTop: 8 }}>
            Last used: {st?.lastUsedAt ? new Date(st.lastUsedAt).toLocaleString() : "never"}
            {st?.lastUsedIp ? ` · ${st.lastUsedIp}` : ""}
          </p>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button className="btn-ghost btn-small" onClick={() => act("regenerate")} disabled={busy}>Regenerate key</button>
            <button className="btn-danger btn-small" onClick={() => act("disable")} disabled={busy}>Disable</button>
          </div>
          <p className="dim small" style={{ marginTop: 8, color: "#fbbf24" }}>
            ⚠ This URL is a login secret — anyone with it can play as this account. Only paste it into OBS.
          </p>
          <StreamAutomationEditor userId={userId} config={st?.config} onSaved={setSt} />
        </>
      ) : (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="btn-primary btn-small" onClick={() => act("enable")} disabled={busy}>
            {st?.exists ? "Re-enable stream login" : "Enable stream login"}
          </button>
          {st?.exists && <span className="dim small">Previously configured, currently disabled.</span>}
        </div>
      )}
    </section>
  );
}

// Stream automation editor — start route + auto-buy balls. Persisted via the
// "config" action on the stream-key endpoint.
function StreamAutomationEditor({ userId, config, onSaved }: {
  userId: string; config: StreamConfig | null | undefined; onSaved: (s: StreamKeyStatus) => void;
}) {
  const [startRoute, setStartRoute] = useState(config?.startRoute ?? "");
  const [abEnabled, setAbEnabled] = useState(!!config?.autoBuyBalls?.enabled);
  const [ballId, setBallId] = useState(config?.autoBuyBalls?.ballId ?? "pokeball");
  const [restockTo, setRestockTo] = useState(config?.autoBuyBalls?.restockTo ?? 50);
  const [autoProceed, setAutoProceed] = useState(config?.autoProceed ?? true);
  const [autoCatch, setAutoCatch] = useState(config?.autoCatch ?? true);
  const [speed, setSpeed] = useState(config?.speed ?? 5);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const save = async () => {
    setSaving(true); setMsg(null);
    const cfg: StreamConfig = {
      autoProceed, autoCatch, speed: Math.max(1, Math.min(5, speed || 1)),
    };
    if (startRoute.trim()) cfg.startRoute = startRoute.trim();
    if (abEnabled) cfg.autoBuyBalls = { enabled: true, ballId, restockTo: Math.max(1, Math.min(9999, restockTo || 1)) };
    try {
      const res = await api.streamKeySet(userId, "config", { config: Object.keys(cfg).length ? cfg : null });
      onSaved(res);
      setMsg("Saved ✓");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border, #2a2a35)" }}>
      <h4 style={{ margin: "0 0 8px" }}>Automation</h4>
      <label className="dim small" style={{ display: "block", marginBottom: 4 }}>
        Start route <em>(route id like <code>route1</code> — must be unlocked on the account; blank = resume where saved)</em>
      </label>
      <input value={startRoute} onChange={(e) => setStartRoute(e.target.value.trim())} placeholder="e.g. route1" style={{ maxWidth: 220 }} />
      <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
        <input type="checkbox" checked={autoProceed} onChange={(e) => setAutoProceed(e.target.checked)} />
        <span>Auto-play — travel to newly-unlocked routes automatically (self-progresses)</span>
      </label>
      <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
        <input type="checkbox" checked={autoCatch} onChange={(e) => setAutoCatch(e.target.checked)} />
        <span>Auto-catch wild Pokémon</span>
      </label>
      <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
        <span>Battle speed</span>
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
          <option value={1}>1× (slow)</option>
          <option value={2}>2×</option>
          <option value={5}>5× (fastest)</option>
        </select>
      </label>
      <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
        <input type="checkbox" checked={abEnabled} onChange={(e) => setAbEnabled(e.target.checked)} />
        <span>Auto-buy Poké Balls when the stream runs low (money permitting)</span>
      </label>
      {abEnabled && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
          <select value={ballId} onChange={(e) => setBallId(e.target.value)}>
            <option value="pokeball">Poké Ball</option>
            <option value="greatball">Great Ball</option>
            <option value="ultraball">Ultra Ball</option>
          </select>
          <span className="dim small">restock to</span>
          <input type="number" min={1} max={9999} value={restockTo} onChange={(e) => setRestockTo(Number(e.target.value) || 1)} style={{ width: 90 }} />
        </div>
      )}
      <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
        <button className="btn-secondary btn-small" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save automation"}</button>
        {msg && <span className="dim small" style={{ color: msg === "Saved ✓" ? "#86efac" : "#fca5a5" }}>{msg}</span>}
      </div>
      <p className="dim small" style={{ marginTop: 6 }}>
        Boot settings apply when the stream loads. The auto-buy ball must be enabled in the account's catch settings. Poké Ball is enabled by default.
      </p>

      <StreamRemoteControl userId={userId} />
    </div>
  );
}

// Live remote control — send a command to a running stream session.
const STREAM_GYMS: { id: string; name: string }[] = [
  { id: "brock", name: "Brock — Pewter (Kanto)" },
  { id: "misty", name: "Misty — Cerulean" },
  { id: "surge", name: "Lt. Surge — Vermilion" },
  { id: "erika", name: "Erika — Celadon" },
  { id: "koga", name: "Koga — Fuchsia" },
  { id: "sabrina", name: "Sabrina — Saffron" },
  { id: "blaine", name: "Blaine — Cinnabar" },
  { id: "giovanni", name: "Giovanni — Viridian" },
  { id: "falkner", name: "Falkner — Violet (Johto)" },
  { id: "bugsy", name: "Bugsy — Azalea" },
  { id: "whitney", name: "Whitney — Goldenrod" },
  { id: "morty", name: "Morty — Ecruteak" },
  { id: "chuck", name: "Chuck — Cianwood" },
  { id: "jasmine", name: "Jasmine — Olivine" },
  { id: "pryce", name: "Pryce — Mahogany" },
  { id: "clair", name: "Clair — Blackthorn" },
];
const STREAM_RAID_TIERS: { id: string; name: string }[] = [
  { id: "birdsBeasts", name: "Birds & Beasts" },
  { id: "titans", name: "Titans" },
  { id: "guardians", name: "Guardians" },
  { id: "coverLegends", name: "Cover Legends" },
  { id: "mythical", name: "Mythical" },
];

export function StreamRemoteControl({ userId }: { userId: string }) {
  const [travelTo, setTravelTo] = useState("");
  const [gym, setGym] = useState(STREAM_GYMS[0].id);
  const [raidTier, setRaidTier] = useState(STREAM_RAID_TIERS[0].id);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async (command: StreamCommand, label: string) => {
    setBusy(true); setMsg(null);
    try {
      const res = await api.streamCommand(userId, command);
      setMsg(res.delivered ? `✓ Sent: ${label}` : `✗ Not delivered: ${label} — the stream isn't online (commands aren't queued; resend once it's live)`);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const row: CSSProperties = { display: "flex", gap: 6, marginTop: 8, alignItems: "center", flexWrap: "wrap" };
  const inputStyle: CSSProperties = { maxWidth: 220 };

  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border, #2a2a35)" }}>
      <h4 style={{ margin: "0 0 4px" }}>🎮 Remote control</h4>
      <p className="dim small" style={{ marginTop: 0 }}>Drive the live stream account. Only runs while it's online as a stream session.</p>

      {/* Automation toggles */}
      <div style={row}>
        <span className="dim small" style={{ minWidth: 70 }}>Auto-play</span>
        <button className="btn-ghost btn-small" disabled={busy} onClick={() => send({ kind: "autoProceed", value: true }, "auto-play on")}>ON</button>
        <button className="btn-ghost btn-small" disabled={busy} onClick={() => send({ kind: "autoProceed", value: false }, "auto-play off")}>OFF</button>
        <span className="dim small" style={{ minWidth: 70, marginLeft: 10 }}>Auto-catch</span>
        <button className="btn-ghost btn-small" disabled={busy} onClick={() => send({ kind: "autoCatch", value: true }, "auto-catch on")}>ON</button>
        <button className="btn-ghost btn-small" disabled={busy} onClick={() => send({ kind: "autoCatch", value: false }, "auto-catch off")}>OFF</button>
      </div>

      {/* Speed */}
      <div style={row}>
        <span className="dim small" style={{ minWidth: 70 }}>Speed</span>
        {[1, 2, 3, 4, 5].map((s) => (
          <button key={s} className="btn-ghost btn-small" disabled={busy} onClick={() => send({ kind: "speed", value: s }, `speed ${s}×`)}>{s}×</button>
        ))}
      </div>

      {/* Travel */}
      <div style={row}>
        <span className="dim small" style={{ minWidth: 70 }}>Travel</span>
        <input value={travelTo} onChange={(e) => setTravelTo(e.target.value.trim())} placeholder="location id e.g. route29" style={inputStyle} />
        <button className="btn-ghost btn-small" disabled={busy || !travelTo} onClick={() => send({ kind: "travel", locationId: travelTo }, `travel ${travelTo}`)}>Go</button>
      </div>

      {/* Gym */}
      <div style={row}>
        <span className="dim small" style={{ minWidth: 70 }}>Gym</span>
        <select value={gym} onChange={(e) => setGym(e.target.value)} style={inputStyle}>
          {STREAM_GYMS.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <button className="btn-secondary btn-small" disabled={busy} onClick={() => send({ kind: "gym", gymId: gym }, `challenge ${gym}`)}>Challenge</button>
      </div>

      {/* Raid */}
      <div style={row}>
        <span className="dim small" style={{ minWidth: 70 }}>Raid</span>
        <select value={raidTier} onChange={(e) => setRaidTier(e.target.value)} style={inputStyle}>
          {STREAM_RAID_TIERS.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <button className="btn-secondary btn-small" disabled={busy} onClick={() => send({ kind: "raid", tier: raidTier }, `raid ${raidTier}`)}>Start Raid</button>
      </div>

      {/* League */}
      <div style={row}>
        <span className="dim small" style={{ minWidth: 70 }}>League</span>
        <button className="btn-secondary btn-small" disabled={busy} onClick={() => send({ kind: "eliteFour" }, "Elite Four gauntlet")}>Fight Elite Four</button>
        <button className="btn-secondary btn-small" disabled={busy} onClick={() => send({ kind: "champion" }, "Champion")}>Fight Champion</button>
      </div>

      {msg && <p className="dim small" style={{ marginTop: 8 }}>{msg}</p>}
    </div>
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
      () => void notify("Save JSON copied to clipboard."),
      () => void notify("Couldn't copy — your browser blocked clipboard write."),
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
