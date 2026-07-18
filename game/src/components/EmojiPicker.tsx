import { useEffect, useRef, useState } from "react";

// Emoji already work end-to-end through chat (composer -> socket
// sanitizer -> Postgres text column -> render) — this just makes them
// discoverable without knowing an OS emoji-picker shortcut. A small
// curated set rather than a full emoji library: this is a chat
// composer accent, not a document editor.
const EMOJI = [
  "😀", "😂", "😍", "😎", "🥳", "😢", "😡", "🤔",
  "👀", "👍", "👎", "🤝", "🙏", "💪", "👏", "🔥",
  "💯", "✨", "⭐", "💰", "🎁", "🏆", "🎯", "🎮",
  "⚡", "❤️", "💀", "😱", "😴", "🍀", "🐉", "🎉",
];

export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickAway = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickAway);
    return () => document.removeEventListener("mousedown", onClickAway);
  }, [open]);

  return (
    <div className="emoji-picker" ref={ref}>
      <button
        type="button"
        className="emoji-picker-btn"
        onClick={() => setOpen((v) => !v)}
        title="Insert an emoji"
        aria-label="Insert an emoji"
        aria-expanded={open}
      >🙂</button>
      {open && (
        <div className="emoji-picker-panel" role="menu">
          {EMOJI.map((e) => (
            <button
              key={e}
              type="button"
              className="emoji-picker-item"
              onClick={() => { onPick(e); setOpen(false); }}
            >{e}</button>
          ))}
        </div>
      )}
    </div>
  );
}
