-- 24/7 Twitch renderer control. A singleton BroadcastState row: the admin
-- dashboard writes the desired state (enabled, which account, encode quality)
-- and the external renderer polls it + reports its live status back. IF NOT
-- EXISTS keeps a rerun from failing.
CREATE TABLE IF NOT EXISTS "BroadcastState" (
  "id"            TEXT NOT NULL,
  "enabled"       BOOLEAN NOT NULL DEFAULT false,
  "accountUserId" TEXT,
  "width"         INTEGER NOT NULL DEFAULT 1920,
  "height"        INTEGER NOT NULL DEFAULT 1080,
  "fps"           INTEGER NOT NULL DEFAULT 30,
  "bitrateKbps"   INTEGER NOT NULL DEFAULT 6000,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  "live"          BOOLEAN NOT NULL DEFAULT false,
  "lastStatus"    TEXT,
  "lastStatusAt"  TIMESTAMP(3),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BroadcastState_pkey" PRIMARY KEY ("id")
);
