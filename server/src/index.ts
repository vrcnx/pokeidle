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
import { makeRateLimiter } from "./lib/rateLimit.js";
import { recordError } from "./lib/errorReporting.js";
import { logger } from "./lib/logger.js";

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

// Better Auth — handles /api/auth/* (signup, signin, OAuth callbacks, etc).
// Rate-limit credential / signup endpoints by client IP so a single
// attacker can't credential-stuff or pile up account-creation requests.
// 30 hits per 15 minutes is loose enough to never affect a real user
// (a wrong password retry burst is well under that) but blocks volume
// attacks. OAuth callbacks aren't gated — they're driven by the IDP.
const authLimiter = makeRateLimiter({ tokens: 30, windowMs: 15 * 60_000 });
const clientIp = (c: any): string => {
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return c.req.header("x-real-ip") ?? "unknown";
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
  await recordError({
    kind: "server",
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack ?? null : null,
    source: `${c.req.method} ${path}`,
    userId: user?.id ?? null,
    username: user?.username ?? null,
    userAgent: c.req.header("user-agent") ?? null,
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

// Catch truly fatal failures that would otherwise just exit the
// process silently. Log + persist (best-effort) before letting the
// process die — Railway's restart policy will bring it back.
process.on("uncaughtException", (err) => {
  recordError({
    kind: "server",
    level: "error",
    message: `[uncaughtException] ${err.message}`,
    stack: err.stack ?? null,
    source: "process.uncaughtException",
  }).catch(() => undefined);
});
process.on("unhandledRejection", (reason: unknown) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  recordError({
    kind: "server",
    level: "error",
    message: `[unhandledRejection] ${err.message}`,
    stack: err.stack ?? null,
    source: "process.unhandledRejection",
  }).catch(() => undefined);
});
