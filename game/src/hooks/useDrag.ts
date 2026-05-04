import { useEffect, useRef } from "react";
import { dragController, type DraggablePayload } from "../utils/dragController";

// Combined source + target hook — most slots in this app (party rows,
// PC cells) are both. Pass `source` to make the element draggable,
// `target` to make it a drop zone, or both for swap behaviour.
export function useDragAndDrop<E extends HTMLElement>(opts: {
  source?: {
    payload: () => DraggablePayload;
    ghost?: () => HTMLElement | null;
    onDragStart?: () => void;
    onDragEnd?: () => void;
  };
  target?: {
    accept: (p: DraggablePayload) => boolean;
    onDrop: (p: DraggablePayload) => void;
    onEnter?: () => void;
    onLeave?: () => void;
  };
  enabled?: boolean;
}) {
  const ref = useRef<E | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  useEffect(() => {
    if (opts.enabled === false) return;
    const el = ref.current;
    if (!el) return;
    const unsubs: Array<() => void> = [];
    if (opts.source) {
      unsubs.push(dragController.registerSource({
        el,
        payload: () => optsRef.current.source!.payload(),
        ghost: () => optsRef.current.source?.ghost?.() ?? null,
        onDragStart: () => optsRef.current.source?.onDragStart?.(),
        onDragEnd: () => optsRef.current.source?.onDragEnd?.(),
      }));
    }
    if (opts.target) {
      unsubs.push(dragController.registerTarget({
        el,
        accept: (p) => optsRef.current.target!.accept(p),
        onDrop: (p) => optsRef.current.target!.onDrop(p),
        onEnter: () => optsRef.current.target?.onEnter?.(),
        onLeave: () => optsRef.current.target?.onLeave?.(),
      }));
    }
    return () => unsubs.forEach((fn) => fn());
    // Re-register if drag-source / drop-target presence changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.enabled, !!opts.source, !!opts.target]);
  return ref;
}

// Thin React bindings around the imperative dragController so
// components can declare drag sources / drop targets without managing
// pointer listeners themselves.

export function useDraggable<E extends HTMLElement>(opts: {
  payload: () => DraggablePayload;
  ghost?: () => HTMLElement | null;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  enabled?: boolean;
}) {
  const ref = useRef<E | null>(null);
  // Keep callbacks fresh without re-registering on every render.
  const optsRef = useRef(opts);
  optsRef.current = opts;
  useEffect(() => {
    if (opts.enabled === false) return;
    const el = ref.current;
    if (!el) return;
    const unregister = dragController.registerSource({
      el,
      payload: () => optsRef.current.payload(),
      ghost: () => optsRef.current.ghost?.() ?? null,
      onDragStart: () => optsRef.current.onDragStart?.(),
      onDragEnd: () => optsRef.current.onDragEnd?.(),
    });
    return unregister;
  }, [opts.enabled]);
  return ref;
}

export function useDropTarget<E extends HTMLElement>(opts: {
  accept: (p: DraggablePayload) => boolean;
  onDrop: (p: DraggablePayload) => void;
  onEnter?: () => void;
  onLeave?: () => void;
  enabled?: boolean;
}) {
  const ref = useRef<E | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  useEffect(() => {
    if (opts.enabled === false) return;
    const el = ref.current;
    if (!el) return;
    const unregister = dragController.registerTarget({
      el,
      accept: (p) => optsRef.current.accept(p),
      onDrop: (p) => optsRef.current.onDrop(p),
      onEnter: () => optsRef.current.onEnter?.(),
      onLeave: () => optsRef.current.onLeave?.(),
    });
    return unregister;
  }, [opts.enabled]);
  return ref;
}
