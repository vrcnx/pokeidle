-- Signup attribution: where each new account came from.
--
-- ── ADDITIVE ONLY ────────────────────────────────────────────────────
-- One new table and three indexes. No existing table is touched, nothing is
-- dropped, retyped or backfilled, so this is safe to apply against the live
-- server while it is serving traffic. Every statement is IF NOT EXISTS, so a
-- rerun or a partially-applied deploy is a no-op rather than a failure.
--
-- ── WHY userId IS THE PRIMARY KEY ────────────────────────────────────
-- One account has exactly one acquisition. Making userId the key rather than
-- adding a surrogate id makes "first write wins" a database guarantee instead
-- of an application convention: the capture endpoint can INSERT and let a
-- duplicate-key error mean "already attributed", with no read-then-write race
-- to lose. A second POST — a double-submit, a retried request, a player who
-- reloads the page mid-signup — cannot overwrite the original.
--
-- ── WHY EVERY COLUMN BUT channel/source IS NULLABLE ──────────────────
-- Most signups carry no campaign tags at all: someone types the domain in
-- directly and there is genuinely no medium, campaign, term or content. NULL
-- says that. A NOT NULL DEFAULT '' would say "we recorded an empty campaign",
-- which reads the same in a GROUP BY and is not the same fact.
--
-- channel and source are NOT NULL because the normaliser always produces
-- both: an untagged, unreferred visit is channel='direct', source='direct'.
-- That is a real classification, not a missing value, and keeping it out of
-- NULL means the dashboard's GROUP BY has no hole to special-case.
--
-- ── ON THE INDEXES ───────────────────────────────────────────────────
-- Unlike Tournament (tens of rows, no index warranted), this table gets one
-- row per signup — it tracks the User table, which is already in the
-- thousands and is the number this game is trying to grow. The dashboard
-- windows on createdAt and groups by channel and by source, so all three are
-- indexed now rather than after the query gets slow enough to notice.
--
-- ── ON DELETE CASCADE ────────────────────────────────────────────────
-- Matches every other per-user table here. An account deletion must not leave
-- an orphan row keyed on an id that no longer resolves — and an acquisition
-- record for a deleted account is not a number anyone should still be
-- counting.

CREATE TABLE IF NOT EXISTS "SignupAttribution" (
  "userId"       TEXT NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "channel"      TEXT NOT NULL,
  "source"       TEXT NOT NULL,
  "medium"       TEXT,
  "campaign"     TEXT,
  "term"         TEXT,
  "content"      TEXT,
  "referrerHost" TEXT,
  "landingPath"  TEXT,
  CONSTRAINT "SignupAttribution_pkey" PRIMARY KEY ("userId")
);

CREATE INDEX IF NOT EXISTS "SignupAttribution_createdAt_idx" ON "SignupAttribution" ("createdAt");
CREATE INDEX IF NOT EXISTS "SignupAttribution_channel_idx"   ON "SignupAttribution" ("channel");
CREATE INDEX IF NOT EXISTS "SignupAttribution_source_idx"    ON "SignupAttribution" ("source");

-- Added tolerantly: on a database where the constraint already exists (a
-- rerun, or a partially-applied deploy) a bare ADD CONSTRAINT would abort the
-- whole migration. Postgres has no ADD CONSTRAINT IF NOT EXISTS.
DO $$
BEGIN
  ALTER TABLE "SignupAttribution"
    ADD CONSTRAINT "SignupAttribution_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
