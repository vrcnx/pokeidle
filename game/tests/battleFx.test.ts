// The battle-FX coordinate space, ported from Pokémon Showdown (MIT).
//
// Showdown's entire move library — 38,000 lines of it — is written against
// this projection. Every ported animation's offsets are meaningless if the
// projection is off, and the failure mode is not a crash: it is 173 moves
// that all play in subtly the wrong place, discovered one at a time by eye.
// So the arithmetic is pinned against Showdown's own numbers here, before
// anything is ported on top of it.
//
// The other thing pinned is the invariant that matters more than any of the
// visuals: an animation must never leave a sprite displaced. The transform is
// inline and additive over CSS, so a script whose last step does not return
// to rest strands a Pokémon in the opponent's corner for the rest of the
// battle.

import { describe, expect, it } from "vitest";
import {
  FX_W, FX_H, Z_NEAR, Z_FAR,
  FxActor, actorFromSlot, fxScale, project,
} from "../src/utils/battleFx";
import { buildMoveMotion, contactAttack, isContactMove } from "../src/utils/battleFxMoves";

/** A stand-in for a DOM element with a known box. The game suite is node-env
 *  with no DOM, and the only thing actorFromSlot reads is the rect. */
const box = (left: number, top: number, width: number, height: number) =>
  ({
    getBoundingClientRect: () => ({
      left, top, width, height, right: left + width, bottom: top + height,
    }),
    style: {} as CSSStyleDeclaration,
    classList: { add() {}, remove() {} },
    // actorFromSlot reads the slot's <img> so an after-image can be a picture
    // of the Pokémon. A slot with no sprite yet is a real state (mid-swap).
    querySelector: () => null,
  }) as unknown as HTMLElement;

describe("the stage matches Showdown's", () => {
  it("is 640×360, which is 16:9 — the same shape as .battle-scene", () => {
    // This is why one uniform scale factor is enough and no coordinate needs
    // re-tuning: their stage and our arena are the same rectangle.
    expect(FX_W / FX_H).toBeCloseTo(16 / 9);
  });

  it("puts the near slot at z 0 and the far slot at z 200", () => {
    // Showdown: `side.z = (side.isFar ? 200 : 0)`.
    expect(Z_NEAR).toBe(0);
    expect(Z_FAR).toBe(200);
  });
});

describe("the projection reproduces Showdown's arithmetic", () => {
  it("uses the gen-5 scale line, because our sprites are the gen-5 set", () => {
    // `2.0 - z/200`, not the `1.5 - 0.5*z/200` used for other generations.
    // Picking the wrong branch halves every distance in the far half.
    expect(fxScale(0)).toBe(2);
    expect(fxScale(200)).toBe(1);
    expect(fxScale(100)).toBe(1.5);
  });

  it("floors the scale so a wild z cannot invert or collapse a sprite", () => {
    expect(fxScale(10_000)).toBe(0.1);
    expect(fxScale(-10_000)).toBeGreaterThan(0);
  });

  it("lands the two slot anchors exactly where Showdown lands them", () => {
    expect(project({ z: 0 })).toMatchObject({ left: 210, top: 245, scale: 2 });
    expect(project({ z: 200 })).toMatchObject({ left: 430, top: 135, scale: 1 });
  });

  it("treats y as UP, opposite to CSS", () => {
    // Getting this backwards flips every arc in the library into the floor.
    expect(project({ y: 50, z: 0 }).top).toBeLessThan(project({ z: 0 }).top);
  });

  it("scales x and y by depth, so distance shrinks with perspective", () => {
    const near = project({ x: 100, z: 0 }).left - project({ z: 0 }).left;
    const far = project({ x: 100, z: 200 }).left - project({ z: 200 }).left;
    expect(near).toBe(200); // ×2 at the near slot
    expect(far).toBe(100);  // ×1 at the far slot
    expect(near).toBeGreaterThan(far);
  });
});

