import { useEffect, useMemo, useRef, useState } from "react";
import { api, type AdminUser } from "../api";

// Global search / command palette.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────
// Finding a player meant: open the nav, pick Users, wait for the list, type
// into the page's own search box. Four steps for the single most common thing
// anyone does in this dashboard — and the same four steps whether you arrived
// from a chat report, an audit row, or a Discord message with a username in it.
//
// Cmd/Ctrl-K searches players and jumps to pages from anywhere, including
// mid-task on an unrelated page.
//
// ── WHY PAGES AND USERS IN ONE LIST ─────────────────────────────────
// They are both "somewhere I want to be". Splitting them into two modes means
// choosing the mode before you know which one your query matches, which is
// exactly the decision a search box exists to spare you. Pages sort first
// because they are an exact, finite set — a user query never outranks a
// literal page name.

export interface PaletteTarget {
  page: string;
  label: string;
  group: string;
}

export function CommandPalette({
  pages, onGoPage, onGoUser,
}: {
  pages: PaletteTarget[];
  onGoPage: (page: string) => void;
  onGoUser: (userId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Cmd/Ctrl-K from anywhere. Also Escape to close, registered here rather than
  // on the dialog so it works before focus has landed inside.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Reset on open rather than on close, so the closing animation does not show
  // the list emptying out.
  useEffect(() => {
    if (!open) return;
    setQ("");
    setUsers([]);
    setSel(0);
    // Focus after paint; focusing a node that is still being mounted is a
    // no-op in some browsers.
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  // Debounced user search. Two characters minimum — a single letter matches
  // most of 2,400 accounts, so it costs a round trip to return noise.
  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    if (term.length < 2) { setUsers([]); setLoading(false); return; }
    setLoading(true);
    let cancelled = false;
    const t = setTimeout(() => {
      api.listUsers(term, 0, 6)
        .then((d) => { if (!cancelled) setUsers(d.users); })
        .catch(() => { if (!cancelled) setUsers([]); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 180);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q, open]);

  const matchedPages = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return pages;
    return pages.filter((p) =>
      p.label.toLowerCase().includes(term) || p.group.toLowerCase().includes(term));
  }, [q, pages]);

  // One flat list, because the keyboard moves through one sequence regardless
  // of how the sections are drawn.
  const items = useMemo(() => [
    ...matchedPages.map((p) => ({ kind: "page" as const, id: p.page, label: p.label, hint: p.group })),
    ...users.map((u) => ({ kind: "user" as const, id: u.id, label: u.username, hint: `Lv ${u.accountLevel}${u.bannedUntil ? " · banned" : ""}` })),
  ], [matchedPages, users]);

  useEffect(() => { setSel((s) => Math.min(s, Math.max(0, items.length - 1))); }, [items.length]);

  const run = (i: number) => {
    const it = items[i];
    if (!it) return;
    setOpen(false);
    if (it.kind === "page") onGoPage(it.id);
    else onGoUser(it.id);
  };

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); run(sel); }
  };

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".cmdk-item.is-sel")
      ?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  return (
    <>
      <button className="topbar-search" onClick={() => setOpen(true)} aria-label="Search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
          <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
        </svg>
        <span className="topbar-search__label">Search</span>
        <kbd className="topbar-search__kbd">⌘K</kbd>
      </button>

      {open && (
        <div className="cmdk-scrim" onMouseDown={() => setOpen(false)}>
          {/* mousedown, not click: a click that STARTS inside the dialog and
              ends on the scrim (a drag while selecting text) would otherwise
              close it. */}
          <div className="cmdk" role="dialog" aria-modal onMouseDown={(e) => e.stopPropagation()}>
            <div className="cmdk-input-row">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
              </svg>
              <input
                ref={inputRef}
                className="cmdk-input"
                value={q}
                placeholder="Search players, jump to a page…"
                onChange={(e) => { setQ(e.target.value); setSel(0); }}
                onKeyDown={onInputKey}
              />
              {loading && <span className="cmdk-spinner" aria-hidden />}
              <kbd className="topbar-search__kbd">esc</kbd>
            </div>

            <div className="cmdk-list" ref={listRef}>
              {items.length === 0 && (
                <div className="cmdk-empty">
                  {q.trim().length < 2
                    ? "Type at least two characters to search players."
                    : loading ? "Searching…" : "Nothing matched."}
                </div>
              )}

              {matchedPages.length > 0 && <div className="cmdk-section">Pages</div>}
              {items.map((it, i) => (
                <div key={`${it.kind}-${it.id}`}>
                  {/* The users heading is emitted before the first user row so
                      the flat keyboard list keeps its single index space. */}
                  {it.kind === "user" && items[i - 1]?.kind !== "user" && (
                    <div className="cmdk-section">Players</div>
                  )}
                  <button
                    className={`cmdk-item ${i === sel ? "is-sel" : ""}`}
                    onMouseEnter={() => setSel(i)}
                    onClick={() => run(i)}
                  >
                    <span className={`cmdk-kind cmdk-kind--${it.kind}`}>
                      {it.kind === "page" ? "Page" : "Player"}
                    </span>
                    <span className="cmdk-label">{it.label}</span>
                    <span className="cmdk-hint dim small">{it.hint}</span>
                  </button>
                </div>
              ))}
            </div>

            <div className="cmdk-foot dim small">
              <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
              <span><kbd>↵</kbd> open</span>
              <span><kbd>esc</kbd> close</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
