-- Additive: two new columns on ChatMessage, both safe to add live.
-- kind distinguishes system-authored messages (announcements, giveaway
-- results — currently posted through the acting admin's own real
-- account and only distinguishable today by sniffing an emoji-prefixed
-- content string) and player trade-offer cards from ordinary chat.
-- meta carries kind-specific structured data (e.g. tradeOffer's
-- {offering, wanting} text).
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'user';
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "meta" TEXT;

-- One-time backfill so existing announcement/giveaway rows render
-- consistently with new ones immediately, without touching their
-- stored content (the emoji-prefix text is left in place — it's
-- harmless legacy content the new kind-based renderer just ignores).
UPDATE "ChatMessage" SET "kind" = 'announcement'
 WHERE "content" LIKE '📢 SERVER ANNOUNCEMENT — %' AND "kind" = 'user';
UPDATE "ChatMessage" SET "kind" = 'giveaway'
 WHERE "content" LIKE '🎉 GIVEAWAY — %' AND "kind" = 'user';
