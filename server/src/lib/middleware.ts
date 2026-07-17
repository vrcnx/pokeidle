import type { MiddlewareHandler } from "hono";
import { timingSafeEqual } from "node:crypto";
import { auth } from "../auth.js";
import { prisma } from "../db.js";
import { kickSession } from "../socket.js";

function notifySessionKicked(userId: string, sessionId: string) {
  // Disconnect the matching socket(s) and notify the client so the
  // browser can show the auth modal immediately, instead of waiting
  // for its next API call to 401. Failure is non-fatal.
  try { kickSession(userId, sessionId); } catch { /* socket layer may not be up yet */ }
}

// Hono variable map types — exposes `user` (and `isAdmin` after
// requireAdmin runs) on the context.
declare module "hono" {
  interface ContextVariableMap {
    user: { id: string; username: string; email: string; name: string | null; isAdmin: boolean };
    /** True when the caller authenticated with ADMIN_API_KEY rather than
     *  a browser session. Read by routes/admin.ts to stamp the audit
     *  trail so agent actions are distinguishable from dashboard clicks. */
    viaApiKey?: boolean;
  }
}

export const requireUser: MiddlewareHandler = async (c, next) => {
  // Already authenticated upstream by adminApiKey. Skip the session
  // lookup entirely — a machine caller has no cookie, and the
  // single-active-session enforcement below would be actively wrong
  // for it (it would start deleting the acting admin's real browser
  // sessions on every CLI call).
  if (c.get("viaApiKey")) return next();

  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) {
    return c.json({ error: "unauthorized" }, 401);
  }

  // Single-active-session enforcement. Pull all of this user's
  // sessions ordered most-recent first. The newest session "owns"
  // the account; every older one gets deleted so the old browsers
  // can't keep playing on stale cookies.
  //
  // Grace window: if two sessions were created within `RACE_GRACE_MS`
  // of each other (e.g. concurrent logins from two tabs racing through
  // signup → cookie set), treat them as a tie and don't kick either.
  // Without this, two simultaneous logins can mutually delete each
  // other's session under load.
  const RACE_GRACE_MS = 3_000;
  const sessions = await prisma.session.findMany({
    where: {
      userId: session.user.id,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true },
  });
  const newest = sessions[0];
  const currentSessionId = (session as any).session?.id;
  const current = sessions.find((s) => s.id === currentSessionId);

  if (
    newest &&
    currentSessionId &&
    current &&
    newest.id !== currentSessionId &&
    // Only kick if the newest is meaningfully newer than us.
    newest.createdAt.getTime() - current.createdAt.getTime() > RACE_GRACE_MS
  ) {
    // The caller is on an older session — a newer login has happened
    // elsewhere. Delete this session and 401 the request.
    await prisma.session.delete({ where: { id: currentSessionId } }).catch(() => undefined);
    notifySessionKicked(session.user.id, currentSessionId);
    return c.json({
      error: "session_replaced",
      reason: "Signed in from another browser/device",
    }, 401);
  }

  // The caller IS (or ties with) the newest session. Proactively delete
  // every clearly-older session so the previous tabs/devices flip to
  // 401 on their next request — no waiting for them to be the one
  // calling in. Sessions within the grace window are spared.
  const cutoffMs = (current?.createdAt.getTime() ?? Date.now()) - RACE_GRACE_MS;
  const staleIds = sessions
    .slice(1)
    .filter((s) => s.createdAt.getTime() < cutoffMs)
    .map((s) => s.id);
  if (staleIds.length > 0) {
    await prisma.session.deleteMany({ where: { id: { in: staleIds } } }).catch(() => undefined);
    for (const id of staleIds) notifySessionKicked(session.user.id, id);
  }

  // Pull the isAdmin flag from the User row — Better Auth's session
  // payload is generic and doesn't include our custom columns.
  let dbUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { isAdmin: true, bannedUntil: true },
  });
  if (dbUser?.bannedUntil && dbUser.bannedUntil.getTime() > Date.now()) {
    return c.json({ error: "banned", bannedUntil: dbUser.bannedUntil }, 403);
  }

  // Bootstrap promotion: if env declares an admin email and this user
  // matches but isn't admin yet, flip the flag now. This is the "first
  // admin gets in via env" pattern — once promoted, manage further
  // admins through the dashboard.
  const bootstrapEmail = process.env.ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase();
  if (
    bootstrapEmail &&
    session.user.email.toLowerCase() === bootstrapEmail &&
    !dbUser?.isAdmin
  ) {
    await prisma.user.update({
      where: { id: session.user.id },
      data: { isAdmin: true },
    });
    dbUser = { isAdmin: true, bannedUntil: null };
    console.log(`[admin-bootstrap] promoted ${session.user.email}`);
  }

  c.set("user", {
    id: session.user.id,
    username: (session.user as any).username ?? session.user.email.split("@")[0],
    email: session.user.email,
    name: session.user.name ?? null,
    isAdmin: !!dbUser?.isAdmin,
  });
  await next();
};

