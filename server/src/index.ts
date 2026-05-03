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
import { makeRateLimiter } from "./lib/rateLimit.js";

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

const server = serve(
  {
    fetch: app.fetch,
    port: PORT,
  },
  (info) => {
    console.log(`[server] listening on http://localhost:${info.port}`);
    console.log(`[server] frontend origins: ${FRONTEND_ORIGINS.join(", ")}`);
    console.log(`[server] Google OAuth: ${process.env.GOOGLE_CLIENT_ID ? "enabled" : "disabled (set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET to enable)"}`);
  }
);

// Attach Socket.IO to the same HTTP server.
attachSocketServer(server as any);
