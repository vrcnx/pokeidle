import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireUser } from "../lib/middleware.js";
import { computeAccountLevel } from "../lib/level.js";
import { validateSave } from "../lib/saveValidation.js";
import { makeRateLimiter } from "../lib/rateLimit.js";

const app = new Hono();

// Save uploads — generous but capped. The client autosaves periodically
// (every ~10 s); 30 writes/minute is well above that and protects the
// DB from a runaway loop or malicious flood.
const saveLimiter = makeRateLimiter({ tokens: 30, windowMs: 60_000 });

// GET /api/saves — return the caller's last cloud save.
app.get("/", requireUser, async (c) => {
  const user = c.get("user");
  const u = await prisma.user.findUnique({
    where: { id: user.id },
    select: { saveData: true, saveVersion: true, saveUpdatedAt: true },
  });
  if (!u) return c.json({ error: "user not found" }, 404);
  return c.json({
    saveData: u.saveData ? JSON.parse(u.saveData) : null,
    saveVersion: u.saveVersion,
    saveUpdatedAt: u.saveUpdatedAt,
  });
});

// POST /api/saves — upload a snapshot. Bumps saveVersion; recomputes
// derived account-level fields from the save payload. Optional
// `expectedSaveVersion` lets the client opt in to compare-and-swap
// semantics: server rejects if the cloud copy has advanced past what
// the client thought it knew (= someone else wrote in between, or the
// client is rolling back).
const UploadBody = z.object({
  saveData: z.record(z.string(), z.unknown()),
  expectedSaveVersion: z.number().int().min(0).optional(),
});

// Hard upper bound on serialized save size (1 MB). A normal save is
// well under 100 KB; anything beyond a megabyte is either a bug or an
// attacker trying to OOM the JSON parser. We check the Content-Length
// header where available, then again on the parsed body.
const MAX_SAVE_BYTES = 1_000_000;

app.post("/", requireUser, async (c) => {
  const user = c.get("user");
  if (!saveLimiter.consume(user.id)) {
    return c.json({ error: "rate_limited", retryAfter: 60 }, 429);
  }
  const lenHeader = c.req.header("content-length");
  if (lenHeader && parseInt(lenHeader, 10) > MAX_SAVE_BYTES) {
    return c.json({ error: "save too large" }, 413);
  }
  const raw = await c.req.text();
  if (raw.length > MAX_SAVE_BYTES) {
    return c.json({ error: "save too large" }, 413);
  }
  let parsedJson: unknown;
  try { parsedJson = JSON.parse(raw); } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  const parsed = UploadBody.safeParse(parsedJson);
  if (!parsed.success) return c.json({ error: "invalid body", details: parsed.error.flatten() }, 400);

  const save = parsed.data.saveData;

  // 1) Anti-cheat: bounds-check the payload before persisting. Rejects
  // obviously bogus saves (level > 100, negative money, party > 6, ...).
  const v = validateSave(save);
  if (!v.ok) {
    return c.json({ error: "save rejected", reason: v.reason }, 400);
  }

  // 2) Monotonic guard. The server-stored `saveVersion` is the source
  // of truth — we increment it on every accepted write. If the client
  // sends `expectedSaveVersion`, we reject when the cloud copy has
  // advanced past it (someone else wrote between this client's last
  // pull and now, or the client is rolling back). The client `__savedAt`
  // is still echoed for diagnostics but no longer the gate.
  const existing = await prisma.user.findUnique({
    where: { id: user.id },
    select: { saveVersion: true },
  });
  const expected = parsed.data.expectedSaveVersion;
  if (existing && expected !== undefined && expected < existing.saveVersion) {
    return c.json({
      error: "stale save",
      reason: "the cloud copy has advanced past your client's last known version",
      serverSaveVersion: existing.saveVersion,
      clientExpectedVersion: expected,
    }, 409);
  }

  const derived = computeAccountLevel(save);
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      saveData: JSON.stringify(save),
      saveVersion: { increment: 1 },
      saveUpdatedAt: new Date(),
      accountLevel: derived.accountLevel,
      totalCaughtLevels: derived.totalCaughtLevels,
      pokedexCaughtCount: derived.pokedexCaughtCount,
    },
    select: {
      saveVersion: true,
      saveUpdatedAt: true,
      accountLevel: true,
      totalCaughtLevels: true,
      pokedexCaughtCount: true,
    },
  });
  return c.json({ ok: true, ...updated });
});

export default app;
