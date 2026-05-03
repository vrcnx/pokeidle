import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { BattleScene } from "./BattleScene";
import { MovesPanel, MovesToolbar } from "./MovesPanel";
import { BottomTabs } from "./BottomTabs";

// Center column: battle arena → toolbar → moves → bottom tabs (Map / Mart /
// Bag / PC / Pokédex). The toolbar (speed/heal/manage) is its own bar above
// the moves card so it reads as a global controls strip.
//
// The battle area can be popped out into the OS-level Picture-in-Picture
// window via the Document Picture-in-Picture API — the same kind of
// always-on-top mini-window browsers offer for videos. The OS handles
// drag/resize/multi-monitor; we just provide the content. Closing the
// PiP window (or clicking the dock button in-page) re-attaches the
// battle scene back into the column.
//
// The Document PiP API ships in Chromium-based browsers (Chrome 116+,
// Edge 116+, Opera). On unsupported browsers the pop-out button is
// disabled with an explanatory tooltip — we don't fall back to a
// custom floating window because the user explicitly wanted the
// browser's native controls.

const PIP_WIDTH = 480;
const PIP_HEIGHT = 270;

declare global {
  interface Window {
    documentPictureInPicture?: {
      requestWindow(opts?: { width?: number; height?: number }): Promise<Window>;
      window: Window | null;
    };
  }
}

const pipSupported = typeof window !== "undefined" && "documentPictureInPicture" in window;

export function CenterColumn() {
  const [pipWindow, setPipWindow] = useState<Window | null>(null);

  // When the user closes the PiP window themselves (X in the title bar
  // or via OS gestures), the page sees a `pagehide` event on it. Clean
  // up our state so the inline scene re-renders.
  useEffect(() => {
    if (!pipWindow) return;
    const onClose = () => setPipWindow(null);
    pipWindow.addEventListener("pagehide", onClose);
    return () => pipWindow.removeEventListener("pagehide", onClose);
  }, [pipWindow]);

  const popOut = async () => {
    if (!pipSupported || !window.documentPictureInPicture) return;
    try {
      const w = await window.documentPictureInPicture.requestWindow({
        width: PIP_WIDTH,
        height: PIP_HEIGHT,
      });
      // The new window starts blank. Clone every <style> and stylesheet
      // <link> from the host document into the popup head — handles both
      // Vite's dev-mode inline styles AND production minified bundles
      // without going through cssRules (which throws for cross-origin).
      [...document.head.querySelectorAll('style, link[rel="stylesheet"]')].forEach(
        (node) => {
          w.document.head.appendChild(node.cloneNode(true));
        }
      );
      // Hard-set body sizing inline so the scene fills the popup before
      // the cloned CSS finishes parsing.
      w.document.body.style.cssText =
        "margin:0;padding:0;background:#000;width:100vw;height:100vh;overflow:hidden;";
      w.document.body.classList.add("pip-body");
      // Reflect the host document's title so the OS window chrome reads
      // useful (otherwise it shows "about:blank" or similar).
      w.document.title = "Pokémon — battle";
      setPipWindow(w);
    } catch (err) {
      // Most common: user activation expired (took too long to click)
      // or browser blocked because PiP slot is taken. Surface the
      // message in the console for debugging.
      console.warn("Document PiP failed:", err);
    }
  };

  const dock = () => {
    pipWindow?.close();
    setPipWindow(null);
  };

  return (
    <div className="center-column">
      {pipWindow ? (
        <BattlePlaceholder onDock={dock} />
      ) : (
        <div className="battle-area">
          <BattleScene />
          <button
            type="button"
            className="battle-popout-btn"
            disabled={!pipSupported}
            title={
              pipSupported
                ? "Pop the battle scene into a floating browser window"
                : "Pop-out requires a Chromium-based browser (Chrome / Edge)"
            }
            onClick={popOut}
            aria-label="Pop out battle scene"
          >
            <PopOutIcon />
          </button>
        </div>
      )}
      <MovesToolbar />
      <MovesPanel />
      <BottomTabs />
      {pipWindow &&
        createPortal(
          <div className="pip-stage">
            <BattleScene />
            <button className="pip-dock-btn" onClick={dock} aria-label="Dock">
              <DockIcon />
            </button>
          </div>,
          pipWindow.document.body
        )}
    </div>
  );
}

function BattlePlaceholder({ onDock }: { onDock: () => void }) {
  return (
    <div className="battle-area battle-placeholder">
      <div className="battle-placeholder-text">
        <strong>Battle scene popped out</strong>
        <span className="dim small">Drag the floating window around or close it to dock back.</span>
        <button className="g-btn-primary g-btn-small" onClick={onDock}>Dock back</button>
      </div>
    </div>
  );
}

function PopOutIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 3h7v7" />
      <path d="M21 3 13 11" />
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </svg>
  );
}

function DockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 14L3 20" />
      <path d="M3 14h6v6" />
      <path d="M3 4h18v10H3z" />
    </svg>
  );
}
