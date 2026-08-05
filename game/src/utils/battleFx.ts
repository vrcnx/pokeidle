/**
 * ── POKÉMON SHOWDOWN'S BATTLE ANIMATION COORDINATE SPACE ─────────────────
 *
 * Ported from smogon/pokemon-showdown-client (MIT), `battle-animations.ts`.
 * The projection, the easing curves and the transition table below are their
 * arithmetic, reimplemented here against our DOM. Their move library is
 * written entirely against this one coordinate space, so getting it exactly
 * right is what lets a ported animation land where its author intended
 * instead of needing every offset re-tuned by hand.
 *
 *   https://github.com/smogon/pokemon-showdown-client — MIT License
 *
 * ── THE SPACE ────────────────────────────────────────────────────────────
 * A 640×360 stage, which is 16:9 — exactly our `.battle-scene` aspect ratio,
 * so the whole space maps onto our arena with a single uniform scale factor
 * and every ported coordinate works unchanged at any window size.
 *
 *   x  right is positive
 *   y  UP is positive (note: opposite to CSS)
 *   z  DEPTH. 0 is the near slot (yours), 200 is the far slot (theirs).
 *
 * Depth is the part that makes these animations read as animations rather
 * than as sprites sliding around: `z` drives scale AND position together, so
 * something moving toward the camera grows on a perspective line rather than
 * just getting bigger in place.
 *
 * ── WHY THE ACTOR ORIGINS ARE MEASURED, NOT CONSTANTS ────────────────────
 * Showdown's slots sit at fixed points in its 640×360 stage. Ours are placed
 * by CSS percentages and do not coincide — our opponent is further right. So
 * rather than hardcode an offset that a stylesheet edit would silently break,
 * the actor's origin is derived by INVERTING the projection from the slot
 * element's real measured centre. Ported offsets (`defender.behind(20)`,
 * `attacker.leftof(-30)`) are then relative to wherever the sprite actually
 * is, which is what they mean anyway.
 */

import { FX_SPRITES, type FxSprite } from "../data/battleFxSprites";

/** Showdown's stage. 16:9, same as `.battle-scene`. */
export const FX_W = 640;
export const FX_H = 360;

/** Depth of each slot. Showdown: `side.z = (side.isFar ? 200 : 0)`. */
export const Z_NEAR = 0;
export const Z_FAR = 200;

/**
 * HIT STOP — the world freezes for a moment when something connects.
 *
 * The oldest trick in action games and the single cheapest thing that makes a
 * hit feel like a hit: at the frame of contact, stop advancing time for a few
 * dozen milliseconds. The eye reads the pause as force. Without it an attack
 * is a smooth interpolation from A to B and lands with no weight at all,
 * which is most of what "the animations seem kinda bad" is describing.
 *
 * Deliberately short. Past about 90ms it stops reading as impact and starts
 * reading as the game stuttering, and this fires on every single attack.
 *
 * In REAL milliseconds, not scene time: a freeze that scaled with game speed
 * would vanish at ×5, which is exactly when the battle most needs punctuation.
 */
export const HIT_STOP_MS = 70;

export interface ScenePos {
  x?: number;
  y?: number;
  z?: number;
  scale?: number;
  /** Axis scales. Ported animations use these to stretch a sprite into a
   *  beam or flatten it into a shockwave, so they are not optional extras —
   *  without them Hyper Beam is a small circle. Default to `scale`. */
  xscale?: number;
  yscale?: number;
  opacity?: number;
  /** Duration of the move INTO this position, ms. Showdown defaults to 500. */
  time?: number;
}

/**
 * Perspective scale at a given depth.
 *
 * Showdown branches on sprite generation — `2.0 - z/200` for gen 5, and
 * `1.5 - 0.5*z/200` for everything else. Our sprites are the gen-5 animated
 * set, so this is the gen-5 line. Floored at 0.1 exactly as they do, which
 * stops a wild `z` from inverting or collapsing a sprite.
 */
export function fxScale(z: number): number {
  return Math.max(0.1, 2.0 - z / 200);
}

/** Where a point in the stage lands, as the CENTRE of whatever sits there. */
export function project(loc: ScenePos): { left: number; top: number; scale: number } {
  const z = loc.z ?? 0;
  const scale = fxScale(z);
  return {
    // 210/245 is the near slot; the two deltas are the perspective rails the
    // far slot sits on. Straight from Showdown's `pos()`.
    left: 210 + (410 - 190) * (z / 200) + (loc.x ?? 0) * scale,
    top: 245 + (135 - 245) * (z / 200) - (loc.y ?? 0) * scale,
    scale: scale * (loc.scale ?? 1),
  };
}

