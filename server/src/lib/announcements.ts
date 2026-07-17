import { z } from "zod";
import type { Announcement } from "@prisma/client";
import { prisma } from "../db.js";

// The pinned server-wide banner. See prisma/schema.prisma `Announcement`.
// A player-facing serialization + the "which one is live right now" query
// live here so the player route, the admin route, and the socket layer all
// agree on one definition.

export const ANNOUNCEMENT_TYPES = ["info", "event", "giveaway", "warning", "maintenance"] as const;
export type AnnouncementType = (typeof ANNOUNCEMENT_TYPES)[number];

export const AnnouncementInput = z.object({
  type: z.enum(ANNOUNCEMENT_TYPES).default("info"),
  // Short by design — this is one glanceable line in a 44px band, not a
  // paragraph. The chat broadcast tool exists for longer messages.
  message: z.string().trim().min(1).max(200),
  // Optional CTA. Accept an absolute http(s) URL or an in-app hash route
  // ("#giveaways"). Anything else is rejected so we never render a link
  // that points somewhere unexpected.
  href: z.string().trim().max(300).nullable().optional(),
  linkLabel: z.string().trim().max(40).nullable().optional(),
  startsAt: z.string().datetime().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});
export type AnnouncementInput = z.infer<typeof AnnouncementInput>;

// In-app hash routes the CLIENT actually knows how to open. Accepting a
// route here that the client can't resolve would let an admin publish a
// banner whose CTA silently renders nothing. Keep this in lockstep with
// resolveCta() in game/src/components/ChannelHeader.tsx.
export const KNOWN_HASH_ROUTES = ["#giveaways"] as const;

export function isValidHref(href: string): boolean {
  if (href.startsWith("#")) return (KNOWN_HASH_ROUTES as readonly string[]).includes(href);
  try {
    const u = new URL(href);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

// The shape the client renders. Never leak createdBy / internal flags.
export interface PublicAnnouncement {
  id: string;
  type: AnnouncementType;
  message: string;
  href: string | null;
  linkLabel: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export function toPublic(a: Announcement): PublicAnnouncement {
  const type = (ANNOUNCEMENT_TYPES as readonly string[]).includes(a.type)
    ? (a.type as AnnouncementType)
    : "info";
  return {
    id: a.id,
    type,
    message: a.message,
    href: a.href ?? null,
    linkLabel: a.linkLabel ?? null,
    createdAt: a.createdAt.toISOString(),
    expiresAt: a.expiresAt ? a.expiresAt.toISOString() : null,
  };
}

// The single banner a player should see right now, or null. Active, started,
// and not expired. Ties broken by most-recent, so publishing a new one wins
// even in the (guarded-against) case where two rows are active at once.
export async function getLiveAnnouncement(now = new Date()): Promise<Announcement | null> {
  return prisma.announcement.findFirst({
    where: {
      active: true,
      OR: [{ startsAt: null }, { startsAt: { lte: now } }],
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
    },
    orderBy: { createdAt: "desc" },
  });
}
