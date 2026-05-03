import { Hono } from "hono";
import { prisma } from "../db.js";

const app = new Hono();

// Public read endpoint — the game frontend hits this on boot to pick up
// any admin-edited overrides. No auth required: positions are visible
// to everyone in the rendered town map anyway. Writes are still
// admin-only via /api/admin/map-positions.
app.get("/positions", async (c) => {
  const rows = await prisma.mapPosition.findMany();
  const positions: Record<string, { x: number; y: number }> = {};
  for (const r of rows) positions[r.locationId] = { x: r.x, y: r.y };
  return c.json({ positions });
});

// Crop rectangle for the current region. Public read so the game can
// apply it to the rendered town map.
app.get("/crop", async (c) => {
  const row = await prisma.mapCrop.findUnique({ where: { regionId: "kanto" } });
  if (!row) return c.json({ crop: null });
  return c.json({ crop: { x: row.x, y: row.y, w: row.w, h: row.h } });
});

export default app;