// ── EASINGS ───────────────────────────────────────────────────────────────
// Showdown's four custom curves verbatim, plus linear and jQuery's `swing`.
// `ballisticUp` is the one that matters most: it is the arc a Pokémon travels
// when it throws itself at the other one.
type Easing = (x: number) => number;

const linear: Easing = (x) => x;
const swing: Easing = (x) => 0.5 - Math.cos(x * Math.PI) / 2;
const ballisticUp: Easing = (x) => -3 * x * x + 4 * x;
const ballisticDown: Easing = (x) => {
  const i = 1 - x;
  return 1 - (-3 * i * i + 4 * i);
};
const quadUp: Easing = (x) => {
  const i = 1 - x;
  return 1 - i * i;
};
const quadDown: Easing = (x) => x * x;

/** Per-axis easings. Showdown eases `left` and `top` SEPARATELY — that split
 *  is the whole trick behind a ballistic arc, and it is also why this cannot
 *  be handed to a tweening library as one `transform` property. */
interface AxisEasing {
  left: Easing;
  top: Easing;
  scale: Easing;
}

export type Transition =
  | "linear" | "swing" | "accel" | "decel"
  | "ballistic" | "ballisticUp" | "ballisticUnder"
  | "ballistic2" | "ballistic2Back" | "ballistic2back" | "ballistic2Under";

function easingsFor(
  transition: Transition,
  fromTop: number,
  toTop: number,
  toZ: number,
): AxisEasing {
  const e: AxisEasing = { left: linear, top: linear, scale: linear };
  const rising = toTop < fromTop;
  switch (transition) {
    case "ballistic":       e.top = rising ? ballisticUp : ballisticDown; break;
    // Named explicitly rather than chosen by direction — a few of their
    // animations want the arc up whichever way the sprite is travelling.
    case "ballisticUp":     e.top = ballisticUp; break;
    case "ballisticUnder":  e.top = rising ? ballisticDown : ballisticUp; break;
    case "ballistic2":      e.top = rising ? quadUp : quadDown; break;
    // Showdown's own comment: this SHOULD be the same as ballistic2, but
    // because their `oldLoc` is the original rather than the previous
    // position, the direction has to be inferred from the destination
    // instead. Reproduced rather than "fixed" — every animation using it was
    // authored against this behaviour.
    // `ballistic2back` is their own typo, used in a handful of animations.
    // Honoured rather than corrected: the alternative is those moves falling
    // through to linear, which is silently worse than reproducing the spelling.
    case "ballistic2Back":
    case "ballistic2back":  e.top = toZ > 0 ? quadUp : quadDown; break;
    case "ballistic2Under": e.top = rising ? quadDown : quadUp; break;
    case "swing":           e.left = e.top = e.scale = swing; break;
    case "accel":           e.left = e.top = e.scale = quadDown; break;
    case "decel":           e.left = e.top = e.scale = quadUp; break;
    case "linear":          break;
  }
  return e;
}

// ── ACTORS ────────────────────────────────────────────────────────────────

interface Step {
  at: number;
  dur: number;
  from: Required<Pick<ScenePos, "x" | "y" | "z" | "scale">>;
  to: Required<Pick<ScenePos, "x" | "y" | "z" | "scale">>;
  ease: AxisEasing;
}

/**
 * One of the two Pokémon on the field, as a move animation sees it.
 *
 * `anim()` and `delay()` build a queue rather than starting anything: a
 * ported animation reads as a script of consecutive moves, and running each
 * one eagerly would fire them all at once.
 */
export class FxActor {
  readonly isFar: boolean;
  readonly el: HTMLElement;
  /** Resting position — the sprite's real CSS placement, in stage units. */
  readonly base: { x: number; y: number; z: number };
  private cur: { x: number; y: number; z: number; scale: number };
  private cursor = 0;
  readonly steps: Step[] = [];

  constructor(el: HTMLElement, isFar: boolean, base: { x: number; y: number }) {
    this.el = el;
    this.isFar = isFar;
    this.base = { ...base, z: isFar ? Z_FAR : Z_NEAR };
    this.cur = { ...this.base, scale: 1 };
  }

