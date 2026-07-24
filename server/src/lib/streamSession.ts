import { randomBytes } from "node:crypto";
import { prisma } from "../db.js";

// ── Stream auto-login sessions ────────────────────────────────────────
// A StreamKey is a per-account, admin-enabled, constant secret that lets
// an unattended browser (OBS browser source, a 24/7 stream box) log into
// ONE specific account by hitting a stable URL:
//
//     https://<api>/stream-login?key=<key>
//
// The endpoint validates the key and sets an httpOnly `pkmn_stream`
// cookie, after which every credentialed request resolves to that
// account — WITHOUT a Better Auth session and WITHOUT participating in
// single-active-session enforcement (so the owner can still play on their
// own browser at the same time, and neither kicks the other).
//
// The resulting session is RESTRICTED (isStream=true): it can play and
// save, but the middleware forces isAdmin=false and the sensitive-action
// guards (account settings, trades, auctions) reject it. So even if the
// link leaks, it can't drain or hijack the account.
//
// Revocation is immediate: disable (enabled=false) or delete the row, or
// regenerate to rotate the secret — any of these makes the cookie stop
// resolving on the very next request, because the key is looked up live
// every time (the cookie stores the key itself, not a signed snapshot).

export const STREAM_COOKIE = "pkmn_stream";

export type StreamAuth = {
  userId: string;
  username: string;
  config: string | null;
};

// Stream automation config an admin sets per key. Validated loosely (admin
// input) before it's stored; the client applies it when the stream boots.
export interface StreamConfig {
  startRoute?: string;
  autoBuyBalls?: { enabled: boolean; ballId: string; restockTo: number };
}

export function sanitizeStreamConfig(raw: unknown): StreamConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: StreamConfig = {};
  if (typeof r.startRoute === "string" && r.startRoute.length > 0 && r.startRoute.length < 64) {
    out.startRoute = r.startRoute;
  }
  const ab = r.autoBuyBalls;
  if (ab && typeof ab === "object") {
    const a = ab as Record<string, unknown>;
    const ballId = typeof a.ballId === "string" ? a.ballId : "pokeball";
    const restockTo = Math.max(1, Math.min(9999, Math.floor(Number(a.restockTo) || 50)));
    out.autoBuyBalls = { enabled: !!a.enabled, ballId, restockTo };
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function parseStreamConfig(json: string | null | undefined): StreamConfig | null {
  if (!json) return null;
  try { return sanitizeStreamConfig(JSON.parse(json)); } catch { return null; }
}

// Mint a fresh high-entropy key. 32 bytes → 64 hex chars. `sk_` prefix
// makes it recognisable in logs/URLs as a stream key (never logged in
// full, but the prefix helps triage).
export function generateStreamKey(): string {
  return `sk_${randomBytes(32).toString("hex")}`;
}

// Pull the stream key out of a raw Cookie header. Hand-rolled so we don't
// depend on Hono's cookie helper in the socket layer (which only has the
// raw header string). Returns null when absent.
export function readStreamCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === STREAM_COOKIE) {
      const raw = part.slice(eq + 1).trim();
      try { return decodeURIComponent(raw); } catch { return raw; }
    }
  }
  return null;
}

// Resolve a raw key value (from the cookie or the login query) to the
// account it logs into. Returns null when the key is unknown, disabled,
// or the account is banned — the caller treats null as "not a valid
// stream session" and falls through to the normal 401 path.
export async function resolveStreamKey(key: string | null | undefined): Promise<StreamAuth | null> {
  if (!key || typeof key !== "string" || key.length < 20) return null;
  const row = await prisma.streamKey.findUnique({
    where: { key },
    select: {
      enabled: true,
      config: true,
      user: { select: { id: true, username: true, email: true, bannedUntil: true } },
    },
  });
  if (!row || !row.enabled || !row.user) return null;
  if (row.user.bannedUntil && row.user.bannedUntil.getTime() > Date.now()) return null;
  return {
    userId: row.user.id,
    username: row.user.username ?? row.user.email.split("@")[0],
    config: row.config ?? null,
  };
}

// Record that a key was just used (best-effort, fire-and-forget). Lets the
// admin dashboard show "last used" so a dead stream is obvious. Throttled
// to at most once per minute per key so a chatty client doesn't hammer
// the DB with an UPDATE on every request.
const lastTouch = new Map<string, number>();
export function touchStreamKey(key: string, ip: string | null): void {
  const now = Date.now();
  const prev = lastTouch.get(key) ?? 0;
  if (now - prev < 60_000) return;
  lastTouch.set(key, now);
  prisma.streamKey
    .update({ where: { key }, data: { lastUsedAt: new Date(now), lastUsedIp: ip ?? undefined } })
    .catch(() => undefined);
}

// Build the Set-Cookie header value for the stream cookie. Mirrors the
// Better Auth session cookie attributes (httpOnly, Lax, Secure in prod)
// so it travels with the same-site credentialed fetches the game already
// makes. Long Max-Age (400 days — the browser cap) because the whole
// point is a link that "remains constant". Revocation is server-side, not
// via cookie expiry.
export function streamCookieHeader(key: string): string {
  const secure = process.env.NODE_ENV === "production" ? "Secure; " : "";
  return `${STREAM_COOKIE}=${encodeURIComponent(key)}; Path=/; Max-Age=34560000; HttpOnly; ${secure}SameSite=Lax`;
}

export function clearStreamCookieHeader(): string {
  const secure = process.env.NODE_ENV === "production" ? "Secure; " : "";
  return `${STREAM_COOKIE}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; ${secure}SameSite=Lax`;
}
