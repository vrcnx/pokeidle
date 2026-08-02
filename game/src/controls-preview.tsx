// Dev-only style guide for the game's control primitives.
//
// ── WHY ─────────────────────────────────────────────────────────────
// "A lot of buttons, tabs, etc just feels like there's so much mismatch."
// That was true, and it was invisible from any one screen: the bottom tab
// strip, the region pills, the chat channels and the social tabs are four
// different components that never appear in the same viewport, so nothing
// ever put them side by side. `.dock-btn` alone had seven definitions
// scattered across app.css, each from a different era.
//
// This page is the side-by-side that did not exist. It renders every tab set
// and every button variant in the game, with the REAL class names and the
// REAL stylesheet — so a mismatch shows up as two rows that do not line up,
// and the check at the bottom of this file is a machine reading the same
// thing.
//
// Never part of a production build: Vite only bundles entries reachable from
// index.html, and nothing in the app imports this.
//
//   cd game && npm run dev  →  http://localhost:5173/controls-preview.html

import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  IconMap, IconCart, IconBackpack, IconMonitor, IconBook,
  IconSettings, IconChat, IconSwords,
} from "./components/Icon";
import "./app.css";

// The icons are the REAL ones, in the real <span class="…-icon"> wrappers.
// The first version of this page rendered label-only tabs, and shipped a
// regression the same afternoon: `.bottom-tab` is stacked icon-over-label
// from a rule earlier in app.css, the shared primitive gave it a fixed 26px
// height without stating an axis, and the content overflowed its own box.
// A style guide that renders a simpler thing than the app renders is a style
// guide that certifies the wrong thing.

function Row({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8, padding: "16px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 11, fontWeight: 800, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--text-muted)" }}>{title}</h2>
        {note && <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{note}</span>}
      </div>
      {children}
    </section>
  );
}

