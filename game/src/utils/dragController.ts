// Custom pointer-events drag-and-drop controller.
//
// Why custom instead of HTML5 DnD or a library:
//   - HTML5 DnD doesn't work on touch devices. Period.
//   - Libraries like dnd-kit are great but add ~30 KB and have
//     their own conventions to learn. We need party-row reorder
//     and PC box-grid drop, both simple — a tight custom layer
//     does the job in ~250 lines.
//
// Public API (from useDraggable / useDropTarget hooks):
//   const dragRef = useDraggable({ payload, ghost: { … } });
//   const dropRef = useDropTarget({ accept: (p) => …, onDrop: (p) => … });
//
// Behaviour:
//   - Mouse: drag starts after MOVE_THRESHOLD_PX of motion (instant).
//   - Touch: ~180 ms long-press OR HOLD_MOVE_THRESHOLD_PX of motion
//     starts a drag (so a tap-and-scroll doesn't accidentally drag).
//   - Floating ghost follows the pointer with NO transition delay.
//   - Drop targets matching `accept(payload)` light up via the
//     `.drop-target-active` class while the pointer is over them.
//   - Releasing over a target fires onDrop. Anywhere else cancels.
//   - Cancel via Escape key.
//
// Smoothness wins:
//   - Ghost transform updates synchronously on pointermove with NO
//     CSS transition — transitions add lag equal to their duration.
//   - Hit-testing uses document.elementFromPoint(x,y) (one O(1) tree
//     walk) instead of iterating every registered target with
//     getBoundingClientRect (which forced a layout flush per target).
//   - setPointerCapture keeps events flowing even when the pointer
//     leaves the source — fixes "drag dies when finger moves fast".
//   - touch-action: none on the body during drag prevents the browser
//     from interpreting the gesture as a scroll.
//   - Ghost grab-offset is captured at drag start so the ghost stays
//     under the finger at the same relative spot the user grabbed.

const LONG_PRESS_MS = 180;
const MOUSE_MOVE_THRESHOLD_PX = 4;
const TOUCH_MOVE_THRESHOLD_PX = 8;

export interface DraggablePayload {
  /** Free-form identifier — drop targets read this to decide
   *  acceptance and dispatch the right action. */
  kind: string;
  data: unknown;
}

interface RegisteredSource {
  el: HTMLElement;
  payload: () => DraggablePayload;
  ghost?: () => HTMLElement | null; // optional override for the floating ghost
  onDragStart?: () => void;
  onDragEnd?: () => void;
}

interface RegisteredTarget {
  el: HTMLElement;
  accept: (p: DraggablePayload) => boolean;
  onDrop: (p: DraggablePayload) => void;
  onEnter?: () => void;
  onLeave?: () => void;
}

class DragController {
  private sources = new Set<RegisteredSource>();
  // Maps drop-target element → registered target. Used by the
  // elementFromPoint hit-test path to look up the registered target
  // attached to whatever element the pointer is over.
  private targets = new Map<HTMLElement, RegisteredTarget>();
  private pressTimer: number | null = null;
  private startX = 0;
  private startY = 0;
  private startPointerType = "mouse";
  private startPointerId = -1;
  private startSource: RegisteredSource | null = null;
  // Captured at drag start: where in the source did the user grab?
  // Used so the ghost stays pinned to the finger at that relative
  // spot rather than centring on the pointer (which feels like the
  // ghost teleports the moment the drag begins).
  private grabOffsetX = 0;
  private grabOffsetY = 0;
  // Coalesce updates to one per animation frame. Pointer events can
  // fire much faster than the display refresh rate; doing layout work
  // for every event is just wasted CPU.
  private rafScheduled = false;
  private lastX = 0;
  private lastY = 0;
  private dragging: {
    source: RegisteredSource;
    payload: DraggablePayload;
    ghost: HTMLElement;
    target: RegisteredTarget | null;
  } | null = null;
  private boundEscape = (e: KeyboardEvent) => {
    if (e.key === "Escape" && this.dragging) this.endDrag(false);
  };

  registerSource(s: RegisteredSource): () => void {
    this.sources.add(s);
    s.el.addEventListener("pointerdown", this.onPointerDown);
    // Block the browser's default touch handling on the source so the
    // long-press / threshold detection isn't pre-empted by native
    // scrolling. The body still scrolls normally outside of sources.
    s.el.style.touchAction = "none";
    s.el.style.userSelect = "none";
    return () => {
      this.sources.delete(s);
      s.el.removeEventListener("pointerdown", this.onPointerDown);
    };
  }

