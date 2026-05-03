import type { ReactNode } from "react";

// Unified header for the Bag / Mart / PC / Dex tab panes (and any
// future tab that fits the same shape). Replaces ad-hoc
// <header className="tab-pane-head"><h3>…</h3>…</header> blocks where
// each tab was free to render its own structure.
//
// Flat solid-gray card matching the surrounding panel chrome —
// title in upper-cased letterspaced label style, optional meta text
// right-aligned, optional tools row (sort buttons, pager, etc.)
// underneath. No per-tab variants — same component, same look.

interface Props {
  title: string;
  /** Right-aligned status line — caught counts, item totals, etc. */
  meta?: ReactNode;
  /** Tools row rendered below the title (sort buttons, pager…). */
  tools?: ReactNode;
  /** Pass-through className for tab-specific tweaks. */
  className?: string;
}

export function TabPaneHead({ title, meta, tools, className }: Props) {
  return (
    <header className={`tab-pane-head v2${className ? " " + className : ""}`}>
      <div className="tab-pane-head-row">
        <h3>{title}</h3>
        {meta && <span className="tab-pane-head-meta">{meta}</span>}
      </div>
      {tools && <div className="tab-pane-head-tools">{tools}</div>}
    </header>
  );
}