function Tabs({ cls, wrap, items }: { cls: string; wrap: string; items: string[] }) {
  const [i, setI] = useState(0);
  return (
    <div className={wrap}>
      {items.map((label, n) => (
        <button
          key={label}
          type="button"
          className={`${cls} ${i === n ? "active" : ""}`}
          onClick={() => setI(n)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** The bottom strip, rendered exactly as BottomTabs.tsx renders it — same
 *  wrapper, same icon spans, same real icons. */
function StackedTabs() {
  const [i, setI] = useState(0);
  const items = [
    { label: "Map", icon: <IconMap size={16} /> },
    { label: "Mart", icon: <IconCart size={16} /> },
    { label: "Bag", icon: <IconBackpack size={16} /> },
    { label: "PC", icon: <IconMonitor size={16} /> },
    { label: "Dex", icon: <IconBook size={16} /> },
  ];
  return (
    <nav className="bottom-tab-strip" role="tablist" style={{ maxWidth: 540 }}>
      {items.map((x, n) => (
        <button
          key={x.label}
          role="tab"
          aria-selected={i === n}
          className={`bottom-tab ${i === n ? "active" : ""}`}
          onClick={() => setI(n)}
        >
          <span className="bottom-tab-icon">{x.icon}</span>
          <span className="bottom-tab-label">{x.label}</span>
        </button>
      ))}
    </nav>
  );
}

function Harness() {
  const [report, setReport] = useState<string | null>(null);

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 20px 60px", color: "var(--text)" }}>
      <h1 style={{ fontSize: 20, margin: "0 0 4px" }}>Control primitives</h1>
      <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--text-dim)", lineHeight: 1.6 }}>
        Every tab set and button variant in the game, on one screen, with the real
        class names. Two rules: one height scale (<code>--ctl-h</code> 32 /{" "}
        <code>--ctl-h-sm</code> 26 / <code>--ctl-h-lg</code> 38), and gold means
        "you are here" and nothing else.
      </p>

      <Row title="Bottom tab strip" note=".bottom-tab — the centre column's primary nav; fills its container, stacks icon over label">
        <StackedTabs />
      </Row>

      <Row title="Region pills" note=".route-region-tab — inside the map pane's header">
        <Tabs cls="route-region-tab" wrap="route-region-tabs" items={["Kanto", "Johto", "Hoenn", "Raids"]} />
      </Row>

      <Row title="Chat channels" note=".mini-chat-tab">
        <Tabs cls="mini-chat-tab" wrap="mini-chat-tabs" items={["Global", "Auctions"]} />
      </Row>

      <Row title="Social tabs" note=".social-tab">
        <Tabs cls="social-tab" wrap="g-tabs" items={["Friends", "Requests", "Blocked"]} />
      </Row>

      <Row title="New primitive" note=".g-tab — what to reach for next time">
        <Tabs cls="g-tab" wrap="g-tabs" items={["One", "Two", "Three"]} />
      </Row>

      <Row title="Dock buttons" note=".dock-btn — stacked icon over label; .active means the panel is open">
        <div className="global-dock" style={{ maxWidth: 320 }}>
          <button type="button" className="dock-btn">
            <span className="dock-btn-icon"><IconSwords size={16} /></span>
            <span className="dock-btn-label">PvP</span>
          </button>
          <button type="button" className="dock-btn active">
            <span className="dock-btn-icon"><IconSettings size={16} /></span>
            <span className="dock-btn-label">Settings</span>
          </button>
          <button type="button" className="dock-btn">
            <span className="dock-btn-icon"><IconChat size={16} /></span>
            <span className="dock-btn-label">Social</span>
          </button>
        </div>
      </Row>

      {/* The same three buttons in the position they actually occupy: the
          meta dock in the top-left of the desktop shell, which is a
          horizontal bar with its own (0,3,0) override. Rendering only the
          stacked version above is how the borderless variant went unnoticed
          in the first place. */}
      <Row title="Meta dock (top-left)" note=".control-column .dock-meta .dock-btn — horizontal, one open at a time">
        <div className="control-column" style={{ display: "contents" }}>
          <div className="dock dock-meta" role="toolbar" style={{ maxWidth: 340 }}>
            <button type="button" className="dock-btn active">
              <span className="dock-btn-icon"><IconSwords size={14} /></span>
              <span className="dock-btn-label">PvP</span>
            </button>
            <button type="button" className="dock-btn">
              <span className="dock-btn-icon"><IconSettings size={14} /></span>
              <span className="dock-btn-label">Settings</span>
            </button>
            <button type="button" className="dock-btn">
              <span className="dock-btn-icon"><IconChat size={14} /></span>
              <span className="dock-btn-label">Social</span>
            </button>
          </div>
        </div>
      </Row>

      <Row title="Row actions" note="the two sizes — 32px default, 26px dense">
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <button className="g-btn-primary">Rematch</button>
          <button className="g-btn-ghost">Manage</button>
          <button className="g-btn-danger-ghost">Release</button>
          <button className="g-btn-primary" disabled>Disabled</button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <button className="g-btn-small g-btn-primary">Go</button>
          <button className="g-btn-small g-btn-ghost">Here</button>
          <button className="g-btn-small g-btn-ghost" disabled>Locked</button>
        </div>
      </Row>

      <Row title="Machine check" note="every control of a kind must agree on height, radius, type size and border">
        <button className="g-btn-primary" onClick={() => setReport(audit())}>Run audit</button>
        {report && (
          <pre style={{
            margin: 0, padding: 12, borderRadius: 8, background: "var(--panel-2)",
            fontSize: 11, lineHeight: 1.6, whiteSpace: "pre-wrap",
          }}>{report}</pre>
        )}
      </Row>
    </div>
  );
}

/**
 * The same question a person asks looking at this page, asked by a machine:
 * does every control of a given kind agree on its shape?
 *
 * Shape, not colour — a selected tab is SUPPOSED to differ in colour. What it
 * may not do is differ in height, radius, type size or border weight, because
 * those are what make two controls read as the same kind of thing.
 */
function audit(): string {
  // `shapes` is how many distinct shapes this kind is ALLOWED. One, unless
  // there is a documented reason for two:
  //   tabs — the bottom strip fills its container and stacks icon over
  //          label; a floating tab row is a single 26px line.
  //   dock — the party dock is a stacked grid cell; the meta dock in the
  //          top-left is a horizontal bar inside a 28px header.
  // Anything above these numbers is drift, not design.
  const KINDS: Array<[string, string[], number]> = [
    ["tabs", [".bottom-tab", ".route-region-tab", ".mini-chat-tab", ".social-tab", ".g-tab"], 2],
    ["dock", [".dock-btn"], 2],
    ["buttons (default)", [".g-btn-primary:not(.g-btn-small)", ".g-btn-ghost:not(.g-btn-small)", ".g-btn-danger-ghost:not(.g-btn-small)"], 1],
    ["buttons (dense)", [".g-btn-small"], 1],
  ];
  const lines: string[] = [];
  for (const [kind, sels, allowed] of KINDS) {
    const shapes = new Map<string, string[]>();
    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) {
        const c = getComputedStyle(el);
        const key = `h=${Math.round(el.getBoundingClientRect().height)} r=${c.borderTopLeftRadius} fs=${c.fontSize} bw=${c.borderTopWidth}`;
        (shapes.get(key) ?? shapes.set(key, []).get(key)!).push(sel);
      }
    }
    const ok = shapes.size <= allowed;
    lines.push(`${ok ? "OK  " : "FAIL"} ${kind}  (${shapes.size}/${allowed} shapes)`);
    for (const [shape, who] of shapes) {
      lines.push(`       ${shape}   ${[...new Set(who)].join(", ")}`);
    }
  }
  return lines.join("\n");
}

const el = document.getElementById("root")!;
const g = window as unknown as { __ctlRoot?: ReturnType<typeof createRoot> };
g.__ctlRoot ??= createRoot(el);
g.__ctlRoot.render(<StrictMode><Harness /></StrictMode>);
