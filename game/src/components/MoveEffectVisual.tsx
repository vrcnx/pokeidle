// The idle game's move-effect markup, driven by props instead of by the idle
// battle's event queue.
//
// WHY A COMPONENT RATHER THAN A REFACTOR OF MoveAnimation.tsx
//
// Every visual here is app.css's, unchanged: `.move-anim`, the per-archetype
// classes and all forty-odd particle/beam/impact rules are GLOBALLY scoped, so
// emitting the same class names is reuse in the only sense that matters — one
// stylesheet, one look, and a change to a keyframe moves the idle game and the
// arena together. What could NOT be reused is the driver: `MoveAnimation()`
// takes no props and reads `useGame().state.pendingEvents[0]`, so mounting it
// inside the PvP arena would animate the SUSPENDED IDLE BATTLE's events on the
// PvP board. Its sub-components are module-private, so there is no third
// option that does not edit live idle-game code.
//
// This file is therefore the props-driven half of that component, and
// MoveAnimation could be reduced to a thin wrapper over it (see the note in
// the task report) — a change to the live idle battle, so proposed rather than
// made here.

import { useLayoutEffect, useRef } from "react";
import type { EffectArchetype } from "../utils/moveEffects";
import { FxScene, actorFromSlot, runFx } from "../utils/battleFx";
import { buildMoveFx, hasFxAnim } from "../utils/battleFxMoves";
import { setCssAnimationRate } from "../utils/animate";
import { moves as movesTable } from "../data/moves";
import { canonicalMoveId } from "../utils/moves";

