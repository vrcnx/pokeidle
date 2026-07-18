import { useEffect, useMemo, useRef, useState } from "react";
import byGroup from "unicode-emoji-json/data-by-group.json";
import { useT } from "../i18n/useT";
import { getRecentEmoji, pushRecentEmoji } from "../utils/emojiRecents";

// Emoji already work end-to-end through chat (composer -> socket
// sanitizer -> Postgres text column -> render) — this is what makes
// them discoverable. unicode-emoji-json ships the full Unicode CLDR
// set (name + group, no runtime deps of its own) so this gets proper
// categories + search instead of hand-maintaining a fixed grid.
interface EmojiEntry {
  emoji: string;
  name: string;
}
interface Category {
  key: string;
  icon: string;
  label: string;
  items: EmojiEntry[];
}

// A representative icon per Unicode CLDR group, used for the category
// tab strip. Falls back to that group's first emoji if a name we don't
// recognize ever shows up in a future data-package bump.
const GROUP_ICON: Record<string, string> = {
  "Smileys & Emotion": "😀",
  "People & Body": "🙌",
  "Animals & Nature": "🐻",
  "Food & Drink": "🍔",
  "Travel & Places": "🌍",
  "Activities": "⚽",
  "Objects": "💡",
  "Symbols": "❤️",
  "Flags": "🏳️",
};

const CATEGORIES: Category[] = Object.values(byGroup).map((g) => ({
  key: g.slug,
  icon: GROUP_ICON[g.name] ?? g.emojis[0]?.emoji ?? "❔",
  label: g.name,
  items: g.emojis.map((e) => ({ emoji: e.emoji, name: e.name })),
}));

const ALL_EMOJI: EmojiEntry[] = CATEGORIES.flatMap((c) => c.items);

export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState(CATEGORIES[0].key);
  const [recents, setRecents] = useState<string[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const t = useT();

  useEffect(() => {
    if (!open) return;
    const onClickAway = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClickAway);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClickAway);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = () => {
    setOpen((v) => {
      const next = !v;
      if (next) {
        setQuery("");
        setRecents(getRecentEmoji());
        setActiveCategory(CATEGORIES[0].key);
        // Panel mounts this render; focus the search box next tick.
        requestAnimationFrame(() => searchRef.current?.focus());
      }
      return next;
    });
  };

  const pick = (emoji: string) => {
    onPick(emoji);
    pushRecentEmoji(emoji);
    setOpen(false);
  };

  const q = query.trim().toLowerCase();
  const searchResults = useMemo(() => {
    if (!q) return null;
    return ALL_EMOJI.filter((e) => e.name.includes(q));
  }, [q]);

  const showingRecents = !q && activeCategory === "recent";
  const activeItems = q
    ? (searchResults ?? [])
    : showingRecents
      ? recents.map((emoji) => ({ emoji, name: emoji }))
      : (CATEGORIES.find((c) => c.key === activeCategory)?.items ?? []);

  return (
    <div className="emoji-picker" ref={ref}>
      <button
        type="button"
        className="emoji-picker-btn"
        onClick={toggle}
        title={t("Insert an emoji")}
        aria-label={t("Insert an emoji")}
        aria-expanded={open}
      >🙂</button>
      {open && (
        <div className="emoji-picker-panel" role="menu">
          <input
            ref={searchRef}
            type="text"
            className="emoji-picker-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("Search emoji…")}
          />
          {!q && (
            <div className="emoji-picker-tabs" role="tablist">
              {recents.length > 0 && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeCategory === "recent"}
                  className={`emoji-picker-tab ${activeCategory === "recent" ? "active" : ""}`}
                  title={t("Recently used")}
                  onClick={() => setActiveCategory("recent")}
                >🕐</button>
              )}
              {CATEGORIES.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  role="tab"
                  aria-selected={activeCategory === c.key}
                  className={`emoji-picker-tab ${activeCategory === c.key ? "active" : ""}`}
                  title={c.label}
                  onClick={() => setActiveCategory(c.key)}
                >{c.icon}</button>
              ))}
            </div>
          )}
          <div className="emoji-picker-grid">
            {activeItems.length === 0 && (
              <div className="emoji-picker-empty dim small">
                {q ? t("No emoji found.") : t("Nothing here yet.")}
              </div>
            )}
            {activeItems.map((e, i) => (
              <button
                key={`${e.emoji}-${i}`}
                type="button"
                className="emoji-picker-item"
                title={e.name}
                onClick={() => pick(e.emoji)}
              >{e.emoji}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
