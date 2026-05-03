// Animation helpers built on anime.js v4. Kept thin so call-sites stay
// declarative — components import the helper that matches the moment
// (modal mount, list reveal, value tick) and pass a ref or selector.
//
// Why a helper module instead of inline anime() calls?
//   1. One place to standardize timing/easing → consistent feel.
//   2. Hooks centralize the cleanup pattern (cancel running animations
//      on unmount) so we don't leak.
//   3. Lets us swap the engine later without hunting through the app.

import { createElement, useEffect, useRef } from "react";
import { animate, stagger, utils, type JSAnimation } from "animejs";

const SPRING_OUT = "out(3)";
const EASE_OUT = "outQuad";

// Mount-entrance for a centered modal dialog. Plays a quick fade-in on
// the overlay (selector relative to document) and a spring scale-up on
// the dialog itself. Returns the running animation so the caller can
// cancel if the modal closes early.
export function animateModalEnter(dialog: HTMLElement): JSAnimation {
  const overlay = dialog.closest(".modal-overlay") as HTMLElement | null;
  if (overlay) {
    animate(overlay, { opacity: [0, 1], duration: 180, ease: EASE_OUT });
  }
  return animate(dialog, {
    opacity: [0, 1],
    scale: [0.94, 1],
    translateY: [8, 0],
    duration: 360,
    ease: SPRING_OUT,
  });
}

// Stagger-reveal for a group of children inside a parent. Used inside
// modals to cascade the cards into view after the dialog itself
// finishes scaling in. The default delay budget keeps the cascade
// tight (under ~250ms total) so it feels snappy not theatrical.
export function animateStaggerIn(
  parent: HTMLElement,
  childSelector: string,
  options: { startDelay?: number; perItem?: number } = {}
): JSAnimation | null {
  const children = parent.querySelectorAll<HTMLElement>(childSelector);
  if (!children.length) return null;
  return animate(Array.from(children), {
    opacity: [0, 1],
    translateY: [10, 0],
    duration: 320,
    delay: stagger(options.perItem ?? 40, { start: options.startDelay ?? 80 }),
    ease: EASE_OUT,
  });
}

// Counts a number element from its current displayed value up to the
// target. The element must contain only the number (or a number with a
// "$" / "/" suffix we preserve via a formatter). Used for stat pills
// in the settings/trainer modals so big numbers feel earned.
export function animateCount(
  el: HTMLElement,
  to: number,
  opts: { from?: number; duration?: number; format?: (n: number) => string } = {}
): JSAnimation {
  const from = opts.from ?? 0;
  const format = opts.format ?? ((n: number) => Math.round(n).toLocaleString());
  const ref = { v: from };
  return animate(ref, {
    v: to,
    duration: opts.duration ?? 700,
    ease: EASE_OUT,
    onUpdate: () => {
      el.textContent = format(ref.v);
    },
  });
}

// Quick "pop" feedback on a button/element — used after successful
// actions (heal, level up, badge earned) to signal the change.
export function animatePop(target: HTMLElement, scale: number = 1.18): JSAnimation {
  return animate(target, {
    scale: [{ to: scale, duration: 110, ease: "outQuad" }, { to: 1, duration: 220, ease: "outElastic(1, 0.5)" }],
  });
}

// React hook: run the modal entrance + an optional card stagger when
// the dialog mounts. Returns a ref to attach to the dialog element.
//
// `enabled` is plumbed through so callers that conditionally render the
// dialog (e.g. SocialPanel keeps its sockets alive while hidden, but the
// JSX itself toggles in/out via a parent flag) can pass that flag and
// re-trigger the entrance whenever the dialog appears.
export function useModalEnter(staggerSelector?: string, enabled: boolean = true) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;
    const enter = animateModalEnter(el);
    let stag: JSAnimation | null = null;
    if (staggerSelector) {
      stag = animateStaggerIn(el, staggerSelector);
    }
    return () => {
      enter.cancel();
      stag?.cancel();
    };
  }, [staggerSelector, enabled]);
  return ref;
}

// React hook: drive a count-up on the contents of an element when its
// numeric `value` prop changes. Starts at 0 on first mount so opening
// a modal feels like the numbers are tallying up; subsequent updates
// count from the last shown value.
export function useCountUp(value: number, format?: (n: number) => string) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const prev = useRef<number>(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const from = prev.current;
    const to = value;
    if (from === to) {
      el.textContent = (format ?? ((n: number) => Math.round(n).toLocaleString()))(to);
      return;
    }
    const anim = animateCount(el, to, { from, format });
    prev.current = to;
    return () => { anim.cancel(); };
  }, [value, format]);
  return ref;
}

// Helper exposed so components can imperatively pop something — e.g.,
// the heal button on a successful action. Wraps anime.js so call-sites
// don't need to import the library directly.
export const animeUtils = utils;

// Inline counting <span>. Drop-in replacement for `{value}` inside JSX
// when we want the number to tick up rather than appear instantly.
// Wrap a prefix/suffix outside this element if needed, e.g. `$<CountUp />`.
export function CountUp({
  value,
  format,
}: {
  value: number;
  format?: (n: number) => string;
}) {
  const ref = useCountUp(value, format);
  return createElement("span", { ref }, format ? format(0) : "0");
}
