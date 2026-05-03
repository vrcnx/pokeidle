import { useEffect, useRef } from "react";
import { useGame } from "../state/GameContext";

const EXP_LINE = /gained \d+ EXP/;

export function BattleLog() {
  const { state } = useGame();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [state.battleLog]);
  return (
    <div className="battle-log" ref={ref}>
      {state.battleLog.map((line, i) => (
        <div key={i} className={EXP_LINE.test(line) ? "log-exp" : ""}>{line}</div>
      ))}
    </div>
  );
}
