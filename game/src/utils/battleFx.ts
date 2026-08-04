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

import { FX_SPRITES } from "../data/battleFxSprites";

/** Showdown's stage. 16:9, same as `.battle-scene`. */
export const FX_W = 640;
export const FX_H = 360;

/** Depth of each slot. Showdown: `side.z = (side.isFar ? 200 : 0)`. */
export const Z_NEAR = 0;
export const Z_FAR = 200;

export interface ScenePos {
  x?: number;
  y?: number;
  z?: number;
  scale?: number;
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
  | "ballistic" | "ballisticUnder"
  | "ballistic2" | "ballistic2Back" | "ballistic2Under";

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
    case "ballisticUnder":  e.top = rising ? ballisticDown : ballisticUp; break;
    case "ballistic2":      e.top = rising ? quadUp : quadDown; break;
    // Showdown's own comment: this SHOULD be the same as ballistic2, but
    // because their `oldLoc` is the original rather than the previous
    // position, the direction has to be inferred from the destination
    // instead. Reproduced rather than "fixed" — every animation using it was
    // authored against this behaviour.
    case "ballistic2Back":  e.top = toZ > 0 ? quadUp : quadDown; break;
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
  return new FxActor(el, isFar, {
    x: (cx - anchor.left) / scale,
    y: (anchor.top - cy) / scale,
  });
}

// ── EFFECT SPRITES ────────────────────────────────────────────────────────

interface FxEffect {
  el: HTMLImageElement;
  t0: number;
  t1: number;
  from: Required<Pick<ScenePos, "x" | "y" | "z" | "scale" | "opacity">>;
  to: Required<Pick<ScenePos, "x" | "y" | "z" | "scale" | "opacity">>;
  w: number;
  h: number;
  ease: AxisEasing;
  after?: "fade" | "explode";
}

const FADE_MS = 100;

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

  /**
   * The 640×360 stage, as a real element.
   *
   * Scaled as a whole rather than per-sprite, so every `pos()` result is used
   * verbatim in px. That is what lets a ported coordinate be pasted in
   * unchanged instead of being multiplied by something at each call site.
   */
  private ensureLayer(): HTMLElement {
    if (this.layer) return this.layer;
    const px = this.el.getBoundingClientRect().width / FX_W;
    const layer = document.createElement("div");
    layer.className = "fx-layer";
    layer.style.cssText =
      `position:absolute;left:0;top:0;width:${FX_W}px;height:${FX_H}px;` +
      `transform:scale(${px});transform-origin:0 0;pointer-events:none;overflow:visible;`;
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
    name: string,
    start: ScenePos,
    end: ScenePos = {},
    transition: Transition = "linear",
    after?: "fade" | "explode",
  ): void {
    const sprite = FX_SPRITES[name];
    // A name with no vendored file behind it. Some sprites are deliberately
    // not shipped (GPL art — see public/fx/PROVENANCE.md), so this is an
    // expected path, and it must skip the sprite rather than render a broken
    // image over the battle.
    if (!sprite) return;

    const t0 = (start.time ?? 0) + this.timeOffset;
    const t1 = (end.time ?? (start.time ?? 0) + 500) + this.timeOffset;
    const merged: ScenePos = { ...start, ...end };

    const el = document.createElement("img");
    el.src = sprite.url;
    el.alt = "";
    el.setAttribute("aria-hidden", "true");
    el.draggable = false;
    el.style.cssText = "display:block;position:absolute;opacity:0";
    this.ensureLayer().appendChild(el);

    const norm = (p: ScenePos) => ({
      x: p.x ?? 0, y: p.y ?? 0, z: p.z ?? 0,
      scale: p.scale ?? 1, opacity: p.opacity ?? 1,
    });
    const from = norm(start);
    const to = norm(merged);
    this.effects.push({
      el, t0, t1, from, to, w: sprite.w, h: sprite.h,
      ease: easingsFor(transition, project(from).top, project(to).top, to.z),
      after,
    });
  }

  /** Total length of everything queued, ms. */
  get duration(): number {
    let d = 0;
    for (const a of this.actors) d = Math.max(d, a.duration);
    for (const e of this.effects) d = Math.max(d, e.t1 + (e.after ? FADE_MS : 0));
    return d;
  }

  /** Paint every effect sprite at time `t`. */
  paintEffects(t: number): void {
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
      const w = e.w * scale;
      const h = e.h * scale;
      e.el.style.left = `${left - w / 2}px`;
      e.el.style.top = `${top - h / 2}px`;
      e.el.style.width = `${w}px`;
      e.el.style.height = `${h}px`;
      e.el.style.opacity = String(Math.max(0, Math.min(1, opacity)));
    }
  }

  /** Remove the whole effect layer. Called on every exit path. */
  teardown(): void {
    this.layer?.remove();
    this.layer = null;
    this.effects.length = 0;
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
  opts: { rate?: number; reducedMotion?: boolean } = {},
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
  const guard = window.setTimeout(clear, total / rate + 60);

  const frame = (now: number) => {
    if (cancelled) return;
    const t = (now - start) * rate;
    for (const a of actors) {
      const tr = a.transformAt(Math.min(t, a.duration), pxPerUnit);
      if (tr) a.el.style.transform = tr;
    }
    scene.paintEffects(t);
    if (t >= total) { window.clearTimeout(guard); clear(); return; }
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
