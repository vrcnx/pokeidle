import { useMemo, useState, type ReactNode } from "react";

// The dashboard's table.
//
// ── WHY A COMPONENT AND NOT JUST CSS ────────────────────────────────
// Styling can make three hand-rolled tables look alike; it cannot give them
// sorting, a real empty state, a loading state, or consistent numeric
// alignment. Those are behaviour, and every page was either re-implementing
// them slightly differently or — far more often — going without.
//
// The concrete gap this closes: not one table in the dashboard could be
// sorted. Finding the highest-level player, the oldest open bug or the most
// recent audit entry meant reading rows by eye, on pages that routinely show
// hundreds. That is the single most common thing an operator wants from a
// table and it was missing everywhere.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────
// No fetching, no pagination, no server-side sort. Pages already own their
// data and their paging, and a component that took over would force every
// caller to restructure. Sorting is client-side over the rows it is handed,
// which is correct for a page that has already fetched its window.

export interface Column<T> {
  /** Stable id — also the sort key. */
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  /**
   * Make the column sortable by returning something comparable. Absent =
   * not sortable, which is right for an actions column or a rendered blob.
   */
  sort?: (row: T) => string | number | null | undefined;
  /** Right-aligns and applies tabular numerics. Use for anything a reader
   *  compares by magnitude — the decimal points have to line up. */
  align?: "left" | "right";
  /** Suppresses the row click, so a button inside a clickable row does not
   *  also trigger the row. */
  stopClick?: boolean;
  width?: string;
}

export interface DataTableProps<T> {
  rows: T[] | null;
  columns: Column<T>[];
  getKey: (row: T) => string;
  /** Shown when rows is an empty array. */
  empty?: ReactNode;
  /** rows === null means "still loading" and renders a skeleton, which is
   *  distinct from "loaded and there is nothing", and a reader should never
   *  have to guess which one they are looking at. */
  loadingRows?: number;
  onRowClick?: (row: T) => void;
  isRowActive?: (row: T) => boolean;
  /** Initial sort, by column key. */
  defaultSort?: { key: string; dir: "asc" | "desc" };
  className?: string;
}

export function DataTable<T>({
  rows, columns, getKey, empty = "Nothing to show.",
  loadingRows = 6, onRowClick, isRowActive, defaultSort, className = "",
}: DataTableProps<T>) {
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(defaultSort ?? null);

  const sorted = useMemo(() => {
    if (!rows || !sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sort) return rows;
    const get = col.sort;
    // Copy before sorting — mutating the caller's array would reorder their
    // state behind their back and desync anything else reading it.
    return [...rows].sort((a, b) => {
      const av = get(a);
      const bv = get(b);
      // Nulls sort last in BOTH directions. A missing value is not "smaller";
      // it is absent, and burying it under a descending sort would hide the
      // rows most likely to need attention.
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" });
      return sort.dir === "asc" ? cmp : -cmp;
    });
  }, [rows, sort, columns]);

  const toggleSort = (col: Column<T>) => {
    if (!col.sort) return;
    setSort((s) =>
      s?.key !== col.key
        // First click on a new column: descending. For an ops table the
        // interesting end is almost always the top — highest level, most
        // recent, most errors — so ascending first would mean two clicks
        // every time.
        ? { key: col.key, dir: "desc" }
        : s.dir === "desc" ? { key: col.key, dir: "asc" } : null,
    );
  };

  return (
    <div className={`table-wrap ${className}`}>
      <table className="admin-table">
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  style={c.width ? { width: c.width } : undefined}
                  className={[c.align === "right" ? "num" : "", c.sort ? "sortable" : "", active ? "sorted" : ""]
                    .filter(Boolean).join(" ")}
                  aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined}
                  onClick={() => toggleSort(c)}
                >
                  <span className="th-inner">
                    {c.header}
                    {c.sort && (
                      <span className={`th-sort${active ? ` th-sort--${sort!.dir}` : ""}`} aria-hidden>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round">
                          <path d="M7 10l5-5 5 5" /><path d="M7 14l5 5 5-5" />
                        </svg>
                      </span>
                    )}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted === null &&
            Array.from({ length: loadingRows }, (_, i) => (
              <tr key={`sk${i}`} className="table-skeleton-row">
                {columns.map((c) => (
                  <td key={c.key}><span className="table-skeleton" /></td>
                ))}
              </tr>
            ))}

          {sorted?.length === 0 && (
            <tr>
              <td colSpan={columns.length}>
                <div className="table-empty">{empty}</div>
              </td>
            </tr>
          )}

          {sorted?.map((row) => (
            <tr
              key={getKey(row)}
              className={[onRowClick ? "is-clickable" : "", isRowActive?.(row) ? "is-active" : ""]
                .filter(Boolean).join(" ")}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={c.align === "right" ? "num" : undefined}
                  // Without this a row-level click handler fires when someone
                  // presses a button in the actions column, so "Unlink" would
                  // also open the row.
                  onClick={c.stopClick ? (e) => e.stopPropagation() : undefined}
                >
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
