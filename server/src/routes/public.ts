import { Hono } from "hono";
import { liveOnlineSnapshot } from "../socket.js";

// Public endpoints — no auth, no session cookie required. Used by the
// pre-sign-in landing surfaces (LoginScreen, unauthenticated landing
// pages) to show live-game vitality without leaking anything the user
// couldn't see by opening the app in an incognito tab.

const app = new Hono();

// GET /api/public/online — { count: number }
// Snapshots the in-memory presence map (userId → sockets) and returns
// the number of distinct users currently connected. Cheap; no DB
// round-trip. Callers should poll on a modest interval (10–30 s) —
// there is no push channel for anonymous clients.
app.get("/online", (c) => {
  const snapshot = liveOnlineSnapshot();
  return c.json({ count: snapshot.length });
});

export default app;
