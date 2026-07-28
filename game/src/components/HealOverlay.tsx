import { useEffect, useRef } from "react";
import { useGame } from "../state/GameContext";
import { sfxManager } from "../utils/sfx";
import { musicManager } from "../utils/music";
import { useT } from "../i18n/useT";

// In-scene heal animation. The heal video is the source of truth for
// timing — we play it through completely and fire COMPLETE_HEALING on
// its `ended` event, so the full clip always plays regardless of its
// duration. Step transitions are scheduled relative to playback so
// caption changes line up with the video instead of arbitrary timers.
//
// Base playback rate is 1.5× so the clip feels brisk without skipping any
// frames. We then scale by the game's speed multiplier so the heal scales
// with the rest of combat (×2 speed → 3.0× heal; ×5 speed → 7.5× capped
// at the browser's effective max). A safety timer fires COMPLETE_HEALING
// if `ended` doesn't (e.g. the video failed to load).
const BASE_PLAYBACK_RATE = 1.5;
const MAX_PLAYBACK_RATE = 8;   // browsers handle this fine; beyond ~16 dims dropping frames
const FALLBACK_DURATION_MS = 6000;

export function HealOverlay() {
  const { state, dispatch } = useGame();
  const t = useT();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const sessionRef = useRef<number>(-1);
  const active = state.phase === "healing" && !!state.healingState;

  useEffect(() => {
    if (!active) {
      sessionRef.current = -1;
      return;
    }
    if (sessionRef.current !== -1) return; // already started this session
    sessionRef.current = Date.now();

    const v = videoRef.current;
    let stepT1: number | undefined;
    let stepT2: number | undefined;
    let safety: number | undefined;

    // Hard backstop, armed unconditionally.
    //
    // The `safety` timer below is created INSIDE start(), and start() only
    // runs on `loadedmetadata` (or on a play() rejection). If the video
    // element resolves play() but never reports metadata — plausible on a
    // headless Chromium with a codec it half-supports — start() never runs,
    // no timer exists, and `ended` never fires. Nothing else can leave the
    // "healing" phase, and START_BOSS_BATTLE parks every gym and Elite Four
    // challenge here first, so that is a permanent freeze on the first boss
    // attempt. This timer cannot fire late into a battle: COMPLETE_HEALING
    // clears healingState, `active` flips false, and the cleanup below runs.
    const hardStop = window.setTimeout(
      () => dispatch({ type: "COMPLETE_HEALING" }),
      (FALLBACK_DURATION_MS / (state.speed || 1)) + 3000,
    );
    // Apply the game's speed multiplier on top of the base heal rate so
    // a 5× game has a 5× heal too. Capped so super-fast doesn't choke
    // the decoder.
    const playRate = Math.min(MAX_PLAYBACK_RATE, BASE_PLAYBACK_RATE * (state.speed || 1));

    // Heal SFX — match the video's playback rate so the audio finishes
    // alongside the visual instead of dragging on after the heal video
    // is done. Pitch is preserved so the chime still sounds itself
    // even at 5× speed.
    sfxManager.play("heal", { rate: playRate });
    // Duck the background music while the heal chime is playing so
    // the sting reads cleanly. The cleanup below unducks when the
    // heal scene tears down (or the user travels away mid-heal).
    musicManager.duck(true);

    const start = () => {
      const dur = (isFinite(v?.duration ?? NaN) && (v?.duration ?? 0) > 0)
        ? (v!.duration / playRate) * 1000
        : FALLBACK_DURATION_MS / (state.speed || 1);

      // Step 1 ("healing…") at 5% of duration; step 2 ("done!") at 90%.
      stepT1 = window.setTimeout(() => dispatch({ type: "HEALING_STEP" }), Math.max(100, dur * 0.05));
      stepT2 = window.setTimeout(() => dispatch({ type: "HEALING_STEP" }), Math.max(400, dur * 0.90));
      // Safety net — if `ended` never fires, finish anyway.
      safety = window.setTimeout(() => dispatch({ type: "COMPLETE_HEALING" }), dur + 250);
    };

    const onEnded = () => dispatch({ type: "COMPLETE_HEALING" });

    if (v) {
      v.currentTime = 0;
      v.playbackRate = playRate;
      v.addEventListener("ended", onEnded);
      // Start the step timers either immediately (if metadata is ready)
      // or after loadedmetadata fires.
      if (isFinite(v.duration) && v.duration > 0) {
        start();
      } else {
        v.addEventListener("loadedmetadata", start, { once: true });
      }
      v.play().catch(() => {
        // Autoplay blocked or codec missing — fall back to a hard timer.
        if (stepT1 === undefined) start();
      });
    } else {
      start();
    }

    return () => {
      clearTimeout(hardStop);
      if (stepT1) clearTimeout(stepT1);
      if (stepT2) clearTimeout(stepT2);
      if (safety) clearTimeout(safety);
      if (v) v.removeEventListener("ended", onEnded);
      musicManager.duck(false);
    };
  }, [active, dispatch]);

  if (!active) return null;
  const step = state.healingState!.step;
  const caption =
    step >= 2 ? t("Your Pokémon are fully healed!")
    : step >= 1 ? t("Healing your Pokémon…")
    : t("Welcome to the Pokémon Center.");

  return (
    <div className="heal-scene-overlay">
      <video
        ref={videoRef}
        className="heal-scene-video"
        src="/heal.webm"
        autoPlay
        muted
        playsInline
        preload="auto"
      />
      <div className="heal-scene-caption">{caption}</div>
    </div>
  );
}
