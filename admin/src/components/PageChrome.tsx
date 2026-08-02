import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// Page title and actions, rendered into the TOPBAR instead of into the page.
//
// ── WHY ─────────────────────────────────────────────────────────────
// Every page opened with a `.page-head` block: an h1, a paragraph of
// explanation, and a row of actions. The topbar directly above it already
// named the page, so the first thing on screen was the page's name twice —
// "Analytics" in the bar, "Overview" beneath it — and the block cost roughly
// 100px of vertical space on all fifteen pages before any content.
//
// The bar has room. It is 56px tall and carries a title, a spacer, and two
// small chips; page actions fit in the gap, which is where every console that
// has thought about this puts them.
//
// ── WHY A PORTAL AND NOT PROPS ──────────────────────────────────────
// The alternative is lifting title/actions into App and passing them down, so
// every page becomes configuration the shell has to know about — and a page
// whose actions depend on its own state (a Refresh that knows the last fetch
// time) cannot express that through a static prop. A portal lets the page keep
// owning its buttons while the shell owns where they appear.
//
// The slot lives in App's topbar. If it is missing — as in a preview harness
// that renders a page without the shell — this renders nothing rather than
// throwing, so a page is never coupled to being inside the real chrome.

const SLOT_ID = "topbar-page-actions";

export function PageActions({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  // The slot is rendered by the shell, which mounts before any page, but the
  // lookup still happens in an effect: reading the DOM during render would be
  // a side effect, and in StrictMode's double-invoked render it can observe a
  // node that is about to be discarded.
  useEffect(() => {
    setSlot(document.getElementById(SLOT_ID));
  }, []);

  if (!slot) return null;
  return createPortal(children, slot);
}

/** Optional one-line context for the current page, shown next to the title in
 *  the topbar. Prose that used to sit under a page's h1 belongs here or
 *  nowhere — a returning operator reads it once and never again. */
export function PageNote({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setSlot(document.getElementById("topbar-page-note")); }, []);
  if (!slot) return null;
  return createPortal(children, slot);
}
