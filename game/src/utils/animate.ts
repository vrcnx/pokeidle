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
  // The dialog's OWN overlay — its parent — and not the nearest one up the
  // tree. `closest()` was the obvious call and it had a real bug in it: a
  // dialog rendered INSIDE another dialog finds the outer one's overlay and
  // fades the whole thing from zero. That is what the Pokemon detail sheet
  // does now that it opens inside the PC — the entire hub blinked out and
  // back every time you tapped a Pokemon.
  //
  // A nested dialog has no overlay of its own to fade, which is correct:
  // the backdrop it would be dimming is already dimmed.
  const parent = dialog.parentElement;
  const overlay = parent?.classList.contains("modal-overlay") ? parent : null;
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

/** Read at call time, not once at module load: the OS setting can change
 *  while a session is open, and a cached answer would keep animating for
 *  someone who just asked it to stop. */
function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

// ── Hub section entrance ────────────────────────────────────────────
// Every page of the central dialog animates in, not just the dialog on
// the frame it first opened.
//
// A section change is a NAVIGATION, and a navigation with no transition
// reads as a repaint — the rail highlight moves and the pane's contents
// are simply different, with nothing connecting the two. This gives the
// move a direction: content arrives from the side the rail is on, so the
// eye is carried from the row you pressed to the pane it filled.
//
// Deliberately shorter than the modal entrance (220ms vs 360). That one is
// a thing appearing; this is a thing you asked for, and asking twice in a
// row must not feel like waiting.
export function animateSectionEnter(pane: HTMLElement): JSAnimation | null {
  if (prefersReducedMotion()) return null;
  return animate(pane, {
    opacity: [0, 1],
    translateX: [10, 0],
    duration: 220,
    ease: EASE_OUT,
  });
}

// The cascade inside a freshly-switched section.
//
// `:scope > *` rather than a per-section selector: nine sections written by
// different hands do not share a card class, and a selector list naming all
// of them would go stale the first time one was refactored. Their top-level
// children are the one thing every pane genuinely has.
//
// Capped at 8. A pane holding 150 box sprites would otherwise cascade for
// three seconds, and the stagger is meant to give the eye an order to read
// in — past the first handful it stops doing that and starts being a wait.
export function animateSectionStagger(pane: HTMLElement): JSAnimation | null {
  if (prefersReducedMotion()) return null;
  const kids = Array.from(pane.children).slice(0, 8) as HTMLElement[];
  if (!kids.length) return null;
  return animate(kids, {
    opacity: [0, 1],
    translateY: [8, 0],
    duration: 260,
    delay: stagger(28, { start: 40 }),
    ease: EASE_OUT,
  });
}
