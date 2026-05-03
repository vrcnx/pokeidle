// Chat channel naming + access control.
//
//   "global"                 — readable/writable by anyone authenticated
//   "area:<locationId>"      — area-specific room keyed by route/town id;
//                              readable/writable by anyone authenticated
//                              (every location is a public meeting place)
//   "dm:<userIdA>:<userIdB>" — direct message between two users (sorted ids)
//
// Sorting the user ids in DM channel keys means both sides resolve the
// same channel regardless of who initiated.

export const GLOBAL_CHANNEL = "global";

export function dmChannelId(userA: string, userB: string): string {
  const [a, b] = [userA, userB].sort();
  return `dm:${a}:${b}`;
}

export function parseDmChannel(channelId: string): { a: string; b: string } | null {
  if (!channelId.startsWith("dm:")) return null;
  const parts = channelId.slice(3).split(":");
  if (parts.length !== 2) return null;
  return { a: parts[0], b: parts[1] };
}

export function areaChannelId(locationId: string): string {
  return `area:${locationId}`;
}

export function parseAreaChannel(channelId: string): { locationId: string } | null {
  if (!channelId.startsWith("area:")) return null;
  const locationId = channelId.slice(5);
  if (!locationId) return null;
  // Whitelist: location ids must be alphanumeric (matches our route ids).
  if (!/^[a-zA-Z0-9_-]+$/.test(locationId)) return null;
  return { locationId };
}

export function canAccessChannel(channelId: string, userId: string): boolean {
  if (channelId === GLOBAL_CHANNEL) return true;
  if (parseAreaChannel(channelId)) return true;
  const dm = parseDmChannel(channelId);
  if (dm) return dm.a === userId || dm.b === userId;
  return false;
}
