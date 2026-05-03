import type { MiddlewareHandler } from "hono";
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
  }
}

export const requireUser: MiddlewareHandler = async (c, next) => {
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