  get x() { return this.base.x; }
  get y() { return this.base.y; }
  get z() { return this.base.z; }

  /**
   * This Pokémon's own sprite, as something `showEffect` can draw.
   *
   * Named `sp` because that is what the ported animations call it, and they
   * use it two ways: to size an effect against how big the Pokémon is, and —
   * the good one — to draw a COPY of the Pokémon itself. That is how Quick
   * Attack ghosts and Double Team splits: the after-image is the sprite,
   * shown again at a lower opacity somewhere else on the field.
   *
   * Measured from the slot, so it needs no sprite-sheet data of its own.
   */
  sp: FxSprite = { url: "", w: 96, h: 96 };

  // Showdown's relative helpers. Each flips sign for the far side so that
  // "behind" means away from the camera for both Pokémon rather than
  // meaning "further right" for one of them.
  behind(offset: number) { return this.base.z + (this.isFar ? 1 : -1) * offset; }
  leftof(offset: number) { return this.base.x + (this.isFar ? 1 : -1) * offset; }
  above(offset: number)  { return this.base.y + (this.isFar ? -1 : 1) * offset; }

  delay(ms: number): this {
    this.cursor += ms;
    return this;
  }

  anim(to: ScenePos, transition: Transition = "linear"): this {
    const dur = to.time ?? 500;
    // An `anim` with no x/y/z returns to REST, which is how every ported
    // recovery step is written (`attacker.anim({time: 500}, 'ballistic2Back')`).
    const next = {
      x: to.x ?? this.base.x,
      y: to.y ?? this.base.y,
      z: to.z ?? this.base.z,
      scale: to.scale ?? 1,
    };
    const from = this.cur;
    this.steps.push({
      at: this.cursor,
      dur,
      from,
      to: next,
      ease: easingsFor(transition, project(from).top, project(next).top, next.z),
    });
    this.cur = next;
    this.cursor += dur;
    return this;
  }

  /** The transform for this actor at time `t`, or null if it is at rest. */
  transformAt(t: number, pxPerUnit: number): string | null {
    let active: Step | null = null;
    for (const s of this.steps) {
      if (t >= s.at) active = s;      // steps are pushed in order
    }
    if (!active) return null;
    const raw = active.dur > 0 ? Math.min(1, (t - active.at) / active.dur) : 1;
    const p0 = project(active.from);
    const p1 = project(active.to);
    const pb = project(this.base);
    const left  = p0.left  + (p1.left  - p0.left)  * active.ease.left(raw);
    const top   = p0.top   + (p1.top   - p0.top)   * active.ease.top(raw);
    const scale = p0.scale + (p1.scale - p0.scale) * active.ease.scale(raw);
    const dx = (left - pb.left) * pxPerUnit;
    const dy = (top - pb.top) * pxPerUnit;
    const s = scale / pb.scale;
    return `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px) scale(${s.toFixed(4)})`;
  }

  get duration(): number {
    return this.steps.reduce((m, s) => Math.max(m, s.at + s.dur), 0);
  }
}

/**
 * Build an actor from a slot element by INVERTING the projection.
 *
 * `project()` is affine in x and y once z is fixed, so the origin that puts
 * this sprite exactly where CSS already put it solves in closed form. Doing
 * it this way means the ported animations track our layout instead of
 * assuming Showdown's.
 */
export function actorFromSlot(
  el: HTMLElement,
  scene: HTMLElement,
  isFar: boolean,
): FxActor | null {
  const s = scene.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (!s.width || !r.width) return null;
  const pxPerUnit = s.width / FX_W;
  // ── ANCHORED AT THE SLOT'S CENTRE, NOT ITS FEET ────────────────────
  // Showdown's `pos()` resolves y to the sprite's middle (it subtracts
  // hoffset/2 to centre it), so every `defender.y + 80` in the library is an
  // offset from a CENTRE. Measuring ours at the feet instead silently added
  // half a sprite-height to every vertical offset in every ported animation.
  //
  // The check that this is right: with centres, our player slot solves to
  // y ≈ 0 and z = 0 — which is exactly Showdown's own near-sprite position.
  // Our arena and theirs agree on where the near Pokémon stands.
  const cx = (r.left + r.width / 2 - s.left) / pxPerUnit;
  const cy = (r.top + r.height / 2 - s.top) / pxPerUnit;
  const z = isFar ? Z_FAR : Z_NEAR;
  const scale = fxScale(z);
  const anchor = project({ z });
  const actor = new FxActor(el, isFar, {
    x: (cx - anchor.left) / scale,
    y: (anchor.top - cy) / scale,
  });
  // In stage units, undoing the perspective scale so `sp.w` means the same
  // thing for both Pokémon regardless of which slot they are standing in.
  // The url is the slot's own <img>, which is what makes an after-image an
  // image of the Pokémon rather than a generic blob.
  const img = el.querySelector("img");
  actor.sp = {
    url: img?.getAttribute("src") ?? "",
    w: r.width / pxPerUnit / scale,
    h: r.height / pxPerUnit / scale,
  };
  return actor;
}