  registerTarget(t: RegisteredTarget): () => void {
    this.targets.set(t.el, t);
    return () => { this.targets.delete(t.el); };
  }

  private findSource(el: EventTarget | null): RegisteredSource | null {
    if (!(el instanceof Node)) return null;
    for (const s of this.sources) {
      if (s.el.contains(el)) return s;
    }
    return null;
  }

  private moveThreshold(): number {
    return this.startPointerType === "touch" ? TOUCH_MOVE_THRESHOLD_PX : MOUSE_MOVE_THRESHOLD_PX;
  }

  private onPointerDown = (e: PointerEvent) => {
    // Ignore right-click / middle-click / non-primary touch.
    if (e.button !== undefined && e.button !== 0) return;
    const source = this.findSource(e.target);
    if (!source) return;
    // Don't start a drag from inside an interactive child (button,
    // input, etc.) — those should keep their own click behaviour.
    // Allowed: when the source IS the interactive element itself,
    // dragging it is fine.
    const t = e.target as HTMLElement;
    const inner = t.closest("button,a,input,select,textarea,[data-no-drag]");
    if (inner && inner !== source.el && !source.el.contains(inner.parentElement!)) {
      // Inner element is interactive AND not the source itself — bail.
      if (source.el.contains(inner) && inner !== source.el) return;
    }
    this.startX = e.clientX;
    this.startY = e.clientY;
    this.startPointerType = e.pointerType || "mouse";
    this.startPointerId = e.pointerId;
    this.startSource = source;
    // Capture the pointer on the source element so move/up keep
    // firing even if the pointer leaves the element (or the ghost
    // intercepts events). Without this, fast drags can drop the
    // gesture mid-flight.
    try { source.el.setPointerCapture(e.pointerId); } catch { /* */ }
    // Long-press timer: only relevant for touch / pen. On mouse the
    // threshold check fires almost immediately so the long-press
    // path is rarely taken.
    this.pressTimer = window.setTimeout(() => {
      this.pressTimer = null;
      if (this.startSource) this.beginDrag(this.startSource, this.startX, this.startY);
    }, LONG_PRESS_MS);
    // Listen for movement / release globally so we capture the whole
    // gesture even if the pointer leaves the source element.
    window.addEventListener("pointermove", this.onPointerMove, { passive: false });
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerUp);
  };

  private onPointerMove = (e: PointerEvent) => {
    if (this.dragging) {
      // Stop the browser interpreting the gesture as a scroll/select.
      // touch-action: none on body (added at drag start) handles most
      // browsers, but preventDefault here is belt-and-braces for the
      // ones that still pass the gesture through.
      e.preventDefault();
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.scheduleFrame();
      return;
    }
    // Pre-drag: check if movement crossed the threshold to start.
    const dx = e.clientX - this.startX;
    const dy = e.clientY - this.startY;
    if (Math.hypot(dx, dy) > this.moveThreshold()) {
      if (this.pressTimer !== null) {
        window.clearTimeout(this.pressTimer);
        this.pressTimer = null;
      }
      if (this.startSource) this.beginDrag(this.startSource, e.clientX, e.clientY);
    }
  };

  private scheduleFrame() {
    if (this.rafScheduled) return;
    this.rafScheduled = true;
    requestAnimationFrame(() => {
      this.rafScheduled = false;
      if (!this.dragging) return;
      this.updateGhost(this.lastX, this.lastY);
      this.updateTarget(this.lastX, this.lastY);
    });
  }

  private onPointerUp = (e: PointerEvent) => {
    if (this.pressTimer !== null) {
      window.clearTimeout(this.pressTimer);
      this.pressTimer = null;
    }
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
    if (this.startSource) {
      try { this.startSource.el.releasePointerCapture(this.startPointerId); } catch { /* */ }
    }
    this.startSource = null;
    if (!this.dragging) return;
    this.endDrag(true, e.clientX, e.clientY);
  };

  private beginDrag(source: RegisteredSource, x: number, y: number) {
    const payload = source.payload();
    const sourceRect = source.el.getBoundingClientRect();
    // Where in the source did the user originally press? Pinning the
    // ghost to that offset feels like the element is being dragged,
    // not teleported under the cursor.
    this.grabOffsetX = Math.min(Math.max(x - sourceRect.left, 0), sourceRect.width);
    this.grabOffsetY = Math.min(Math.max(y - sourceRect.top, 0), sourceRect.height);
    const ghost = source.ghost?.() ?? this.makeDefaultGhost(source.el);
    document.body.appendChild(ghost);
    document.body.classList.add("dnd-active");
    document.addEventListener("keydown", this.boundEscape);
    this.dragging = { source, payload, ghost, target: null };
    this.lastX = x;
    this.lastY = y;
    source.el.classList.add("drag-source-active");
    source.onDragStart?.();
    this.updateGhost(x, y);
    this.updateTarget(x, y);
    // Haptic feedback on supported devices — feels great on mobile.
    if (navigator.vibrate) {
      try { navigator.vibrate(10); } catch { /* */ }
    }
  }

  private makeDefaultGhost(el: HTMLElement): HTMLElement {
    const rect = el.getBoundingClientRect();
    const clone = el.cloneNode(true) as HTMLElement;
    clone.classList.add("dnd-ghost");
    clone.style.position = "fixed";
    clone.style.pointerEvents = "none";
    clone.style.zIndex = "9999";
    clone.style.width = `${rect.width}px`;
    clone.style.height = `${rect.height}px`;
    clone.style.left = "0";
    clone.style.top = "0";
    clone.style.margin = "0";
    clone.style.opacity = "0.95";
    // CRITICAL: no transition on transform. The ghost MUST update
    // synchronously with the pointer or it feels laggy. Any non-zero
    // transition duration here would lag the ghost behind the cursor
    // by exactly that duration on every move.
    clone.style.transition = "none";
    clone.style.willChange = "transform";
    clone.style.boxShadow = "0 6px 20px rgba(0,0,0,0.40), 0 2px 4px rgba(0,0,0,0.30)";
    clone.style.borderRadius = getComputedStyle(el).borderRadius;
    return clone;
  }

  private updateGhost(x: number, y: number) {
    if (!this.dragging) return;
    const tx = x - this.grabOffsetX;
    const ty = y - this.grabOffsetY;
    // translate3d nudges the renderer toward GPU compositing on
    // browsers that don't already promote translate() automatically.
    this.dragging.ghost.style.transform = `translate3d(${tx}px, ${ty}px, 0) rotate(-1.5deg)`;
  }

  private updateTarget(x: number, y: number) {
    if (!this.dragging) return;
    // elementFromPoint is a single O(1) hit-test into the browser's
    // own composited tree — much faster than iterating every target
    // and calling getBoundingClientRect() (each of those forces a
    // layout flush). The ghost has pointer-events: none so it never
    // intercepts the hit; we always see the element underneath.
    const hit = document.elementFromPoint(x, y);
    let next: RegisteredTarget | null = null;
    if (hit) {
      let node: Node | null = hit;
      while (node) {
        if (node instanceof HTMLElement) {
          const t = this.targets.get(node);
          if (t && t.accept(this.dragging.payload)) {
            next = t;
            break;
          }
        }
        node = node.parentNode;
      }
    }
    if (next === this.dragging.target) return;
    if (this.dragging.target) {
      this.dragging.target.el.classList.remove("drop-target-active");
      this.dragging.target.onLeave?.();
    }
    this.dragging.target = next;
    if (next) {
      next.el.classList.add("drop-target-active");
      next.onEnter?.();
    }
  }

  private endDrag(commit: boolean, _x?: number, _y?: number) {
    if (!this.dragging) return;
    const { source, payload, ghost, target } = this.dragging;
    document.removeEventListener("keydown", this.boundEscape);
    document.body.classList.remove("dnd-active");
    source.el.classList.remove("drag-source-active");
    if (target) {
      target.el.classList.remove("drop-target-active");
      target.onLeave?.();
    }
    ghost.remove();
    this.dragging = null;
    source.onDragEnd?.();
    // Pointerup synthesises a click on the source after a drag —
    // without this the detail modal would pop every time you finish
    // moving a party row. Swallow exactly one click.
    this.suppressNextClick();
    if (commit && target) {
      target.onDrop(payload);
    }
  }

  private suppressNextClick() {
    const handler = (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      document.removeEventListener("click", handler, true);
    };
    document.addEventListener("click", handler, true);
    // If no click arrives within ~50 ms (pointer released over empty
    // space), drop the listener so it doesn't swallow a *legitimate*
    // click that happens later.
    setTimeout(() => document.removeEventListener("click", handler, true), 50);
  }
}

export const dragController = new DragController();
