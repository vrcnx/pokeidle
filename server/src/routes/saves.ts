import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireUser } from "../lib/middleware.js";
import { computeAccountLevel } from "../lib/level.js";
import { validateSave, MAX_BOX } from "../lib/saveValidation.js";
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

// Hard upper bound on serialized save size. Guards the JSON parser against
// an OOM attempt. We check the Content-Length header where available, then
// again on the parsed body.
//
// Must stay consistent with saveValidation's MAX_BOX: a save the validator
// accepts must be one this transport can carry. These were picked
// independently and disagreed — MAX_BOX allowed 9999 mons while this capped
// the body at 1MB, so a save could be simultaneously valid and unsendable,
// 413ing forever with no client recovery. A save is ~600 bytes/mon, so 9999
// mons is ~6MB: the two constants contradicted each other by ~6x.
//
// Nobody has hit this yet — the largest of 1679 real boxes is 212 mons
// (~130KB), so there is ~8x headroom. Sizing the transport to the declared
// limit is the cheap half of the fix. The real fix is architectural: the
// whole collection ships in every save, so payload grows without bound and
// ANY constant here is a future outage. Delta saves are the answer; this
// buys the room to build them.
const MAX_SAVE_BYTES = 8_000_000;

// Measured against the real createPokemon shape, including the statStages
// the reducer spreads in wholesale: ~635 bytes per boxed mon.
const BYTES_PER_MON = 635;

// Fail at boot, not at 3am in a player's save. The two constants have no
// compile-time link, so this is the link: if someone raises MAX_BOX or
// lowers this cap such that a validator-approved save can no longer be
// SENT, the server refuses to start rather than silently 413ing veterans
// forever. That is exactly the failure mode this pair already shipped.
if (MAX_SAVE_BYTES < MAX_BOX * BYTES_PER_MON) {
  throw new Error(
    `Save limits contradict: MAX_BOX=${MAX_BOX} needs ~${MAX_BOX * BYTES_PER_MON} bytes `
    + `but MAX_SAVE_BYTES=${MAX_SAVE_BYTES}. A save could be valid yet unsendable.`
  );
}

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
    select: { saveVersion: true, saveData: true },
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

  // 2b) Anti-regression guard. Even with no expectedSaveVersion, refuse
  // writes from older clients that would erase major milestone progress
  // (Elite Four cleared, Champion defeated, badges earned, Pokédex
  // entries). Cross-device save-sync bugs in v1 of the client caused
  // a stale device to silently overwrite the canonical save and bury
  // weeks of progress. This guard catches every save-clobber path on
  // the server regardless of which client version sent the write.
  if (existing?.saveData) {
    try {
      const prior = JSON.parse(existing.saveData) as Record<string, unknown>;
      const sig = (s: Record<string, unknown>) => ({
        badges:   Array.isArray(s.defeatedGyms)      ? (s.defeatedGyms as unknown[]).length      : 0,
        e4:       Array.isArray(s.defeatedEliteFour) ? (s.defeatedEliteFour as unknown[]).length : 0,
        champion: !!s.championDefeated,
        caught:   Array.isArray(s.pokedexCaught)     ? (s.pokedexCaught as unknown[]).length     : 0,
      });
      const before = sig(prior);
      const after  = sig(save as Record<string, unknown>);
      const regressed =
           after.badges   < before.badges
        || after.e4       < before.e4
        || (before.champion && !after.champion)
        || after.caught   < before.caught;
      if (regressed) {
        return c.json({
          error: "regression_blocked",
          reason: "incoming save erases milestone progress — refusing to clobber the cloud copy",
          before,
          after,
        }, 409);
      }
    } catch {
      // Existing save unparseable; treat as if there's no prior — let
      // the new write through. This is the migration / corruption
      // recovery path.
    }
  }

  const derived = computeAccountLevel(save);
  // ATOMIC compare-and-swap.
  //
  // The version check ~50 lines above is a read; this is the write. Between
  // them another request from the same account can land, and both writers
  // pass a check neither of them still holds — classic check-then-act. Both
  // got `ok: true` and one save was silently destroyed.
  //
  // Putting saveVersion in the WHERE makes the database arbitrate: exactly
  // one of two concurrent writers matches a given version, the loser
  // matches no row and Prisma raises P2025, which is precisely a 409. The
  // read above stays as a fast path that returns a friendlier body.
  let updated;
  try {
    updated = await prisma.user.update({
    where: expected !== undefined
      ? { id: user.id, saveVersion: expected }
      : { id: user.id },
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
  } catch (e: any) {
    // P2025 = "record to update not found". The id is real (requireUser
    // resolved it), so the only way the WHERE misses is the saveVersion
    // guard: another write beat us. That is a conflict, not an error.
    if (e?.code === "P2025") {
      const now = await prisma.user.findUnique({
        where: { id: user.id },
        select: { saveVersion: true },
      });
      return c.json({
        error: "stale save",
        reason: "another device wrote while this save was in flight",
        serverSaveVersion: now?.saveVersion ?? null,
        clientExpectedVersion: expected ?? null,
      }, 409);
    }
    throw e;
  }
  return c.json({ ok: true, ...updated });
});

export default app;
