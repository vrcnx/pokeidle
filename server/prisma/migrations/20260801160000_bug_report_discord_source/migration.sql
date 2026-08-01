-- Discord-sourced bug reports: the community server's bug channel feeds the
-- admin dashboard's existing bug report page.
--
-- ── ADDITIVE ONLY ────────────────────────────────────────────────────
-- Two columns and one index on an existing table. Nothing dropped, retyped or
-- rewritten; every statement is IF NOT EXISTS, so a rerun or a partially
-- applied deploy is a no-op. Safe against a live server.
--
-- ── WHY "game" IS THE CORRECT DEFAULT FOR EVERY EXISTING ROW ─────────
-- Every BugReport that exists today came from the in-game Report Bug modal —
-- the Discord ingest did not exist. So the default is not a placeholder, it is
-- the true value, and no backfill is needed or possible.
--
-- ── WHY discordMessageId IS UNIQUE, AND WHY THAT IS THE WHOLE DESIGN ─
-- The bot ingests the same message more than once by construction: it listens
-- for new messages live AND sweeps recent channel history on boot, so anything
-- posted while it was redeploying arrives twice — once from the sweep, once
-- from nothing at all, and a restart mid-sweep can repeat it again.
--
-- A check-then-insert loses that race and produces duplicate reports in the
-- triage queue, which is exactly the kind of noise that makes an operator stop
-- reading the queue. The unique index means the SECOND insert is refused by
-- Postgres (23505 → Prisma P2002), which the ingest endpoint catches and
-- reports as "already have this one" — success-shaped, because the state the
-- caller wanted is true.
--
-- Nullable, and Postgres permits unlimited NULLs in a unique index, so this
-- constrains precisely the Discord-sourced rows and leaves every in-game
-- report unaffected. That is why it is a nullable column with a unique index
-- rather than a separate table.

ALTER TABLE "BugReport" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'game';
ALTER TABLE "BugReport" ADD COLUMN IF NOT EXISTS "discordMessageId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "BugReport_discordMessageId_key"
  ON "BugReport"("discordMessageId");
