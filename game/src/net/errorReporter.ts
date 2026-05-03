// Client-side error reporter. Three sources:
//   1. <GlobalErrorBoundary>     — React render-tree errors
//   2. window.onerror             — synchronous JS errors outside React
//   3. window.unhandledrejection  — uncaught Promise rejections
//
// Each call POSTs to /api/bug-reports/client-error. The server keeps
// its own rate limit (30/min/user); we additionally throttle here so a
// single tight loop can't fire thousands of fetches before the server
// rate-limits us. Anonymous (unauthenticated) errors are dropped — the
// endpoint requires auth and we'd just churn 401s otherwise.
//
// `installGlobalErrorReporters()` is idempotent — safe to call from
// main.tsx exactly once.

import { api } from "./api";

const RECENT_TTL_MS = 60_000;
const MAX_PER_WINDOW = 10;

const recent: { key: string; t: number }[] = [];

function shouldReport(key: string): boolean {
  const now = Date.now();
  // Drop entries older than the window.
  while (recent.length && recent[0].t < now - RECENT_TTL_MS) recent.shift();
  if (recent.length >= MAX_PER_WINDOW) return false;
  // Dedup identical messages within the window so a tight loop reports once.
  if (recent.some((r) => r.key === key)) return false;
  recent.push({ key, t: now });
  return true;
}

export interface ClientErrorContext {
  message: string;
  stack?: string | null;
  source?: string;
  meta?: Record<string, unknown>;
}

export function reportClientError(ctx: ClientErrorContext): void {
  const key = `${ctx.source ?? ""}:${ctx.message}`;
  if (!shouldReport(key)) return;
  // Fire-and-forget; we never want error reporting itself to throw or
  // surface to the user. A failed POST is just lost — the server logs
  // in stdout would still capture anything that bubbled out of a 500.
  api.reportClientError({
    message: ctx.message.slice(0, 2000),
    stack: ctx.stack ? ctx.stack.slice(0, 20_000) : undefined,
    source: ctx.source ? ctx.source.slice(0, 500) : undefined,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
    meta: ctx.meta,
  }).catch(() => undefined);
}

let _installed = false;
export function installGlobalErrorReporters(): void {
  if (_installed || typeof window === "undefined") return;
  _installed = true;

  window.addEventListener("error", (event) => {
    const err = event.error instanceof Error ? event.error : null;
    reportClientError({
      message: err?.message ?? String(event.message ?? "window.onerror"),
      stack: err?.stack ?? null,
      source: `window.onerror @ ${event.filename ?? location.href}:${event.lineno ?? 0}:${event.colno ?? 0}`,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason: unknown = (event as PromiseRejectionEvent).reason;
    const err = reason instanceof Error ? reason : null;
    reportClientError({
      message: err?.message ?? (typeof reason === "string" ? reason : "unhandled rejection"),
      stack: err?.stack ?? null,
      source: `unhandledrejection @ ${location.href}`,
    });
  });
}
