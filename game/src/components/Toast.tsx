import { useEffect, useState } from "react";

// Lightweight toast notifications — imperatively triggered via
// `pushToast({...})`, rendered by <ToastHost /> mounted once at the
// app root. Toasts stack bottom-up, auto-dismiss after 2.5s, and
// fade in/out via a CSS transition. No accessibility roles beyond
// role="status" (these are non-critical confirmations; the reducer
// log line is the durable record).

export type ToastKind = "info" | "success" | "warn";

interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
  icon?: string;
}

const DURATION_MS = 2500;
const MAX_STACK = 4;

let nextId = 1;
const listeners = new Set<(toasts: Toast[]) => void>();
let toasts: Toast[] = [];

function emit() {
  for (const fn of listeners) fn(toasts);
}

export function pushToast(input: { kind?: ToastKind; text: string; icon?: string }): void {
  const t: Toast = {
    id: nextId++,
    kind: input.kind ?? "info",
    text: input.text,
    icon: input.icon,
  };
  toasts = [...toasts, t].slice(-MAX_STACK);
  emit();
  window.setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    emit();
  }, DURATION_MS);
}

export function ToastHost() {
  const [list, setList] = useState<Toast[]>(toasts);
  useEffect(() => {
    listeners.add(setList);
    return () => { listeners.delete(setList); };
  }, []);
  if (list.length === 0) return null;
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          {t.icon && <span className="toast-icon">{t.icon}</span>}
          <span className="toast-text">{t.text}</span>
        </div>
      ))}
    </div>
  );
}
