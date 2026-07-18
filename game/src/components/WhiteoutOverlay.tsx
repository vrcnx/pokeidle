import { useEffect } from "react";
import { useGame } from "../state/GameContext";
import { useT } from "../i18n/useT";

// Plays a brief fade-to-black "You fainted!" overlay whenever the team gets
// wiped out. Triggered via state.whiteoutAnim (set in handleFaint white-out
// branches and the defensive HEAL_PARTY when all-fainted). After the fade
// finishes, automatically chain into the heal animation so the player sees
// their party getting restored before being dropped back into idle.
const WHITEOUT_DURATION_MS = 1800;

export function WhiteoutOverlay() {
  const { state, dispatch } = useGame();
  const anim = state.whiteoutAnim;
  const t = useT();

  useEffect(() => {
    if (!anim) return;
    const t = window.setTimeout(() => {
      dispatch({ type: "CLEAR_WHITEOUT_ANIM" });
      // Chain straight into the heal animation. The reducer's
      // START_HEALING moves phase→"healing"; HealOverlay then plays
      // the video and dispatches COMPLETE_HEALING when finished.
      dispatch({ type: "START_HEALING" });
    }, WHITEOUT_DURATION_MS);
    return () => clearTimeout(t);
  }, [anim?.key, dispatch]);

  if (!anim) return null;
  return (
    <div className="whiteout-overlay" key={anim.key} role="alert" aria-live="assertive">
      <span className="whiteout-text">{t("You fainted!")}</span>
    </div>
  );
}