// Strict gate for admin-only endpoints. Layer on top of requireUser.
export const requireAdmin: MiddlewareHandler = async (c, next) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "unauthorized" }, 401);
  if (!user.isAdmin) return c.json({ error: "forbidden" }, 403);
  await next();
};

// ── Machine auth for admin endpoints ──────────────────────────────────
// Lets non-browser callers (the scripts/admin.ts CLI, cron jobs, an
// operator's agent) drive the same admin endpoints the dashboard uses,
// without holding a Better Auth session cookie.
//
// Security posture — this is a privileged bypass, so it is deliberately
// hard to enable and easy to audit:
//   * OFF unless ADMIN_API_KEY is set in the server env. No default, no
//     dev fallback. An unset key means the header is simply ignored and
//     the request falls through to normal session auth.
//   * Key must be >= 32 chars. A short key is treated as misconfiguration
//     and refused outright rather than silently accepted.
//   * Constant-time compare (timingSafeEqual) so the key cannot be
//     recovered byte-by-byte via response timing.
//   * The key does not mint a new identity. It ACTS AS a real admin row
//     (ADMIN_API_KEY_USERNAME, else the oldest admin). If that user is
//     not an admin, the request is refused. Revoking that user's admin
//     flag therefore revokes the key.
//   * Every action lands in AdminAudit attributed to that admin with
//     `via: "api-key"` in the meta (see withVia in routes/admin.ts), so
//     the ledger distinguishes agent actions from dashboard clicks.
//   * The key value is never logged.
function keyMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so gate on it first.
  // Length is not itself a secret worth protecting here.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Runs BEFORE requireUser. With no `x-admin-key` header it is a no-op
// and the request falls through to the normal session path untouched.
// With a valid key it populates `user` itself and sets `viaApiKey`,
// which makes requireUser skip its session work on the way past.
export const adminApiKey: MiddlewareHandler = async (c, next) => {
  const provided = c.req.header("x-admin-key");

  // No header → normal browser/session path. Unchanged behaviour.
  if (!provided) return next();

  const expected = process.env.ADMIN_API_KEY?.trim();
  if (!expected) {
    return c.json({ error: "unauthorized", reason: "api key auth is not enabled on this server" }, 401);
  }
  if (expected.length < 32) {
    console.error("[admin-api-key] ADMIN_API_KEY is set but shorter than 32 chars — refusing to honour it.");
    return c.json({ error: "unauthorized", reason: "api key auth is misconfigured" }, 401);
  }
  if (!keyMatches(provided, expected)) {
    return c.json({ error: "unauthorized" }, 401);
  }

  // Resolve the human the key acts as, so the audit trail names a real
  // account rather than a ghost.
  const actAs = process.env.ADMIN_API_KEY_USERNAME?.trim();
  const actor = actAs
    ? await prisma.user.findUnique({
        where: { username: actAs },
        select: { id: true, username: true, email: true, name: true, isAdmin: true },
      })
    : await prisma.user.findFirst({
        where: { isAdmin: true },
        orderBy: { createdAt: "asc" },
        select: { id: true, username: true, email: true, name: true, isAdmin: true },
      });

  if (!actor) {
    return c.json({ error: "forbidden", reason: "api key actor not found" }, 403);
  }
  if (!actor.isAdmin) {
    // Demoting the actor is the revocation path for the key.
    return c.json({ error: "forbidden", reason: "api key actor is not an admin" }, 403);
  }

  c.set("user", {
    id: actor.id,
    username: actor.username,
    email: actor.email,
    name: actor.name,
    isAdmin: true,
  });
  c.set("viaApiKey", true);
  await next();
};
