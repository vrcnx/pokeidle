import { Hono } from "hono";
import { requireUser } from "../lib/middleware.js";
import { getLiveAnnouncement, toPublic } from "../lib/announcements.js";

// PLAYER-facing. The only thing a normal player may do with the banner is
// read the current one. Admin CRUD lives in routes/admin.ts behind the
// admin gate. Kept separate from the socket push so the very first paint —
// before the socket has connected — still has the banner.
const app = new Hono();
app.use("*", requireUser);

// GET /api/announcements/active — the live banner or null.
app.get("/active", async (c) => {
  const a = await getLiveAnnouncement();
  return c.json({ announcement: a ? toPublic(a) : null });
});

export default app;
