import { useEffect, useRef } from "react";
import { useGame } from "../state/GameContext";

/**
 * Reward lines get the accent treatment so they stand out from the
 * blow-by-blow. EV gains join EXP here rather than getting a class of their
 * own: they are the same "you just made progress" beat, and players were
 * missing them entirely.
 *
 * Exported because the log renders in two places — this panel and
 * BattleLogModal — which each carried their own copy of the EXP pattern. Two
 * definitions of "reward line" means the next one added is styled in one view
 * and plain in the other, which is exactly what happened to the EV line.
 */
export const REWARD_LINE = /gained \d+ EXP|gained EVs:|fully EV trained/;

export function BattleLog() {
  const { state } = useGame();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [state.battleLog]);
  return (
    <div className="battle-log" ref={ref}>
      {state.battleLog.map((line, i) => (
        <div key={i} className={REWARD_LINE.test(line) ? "log-exp" : ""}>{line}</div>
      ))}
    </div>
  );
}
