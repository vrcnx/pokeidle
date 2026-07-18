import { useEffect, useRef } from "react";
import { useGame } from "../state/GameContext";
import { useT } from "../i18n/useT";

// Pokémon Center healing scene. We dispatch the same step transitions the
// reducer expects (START_HEALING already moved phase→"healing"; we drive
// HEALING_STEP and finally COMPLETE_HEALING ourselves), and play the
// heal-animation video underneath at 2.5× speed.
//
// Timing matches the original site:
//   t=250ms   → HEALING_STEP   (step 1, "healing…")
//   t=3000ms  → HEALING_STEP   (step 2, "done")
//   t=3750ms  → COMPLETE_HEALING (party is restored, phase returns to idle)
export function HealingModal() {
  const { state, dispatch } = useGame();
  const t = useT();
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const active = state.phase === "healing" && !!state.healingState;

  useEffect(() => {
    if (!active) return;
    const v = videoRef.current;
    if (v) {
      v.playbackRate = 2.5;
      // play() returns a Promise that may reject if autoplay is blocked.
      // We swallow it — the timing below still completes the heal flow.
      v.play().catch(() => {});
    }
    const t1 = window.setTimeout(() => dispatch({ type: "HEALING_STEP" }), 250);
    const t2 = window.setTimeout(() => dispatch({ type: "HEALING_STEP" }), 3000);
    const t3 = window.setTimeout(() => dispatch({ type: "COMPLETE_HEALING" }), 3750);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [active, dispatch]);

  if (!active) return null;
  const step = state.healingState!.step;
  const label =
    step >= 2 ? t("Your Pokémon are fully healed!")
    : step >= 1 ? t("Healing your Pokémon…")
    : t("Welcome to the Pokémon Center.");

  return (
    <div className="modal-overlay heal-overlay">
      <div className="modal healing">
        <header className="heal-head">
          <span className="heal-cross" aria-hidden>+</span>
          <strong>{t("Pokémon Center")}</strong>
        </header>
        <div className="heal-video-frame">
          <video
            ref={videoRef}
            className="heal-video"
            src="/heal-animation-web.mp4"
            muted
            playsInline
            preload="auto"
          />
        </div>
        <p className="heal-caption">
          <span className={`heal-pulse ${step >= 2 ? "done" : ""}`} />
          {label}
        </p>
      </div>
    </div>
  );
}