// ── EFFECT SPRITES ────────────────────────────────────────────────────────

type FxPos = Required<Pick<ScenePos, "x" | "y" | "z" | "scale" | "xscale" | "yscale" | "opacity">>;

interface FxEffect {
  el: HTMLElement;
  t0: number;
  t1: number;
  from: FxPos;
  to: FxPos;
  w: number;
  h: number;
  ease: AxisEasing;
  after?: "fade" | "explode";
  /** Drawn only at the moment of contact — used to locate the hit. */
  isImpact: boolean;
}

const FADE_MS = 100;

/**
 * Effects that are LIGHT, and so must be composited additively.
 *
 * ── THE BIGGEST SINGLE THING WRONG WITH THESE ANIMATIONS ─────────────────
 * Fire, lightning and energy emit light. Drawn with ordinary alpha they are
 * pasted ON TOP of the arena — a semi-transparent orange PNG sitting over the
 * background, which is exactly what "looks like a sticker" means. Composited
 * with `screen`, the dark parts of the sprite drop out and the bright parts
 * add to what is behind them, so a fireball lights the scene instead of
 * covering it.
 *
 * It is per-sprite and not a blanket rule on the layer, because half of these
 * are the opposite: Shadow Ball, the dark wisps and the poison clouds are
 * DARK effects, and `screen` would erase them completely — a black sprite
 * screened over anything is invisible. Those keep normal compositing, which
 * is what makes them read as a void rather than a glow.
 */
const LUMINOUS: ReadonlySet<string> = new Set([
  "fireball", "bluefireball", "flareball", "electroball", "energyball",
  "iceball", "mistball", "wisp", "waterwisp", "moon", "shine", "rainbow",
  "hitmark", "impact", "gear", "greenmetal1", "greenmetal2",
  "leftslash", "rightslash", "leftclaw", "rightclaw", "leftchop", "rightchop",
  "fist", "fist1", "foot", "sword", "stare", "petal", "feather",
]);

/**
 * The stage a move animation is drawn on.
 *
 * Holds the two Pokémon and every effect sprite, so one runner drives them
 * off one clock. A ported animation is written as a sequence of `showEffect`
 * calls plus actor moves, and the two have to share a timeline or the impact
 * lands on a sprite that has not arrived.
 */
export class FxScene {
  readonly el: HTMLElement;
  readonly actors: FxActor[] = [];
  readonly effects: FxEffect[] = [];
  private layer: HTMLElement | null = null;
  /** Showdown's `scene.wait()` — shifts everything queued after it. */
  private timeOffset = 0;

  constructor(el: HTMLElement) {
    this.el = el;
  }

  wait(ms: number): void {
    this.timeOffset += ms;
  }

  add(actor: FxActor): FxActor {
    this.actors.push(actor);
    return actor;
  }

  /** Arena pixels per stage unit. Measured once, when the layer is created. */
  private px = 1;

  /**
   * The stage, as a real element.
   *
   * ── DELIBERATELY NOT `transform: scale()` ────────────────────────────
   * Scaling the whole layer was the obvious way to keep every `pos()` result
   * usable verbatim in px, and it silently broke additive blending:
   * `mix-blend-mode` composites against the backdrop WITHIN the current
   * stacking context, and a `transform` creates one. So every luminous
   * effect would have been screening against an empty transparent layer —
   * blending with nothing, which looks identical to not blending at all.
   *
   * The layer therefore has no transform, no z-index and no opacity, so it
   * forms no stacking context of its own and a fireball composites against
   * the arena behind it. The stage-to-pixel scale moved into `paintEffects`,
   * which costs one multiply per property per frame.
   */
  private ensureLayer(): HTMLElement {
    if (this.layer) return this.layer;
    this.px = this.el.getBoundingClientRect().width / FX_W || 1;
    const layer = document.createElement("div");
    layer.className = "fx-layer";
    layer.style.cssText =
      "position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;";
    this.el.appendChild(layer);
    this.layer = layer;
    return layer;
  }

