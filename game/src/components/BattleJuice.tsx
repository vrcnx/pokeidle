import { useEffect, useRef, useState } from "react";
import { useGame } from "../state/GameContext";

// Battle juice — picks up "grew to Lv N", "X was caught!", and "earned
// $N" messages from the battle log and overlays a transient celebratory
// banner on the arena. Tuned to dwell shorter at higher speed multipliers
// so the player doesn't accumulate stale messages while grinding.
//
// Reuses the same log-scanning pattern as EffectivenessFlash so we don't
// add a parallel state machine. Each detection bumps a key so the CSS
// keyframe restarts even on rapid back-to-back unlocks.

type Burst =
  | { key: number; kind: "levelup"; text: string }
  | { key: number; kind: "catch";   text: string }
  | { key: number; kind: "money";   text: string };

export function BattleJuice() {
  const { state } = useGame();
  const prevLen = useRef(state.battleLog.length);
  const [burst, setBurst] = useState<Burst | null>(null);

  useEffect(() => {
    const start = prevLen.current;
    const end = state.battleLog.length;
    prevLen.current = end;
    if (end <= start) return;

    let next: Burst | null = null;
    for (let i = start; i < end; i++) {
      const line = state.battleLog[i] ?? "";

      // Catch wins highest priority (rarest + most celebratory).
      const catchMatch = /^(.+?) was caught!$/.exec(line);
      if (catchMatch) {
        next = { key: Date.now() + i, kind: "catch", text: "GOT IT!" };
        break;
      }

      // Level-up — "Pikachu grew to Lv. 18!" (canonical format from the
      // game's level-up message)
      const lvMatch = /grew to (?:Lv\.?\s*)?(\d+)/i.exec(line);
      if (lvMatch && !next) {
        const lv = lvMatch[1];
        next = { key: Date.now() + i, kind: "levelup", text: `LV ${lv}!` };
      }

      // Money — "Got $48 for winning!" / "Earned $X" / various phrasings.
      const moneyMatch = /\$([\d,]+)/.exec(line);
      if (moneyMatch && !next) {
        const amt = moneyMatch[1];
        next = { key: Date.now() + i, kind: "money", text: `+$${amt}` };
      }
    }
    if (!next) return;
    setBurst(next);
    const dwell = state.speed >= 5 ? 900 : state.speed >= 2 ? 1200 : 1500;
    const t = setTimeout(() => setBurst(null), dwell);
    return () => clearTimeout(t);
  }, [state.battleLog, state.speed]);

  if (!burst) return null;
  return (
    <div className="battle-juice" aria-hidden>
      <span key={burst.key} className={`battle-juice-burst ${burst.kind}`}>
        {burst.text}
      </span>
    </div>
  );
}
