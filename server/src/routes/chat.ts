import { Hono } from "hono";
import { prisma } from "../db.js";
import { requireUser } from "../lib/middleware.js";
import { canAccessChannel, GLOBAL_CHANNEL } from "../lib/chatChannels.js";

const app = new Hono();

// GET /api/chat/:channelId/history — most recent N messages, oldest-first.
// Used to seed the chat panel when a channel opens.
app.get("/:channelId/history", requireUser, async (c) => {
  const user = c.get("user");
  const channelId = decodeURIComponent(c.req.param("channelId"));
  if (!canAccessChannel(channelId, user.id)) {
    return c.json({ error: "forbidden" }, 403);
  }
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 200);
  const rows = await prisma.chatMessage.findMany({
    where: { channelId },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { user: { select: { id: true, username: true, name: true, accountLevel: true } } },
  });
  // Send oldest-first so the client can append from the bottom up.
  rows.reverse();
  return c.json({
    channelId,
    // kind/meta must round-trip the same way the live socket broadcast
    // does (server/src/socket.ts) — omitting them here silently downgrades
    // every historical system/giveaway/trade-offer card to a plain bubble
    // the instant a player reloads or opens a fresh tab.
    messages: rows.map((m) => ({
      id: m.id,
      channelId: m.channelId,
      content: m.content,
      kind: m.kind,
      meta: m.meta ? JSON.parse(m.meta) : null,
      createdAt: m.createdAt,
      user: m.user,
    })),
  });
});

export { GLOBAL_CHANNEL };
export default app;