  /**
   * Ported from Showdown's `showEffect` / `animateEffect`.
   *
   * `time` on start and end is ABSOLUTE within the animation, not a duration
   * — that is the part most likely to be mis-read, and getting it wrong turns
   * a choreographed sequence into everything firing at once. `end` inherits
   * every field `start` set, so a ported call that only changes opacity does
   * not silently reset the position to the origin.
   */
  showEffect(
    effect: string | FxSprite,
    start: ScenePos,
    end: ScenePos = {},
    transition: Transition = "linear",
    after?: "fade" | "explode",
  ): void {
    // A sprite object rather than a name is an actor's own `sp` — the
    // after-image trick. Nothing to look up; it already knows its art.
    const sprite = typeof effect === "string" ? FX_SPRITES[effect] : effect;
    // A name with no vendored file behind it. Some sprites are deliberately
    // not shipped (GPL art — see public/fx/PROVENANCE.md), so this is an
    // expected path, and it must skip the sprite rather than render a broken
    // image over the battle. An actor with no resolvable sprite url is the
    // same case.
    if (!sprite || !sprite.url) return;

    const t0 = (start.time ?? 0) + this.timeOffset;
    const t1 = (end.time ?? (start.time ?? 0) + 500) + this.timeOffset;
    const merged: ScenePos = { ...start, ...end };

    const el = document.createElement("img");
    el.src = sprite.url;
    el.alt = "";
    el.setAttribute("aria-hidden", "true");
    el.draggable = false;
    const lit = typeof effect === "string" && LUMINOUS.has(effect);
    el.style.cssText =
      "display:block;position:absolute;opacity:0" +
      (lit ? ";mix-blend-mode:screen" : "");
    this.ensureLayer().appendChild(el);

    const norm = (p: ScenePos): FxPos => ({
      x: p.x ?? 0, y: p.y ?? 0, z: p.z ?? 0,
      scale: p.scale ?? 1,
      xscale: p.xscale ?? p.scale ?? 1,
      yscale: p.yscale ?? p.scale ?? 1,
      opacity: p.opacity ?? 1,
    });
    const from = norm(start);
    const to = norm(merged);
    this.effects.push({
      el, t0, t1, from, to, w: sprite.w, h: sprite.h,
      ease: easingsFor(transition, project(from).top, project(to).top, to.z),
      after,
      isImpact: effect === "impact" || effect === "hitmark",
    });
  }

  /**
   * A full-stage colour wash — ported from Showdown's `backgroundEffect`.
   *
   * This is what makes a big move feel big: Blizzard whitens the arena,
   * Dark Pulse blackens it, Solar Beam floods it yellow. 218 of their move
   * animations call it, so without it a fifth of the library either could
   * not be ported or would arrive missing its most visible half.
   *
   * Fades in over 250ms, holds, fades out over 250ms — their timing.
   */
  backgroundEffect(background: string, duration: number, opacity = 1, delay = 0): void {
    const el = document.createElement("div");
    el.setAttribute("aria-hidden", "true");
    el.style.cssText =
      `position:absolute;inset:0;pointer-events:none;opacity:0;background:${background};`;
    this.ensureLayer().appendChild(el);
    this.backgrounds.push({
      el,
      t0: delay + this.timeOffset,
      t1: delay + duration + this.timeOffset,
      opacity,
    });
  }

  private readonly backgrounds: {
    el: HTMLElement; t0: number; t1: number; opacity: number;
  }[] = [];

