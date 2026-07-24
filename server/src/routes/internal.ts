import { Hono } from "hono";
import type { Context } from "hono";
import { timingSafeEqual } from "node:crypto";
import { getBroadcast, reportBroadcastStatus, resolveLoginUrl } from "../lib/broadcast.js";
import { drainInput, isWatching, putFrame } from "../lib/browserControl.js";

// Internal endpoints for the standalone 24/7 renderer service. Authenticated
// by a shared bearer secret (RENDERER_TOKEN) — NOT an admin session — because
// the renderer is a headless machine, not a logged-in human. Keep this route
// tiny and machine-only: it never touches player data, only the broadcast
// control row.
const app = new Hono();

// A JSON body of literal `null` (or an array/scalar) survives `.catch(() => ({}))`
// and then throws on property access — a 500 plus a bogus ErrorLog row. Normalise
// to a plain object first.
async function jsonObject(c: Context): Promise<Record<string, unknown>> {
  const raw = await c.req.json().catch(() => null);
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function tokenOk(c: Context): boolean {
  const expected = process.env.RENDERER_TOKEN?.trim();
  // Fail closed: no token configured on the server → the renderer API is off.
  if (!expected || expected.length < 16) return false;
  const hdr = c.req.header("authorization") ?? "";
  const provided = hdr.startsWith("Bearer ")
    ? hdr.slice(7).trim()
    : (c.req.header("x-renderer-key") ?? "").trim();
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

app.use("*", async (c, next) => {
  if (!tokenOk(c)) return c.json({ error: "unauthorized" }, 401);
  return next();
});

// GET /api/internal/broadcast/state — the renderer polls this to learn whether
// it should be live, which stream-login URL to open, and at what quality. The
// login URL is resolved fresh each poll from the account's StreamKey, so
// disabling the key (or clearing the account) cleanly stops the broadcast.
app.get("/broadcast/state", async (c) => {
  const b = await getBroadcast();
  const loginUrl = b.enabled ? await resolveLoginUrl(b.accountUserId) : null;
  return c.json({
    enabled: b.enabled && !!loginUrl,
    loginUrl,
    account: b.accountUserId,
    width: b.width,
    height: b.height,
    fps: b.fps,
    bitrateKbps: b.bitrateKbps,
    // Live browser control: capture frames only while an admin is watching
    // (it costs renderer CPU), and hand over any queued clicks/keystrokes.
    watching: isWatching(),
    input: drainInput(),
  });
});

// POST /api/internal/broadcast/frame — renderer uploads a preview screenshot
// of the page for the admin's live-control panel. Kept in memory only.
app.post("/broadcast/frame", async (c) => {
  const body = (await jsonObject(c)) as { data?: string; width?: number; height?: number };
  if (!body.data || typeof body.data !== "string") return c.json({ error: "data required" }, 400);
  // ~4MB of base64 is a generous ceiling for a JPEG frame.
  if (body.data.length > 4_000_000) return c.json({ error: "frame too large" }, 413);
  putFrame(body.data, Number(body.width) || 0, Number(body.height) || 0);
  return c.json({ ok: true });
});

// POST /api/internal/broadcast/status — the renderer reports its live status
// (live?, uptime, encoder stats, last error) so the admin dashboard can show
// what's actually happening on the box.
app.post("/broadcast/status", async (c) => {
  const body = (await jsonObject(c)) as { live?: boolean };
  await reportBroadcastStatus(!!body.live, body);
  return c.json({ ok: true });
});

export default app;
