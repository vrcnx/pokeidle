import type { ReactNode } from "react";

// Unified header for the Bag / Mart / PC / Dex tab panes (and any
// future tab that fits the same shape). Replaces ad-hoc
// <header className="tab-pane-head"><h3>…</h3>…</header> blocks where
// each tab was free to render its own structure, leaving the visual
// language inconsistent and the dark/light theming to fight with the
// surrounding tab background.
//
// The design is a horizontal card with:
//   - A 3px left accent stripe in the tab's accent colour
//   - Title in upper-cased letterspaced label style (gold by default)
//   - Optional subtitle/meta text right-aligned, dimmed
//   - Optional tools row (sort buttons / pager / wallet) below the
//     title row, full-width, with comfortable padding for tap targets
//
// Tabs pass `accent` to set the stripe color; everything else flows
// from the same CSS so adding a new tab is one prop set.

interface Props {
  title: string;
  /** Right-aligned status line — caught counts, item totals, etc. */
  meta?: ReactNode;
  /** Tools row rendered below the title (sort buttons, pager…). */
  tools?: ReactNode;
  /** Accent color for the left stripe. Defaults to the gold token. */
  accent?: string;
  /** Pass-through className for tab-specific tweaks. */
  className?: string;
}

export function TabPaneHead({ title, meta, tools, accent, className }: Props) {
  return (
    <header
      className={`tab-pane-head v2${className ? " " + className : ""}`}
      style={accent ? ({ ["--tab-head-accent" as any]: accent }) : undefined}
    >
      <div className="tab-pane-head-row">
        <h3>{title}</h3>
        {meta && <span className="tab-pane-head-meta">{meta}</span>}
      </div>
      {tools && <div className="tab-pane-head-tools">{tools}</div>}
    </header>
  );
}
