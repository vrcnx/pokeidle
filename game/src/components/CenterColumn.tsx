import { useEffect, useState } from "react";
import { BattleScene } from "./BattleScene";
import { MovesPanel, MovesToolbar } from "./MovesPanel";
import { BottomTabs } from "./BottomTabs";
import { musicManager, type PublicState as MusicState } from "../utils/music";
import { sfxManager } from "../utils/sfx";
import { useT } from "../i18n/useT";

// Center column: battle arena → toolbar → moves → bottom tabs (Map / Mart /
// Bag / PC / Pokédex). The toolbar (speed/heal/manage) is its own bar above
// the moves card so it reads as a global controls strip.
//
// Two quick-toggle buttons sit in the top-right of the battle scene —
// one for music, one for sound effects — so the player can silence
// either bus without opening Settings.

export function CenterColumn() {
  return (
    <div className="center-column">
      <div className="battle-area">
        <BattleScene />
        <div className="battle-audio-toggles">
          <MusicToggleButton />
          <SfxToggleButton />
        </div>
      </div>
      <MovesToolbar />
      <MovesPanel />
      <BottomTabs />
    </div>
  );
}

function MusicToggleButton() {
  const [s, setS] = useState<MusicState>(() => musicManager.snapshot());
  const t = useT();
  useEffect(() => musicManager.subscribe(setS), []);
  const on = s.enabled;
  return (
    <button
      type="button"
      className={`battle-audio-btn ${on ? "" : "muted"}`}
      onClick={() => musicManager.setEnabled(!on)}
      title={on ? t("Mute music") : t("Unmute music")}
      aria-label={on ? t("Mute music") : t("Unmute music")}
      aria-pressed={!on}
    >
      {on ? <NoteIcon /> : <NoteOffIcon />}
    </button>
  );
}

function SfxToggleButton() {
  const [s, setS] = useState(() => sfxManager.snapshot());
  const t = useT();
  useEffect(() => sfxManager.subscribe(setS), []);
  const on = s.enabled;
  return (
    <button
      type="button"
      className={`battle-audio-btn ${on ? "" : "muted"}`}
      onClick={() => sfxManager.setEnabled(!on)}
      title={on ? t("Mute sound effects") : t("Unmute sound effects")}
      aria-label={on ? t("Mute sound effects") : t("Unmute sound effects")}
      aria-pressed={!on}
    >
      {on ? <SpeakerIcon /> : <SpeakerOffIcon />}
    </button>
  );
}

function NoteIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  );
}

function NoteOffIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
      <line x1="3" y1="3" x2="21" y2="21" />
    </svg>
  );
}

function SpeakerIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  );
}

function SpeakerOffIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <line x1="23" y1="9" x2="17" y2="15" />
      <line x1="17" y1="9" x2="23" y2="15" />
    </svg>
  );
}
