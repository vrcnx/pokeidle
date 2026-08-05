import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useGame } from "../state/GameContext";
import { moves as movesTable } from "../data/moves";
import { canonicalMoveId } from "../utils/moves";
import { archetypeFor, SHAKE_MOVES, TYPE_COLOR, type EffectArchetype } from "../utils/moveEffects";
import { animLifetimeMs, moveAnimRate, remainingMs } from "../utils/battleTiming";
import { setCssAnimationRate } from "../utils/animate";
import { FxScene, HIT_STOP_MS, actorFromSlot, runFx } from "../utils/battleFx";
import { buildMoveFx, hasFxAnim } from "../utils/battleFxMoves";
import type { BattleEvent, PokemonType } from "../types";

// Particle/keyframe layer mounted inside .battle-scene. When an "attack"
// battle event reaches the head of pendingEvents, this looks up the
// move's archetype and mounts the matching CSS-driven effect briefly.
//
// Phase 1 archetypes implemented: fire-special, electric-special. All
// other moves currently fall through to a generic flash so battles
// don't look broken — additional archetypes will be filled in next.

interface ActiveAnim {
  key: number;
  archetype: EffectArchetype;
  target: "enemy" | "player";
  shake: boolean;
  moveType: PokemonType;
  moveId: string;
  /** Does the ported FX engine own this move's visuals? See `css` below. */
  fx: boolean;
}