describe("actor origins are measured from the real slots", () => {
  // Our slots are placed by CSS percentages and do NOT sit where Showdown's
  // do. Inverting the projection from the measured centre is what makes a
  // ported offset land relative to where the sprite actually is.
  const scene = box(0, 0, 1280, 720); // a 2× stage
  const enemySlot = box(940, 100, 200, 200);

  it("round-trips: projecting the derived origin returns the slot's centre", () => {
    const a = actorFromSlot(enemySlot, scene, true)!;
    expect(a).toBeTruthy();
    const p = project(a.base);
    // Stage units, so px/2 here (the scene is a 2× stage). The slot spans
    // x 940–1140 and y 100–300, so its centre is (1040, 200).
    expect(p.left).toBeCloseTo(1040 / 2, 5);
    expect(p.top).toBeCloseTo(200 / 2, 5);
  });

  it("anchors at the centre, matching what Showdown's y offsets mean", () => {
    // Their pos() resolves y to the sprite's middle, so every `defender.y +
    // N` in the library is an offset from a CENTRE. Measuring at the feet
    // instead adds half a sprite-height to every vertical offset in every
    // ported animation — with our 58%-tall player slot that threw the
    // attacker 85% off the top of the arena on a plain Tackle.
    const tall = box(0, 0, 100, 400);   // centre y = 200, feet = 400
    const a = actorFromSlot(tall, scene, false)!;
    expect(project(a.base).top).toBeCloseTo(200 / 2, 5);
  });

  it("gives the far actor depth 200 and the near actor depth 0", () => {
    expect(actorFromSlot(enemySlot, scene, true)!.z).toBe(200);
    expect(actorFromSlot(enemySlot, scene, false)!.z).toBe(0);
  });

  it("refuses a scene that has not been laid out yet", () => {
    // Zero-width means the arena is not on screen. Dividing by it produces
    // Infinity coordinates and a sprite flung out of the document.
    expect(actorFromSlot(enemySlot, box(0, 0, 0, 0), true)).toBeNull();
  });
});

describe("the relative helpers flip for the far side", () => {
  // `behind` has to mean "away from the camera" for BOTH Pokémon. Without
  // the sign flip it means "further right" for one of them and every ported
  // knockback pushes the wrong way.
  const near = new FxActor(box(0, 0, 10, 10), false, { x: 0, y: 0 });
  const far = new FxActor(box(0, 0, 10, 10), true, { x: 0, y: 0 });

  it("pushes the near actor toward the camera and the far one away", () => {
    expect(near.behind(20)).toBeLessThan(near.z);
    expect(far.behind(20)).toBeGreaterThan(far.z);
  });

  it("mirrors leftof and above too", () => {
    expect(near.leftof(20)).toBe(-20);
    expect(far.leftof(20)).toBe(20);
    expect(near.above(20)).toBe(20);
    expect(far.above(20)).toBe(-20);
  });
});

describe("a script always returns its sprites to rest", () => {
  // THE invariant. The transform is inline and additive over CSS layout, so
  // an animation that ends anywhere but rest leaves a Pokémon standing in
  // the wrong place for the remainder of the battle.
  const make = () => ({
    attacker: new FxActor(box(0, 0, 10, 10), false, { x: -12, y: 0 }),
    defender: new FxActor(box(0, 0, 10, 10), true, { x: 69, y: 12 }),
  });

  it("ends contactattack with both actors back at their origin", () => {
    const { attacker, defender } = make();
    contactAttack(attacker, defender);
    for (const a of [attacker, defender]) {
      const last = a.steps[a.steps.length - 1];
      expect(last.to.x, "x").toBeCloseTo(a.base.x);
      expect(last.to.y, "y").toBeCloseTo(a.base.y);
      expect(last.to.z, "z").toBeCloseTo(a.base.z);
      expect(last.to.scale, "scale").toBe(1);
    }
  });

  it("reports no transform before the script starts", () => {
    const { attacker, defender } = make();
    contactAttack(attacker, defender);
    // The defender waits out the approach — it must not twitch at t=0.
    expect(defender.transformAt(0, 1)).toBeNull();
  });

  it("is back at the origin at the final frame", () => {
    const { attacker, defender } = make();
    contactAttack(attacker, defender);
    for (const a of [attacker, defender]) {
      const tr = a.transformAt(a.duration, 1)!;
      expect(tr).toMatch(/translate\(-?0\.00px, -?0\.00px\) scale\(1\.0000\)/);
    }
  });
});