export function MoveEffectVisual({
  archetype,
  target,
  shake,
  typeColor,
  animKey,
  moveId,
}: {
  archetype: EffectArchetype;
  /** The canonical move key. When the ported animation library has one, it
   *  draws that instead of the archetype below — see the note in the body. */
  moveId?: string;
  /** "player" is the LOCAL player's slot. app.css reads `.target-*` to pick
   *  the projectile's direction, and both slots' anchor coordinates are baked
   *  from `.player-slot` / `.enemy-slot` — the exact classes the arena's
   *  sprites already use, so they land correctly with no override. */
  target: "player" | "enemy";
  shake: boolean;
  typeColor: string;
  /** Bumped per effect so identical consecutive moves both replay their
   *  keyframes instead of the second being a no-op on a live element. */
  animKey: number;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  // ── PvP DRAWS THE SAME ANIMATIONS AS THE IDLE BATTLE ─────────────────
  // The arena used these archetypes because they were all there was: twenty
  // generic buckets covering every move in the game. The idle side has had
  // 234 of Showdown's real per-move animations since they were ported, plus
  // the hit stop and the new art, and the only thing keeping PvP on the old
  // path was that nothing threaded the move id this far.
  //
  // It works with no coordinate changes because the arena already renders its
  // sprites into `.sprite-slot.player-slot` / `.enemy-slot` — the exact
  // classes `actorFromSlot` measures. It was written that way deliberately
  // (see the note at the top of PvpArena) and this is the payoff.
  //
  // Rate is a flat 1: PvP has no game-speed setting, and the narration pacer
  // deliberately runs in absolute milliseconds so both players see the same
  // battle at the same tempo.
  const fx = !!moveId && hasFxAnim(moveId);
  useLayoutEffect(() => {
    if (!fx || !moveId) return;
    const el = rootRef.current;
    if (!el) return;
    const scene = el.closest<HTMLElement>(".pvp2-scene, .battle-scene");
    if (!scene) return;
    const attackerEl = scene.querySelector<HTMLElement>(
      target === "enemy" ? ".player-slot" : ".enemy-slot",
    );
    const defenderEl = scene.querySelector<HTMLElement>(
      target === "enemy" ? ".enemy-slot" : ".player-slot",
    );
    if (!attackerEl || !defenderEl) return;
    const attacker = actorFromSlot(attackerEl, scene, target !== "enemy");
    const defender = actorFromSlot(defenderEl, scene, target === "enemy");
    if (!attacker || !defender) return;

    const scene2 = new FxScene(scene);
    scene2.add(attacker);
    scene2.add(defender);
    if (!buildMoveFx(moveId, scene2, attacker, defender)) { scene2.teardown(); return; }

    setCssAnimationRate([el], 1, { subtree: true });
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const isStatus = movesTable[canonicalMoveId(moveId)]?.category === "status";
    const impactAt = isStatus
      ? null
      : scene2.impactAt(defender) ?? Math.round(scene2.duration * 0.6);
    const run = runFx(scene2, { rate: 1, reducedMotion, impactAt });
    return () => run.cancel();
    // `animKey` is the trigger: the same move used twice in a row must replay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animKey, fx, moveId, target]);

  return (
    <div
      ref={rootRef}
      key={animKey}
      className={`move-anim${fx ? "" : ` move-anim-${archetype}`} target-${target}${shake ? " shake-screen" : ""}`}
      style={{ ["--type-color" as string]: typeColor }}
      aria-hidden
    >
      {!fx && (
      <>
      {archetype === "fire-special" && <ParticleStream className="fire-particle" count={6} />}
      {archetype === "water-special" && <ParticleStream className="water-particle" count={7} />}
      {archetype === "grass-special" && <ParticleStream className="grass-particle" count={5} />}
      {archetype === "ice-special" && <ParticleStream className="ice-particle" count={6} />}
      {archetype === "poison-special" && <ParticleStream className="poison-particle" count={5} />}
      {archetype === "bug-special" && <ParticleStream className="bug-particle" count={4} />}
      {archetype === "rock-special" && <ParticleStream className="rock-particle" count={5} />}
      {archetype === "ground-special" && <ParticleStream className="ground-particle" count={5} />}
      {archetype === "flying-special" && <ParticleStream className="flying-particle" count={4} />}
      {archetype === "normal-special" && <ParticleStream className="normal-particle" count={4} />}
      {archetype === "fighting-special" && (
        <>
          <span className="fighting-slash s1" />
          <span className="fighting-slash s2" />
          <span className="fighting-impact-star" />
        </>
      )}
      {archetype === "physical-impact" && (
        <>
          <span className="impact-slash s1" />
          <span className="impact-slash s2" />
          <span className="impact-ring" />
        </>
      )}
      {archetype === "status-aura" && (
        <>
          <span className="aura-ring r1" />
          <span className="aura-ring r2" />
          <span className="aura-sparkle s1" />
          <span className="aura-sparkle s2" />
          <span className="aura-sparkle s3" />
        </>
      )}
      {archetype === "electric-special" && (
        <>
          <span className="electric-bolt" />
          <span className="electric-flash" />
        </>
      )}
      {archetype === "psychic-special" && (
        <>
          <span className="psychic-ring r1" />
          <span className="psychic-ring r2" />
          <span className="psychic-ring r3" />
        </>
      )}
      {archetype === "ghost-special" && (
        <>
          <span className="ghost-wisp w1" />
          <span className="ghost-wisp w2" />
          <span className="ghost-wisp w3" />
        </>
      )}
      {archetype === "dragon-special" && <span className="dragon-beam" />}
      {archetype === "dark-special" && (
        <>
          <span className="dark-vignette" />
          <span className="dark-wisp w1" />
          <span className="dark-wisp w2" />
          <span className="dark-wisp w3" />
        </>
      )}
      {archetype === "hyper-beam" && (
        <>
          <span className="hyperbeam-charge" />
          <span className="hyperbeam-ray" />
          <span className="hyperbeam-impact" />
        </>
      )}
      {archetype === "solar-beam" && (
        <>
          <span className="solarbeam-charge" />
          <span className="solarbeam-ray" />
          <span className="solarbeam-impact" />
        </>
      )}
      {archetype === "explosion" && (
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
      )}
      </>
      )}
    </div>
  );
}

function ParticleStream({ className, count }: { className: string; count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className={className} />
      ))}
    </>
  );
}
