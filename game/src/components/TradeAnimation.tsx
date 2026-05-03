import { useEffect, useState } from "react";
import { pokemonTable } from "../data/pokemon";
import { pokemonSpriteUrl, itemSpriteUrl } from "../utils/sprites";

// Trade cinematic — plays the classic Pokemon trade sequence whenever
// a finalised peer-to-peer trade resolves. The overlay is deliberately
// stateless: it animates whatever is passed to `playTradeAnimation`,
// then fires `onComplete`. Game-state mutation (the actual party swap,
// trade-only evolutions like Kadabra → Alakazam) is the caller's job.
//
// Stages:
//   0 setup    — both sprites visible, "Trade in progress…"
//   1 absorb   — sprites collapse into Pokéballs
//   2 travel   — balls cross the screen along a neon link cable
//   3 reveal   — balls land on the opposite side and pop open
//   4 done     — new sprites unfurl, caption "Take care of <name>!"
//   5 evolve   — (optional) trade-evo silhouette flicker into final form
//
// Each stage's duration is fixed; the whole animation runs ~6.4 seconds
// (or ~8 seconds when an evolution rider is attached).

export interface TradeParty {
  name: string;          // trainer name (you / them)
  pokemonName: string;   // Pokemon species/nickname shown in captions
  speciesKey: string;    // initial sprite
  isShiny?: boolean;
  evolveInto?: string;   // optional trade-only evolution target
}

interface TradeRequest {
  from: TradeParty;      // what you sent away (your old mon)
  to: TradeParty;        // what came back from the other side
  onComplete?: () => void;
}

const STEP_DURATIONS = [1100, 900, 1500, 900, 2000, 1300];

let _request: TradeRequest | null = null;
const _listeners = new Set<(r: TradeRequest | null) => void>();

export function playTradeAnimation(req: TradeRequest) {
  _request = req;
  for (const fn of _listeners) fn(req);
}
function clearTrade() {
  const cb = _request?.onComplete;
  _request = null;
  for (const fn of _listeners) fn(null);
  cb?.();
}

function useTradeRequest(): TradeRequest | null {
  const [r, setR] = useState<TradeRequest | null>(_request);
  useEffect(() => {
    _listeners.add(setR);
    return () => { _listeners.delete(setR); };
  }, []);
  return r;
}

export function TradeAnimation() {
  const req = useTradeRequest();
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!req) {
      setStep(0);
      return;
    }
    setStep(0);
    let i = 0;
    let timer: number | undefined;
    const advance = () => {
      i += 1;
      const hasEvolve =
        !!req.from.evolveInto || !!req.to.evolveInto;
      const lastStep = hasEvolve ? 5 : 4;
      if (i > lastStep) {
        clearTrade();
        return;
      }
      setStep(i);
      timer = window.setTimeout(advance, STEP_DURATIONS[i] ?? 800);
    };
    timer = window.setTimeout(advance, STEP_DURATIONS[0]);
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [req]);

  if (!req) return null;

  const fromInfo = pokemonTable[req.from.speciesKey];
  const toInfo = pokemonTable[req.to.speciesKey];

  // Pre-trade (stages 0–3): each slot shows its OWN side's pokemon.
  //   left  = you giving away req.from
  //   right = them giving away req.to
  // After reveal (stages 4+): the slots have swapped — left now holds
  // what came back from the other side (req.to), right now holds what
  // we sent away (req.from). On stage 5 the trade-only evolution
  // morphs the relevant slot into its evolved form.
  const swapped = step >= 4;
  const leftSpecies =
    swapped && step >= 5 && req.to.evolveInto
      ? req.to.evolveInto
      : swapped
      ? req.to.speciesKey
      : req.from.speciesKey;
  const rightSpecies =
    swapped && step >= 5 && req.from.evolveInto
      ? req.from.evolveInto
      : swapped
      ? req.from.speciesKey
      : req.to.speciesKey;
  const leftShiny = swapped ? !!req.to.isShiny : !!req.from.isShiny;
  const rightShiny = swapped ? !!req.from.isShiny : !!req.to.isShiny;
  const leftLabel = swapped ? toInfo?.name ?? req.to.pokemonName : fromInfo?.name ?? req.from.pokemonName;
  const rightLabel = swapped ? fromInfo?.name ?? req.from.pokemonName : toInfo?.name ?? req.to.pokemonName;

  return (
    <div className="trade-overlay" data-stage={step} aria-hidden>
      <div className="trade-stage" data-stage={step}>
        {/* Background grid / energy field */}
        <div className="trade-bg-grid" />
        <div className="trade-bg-stars" />

        {/* Two trainer slots — captioned with the trainers' names */}
        <div className="trade-slot left">
          <div className="trade-trainer-tag">{req.from.name}</div>
          <div className="trade-sprite-wrap" key={`${leftSpecies}-${leftShiny}-${step}`}>
            <img
              className={`trade-sprite ${step >= 1 && step <= 3 ? "absorbed" : ""}`}
              src={pokemonSpriteUrl(leftSpecies, true, leftShiny)}
              alt={leftLabel ?? leftSpecies}
              style={{ imageRendering: "pixelated" }}
              onError={(e) => ((e.target as HTMLImageElement).style.opacity = "0")}
            />
            {/* Pokéball replaces the sprite mid-trade */}
            <img
              className={`trade-ball left-ball stage-${step}`}
              src={itemSpriteUrl("pokeball")}
              alt=""
              style={{ imageRendering: "pixelated" }}
            />
          </div>
        </div>

        <div className="trade-cable" aria-hidden>
          <span className="trade-cable-line" />
          <span className="trade-cable-pulse" />
        </div>

        <div className="trade-slot right">
          <div className="trade-trainer-tag">{req.to.name}</div>
          <div className="trade-sprite-wrap" key={`${rightSpecies}-${rightShiny}-${step}`}>
            <img
              className={`trade-sprite ${step >= 1 && step <= 3 ? "absorbed" : ""}`}
              src={pokemonSpriteUrl(rightSpecies, true, rightShiny)}
              alt={rightLabel ?? rightSpecies}
              style={{ imageRendering: "pixelated" }}
              onError={(e) => ((e.target as HTMLImageElement).style.opacity = "0")}
            />
            <img
              className={`trade-ball right-ball stage-${step}`}
              src={itemSpriteUrl("pokeball")}
              alt=""
              style={{ imageRendering: "pixelated" }}
            />
          </div>
        </div>

        {/* Peak white flash — fires when balls land + when evolving. */}
        <div className={`trade-flash stage-${step}`} aria-hidden />

        <div className="trade-caption">
          {step === 0 && <>Trade in progress…</>}
          {step === 1 && (
            <>
              Sending <strong>{req.from.pokemonName}</strong>…
            </>
          )}
          {step === 2 && <>The Pokémon are being traded…</>}
          {step === 3 && (
            <>
              <strong>{req.to.name}</strong> sent{" "}
              <strong>{req.to.pokemonName}</strong>!
            </>
          )}
          {step === 4 && (
            <>
              Take good care of{" "}
              <strong>{req.to.pokemonName}</strong>!
            </>
          )}
          {step === 5 && (
            <>
              <strong>{req.from.evolveInto ? req.from.pokemonName : req.to.pokemonName}</strong>{" "}
              is evolving!
            </>
          )}
        </div>
      </div>
    </div>
  );
}