export function MoveAnimation() {
  const { state } = useGame();
  const [active, setActive] = useState<ActiveAnim | null>(null);
  // Track the last attack-event we animated by identity so we don't
  // re-fire when other state changes cause a re-render.
  const lastAnimatedEventRef = useRef<BattleEvent | null>(null);
  const counterRef = useRef(0);
  const shownAtRef = useRef(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** Wall-clock ms the ported animation needs. 0 until the layout effect
   *  below has built the scene and can measure it. */
  const fxMsRef = useRef(0);

  const head = state.pendingEvents[0];

  // ── DETECTION. Deliberately does NOT depend on state.speed ──────────
  // It used to, and the expiry timer was armed down here inside it. Changing
  // speed re-ran the effect, the cleanup killed the pending timer, and then
  // the `head === lastAnimatedEventRef.current` guard returned early before
  // arming a replacement — so the effect layer stayed on screen indefinitely.
  // Detecting a move and expiring it are separate concerns and are now
  // separate effects.
  useEffect(() => {
    if (!head || head.type !== "attack") return;
    if (head === lastAnimatedEventRef.current) return;
    lastAnimatedEventRef.current = head;

    const moveId = head.payload?.moveId as string | undefined;
    const target = (head.payload?.target as "enemy" | "player") ?? "enemy";
    if (!moveId) return;
    const m = movesTable[moveId];
    if (!m) return;
    const archetype = archetypeFor(moveId, m.type, m.category);
    const shake = SHAKE_MOVES.has(moveId);

    counterRef.current++;
    shownAtRef.current = Date.now();
    fxMsRef.current = 0; // re-measured by the layout effect for this move
    setActive({
      key: counterRef.current, archetype, target, shake, moveType: m.type, moveId,
      // Decided HERE, before the first paint. Deciding it in the layout effect
      // below would be one frame too late and the CSS effect would flash.
      fx: hasFxAnim(moveId),
    });
  }, [head]);

  // ── EXPIRY. Re-running this is harmless: it keys on the pop itself and
  // schedules against elapsed time, so switching speed mid-effect retimes
  // the remaining window instead of restarting it.
  useEffect(() => {
    if (!active) return;
    // ── THE ANIMATION DECIDES HOW LONG IT NEEDS ────────────────────────
    // `moveAnimMs` is the lifetime of the old CSS archetypes: a flat 600ms at
    // ×1, which every one of them fitted inside. The ported animations do
    // not — they run 650–1400ms — so holding them to that budget cut the end
    // off nearly all of them. Shadow Ball was showing 43% of itself, Surf
    // 67%: the impact, the burst and the recovery all landed after the
    // component had already unmounted. That is what "lacking animations"
    // was; the animation was there, it was being thrown away.
    //
    // The CSS ladder stays as a FLOOR, so the three moves still on the
    // archetypes are unaffected and a ported animation can never be shorter
    // than the effect it replaced.
    const life = animLifetimeMs(state.speed, fxMsRef.current);
    const left = remainingMs(shownAtRef.current, life, Date.now());
    const t = window.setTimeout(() => setActive(null), left);
    return () => clearTimeout(t);
  }, [active, state.speed]);

  // ── THE KEYFRAMES OBEY THE SPEED SETTING ────────────────────────────
  // The timer above always scaled; the stylesheet never did, so at ×5 the
  // effect was truncated rather than sped up (pani's report). Applied as a
  // playback rate in a LAYOUT effect so it lands before the first painted
  // frame — a rate set a frame late is a visible stutter at the start of
  // every attack.
  useLayoutEffect(() => {
    if (!active) return;
    const el = rootRef.current;
    if (!el) return;
    const rate = moveAnimRate(state.speed);
    setCssAnimationRate([el], rate, { subtree: true });
    // The Earthquake rattle is attached by CSS to an ANCESTOR via :has(), so
    // it is not in this element's subtree and would otherwise keep rattling
    // at ×1 long after the effect that triggered it had finished.
    if (active.shake) {
      const shakeScene = el.closest(".battle-scene, .pvp2-scene");
      setCssAnimationRate([shakeScene?.querySelector(".scene-content")], rate);
    }

    // ── THE SPRITES THEMSELVES MOVE NOW ─────────────────────────────────
    // Everything above animates a layer ON TOP of the battle. This moves the
    // two Pokémon, which is what a contact move actually is — and what no
    // physical move in this game has ever done. See utils/battleFxMoves.
    //
    // The effect layer still plays underneath for every move, so a move with
    // no ported motion looks exactly as it does today rather than looking
    // half-finished. That is what lets this be ported one move at a time.
    const sceneEl = el.closest<HTMLElement>(".battle-scene");
    if (!sceneEl) return;
    const attackerEl = sceneEl.querySelector<HTMLElement>(
      active.target === "enemy" ? ".player-slot" : ".enemy-slot",
    );
    const defenderEl = sceneEl.querySelector<HTMLElement>(
      active.target === "enemy" ? ".enemy-slot" : ".player-slot",
    );
    if (!attackerEl || !defenderEl) return;
    const attacker = actorFromSlot(attackerEl, sceneEl, active.target !== "enemy");
    const defender = actorFromSlot(defenderEl, sceneEl, active.target === "enemy");
    if (!attacker || !defender) return;
    const fx = new FxScene(sceneEl);
    fx.add(attacker);
    fx.add(defender);
    // Built but not run leaks the effect layer — runFx is what tears it down.
    // Nothing queues sprites before returning false today, so this is belt and
    // braces, but the next move ported could and the leak would be a silent
    // pile of stale <img> over the battle.
    if (!buildMoveFx(active.moveId, fx, attacker, defender)) {
      fx.teardown();
      return;
    }
    // Measured here, before the expiry effect for this same commit runs —
    // React flushes layout effects ahead of passive ones, which is the whole
    // reason this is a useLayoutEffect and the expiry is a useEffect.
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Status moves never freeze the world. Thirteen of them throw something at
    // the target — Leech Seed, Toxic, Sand Attack — so the geometry alone
    // reads them as a hit, and they would punch like a Body Slam. Nothing
    // landed; the category is the only thing that actually knows that.
    const isStatus =
      movesTable[canonicalMoveId(active.moveId)]?.category === "status";
    // A damaging move ALWAYS punctuates. The geometry finds the moment for
    // 140 of the 160, but twenty are genuinely ambiguous — a drain travels
    // toward the attacker, Explosion is centred on the attacker, Sonic Boom
    // is a wave with no destination — and leaving those unpunctuated would
    // make them feel weaker than everything around them for a reason the
    // player cannot see. Consistency matters more here than precision, so
    // they freeze at roughly where the payoff lands.
    const impactAt = isStatus
      ? null
      : fx.impactAt(defender) ?? Math.round(fx.duration * 0.6);
    // The hit stop is real time added to the run, so the lifetime has to
    // include it — otherwise freezing on impact would push the tail back off
    // the end again, which is the bug this file just fixed.
    fxMsRef.current =
      Math.ceil(fx.duration / rate) + (impactAt != null && !reducedMotion ? HIT_STOP_MS : 0);
    const run = runFx(fx, { rate, reducedMotion, impactAt });
    return () => run.cancel();
  }, [active, state.speed]);

  if (!active) return null;
  // Type color is injected as a CSS variable so generic effects (impact,
  // aura) can pick it up without hard-coded per-type rules.
  const typeColor = TYPE_COLOR[active.moveType];

  // ── ONE ANIMATION PER MOVE, NOT TWO ──────────────────────────────────
  // The CSS archetypes and the ported engine are two different renderings of
  // the same attack. While only a handful of moves were ported, running both
  // was the safe default — a ported move gained real choreography and an
  // unported one was untouched. Now that 234 of 248 are ported it is just a
  // double image: two sets of particles on every hit.
  //
  // The archetype class and its children are dropped for a move the engine
  // owns. The element itself stays: it is what the layout effect above walks
  // up from to find the arena, and it still carries `.shake-screen`, which is
  // OURS — Showdown's animations have no screen rattle and Earthquake needs
  // one. The remaining fourteen moves, and the whole PvP arena, keep drawing
  // the archetypes exactly as before.
  const cssLayer = !active.fx;
  return (
    <div
      key={active.key}
      ref={rootRef}
      className={`move-anim${cssLayer ? ` move-anim-${active.archetype}` : ""} target-${active.target}${active.shake ? " shake-screen" : ""}`}
      style={{ ["--type-color" as string]: typeColor }}
      aria-hidden
    >
      {cssLayer && (
      <>
      {active.archetype === "fire-special"     && <ParticleStream className="fire-particle"    count={6} />}
      {active.archetype === "water-special"    && <ParticleStream className="water-particle"   count={7} />}
      {active.archetype === "grass-special"    && <ParticleStream className="grass-particle"   count={5} />}
      {active.archetype === "ice-special"      && <ParticleStream className="ice-particle"     count={6} />}
      {active.archetype === "poison-special"   && <ParticleStream className="poison-particle"  count={5} />}
      {active.archetype === "bug-special"      && <ParticleStream className="bug-particle"     count={4} />}
      {active.archetype === "rock-special"     && <ParticleStream className="rock-particle"    count={5} />}
      {active.archetype === "ground-special"   && <ParticleStream className="ground-particle"  count={5} />}
      {active.archetype === "flying-special"   && <ParticleStream className="flying-particle"  count={4} />}
      {active.archetype === "normal-special"   && <ParticleStream className="normal-particle"  count={4} />}
      {active.archetype === "fighting-special" && <FightingImpact />}
      {active.archetype === "physical-impact"  && <PhysicalImpact />}
      {active.archetype === "status-aura"      && <StatusAura />}
      {active.archetype === "electric-special" && <ElectricBolt />}
      {active.archetype === "psychic-special"  && <PsychicWave />}
      {active.archetype === "ghost-special"    && <GhostWisps />}
      {active.archetype === "dragon-special"   && <DragonBeam />}
      {active.archetype === "dark-special"     && <DarkVoid />}
      {active.archetype === "hyper-beam"       && <HyperBeam />}
      {active.archetype === "solar-beam"       && <SolarBeam />}
      {active.archetype === "explosion"        && <Explosion />}
      </>
      )}
    </div>
  );
}

// Generic flying-particle stream — used by most projectile-ish elements.
// Per-type CSS picks the color/shape via the className passed in.
function ParticleStream({ className, count }: { className: string; count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className={className} />
      ))}
    </>
  );
}

