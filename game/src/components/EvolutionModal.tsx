import { useEffect, useState } from "react";
import { useGame } from "../state/GameContext";
import { pokemonTable } from "../data/pokemon";
import { pokemonSpriteUrl } from "../utils/sprites";
import { useModalEnter } from "../utils/animate";
import { useT } from "../i18n/useT";

// Evolution flow:
//   step 0 — setup: original sprite, intro text, slow pulse
//   step 1 — silhouette flicker (toggle to new form, white silhouette)
//   step 2 — silhouette flicker (back to old, faster)
//   step 3 — silhouette flicker (new again, fastest)
//   step 4 — peak: white flash, new sprite revealed in full color
//   step 5 — completion: COMPLETE_EVOLUTION dispatched, modal closes
//
// Step durations vary so the cadence accelerates toward the climax —
// closer to how Pokemon games stage the transformation.
const STEP_DURATIONS = [1000, 700, 500, 400, 1100];

export function EvolutionModal() {
  const { state, dispatch } = useGame();
  const ev = state.evolutionState;

  useEffect(() => {
    if (!ev || state.phase !== "evolution") return;
    const dur = STEP_DURATIONS[ev.step] ?? 700;
    const t = setTimeout(() => {
      if (ev.step >= 4) {
        dispatch({ type: "COMPLETE_EVOLUTION" });
      } else {
        dispatch({ type: "EVOLUTION_STEP" });
      }
    }, dur);
    return () => clearTimeout(t);
  }, [ev, ev?.step, state.phase, dispatch]);

  if (!ev || state.phase !== "evolution") return null;
  const p = state.party[ev.partyIndex];
  if (!p) return null;
  return <EvolutionDialog pokemon={p} ev={ev} />;
}

function EvolutionDialog({ pokemon: p, ev }: { pokemon: any; ev: { step: number; toSpeciesKey: string } }) {
  const dialogRef = useModalEnter();
  const t = useT();
  const fromSp = pokemonTable[p.speciesKey];
  const toSp = pokemonTable[ev.toSpeciesKey];

  // Pre-load the new sprite so step 4 doesn't flash a broken image.
  useEffect(() => {
    const img = new Image();
    img.src = pokemonSpriteUrl(ev.toSpeciesKey, false, p.isShiny);
  }, [ev.toSpeciesKey, p.isShiny]);

  // step → render config
  const isPeak = ev.step >= 4;
  const showFrom = !isPeak && ev.step % 2 === 0;
  const sprite = isPeak
    ? ev.toSpeciesKey
    : showFrom ? p.speciesKey : ev.toSpeciesKey;

  return (
    <div className="modal-overlay evolution-overlay" data-stage={ev.step}>
      <div
        ref={dialogRef}
        className="g-modal evolution-modal-v2"
        data-stage={ev.step}
        role="dialog"
        aria-label={t("Evolution")}
      >
        <div className="evo-stage" data-stage={ev.step}>
          {/* Radiating light rays — visible during silhouette flicker and peak. */}
          <div className="evo-rays" aria-hidden>
            <span /><span /><span /><span /><span /><span /><span /><span />
          </div>
          {/* Peak white flash overlay. */}
          <div className="evo-flash" aria-hidden />

          <div className="evo-sprite-wrap">
            <img
              key={sprite + ev.step}
              src={pokemonSpriteUrl(sprite, false, p.isShiny)}
              alt={sprite}
              width={160}
              height={160}
              className="evo-sprite"
              style={{ imageRendering: "pixelated" }}
            />
          </div>

          <div className="evo-caption">
            {ev.step === 0 && (
              <>{t("What? ")}<strong>{fromSp?.name}</strong>{t(" is evolving!")}</>
            )}
            {ev.step >= 1 && ev.step <= 3 && (
              <span className="evo-caption-pulse">…</span>
            )}
            {ev.step >= 4 && (
              <>{t("Congratulations! ")}<strong>{fromSp?.name}</strong>{t(" evolved into ")}<strong>{toSp?.name}</strong>{t("!")}</>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
