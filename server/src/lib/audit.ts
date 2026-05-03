import { prisma } from "../db.js";
import { randomBytes } from "node:crypto";

// Append-only admin audit log. Records actions that touch other users
// (raw save reads, bans, demotes, deletes, save resets, chat-mod
// deletes). Failure is non-fatal — we never block the action on the
// audit write succeeding, but we log if it doesn't.
//
// Implemented via raw SQL because the Prisma client codegen on Windows
// locks the query-engine DLL while the dev server is running; the
// AdminAudit table exists in the DB (db push synced it) but the client
// types don't yet know about it. The next clean deploy will regenerate
// and we can switch to prisma.adminAudit.create().

export async function audit(
  adminId: string,
  action: string,
  targetId: string | null,
  meta?: Record<string, unknown>
): Promise<void> {
  const id = "a_" + randomBytes(9).toString("hex");
  const metaJson = meta ? JSON.stringify(meta) : null;
  try {
    await prisma.$executeRaw`
      INSERT INTO "AdminAudit" ("id", "adminId", "action", "targetId", "meta", "createdAt")
      VALUES (${id}, ${adminId}, ${action}, ${targetId}, ${metaJson}, NOW())
    `;
  } catch (e) {
    // The action already happened; we'd rather log the audit failure
    // than reverse a legitimate admin operation.
    console.error("[audit] failed to record", { action, targetId, err: String(e) });
  }
}
