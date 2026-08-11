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
// 15 minutes, halved from 30 while save-loss reports are open.
//
// The ring below is what turns "your progress is gone" into "give me five
// minutes". Three players lost hours in a week and the recovery question was
// not "can we restore" but "how far back does it go" — so resolution and
// coverage both matter, and doubling the rate costs a few hundred KB per
// player against losing somebody's afternoon.
const SNAPSHOT_INTERVAL_MS = 15 * 60_000;

// Ring size per player. 24 × ~8KB median ≈ 190KB/player; even at the 129KB
// max real save that is ~3MB for the single largest account. Comfortably
// bounded across ~1,800 players.
// 64 × 15 min = 16 hours of coverage, up from 24 × 30 min = 12.
//
// 12 hours sounds ample until somebody reports a loss the morning after: the
// oldest checkpoint has already rolled off and the good state is simply gone.
// At the 8KB median this is ~512KB per player and ~920MB across the whole
// player base — a rounding error next to the alternative.
const MAX_SNAPSHOTS_PER_USER = 64;

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
