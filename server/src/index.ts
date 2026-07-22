import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { auth } from "./auth.js";
import { attachSocketServer } from "./socket.js";
import savesRoute from "./routes/saves.js";
import profileRoute from "./routes/profile.js";
import friendsRoute from "./routes/friends.js";
import chatRoute from "./routes/chat.js";
import adminRoute from "./routes/admin.js";
import mapRoute from "./routes/map.js";
import bugReportsRoute from "./routes/bugReports.js";
import pvpRoute from "./routes/pvp.js";
import giveawaysRoute from "./routes/giveaways.js";
import announcementsRoute from "./routes/announcements.js";
import dailiesRoute from "./routes/dailies.js";
import publicRoute from "./routes/public.js";
import auctionsRoute from "./routes/auctions.js";
import pollsRoute from "./routes/polls.js";
import { makeRateLimiter } from "./lib/rateLimit.js";
import { recordError } from "./lib/errorReporting.js";
import { logger } from "./lib/logger.js";
import { startAuctionSettlementLoop } from "./lib/auctionSettlement.js";

const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGIN ?? "http://localhost:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const PORT = parseInt(process.env.PORT ?? "8787", 10);

const app = new Hono();

// CORS: allow the game frontend(s) and admin dashboard to send cookies.
// `origin` accepts a function so we can reflect any of the configured
// origins on the per-request basis (browsers don't accept lists in
// Access-Control-Allow-Origin).
app.use(
  "*",
  cors({
    // Reflect the request origin only if it's explicitly allow-listed.
    // Returning null (rather than a fallback origin) makes the browser
    // refuse the response entirely, which is the correct behaviour for
    // unknown origins — falling back to FRONTEND_ORIGINS[0] would
    // attach Allow-Credentials:true to a header that names an origin
    // the request didn't come from, which is ambiguous-at-best.
    origin: (origin) =>
      origin && FRONTEND_ORIGINS.includes(origin) ? origin : null,
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    exposeHeaders: ["Set-Cookie"],
    maxAge: 600,
  })
);

// Health check.
app.get("/healthz", (c) => c.json({ ok: true, t: Date.now() }));

// Public probe for which auth providers are configured. The frontend
// uses this to show or hide the "Continue with Google" button — when
// Google OAuth env vars aren't set, Better Auth doesn't register the
// social-sign-in route, so showing the button would just 404 the user.
app.get("/api/auth/providers", (c) => {
  return c.json({
    google: !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET,
  });
});

// Sledgehammer sign-out. Better Auth's POST /api/auth/sign-out is the
// primary path (deletes the current session row + clears the cookie),
// but reports of users staying signed-in after clicking sign-out
// suggest its cookie-clear is sometimes lost (cross-site Set-Cookie
// drop, or the session cookie token wasn't received and so its
// session lookup returns nothing to delete). This endpoint takes a
// belt-and-braces approach:
//   1. Identify the user via the existing session (uses Better Auth's
//      getSession off the cookie).
//   2. Delete EVERY session row that user owns — kicks every device.
//   3. Clear the auth cookie ourselves on the response.
// The frontend hits this AFTER calling Better Auth's sign-out, so a
// stale cookie can't keep authenticating against a still-alive DB
// session anywhere.
import { auth as authForSignOut } from "./auth.js";
app.post("/api/auth/sign-out-all", async (c) => {
  try {
    const session = await authForSignOut.api.getSession({ headers: c.req.raw.headers });
    if (session?.user?.id) {
      await import("./db.js").then(({ prisma }) =>
        prisma.session.deleteMany({ where: { userId: session.user.id } }),
      );
    }
  } catch { /* best effort — even if lookup fails, still clear cookies below */ }
  // Clear every cookie this app is known to set. We can't enumerate
  // dynamically, so we hit the well-known names from auth config.
  // These match the `cookiePrefix: "pkmn"` setting in auth.ts.
  const expired = "Thu, 01 Jan 1970 00:00:00 GMT";
  for (const name of ["pkmn.session_token", "pkmn.session_data", "pkmn.dont_remember"]) {
    c.header(
      "Set-Cookie",
      `${name}=; Path=/; Expires=${expired}; HttpOnly; ${process.env.NODE_ENV === "production" ? "Secure;" : ""} SameSite=Lax`,
      { append: true },
    );
  }
  return c.json({ ok: true });
});

