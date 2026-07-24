-- Additive: stream automation config (JSON) for a StreamKey. Nullable, no
-- default, so existing rows are untouched. IF NOT EXISTS keeps a rerun from
-- failing the deploy.
ALTER TABLE "StreamKey" ADD COLUMN IF NOT EXISTS "config" TEXT;
