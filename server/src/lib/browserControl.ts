// In-memory broker for live control of the streamed browser.
//
// The admin dashboard shows a periodic screenshot of the renderer's page and
// relays clicks/keystrokes back to it. Frames and queued input are deliberately
// NOT persisted: they're ephemeral, high-churn, and worthless a second later —
// putting them in Postgres would add write load for no benefit. A restart just
// drops the preview until the next frame arrives.

export type InputCommand =
  // Coordinates are NORMALISED (0..1) so they survive a resolution change
  // between what the admin sees and what the page actually is.
  | { kind: "click"; x: number; y: number; button?: "left" | "right"; clicks?: number }
  | { kind: "move"; x: number; y: number }
  | { kind: "scroll"; x: number; y: number; dy: number }
  | { kind: "type"; text: string }
  | { kind: "key"; key: string }
  | { kind: "reload" }
  | { kind: "home" }
  | { kind: "navigate"; url: string };

export const INPUT_KINDS = new Set([
  "click", "move", "scroll", "type", "key", "reload", "home", "navigate",
]);

interface Frame {
  /** base64 JPEG */
  data: string;
  at: number;
  width: number;
  height: number;
}

let latestFrame: Frame | null = null;
let queue: { cmd: InputCommand; at: number }[] = [];
let lastWatchAt = 0;

/** Capturing frames costs CPU on the renderer, so it only does it while an
 *  admin is actually looking. Any admin frame fetch / input refreshes this. */
const WATCH_TTL_MS = 15_000;
const MAX_QUEUE = 50;
/** A frame older than this is not "live" — serving it would show a frozen
 *  screen as current and invite clicks against stale coordinates. */
const FRAME_TTL_MS = 12_000;
/** Queued input older than this is dropped rather than replayed: coordinates
 *  derived from a long-gone frame would land somewhere meaningless. */
const INPUT_TTL_MS = 10_000;

export function markWatching(): void {
  lastWatchAt = Date.now();
}

export function isWatching(): boolean {
  return Date.now() - lastWatchAt < WATCH_TTL_MS;
}

export function putFrame(dataBase64: string, width: number, height: number): void {
  latestFrame = { data: dataBase64, at: Date.now(), width, height };
}

/** Self-expiring: a stale frame is dropped (and its buffer released) rather
 *  than served as if it were live. */
export function getFrame(): Frame | null {
  if (latestFrame && Date.now() - latestFrame.at > FRAME_TTL_MS) latestFrame = null;
  return latestFrame;
}

export function enqueueInput(cmd: InputCommand): boolean {
  const now = Date.now();
  // Opportunistically shed anything the renderer never came back for.
  queue = queue.filter((q) => now - q.at <= INPUT_TTL_MS);
  if (queue.length >= MAX_QUEUE) return false;
  queue.push({ cmd, at: now });
  return true;
}

/** Renderer drains the queue on each poll. Stale commands are discarded — a
 *  renderer reconnecting after an outage must not replay old coordinates. */
export function drainInput(): InputCommand[] {
  if (queue.length === 0) return [];
  const now = Date.now();
  const out = queue.filter((q) => now - q.at <= INPUT_TTL_MS).map((q) => q.cmd);
  queue = [];
  return out;
}

/** Hosts the streamed browser may be pointed at: our own game frontend(s) and
 *  API origin, derived from the same env the rest of the server uses. */
function navAllowedHosts(): Set<string> {
  const out = new Set<string>();
  const add = (origin: string) => {
    try { out.add(new URL(origin.trim()).hostname.toLowerCase()); } catch { /* ignore malformed */ }
  };
  (process.env.FRONTEND_ORIGIN ?? "").split(",").filter(Boolean).forEach(add);
  if (process.env.BETTER_AUTH_URL) add(process.env.BETTER_AUTH_URL);
  return out;
}

/** Validate + normalise an untrusted command from the admin client. */
export function sanitizeInput(raw: unknown): InputCommand | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const kind = String(c.kind ?? "");
  if (!INPUT_KINDS.has(kind)) return null;
  const unit = (v: unknown) => Math.max(0, Math.min(1, Number(v)));
  switch (kind) {
    case "click": {
      if (!Number.isFinite(Number(c.x)) || !Number.isFinite(Number(c.y))) return null;
      const clicks = Math.max(1, Math.min(3, Math.round(Number(c.clicks ?? 1)) || 1));
      const button = c.button === "right" ? "right" : "left";
      return { kind: "click", x: unit(c.x), y: unit(c.y), button, clicks };
    }
    case "move":
      if (!Number.isFinite(Number(c.x)) || !Number.isFinite(Number(c.y))) return null;
      return { kind: "move", x: unit(c.x), y: unit(c.y) };
    case "scroll": {
      // Same finite check the click/move cases apply — without it a NaN
      // coordinate clamps to 0 and the scroll lands in the page's corner.
      if (!Number.isFinite(Number(c.x)) || !Number.isFinite(Number(c.y))) return null;
      const dy = Math.max(-3000, Math.min(3000, Math.round(Number(c.dy)) || 0));
      if (!dy) return null;
      return { kind: "scroll", x: unit(c.x), y: unit(c.y), dy };
    }
    case "type": {
      const text = String(c.text ?? "").slice(0, 500);
      if (!text) return null;
      return { kind: "type", text };
    }
    case "key": {
      const key = String(c.key ?? "").slice(0, 24);
      if (!key) return null;
      return { kind: "key", key };
    }
    case "reload":
      return { kind: "reload" };
    case "home":
      return { kind: "home" };
    case "navigate": {
      // Restricted to our own origins on purpose. The renderer runs inside the
      // private network and its screen is readable via the preview AND visible
      // on the live stream, so an arbitrary URL here would be both an SSRF
      // read primitive and a way to broadcast anything. `home`/`reload` cover
      // the real operational need; widen this deliberately if ever required.
      const raw = String(c.url ?? "").slice(0, 500);
      let u: URL;
      try { u = new URL(raw); } catch { return null; }
      if (u.protocol !== "https:" && u.protocol !== "http:") return null;
      if (!navAllowedHosts().has(u.hostname.toLowerCase())) return null;
      return { kind: "navigate", url: u.toString() };
    }
    default:
      return null;
  }
}
