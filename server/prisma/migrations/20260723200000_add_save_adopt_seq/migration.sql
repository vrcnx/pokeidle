-- Additive: server-owned "adopt sequence" so admin/authoritative save writes
-- can force the client to adopt the cloud copy wholesale. Nullable-safe with a
-- default; existing rows get 0. IF NOT EXISTS keeps a rerun from failing.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "saveAdoptSeq" INTEGER NOT NULL DEFAULT 0;