// Vertical jagged bolt + flash on the target.
function ElectricBolt() {
  return (
    <>
      <span className="electric-bolt" />
      <span className="electric-flash" />
    </>
  );
}

// Pulsing ring centered on the target — pink/purple psychic feel.
function PsychicWave() {
  return (
    <>
      <span className="psychic-ring r1" />
      <span className="psychic-ring r2" />
      <span className="psychic-ring r3" />
    </>
  );
}

// Three semi-transparent purple wisps that drift toward the target then fade.
function GhostWisps() {
  return (
    <>
      <span className="ghost-wisp w1" />
      <span className="ghost-wisp w2" />
      <span className="ghost-wisp w3" />
    </>
  );
}

// Single thick beam that fires from attacker → defender. Saturated
// orange/purple gradient evokes a dragon-energy feel.
function DragonBeam() {
  return <span className="dragon-beam" />;
}

// Dark wisps converging on the target with a vignette darkening the area.
function DarkVoid() {
  return (
    <>
      <span className="dark-vignette" />
      <span className="dark-wisp w1" />
      <span className="dark-wisp w2" />
      <span className="dark-wisp w3" />
    </>
  );
}

// Quick slash + impact star on the target — heavier than the generic
// physical-impact pulse to fit Fighting moves' weight.
function FightingImpact() {
  return (
    <>
      <span className="fighting-slash s1" />
      <span className="fighting-slash s2" />
      <span className="fighting-impact-star" />
    </>
  );
}

// Physical-impact: every non-special damaging move (Tackle, Body Slam,
// Earthquake, Dragon Claw, etc.) gets a visible slash + ring burst on
// the target. Tinted by --type-color so an Ice Punch reads blue, a Fire
// Punch reads orange, etc.
function PhysicalImpact() {
  return (
    <>
      <span className="impact-slash s1" />
      <span className="impact-slash s2" />
      <span className="impact-ring" />
    </>
  );
}

// Status-aura: a colored expanding ring + sparkle on the target so stat
// changes / status moves don't look like nothing's happening.
function StatusAura() {
  return (
    <>
      <span className="aura-ring r1" />
      <span className="aura-ring r2" />
      <span className="aura-sparkle s1" />
      <span className="aura-sparkle s2" />
      <span className="aura-sparkle s3" />
    </>
  );
}

// Hyper Beam — wide bright beam from attacker → defender + ring burst.
function HyperBeam() {
  return (
    <>
      <span className="hyperbeam-charge" />
      <span className="hyperbeam-ray" />
      <span className="hyperbeam-impact" />
    </>
  );
}

// Solar Beam — yellow gather aura on attacker, then a green beam blast.
function SolarBeam() {
  return (
    <>
      <span className="solarbeam-charge" />
      <span className="solarbeam-ray" />
      <span className="solarbeam-impact" />
    </>
  );
}

// Explosion / Self-Destruct — full-scene white flash + expanding fire ring.
function Explosion() {
  return (
    <>
      <span className="explosion-flash" />
      <span className="explosion-ring" />
      <span className="explosion-debris d1" />
      <span className="explosion-debris d2" />
      <span className="explosion-debris d3" />
      <span className="explosion-debris d4" />
      <span className="explosion-debris d5" />
      <span className="explosion-debris d6" />
    </>
  );
}
