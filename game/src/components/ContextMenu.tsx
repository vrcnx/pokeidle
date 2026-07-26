import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// Lightweight right-click context menu used by Party rows and PC cells.
// Open imperatively via the exported `openContextMenu()` so call-sites
// don't need to wire their own portals — the singleton listens for
// "close" signals (Escape, scroll, click outside) and dismisses itself.

export interface ContextMenuItem {
  label: string;
  icon?: React.ReactNode;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

interface MenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
  key: number;
}

let setMenuExternal: ((m: MenuState | null) => void) | null = null;
let nextKey = 1;

// Open a menu at the given screen position with the given items. Pass
// the React MouseEvent directly: `openContextMenu(e, [...])`.
export function openContextMenu(
  e: React.MouseEvent | { clientX: number; clientY: number },
  items: ContextMenuItem[]
) {
  if (!setMenuExternal) return;
  const visible = items.filter((i) => !!i);
  if (visible.length === 0) return;
  setMenuExternal({ x: e.clientX, y: e.clientY, items: visible, key: nextKey++ });
}

export function closeContextMenu() {
  setMenuExternal?.(null);
}

// Keep one axis of the menu inside the viewport: pull it back off the far
// edge, but never past the near edge (a menu taller than the screen stays
// pinned at the top rather than sliding off it).
const EDGE_PAD = 8;
function clamp(at: number, size: number, viewport: number): number {
  return Math.max(EDGE_PAD, Math.min(at, viewport - size - EDGE_PAD));
}

// The enabled rows, in DOM order — disabled entries are skipped so arrow
// keys never park focus on something Enter can't activate.
function itemButtons(list: HTMLUListElement | null): HTMLButtonElement[] {
  return Array.from(list?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
}

// Mount this once at the app root. The menu portals into document.body
// so it stacks above everything (including the .modal-overlay).
export function ContextMenuHost() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // Position measured from the rendered menu, tagged with the menu key so a
  // freshly-opened menu never paints at the previous one's coordinates.
  const [fit, setFit] = useState<{ key: number; x: number; y: number } | null>(null);
  useEffect(() => {
    setMenuExternal = setMenu;
    return () => {
      if (setMenuExternal === setMenu) setMenuExternal = null;
    };
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    const onScroll = () => close();
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
    // The global `contextmenu` listener was closing the menu on the very
    // same event that opened it — caught in the bubble phase after the
    // element handler. The backdrop already intercepts further clicks,
    // and call-sites that want to retarget can call openContextMenu again.
  }, [menu?.key]);

  // Re-clamp against the real rendered box before the browser paints — the
  // item count is a poor size proxy once icons, hints and translated labels
  // change the row metrics.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!menu || !el) return;
    // offsetWidth/Height, not getBoundingClientRect — the open animation
    // scales the menu, and the transformed box would read short.
    setFit({
      key: menu.key,
      x: clamp(menu.x, el.offsetWidth, window.innerWidth),
      y: clamp(menu.y, el.offsetHeight, window.innerHeight),
    });
  }, [menu?.key]);

  // Focus the first actionable row on open so the menu is immediately
  // drivable from the keyboard (arrows move, Enter picks, Escape closes).
  useEffect(() => {
    if (!menu) return;
    itemButtons(listRef.current)[0]?.focus();
  }, [menu?.key]);

  if (!menu) return null;

  const pos =
    fit && fit.key === menu.key
      ? fit
      : // First paint, before the measurement lands: fall back to an estimate
        // off the item count so the menu doesn't flash at the cursor and jump.
        {
          x: clamp(menu.x, 220, window.innerWidth),
          y: clamp(menu.y, menu.items.length * 32 + 8, window.innerHeight),
        };

  function onKeyDown(e: React.KeyboardEvent) {
    const buttons = itemButtons(listRef.current);
    if (buttons.length === 0) return;
    // Tabbing away from a context menu should dismiss it rather than leave it
    // floating while focus moves off somewhere behind the backdrop.
    if (e.key === "Tab") { setMenu(null); return; }
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === "ArrowDown") next = (at + 1) % buttons.length;
    else if (e.key === "ArrowUp") next = (at <= 0 ? buttons.length : at) - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = buttons.length - 1;
    if (next < 0) return;
    e.preventDefault();
    buttons[next].focus();
  }

  return createPortal(
    <div
      className="ctx-menu-backdrop"
      onMouseDown={(e) => {
        // Click outside the menu closes it. The menu itself stops
        // propagation so its own clicks don't trip this.
        if ((e.target as HTMLElement).classList.contains("ctx-menu-backdrop")) {
          setMenu(null);
        }
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <ul
        ref={listRef}
        className="ctx-menu"
        style={{ left: pos.x, top: pos.y }}
        role="menu"
        aria-orientation="vertical"
        onKeyDown={onKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {menu.items.map((item, i) => (
          <li key={i} role="none">
            <button
              type="button"
              role="menuitem"
              className={`ctx-menu-item ${item.danger ? "danger" : ""}`}
              disabled={item.disabled}
              onClick={() => {
                if (item.disabled) return;
                item.onClick();
                setMenu(null);
              }}
            >
              {item.icon && <span className="ctx-menu-icon">{item.icon}</span>}
              <span className="ctx-menu-label">{item.label}</span>
              {item.hint && <span className="ctx-menu-hint">{item.hint}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>,
    document.body
  );
}
