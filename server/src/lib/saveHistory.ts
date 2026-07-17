import { prisma } from "../db.js";

// Append-only save history. See prisma/schema.prisma `SaveSnapshot`.
//
// The problem this solves: saveData is one column, overwritten in place, so
// an accepted-but-wrong write (a stale-tab clobber, a bad merge, a bug) was
// unrecoverable. Now a rolling set of checkpoints per player means any bad
// state can be rolled back to a known-good one.

// At most one auto snapshot per player per interval. Saves fire every few
// seconds while playing; snapshotting each would be thousands of near-
// identical rows. 30 minutes gives checkpoints spread across a play session
// (and across days for a casual player) without flooding the table.
const SNAPSHOT_INTERVAL_MS = 30 * 60_000;

// Ring size per player. 24 × ~8KB median ≈ 190KB/player; even at the 129KB
// max real save that is ~3MB for the single largest account. Comfortably
// bounded across ~1,800 players.
const MAX_SNAPSHOTS_PER_USER = 24;

// Take a periodic checkpoint of a just-accepted save, if the last one is old
// enough. Best-effort by contract: a failure here must NEVER fail the save
// that already committed — the snapshot is a bonus, the live write is truth.
export async function maybeSnapshot(userId: string, saveVersion: number, saveData: string): Promise<void> {
  try {
    const last = await prisma.saveSnapshot.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (last && Date.now() - last.createdAt.getTime() < SNAPSHOT_INTERVAL_MS) return;

    await prisma.saveSnapshot.create({
      data: { userId, saveVersion, saveData, reason: "auto" },
    });
    await pruneSnapshots(userId);
  } catch {
    /* history is a safety net, never a gate on the actual save */
  }
}

// Force a checkpoint regardless of the interval — used right before an admin
// restore so the restore is itself reversible. Also pruned. Not swallowed:
// the caller (restore) wants to know it captured the pre-state.
export async function forceSnapshot(userId: string, saveVersion: number, saveData: string, reason: string): Promise<void> {
  await prisma.saveSnapshot.create({ data: { userId, saveVersion, saveData, reason } });
  await pruneSnapshots(userId);
}

// Keep only the newest MAX_SNAPSHOTS_PER_USER for a player.
async function pruneSnapshots(userId: string): Promise<void> {
  const keep = await prisma.saveSnapshot.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: MAX_SNAPSHOTS_PER_USER,
    select: { id: true },
  });
  if (keep.length < MAX_SNAPSHOTS_PER_USER) return;
  await prisma.saveSnapshot.deleteMany({
    where: { userId, id: { notIn: keep.map((k) => k.id) } },
  });
}
