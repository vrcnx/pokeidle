import { prisma } from "../db.js";

// Control layer for the 24/7 Twitch renderer (see the standalone `renderer/`
// service). Exactly one row (id = "singleton") holds the DESIRED broadcast
// state written by the admin dashboard, plus the LIVE status the renderer
// reports back on each poll.
export const BROADCAST_ID = "singleton";

// Encode-quality clamps. The renderer always captures the Xvfb display at
// 1920x1080 and lets ffmpeg scale to the output size, so any width/height up
// to 1080p is valid; fps is 30 or 60 in practice but we allow 24..60.
function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

// H.264 4:2:0 requires even width/height, else ffmpeg's scale filter errors.
function clampEven(v: unknown, lo: number, hi: number, fallback: number): number {
  return clampInt(v, lo, hi, fallback) & ~1;
}

// Read the singleton without writing. Only the very first call (when the row
// is absent) creates it — otherwise this would bump `updatedAt` on every
// renderer/admin poll and make the timestamp meaningless.
export async function getBroadcast() {
  const existing = await prisma.broadcastState.findUnique({ where: { id: BROADCAST_ID } });
  if (existing) return existing;
  return prisma.broadcastState.upsert({
    where: { id: BROADCAST_ID },
    create: { id: BROADCAST_ID },
    update: {},
  });
}

export interface BroadcastPatch {
  enabled?: boolean;
  accountUserId?: string | null;
  width?: number;
  height?: number;
  fps?: number;
  bitrateKbps?: number;
}

export async function setBroadcast(patch: BroadcastPatch) {
  const data: BroadcastPatch = {};
  if (patch.enabled !== undefined) data.enabled = !!patch.enabled;
  if (patch.accountUserId !== undefined) data.accountUserId = patch.accountUserId || null;
  if (patch.width !== undefined) data.width = clampEven(patch.width, 640, 1920, 1920);
  if (patch.height !== undefined) data.height = clampEven(patch.height, 360, 1080, 1080);
  if (patch.fps !== undefined) data.fps = clampInt(patch.fps, 24, 60, 30);
  if (patch.bitrateKbps !== undefined) data.bitrateKbps = clampInt(patch.bitrateKbps, 1500, 9000, 6000);
  return prisma.broadcastState.upsert({
    where: { id: BROADCAST_ID },
    create: { id: BROADCAST_ID, ...data },
    update: data,
  });
}

export async function reportBroadcastStatus(live: boolean, status: unknown) {
  return prisma.broadcastState
    .update({
      where: { id: BROADCAST_ID },
      data: {
        live: !!live,
        lastStatus: JSON.stringify(status ?? {}).slice(0, 4000),
        lastStatusAt: new Date(),
      },
    })
    .catch(() => null);
}

// Build the one-shot stream-login URL the renderer opens in Chromium. Derived
// from the configured account's ENABLED StreamKey; returns null if the account
// is unset, has no key, or the key is disabled (which safely halts the stream).
export async function resolveLoginUrl(accountUserId: string | null): Promise<string | null> {
  if (!accountUserId) return null;
  const key = await prisma.streamKey.findUnique({
    where: { userId: accountUserId },
    select: { key: true, enabled: true },
  });
  if (!key || !key.enabled) return null;
  const base = (process.env.BETTER_AUTH_URL?.trim() || "").replace(/\/$/, "");
  if (!base) return null;
  return `${base}/stream-login?key=${encodeURIComponent(key.key)}`;
}