  /**
   * When the hit lands, in scene time — or null if this animation has no
   * moment of contact (a self-buff, a weather change).
   *
   * ── WHY THE ENGINE HAS TO GUESS THIS ─────────────────────────────────
   * Showdown's animations do not mark their impact frame; there is no field
   * for it, because their renderer never needed one. Ours does, for hit-stop.
   * So it is inferred, in falling order of reliability:
   *
   *   1. The defender's first movement. If a Pokémon is knocked backwards,
   *      that IS the impact — it is what the animation's author timed the
   *      recoil to.
   *   2. The first `impact` or `hitmark` sprite, drawn for exactly this
   *      purpose and nothing else.
   *   3. The first moment something ARRIVES at the defender. Most special
   *      moves have neither of the above — Showdown's Flamethrower does not
   *      move the target and draws no impact mark — so without this the hit
   *      stop only fired on contact attacks, which is most of the value
   *      missing. A projectile whose destination is the defender has landed
   *      when it gets there.
   *   4. Nothing. A move that never reaches the other Pokémon is a self-buff
   *      or a weather change, and freezing the world for it would be wrong.
   */
  impactAt(defender: FxActor): number | null {
    const recoil = defender.steps[0];
    if (recoil) return recoil.at;

    let mark = Infinity;
    let arrival = Infinity;
    // Generous, because "at the defender" is judged in stage units and a
    // projectile is allowed to land slightly short or wide of dead centre.
    const NEAR = 45;
    for (const e of this.effects) {
      if (e.isImpact) mark = Math.min(mark, e.t0);
      const near =
        Math.abs(e.to.x - defender.x) < NEAR &&
        Math.abs(e.to.y - defender.y) < NEAR &&
        Math.abs(e.to.z - defender.z) < NEAR;
      // Only count something that actually TRAVELLED there. An effect that
      // starts and ends on the defender is an aura, not a hit.
      //
      // `y` counts as travel, and has to: Thunderbolt and Ice Beam come DOWN
      // onto the target rather than across at it, so their start and end share
      // an x and a z. Testing only the horizontal plane silently excluded
      // every falling move.
      const travelled =
        Math.abs(e.from.x - e.to.x) > NEAR ||
        Math.abs(e.from.z - e.to.z) > NEAR ||
        Math.abs(e.from.y - e.to.y) > NEAR;
      if (near && travelled) arrival = Math.min(arrival, e.t1);
    }
    const best = Math.min(mark, arrival);
    return Number.isFinite(best) ? best : null;
  }

  /** Total length of everything queued, ms. */
  get duration(): number {
    let d = 0;
    for (const a of this.actors) d = Math.max(d, a.duration);
    for (const e of this.effects) d = Math.max(d, e.t1 + (e.after ? FADE_MS : 0));
    for (const b of this.backgrounds) d = Math.max(d, b.t1);
    return d;
  }

  /** Paint every effect sprite at time `t`. */
  paintEffects(t: number): void {
    const RAMP = 250; // Showdown's fade in/out, both ends.
    for (const b of this.backgrounds) {
      let o = 0;
      if (t >= b.t0 && t <= b.t1) {
        const inT = Math.min(1, (t - b.t0) / RAMP);
        const outT = Math.min(1, Math.max(0, (b.t1 - t) / RAMP));
        o = b.opacity * Math.min(inT, outT);
      }
      b.el.style.opacity = String(o);
    }
    for (const e of this.effects) {
      if (t < e.t0) { e.el.style.opacity = "0"; continue; }
      const span = e.t1 - e.t0;
      const raw = span > 0 ? Math.min(1, (t - e.t0) / span) : 1;
      const p0 = project(e.from);
      const p1 = project(e.to);
      let scale = p0.scale + (p1.scale - p0.scale) * e.ease.scale(raw);
      let opacity = e.from.opacity + (e.to.opacity - e.from.opacity) * raw;
      // The tail, after the main move has landed.
      if (t > e.t1 && e.after) {
        const tail = Math.min(1, (t - e.t1) / FADE_MS);
        opacity *= 1 - tail;
        if (e.after === "explode") scale *= 1 + 2 * tail; // ×3 by the end
      }
      const left = p0.left + (p1.left - p0.left) * e.ease.left(raw);
      const top = p0.top + (p1.top - p0.top) * e.ease.top(raw);
      // Axis scales ride on top of the perspective scale, which is what lets
      // a ported animation stretch one sprite into a beam.
      const es = e.ease.scale(raw);
      const xs = e.from.xscale + (e.to.xscale - e.from.xscale) * es;
      const ys = e.from.yscale + (e.to.yscale - e.from.yscale) * es;
      const base = scale / (e.from.scale + (e.to.scale - e.from.scale) * es || 1);
      const w = e.w * base * xs;
      const h = e.h * base * ys;
      // Stage units -> arena pixels here, because the layer cannot carry a
      // transform without isolating the blend. See ensureLayer.
      const k = this.px;
      e.el.style.left = `${(left - w / 2) * k}px`;
      e.el.style.top = `${(top - h / 2) * k}px`;
      e.el.style.width = `${w * k}px`;
      e.el.style.height = `${h * k}px`;
      e.el.style.opacity = String(Math.max(0, Math.min(1, opacity)));
    }
  }

