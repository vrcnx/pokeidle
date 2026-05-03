import { useEffect, useState } from "react";
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

// Mount this once at the app root. The menu portals into document.body
// so it stacks above everything (including the .modal-overlay).
export function ContextMenuHost() {
  const [menu, setMenu] = useState<MenuState | null>(null);
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

  if (!menu) return null;

  // Edge-clamp so the menu never overflows the viewport. Estimate the
  // menu size off the item count; refined in a layout effect below if
  // the actual rendered height differs.
  const estW = 220;
  const estH = menu.items.length * 32 + 8;
  const x = Math.min(menu.x, window.innerWidth - estW - 8);
  const y = Math.min(menu.y, window.innerHeight - estH - 8);

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
        className="ctx-menu"
        style={{ left: x, top: y }}
        role="menu"
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
