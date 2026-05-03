import { Hono } from "hono";
import { prisma } from "../db.js";
import { requireUser } from "../lib/middleware.js";

const app = new Hono();

// GET /api/profile/me — caller's profile + derived stats.
app.get("/me", requireUser, async (c) => {
  const user = c.get("user");
  const u = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      id: true,
      username: true,
      email: true,
      name: true,
      image: true,
      accountLevel: true,
      totalCaughtLevels: true,
      pokedexCaughtCount: true,
      createdAt: true,
      lastSeenAt: true,
    },
  });
  if (!u) return c.json({ error: "user not found" }, 404);
  return c.json(u);
});

// GET /api/profile/:username — public profile (no email).
app.get("/:username", requireUser, async (c) => {
  const username = c.req.param("username");
  const u = await prisma.user.findUnique({
    where: { username },
    select: {
      id: true,
      username: true,
      name: true,
      image: true,
      accountLevel: true,
      totalCaughtLevels: true,
      pokedexCaughtCount: true,
      createdAt: true,
      lastSeenAt: true,
    },
  });
  if (!u) return c.json({ error: "user not found" }, 404);
  return c.json(u);
});

export default app;
