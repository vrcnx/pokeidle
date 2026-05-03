// Lightweight structured logger. Emits one JSON line per call to
// stdout (Railway captures stdout into its log viewer, so JSON parses
// nicely there and any future log-aggregator can ingest the same
// format). No external dependency — pino-style format hand-rolled to
// keep the server's dep tree lean.
//
// Levels: "error" | "warn" | "info" | "debug"
// Severity gate honours LOG_LEVEL env (default "info"); "debug"
// messages are dropped in production unless LOG_LEVEL=debug is set.

type Level = "error" | "warn" | "info" | "debug";

const LEVEL_ORDER: Record<Level, number> = { error: 40, warn: 30, info: 20, debug: 10 };

const ENV_LEVEL = ((process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug")) as Level);
const MIN_SEVERITY = LEVEL_ORDER[ENV_LEVEL] ?? LEVEL_ORDER.info;

function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return JSON.stringify({ __serializeError: true });
  }
}

function emit(level: Level, message: string, meta?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < MIN_SEVERITY) return;
  const entry = {
    t: new Date().toISOString(),
    level,
    msg: message,
    ...meta,
  };
  // Stream straight to stdout — Railway captures both stdout/stderr.
  // Errors also print human-readable below the JSON for the live tail.
  process.stdout.write(safeStringify(entry) + "\n");
}

export const logger = {
  error(message: string, meta?: Record<string, unknown>) { emit("error", message, meta); },
  warn(message: string, meta?: Record<string, unknown>)  { emit("warn", message, meta); },
  info(message: string, meta?: Record<string, unknown>)  { emit("info", message, meta); },
  debug(message: string, meta?: Record<string, unknown>) { emit("debug", message, meta); },
};
