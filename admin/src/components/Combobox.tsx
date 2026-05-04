import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

// Searchable single-select combobox.
//
// Why custom: the dataset is bounded (a few hundred entries) so we
// don't need virtualisation, and we want the dropdown rows to render
// rich content (sprite + name + type chips), which native <select>
// can't do. ~150 lines is cheaper than dnd-kit-style dependencies.
//
// Behaviour:
//   - Type to filter (substring match against the user-supplied
//     getSearchText). Filter is case-insensitive.
//   - Up / Down arrow to move the highlighted row. Enter selects.
//   - Escape closes the dropdown without selecting.
//   - Click outside closes.
//   - Selected row's label appears in the input when closed.
//
// `value` is the *displayed* text in the input. `onSelect` is called
// when the user picks a row. Caller decides what to do with the
// selection (typically: derive the canonical id and grant / save).
export interface ComboboxProps<T> {
  value: string;
  onChange: (text: string) => void;
  onSelect: (item: T) => void;
  options: T[];
  placeholder?: string;
  disabled?: boolean;
  getKey: (item: T) => string;
  getSearchText: (item: T) => string;
  renderOption: (item: T, highlighted: boolean) => ReactNode;
  renderEmpty?: () => ReactNode;
  maxResults?: number;
}

export function Combobox<T>({
  value,
  onChange,
  onSelect,
  options,
  placeholder,
  disabled,
  getKey,
  getSearchText,
  renderOption,
  renderEmpty,
  maxResults = 50,
}: ComboboxProps<T>) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Filter — substring match, case-insensitive. Cap to maxResults so
  // typing a single letter doesn't render hundreds of rows.
  const matches = useMemo(() => {
    const q = value.trim().toLowerCase();
    const list = q.length === 0
      ? options
      : options.filter((o) => getSearchText(o).toLowerCase().includes(q));
    return list.slice(0, maxResults);
  }, [value, options, getSearchText, maxResults]);

  // Reset the highlight whenever the filtered list changes — keeping
  // an out-of-range index would highlight nothing visually.
  useEffect(() => {
    setHi((cur) => (cur >= matches.length ? 0 : cur));
  }, [matches.length]);

  // Keep the highlighted row scrolled into view when navigating with
  // arrow keys.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-i="${hi}"]`);
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [hi, open]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHi((i) => Math.min(matches.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      if (open && matches[hi]) {
        e.preventDefault();
        onSelect(matches[hi]);
        setOpen(false);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="combobox" ref={wrapRef}>
      <input
        type="text"
        className="combobox-input"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setHi(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && !disabled && (
        <div className="combobox-popover" ref={listRef}>
          {matches.length === 0 ? (
            <div className="combobox-empty">{renderEmpty?.() ?? "No matches."}</div>
          ) : (
            matches.map((item, i) => (
              <div
                key={getKey(item)}
                data-i={i}
                className={`combobox-option ${hi === i ? "highlighted" : ""}`}
                onMouseEnter={() => setHi(i)}
                onMouseDown={(e) => {
                  // Use mousedown rather than click so we beat the
                  // "click outside" handler which closes the popover.
                  e.preventDefault();
                  onSelect(item);
                  setOpen(false);
                }}
              >
                {renderOption(item, hi === i)}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