  /** Remove the whole effect layer. Called on every exit path. */
  teardown(): void {
    this.layer?.remove();
    this.layer = null;
    this.effects.length = 0;
    this.backgrounds.length = 0;
  }
}

/**
 * Run a built animation.
 *
 * ── IT MUST NEVER LEAVE A SPRITE DISPLACED ───────────────────────────────
 * The transform is inline and additive over CSS, so the only correct end
 * state is removing it. That happens on completion, on cancel, and if the
 * caller is torn down mid-flight — a Pokémon left translated 200px into the
 * opponent's corner because a tab was backgrounded is a far worse bug than a
 * missing flourish, and this is exactly the shape of thing that produces it.
 *
 * Speed-scaled by `rate` for the same reason everything else in the battle
 * scene is: at ×5 the whole game is faster and an animation that is not
 * scaled has to be cut off instead.
 */
export function runFx(
  scene: FxScene,
  opts: { rate?: number; reducedMotion?: boolean; impactAt?: number | null } = {},
): { cancel: () => void } {
  const actors = scene.actors;
  const clear = () => {
    for (const a of actors) {
      a.el.style.transform = "";
      a.el.classList.remove("fx-lunging");
    }
    scene.teardown();
  };
  const total = scene.duration;
  if (opts.reducedMotion || total === 0) {
    clear();
    return { cancel: clear };
  }

  const pxPerUnit = scene.el.getBoundingClientRect().width / FX_W;
  const rate = opts.rate && opts.rate > 0 ? opts.rate : 1;
  // The lunging sprite has to come forward. Our own slot already sits above
  // the effect layer; the opponent's sits below it, so without this the
  // enemy attacking you slides UNDER its own impact effect.
  for (const a of actors) {
    if (a.steps.length) a.el.classList.add("fx-lunging");
  }

  let raf = 0;
  let cancelled = false;
  const start = performance.now();

  // ── THE TIMER IS THE ONE THAT GUARANTEES CLEANUP ────────────────────
  // requestAnimationFrame does NOT fire in a tab that is not compositing —
  // backgrounded, occluded, or a hidden preview pane. Relying on the rAF loop
  // to reach its own end and call clear() therefore strands the sprite
  // mid-lunge until something else re-renders it, which is the exact failure
  // this file's header warns about. (Found by running it in a non-visible
  // tab, where every frame reported "rest" and the transform never lifted.)
  //
  // Same resolution as animateModalExit: a wall-clock timer owns the ending,
  // the animation only owns the in-between. `rate` scales game time, so the
  // real elapsed time is total/rate.
  const impactAt = opts.impactAt ?? null;
  const stopMs = impactAt == null || opts.reducedMotion ? 0 : HIT_STOP_MS;
  const guard = window.setTimeout(clear, total / rate + stopMs + 60);

  // Scene time is ACCUMULATED rather than derived from (now - start), because
  // the hit stop has to remove a slice of real time from it. Deriving it
  // would make the animation jump forward the instant the freeze ended,
  // skipping exactly the frames the freeze was meant to draw attention to.
  let sceneT = 0;
  let last = start;
  let frozenUntil = 0;
  let hasFrozen = false;

  const frame = (now: number) => {
    if (cancelled) return;
    const dt = now - last;
    last = now;
    if (now >= frozenUntil) sceneT += dt * rate;
    if (!hasFrozen && impactAt != null && sceneT >= impactAt && stopMs > 0) {
      hasFrozen = true;
      frozenUntil = now + stopMs;
    }
    for (const a of actors) {
      const tr = a.transformAt(Math.min(sceneT, a.duration), pxPerUnit);
      if (tr) a.el.style.transform = tr;
    }
    scene.paintEffects(sceneT);
    if (sceneT >= total) { window.clearTimeout(guard); clear(); return; }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return {
    cancel: () => {
      cancelled = true;
      window.clearTimeout(guard);
      cancelAnimationFrame(raf);
      clear();
    },
  };
}
