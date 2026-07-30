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

import type { EffectArchetype } from "../utils/moveEffects";

export function MoveEffectVisual({
  archetype,
  target,
  shake,
  typeColor,
  animKey,
}: {
  archetype: EffectArchetype;
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
  return (
    <div
      key={animKey}
      className={`move-anim move-anim-${archetype} target-${target}${shake ? " shake-screen" : ""}`}
      style={{ ["--type-color" as string]: typeColor }}
      aria-hidden
    >
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