describe("contactattack reads as a hit, not as two sprites drifting", () => {
  const attacker = new FxActor(box(0, 0, 10, 10), false, { x: -12, y: 0 });
  const defender = new FxActor(box(0, 0, 10, 10), true, { x: 69, y: 12 });
  contactAttack(attacker, defender);

  it("travels the attacker to the defender before recoiling it", () => {
    // The approach is the first step and it genuinely crosses the field.
    const approach = attacker.steps[0];
    expect(Math.abs(approach.to.x - defender.x)).toBeLessThan(1);
    expect(approach.to.z).toBe(defender.behind(-30));
  });

  it("times the defender's recoil to the contact frame", () => {
    // The attacker's 400ms arc is followed by a 100ms snap onto the target;
    // the defender's knockback starts at 450ms, inside that snap. This delay
    // is the entire difference between a hit and a near-miss.
    const contactStart = attacker.steps[0].dur;               // 400
    const contactEnd = contactStart + attacker.steps[1].dur;  // 500
    const recoilStart = defender.steps[0].at;                 // 450
    expect(recoilStart).toBeGreaterThanOrEqual(contactStart);
    expect(recoilStart).toBeLessThanOrEqual(contactEnd);
  });

  it("knocks the defender backwards, not forwards", () => {
    expect(defender.steps[0].to.z).toBe(defender.behind(20));
    expect(defender.steps[0].to.z).toBeGreaterThan(defender.z); // far side: away
  });

  it("arcs rather than sliding — the vertical easing is not linear", () => {
    // A ballistic approach eased linearly is a sprite sliding diagonally,
    // which is what makes cheap animations look cheap.
    const approach = attacker.steps[0];
    expect(approach.ease.top(0.5)).not.toBeCloseTo(0.5, 2);
    expect(approach.ease.left(0.5)).toBeCloseTo(0.5, 5); // horizontal IS linear
  });
});

describe("which moves get motion", () => {
  it("moves the attacker for a contact move", () => {
    const a = new FxActor(box(0, 0, 10, 10), false, { x: 0, y: 0 });
    const d = new FxActor(box(0, 0, 10, 10), true, { x: 0, y: 0 });
    expect(buildMoveMotion("tackle", a, d)).toBe(true);
    expect(a.steps.length).toBeGreaterThan(0);
  });

  it("leaves the attacker planted for a non-contact physical move", () => {
    // Earthquake is the ground erupting under them. Lunging would be absurd.
    const a = new FxActor(box(0, 0, 10, 10), false, { x: 0, y: 0 });
    const d = new FxActor(box(0, 0, 10, 10), true, { x: 0, y: 0 });
    expect(buildMoveMotion("earthquake", a, d)).toBe(false);
    expect(a.steps).toHaveLength(0);
  });

  it("does not lunge on special or status moves", () => {
    expect(isContactMove("flamethrower")).toBe(false);
    expect(isContactMove("growl")).toBe(false);
  });

  it("defaults an unlisted physical move to contact, which is the safe way round", () => {
    // Our move table carries no contact flag, so the list is of EXCEPTIONS.
    // Most physical moves are contact, so an omission gets the right
    // animation rather than the wrong one.
    expect(isContactMove("scratch")).toBe(true);
    expect(isContactMove("bodySlam")).toBe(true);
  });

  it("makes a priority move visibly faster, not just nominally", () => {
    // A move whose entire flavour is speed playing the standard one-second
    // arc contradicts its own description.
    const mk = () => {
      const a = new FxActor(box(0, 0, 10, 10), false, { x: 0, y: 0 });
      const d = new FxActor(box(0, 0, 10, 10), true, { x: 0, y: 0 });
      return { a, d };
    };
    const quick = mk();
    buildMoveMotion("quickAttack", quick.a, quick.d);
    const normal = mk();
    buildMoveMotion("tackle", normal.a, normal.d);
    expect(quick.a.duration).toBeLessThan(normal.a.duration);
  });

  it("resolves a move id in either spelling", () => {
    // levelUpMoves spells the same move camelCase for gen 1 species and flat
    // lowercase for gen 2 ones — see canonicalMoveId.
    expect(isContactMove("quickAttack")).toBe(isContactMove("quickattack"));
  });
});
