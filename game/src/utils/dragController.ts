// Custom pointer-events drag-and-drop controller.
//
// Why custom instead of HTML5 DnD or a library:
//   - HTML5 DnD doesn't work on touch devices. Period.
//   - Libraries like dnd-kit are great but add ~30 KB and have
//     their own conventions to learn. We need party-row reorder
//     and PC box-grid drop, both simple — a tight custom layer
//     does the job in ~200 lines.
//
// Public API (from useDraggable / useDropTarget hooks below):
//   const dragRef = useDraggable({ payload, ghost: { … } });
//   const dropRef = useDropTarget({ accept: (p) => …, onDrop: (p) => … });
//
// Behaviour:
//   - Press-and-hold for 220ms OR move ≥6 px starts a drag (so
//     scrolling a list with a touch doesn't accidentally drag).
//   - During drag, a floating ghost follows the pointer.
//   - Drop targets that match `accept(payload)` light up (CSS
//     class `.drop-target-active`) when the pointer is over them.
//   - Releasing over a target fires onDrop. Releasing anywhere
//     else cancels — nothing changes.
//   - Cancel via Escape key.

const LONG_PRESS_MS = 220;
const MOVE_THRESHOLD_PX = 6;

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
  private targets = new Set<RegisteredTarget>();
  private pressTimer: number | null = null;
  private startX = 0;
  private startY = 0;
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
    s.el.style.touchAction = "manipulation";
    s.el.style.userSelect = "none";
    return () => {
      this.sources.delete(s);
      s.el.removeEventListener("pointerdown", this.onPointerDown);
    };
  }

  registerTarget(t: RegisteredTarget): () => void {
    this.targets.add(t);
    return () => { this.targets.delete(t); };
  }

  private findSource(el: EventTarget | null): RegisteredSource | null {
    if (!(el instanceof Node)) return null;
    for (const s of this.sources) {
      if (s.el.contains(el)) return s;
    }
    return null;
  }

  private onPointerDown = (e: PointerEvent) => {
    // Ignore right-click / middle-click / touch-not-primary.
    if (e.button !== undefined && e.button !== 0) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const source = this.findSource(e.target);
    if (!source) return;
    // Don't start a drag from inside an interactive child (button,
    // input, etc.) — those should keep their own click behaviour.
    const t = e.target as HTMLElement;
    if (t.closest("button,a,input,select,textarea,[data-no-drag]") && t !== source.el) {
      // Only bail out if the inner element isn't the source itself.
      const closest = t.closest("button,a,input,select,textarea,[data-no-drag]");
      if (closest && closest !== source.el) return;
    }
    this.startX = e.clientX;
    this.startY = e.clientY;
    // Long-press timer: starts the drag even without movement.
    this.pressTimer = window.setTimeout(() => {
      this.pressTimer = null;
      this.beginDrag(source, e);
    }, LONG_PRESS_MS);
    // Listen for movement / release globally so we capture the whole
    // gesture even if the pointer leaves the source element.
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerUp);
  };

  private onPointerMove = (e: PointerEvent) => {
    if (this.dragging) {
      this.updateGhost(e.clientX, e.clientY);
      this.updateTarget(e.clientX, e.clientY);
      return;
    }
    // Pre-drag: check if movement crossed the threshold to start.
    const dx = e.clientX - this.startX;
    const dy = e.clientY - this.startY;
    if (Math.hypot(dx, dy) > MOVE_THRESHOLD_PX) {
      const source = this.findSource(e.target) ?? this.findSourceByPosition(this.startX, this.startY);
      if (this.pressTimer !== null) {
        window.clearTimeout(this.pressTimer);
        this.pressTimer = null;
      }
      if (source) this.beginDrag(source, e);
    }
  };

  private findSourceByPosition(x: number, y: number): RegisteredSource | null {
    for (const s of this.sources) {
      const r = s.el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return s;
    }
    return null;
  }

  private onPointerUp = (e: PointerEvent) => {
    if (this.pressTimer !== null) {
      window.clearTimeout(this.pressTimer);
      this.pressTimer = null;
    }
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
    if (!this.dragging) return;
    this.endDrag(true, e.clientX, e.clientY);
  };

  private beginDrag(source: RegisteredSource, e: PointerEvent) {
    const payload = source.payload();
    const ghost = source.ghost?.() ?? this.makeDefaultGhost(source.el);
    document.body.appendChild(ghost);
    document.body.classList.add("dnd-active");
    document.addEventListener("keydown", this.boundEscape);
    this.dragging = { source, payload, ghost, target: null };
    source.el.classList.add("drag-source-active");
    source.onDragStart?.();
    this.updateGhost(e.clientX, e.clientY);
    this.updateTarget(e.clientX, e.clientY);
    // Haptic feedback if available — feels great on mobile.
    if (navigator.vibrate) {
      try { navigator.vibrate(8); } catch { /* */ }
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
    clone.style.opacity = "0.92";
    clone.style.transform = "translate(0,0) rotate(-2deg) scale(1.04)";
    clone.style.transition = "transform 120ms ease-out";
    clone.style.boxShadow = "0 8px 24px rgba(0,0,0,0.45), 0 2px 4px rgba(0,0,0,0.3)";
    clone.style.borderRadius = getComputedStyle(el).borderRadius;
    return clone;
  }

  private updateGhost(x: number, y: number) {
    if (!this.dragging) return;
    const g = this.dragging.ghost;
    const rect = g.getBoundingClientRect();
    const tx = x - rect.width / 2;
    const ty = y - rect.height / 2;
    g.style.transform = `translate(${tx}px, ${ty}px) rotate(-2deg) scale(1.04)`;
  }

  private updateTarget(x: number, y: number) {
    if (!this.dragging) return;
    let next: RegisteredTarget | null = null;
    for (const t of this.targets) {
      const r = t.el.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      if (!t.accept(this.dragging.payload)) continue;
      next = t;
      break;
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
    // Pointerup fires a synthetic click on the source element after
    // a drag — without this the detail modal would pop open every
    // time you finish moving a party row. Swallow exactly one click.
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
    // If no click arrives within a frame (e.g. pointer was released
    // outside any element), drop the listener so it doesn't swallow
    // the next *legitimate* click instead.
    setTimeout(() => document.removeEventListener("click", handler, true), 50);
  }
}

export const dragController = new DragController();