// Better Auth — handles /api/auth/* (signup, signin, OAuth callbacks, etc).
// Rate-limit credential / signup endpoints by client IP so a single
// attacker can't credential-stuff or pile up account-creation requests.
// 30 hits per 15 minutes is loose enough to never affect a real user
// (a wrong password retry burst is well under that) but blocks volume
// attacks. OAuth callbacks aren't gated — they're driven by the IDP.
const authLimiter = makeRateLimiter({ tokens: 30, windowMs: 15 * 60_000 });
// Resolve the client IP for rate-limiting. The naive `X-Forwarded-For
// leftmost` approach is a classic pitfall: any client can send an
// arbitrary header value and land in a fresh rate-limit bucket every
// request, defeating the auth limiter and enabling brute-force
// credential stuffing. We trust XFF (rightmost = closest proxy that
// we control) ONLY when the deployment opts in via the
// TRUSTED_PROXY env var, which should be set on Railway/Vercel/etc.
// where the platform terminates TLS and appends a verified
// client-IP hop. Otherwise we fall back to the socket address.
const TRUST_PROXY = (process.env.TRUSTED_PROXY ?? "").toLowerCase() === "true";
const clientIp = (c: any): string => {
  if (TRUST_PROXY) {
    const xff = c.req.header("x-forwarded-for");
    if (xff) {
      // Rightmost = the IP the trusted proxy actually saw; leftmost
      // entries were claimed by the client and can't be trusted.
      const hops = xff.split(",").map((s: string) => s.trim()).filter(Boolean);
      const last = hops[hops.length - 1];
      if (last) return last;
    }
    const real = c.req.header("x-real-ip");
    if (real) return real.trim();
  }
  // Direct socket address — works when the server isn't behind a
  // proxy. @hono/node-server exposes the raw connection on c.env.incoming.
  const raw = (c.env as any)?.incoming;
  const sock = raw?.socket?.remoteAddress ?? raw?.connection?.remoteAddress;
  return sock || "unknown";
};
app.all("/api/auth/*", async (c) => {
  const path = new URL(c.req.url).pathname;
  if (path.includes("/sign-in/") || path.includes("/sign-up/")) {
    if (!authLimiter.consume(`auth:${clientIp(c)}`)) {
      return c.json({ error: "too many attempts, slow down" }, 429);
    }
  }
  return auth.handler(c.req.raw);
});

// API routes.
app.route("/api/saves", savesRoute);
app.route("/api/profile", profileRoute);
app.route("/api/friends", friendsRoute);
app.route("/api/chat", chatRoute);
app.route("/api/admin", adminRoute);
app.route("/api/map", mapRoute);
app.route("/api/bug-reports", bugReportsRoute);
app.route("/api/pvp", pvpRoute);
app.route("/api/giveaways", giveawaysRoute);
app.route("/api/announcements", announcementsRoute);
app.route("/api/dailies", dailiesRoute);
app.route("/api/public", publicRoute);
app.route("/api/auctions", auctionsRoute);
app.route("/api/polls", pollsRoute);

// Global error handler — anything that throws inside a route handler
// without being caught lands here. We persist a structured ErrorLog
// row so it shows up in the admin dashboard, then return a generic
// 500 to the client (no stack traces leaked over the wire).
app.onError(async (err, c) => {
  const path = new URL(c.req.url).pathname;
  // The Hono context may or may not have user populated depending on
  // where the throw happened. Try to read it best-effort.
  let user: { id: string; username: string } | null = null;
  try { const u = c.get("user"); if (u) user = { id: u.id, username: u.username }; } catch { /* */ }
  // message stays a fixed classifier (constructor name), not the raw
  // exception text — this is the catch-all for every uncaught throw in
  // every route, and raw error text (Prisma constraint names, ids,
  // per-request validation strings, etc.) almost always differs between
  // occurrences, which used to fragment one real error type into a
  // separate (kind, message) dashboard group per occurrence.
  await recordError({
    kind: "server",
    message: err instanceof Error ? err.constructor.name : "non_error_throw",
    stack: err instanceof Error ? err.stack ?? null : null,
    source: `${c.req.method} ${path}`,
    userId: user?.id ?? null,
    username: user?.username ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    meta: { errorMessage: err instanceof Error ? err.message : String(err) },
  }).catch(() => undefined);
  return c.json({ error: "internal_error" }, 500);
});

const server = serve(
  {
    fetch: app.fetch,
    port: PORT,
  },
  (info) => {
    logger.info("server listening", {
      port: info.port,
      frontendOrigins: FRONTEND_ORIGINS,
      googleOAuth: !!process.env.GOOGLE_CLIENT_ID,
      nodeEnv: process.env.NODE_ENV ?? "development",
    });
  }
);

// Attach Socket.IO to the same HTTP server.
attachSocketServer(server as any);

// Auctions settle on a timer independent of either player being
// connected — see lib/auctionSettlement.ts.
startAuctionSettlementLoop();

// Catch truly fatal failures that would otherwise just exit the
// process silently. Log + persist (best-effort) before letting the
// process die — Railway's restart policy will bring it back.
process.on("uncaughtException", (err) => {
  recordError({
    kind: "server",
    level: "error",
    message: `[uncaughtException] ${err.constructor.name}`,
    stack: err.stack ?? null,
    source: "process.uncaughtException",
    meta: { errorMessage: err.message },
  }).catch(() => undefined);
});
process.on("unhandledRejection", (reason: unknown) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  recordError({
    kind: "server",
    level: "error",
    message: `[unhandledRejection] ${err.constructor.name}`,
    stack: err.stack ?? null,
    source: "process.unhandledRejection",
    meta: { errorMessage: err.message },
  }).catch(() => undefined);
});
