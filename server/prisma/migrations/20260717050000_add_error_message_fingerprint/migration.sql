-- Not a table change — a helper function the error-log grouping queries
-- call at query time. Exact-string "GROUP BY message" fragments one real
-- error type into many groups whenever a message embeds instance-specific
-- data (a save version, a raw exception's dynamic text, an id). This
-- collapses the obviously-variable parts of a message to stable
-- placeholders before anything groups on it, so grouping survives a
-- future call site making the same mistake, not just today's known ones.
--
-- CREATE OR REPLACE is naturally idempotent/rerunnable — no IF NOT EXISTS
-- needed. Nothing is stored or backfilled: this runs at query time, so
-- changing the regex later is a one-line function edit, applied instantly
-- to every existing row with no migration.
--
-- Order matters: UUID / email / timestamp / long-opaque-id patterns run
-- BEFORE the generic digit collapse, because those tokens contain digits
-- themselves — collapsing digits first would shred a cuid like
-- "cm3x9f8h20001qzoab7f9k2m" into fragments instead of one clean unit.
CREATE OR REPLACE FUNCTION error_message_fingerprint(msg text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT regexp_replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(
                 regexp_replace(
                   regexp_replace(
                     msg,
                     '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}',
                     '<uuid>', 'gi'
                   ),
                   '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}',
                   '<email>', 'g'
                 ),
                 '\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?',
                 '<timestamp>', 'g'
               ),
               '\y[0-9A-Za-z]{20,}\y',
               '<id>', 'g'
             ),
             '\y0x[0-9a-fA-F]+\y',
             '<hex>', 'g'
           ),
           '[0-9]+',
           '<num>', 'g'
         )
$$;
