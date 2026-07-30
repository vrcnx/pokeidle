/**
 * Reading "what was appended to the battle log since I last looked".
 *
 * ── THE BUG THIS EXISTS TO FIX (br_15040fe48311121a4a) ────────────────
 * "Effectiveness and '+XP' texts stop appearing shortly after opening or
 * refreshing the page."
 *
 * Three float layers — ExpGainFlash, EffectivenessFlash and BattleJuice — each
 * kept its own cursor, and each cursor was `state.battleLog.length`:
 *
 *     const start = prevLen.current;
 *     const end = state.battleLog.length;
 *     prevLen.current = end;
 *     if (end <= start) return;          // ← permanently true after 50 lines
 *
 * pushLog caps the log at the last 50 lines, so `length` climbs to 50 and then
 * never moves again. From that moment `end <= start` is always true and all
 * three components early-return for the rest of the session. Three real wild
 * battles produce ~21 lines, so the floats died after about eight battles —
 * "shortly after opening", exactly as reported. A refresh reset the log to one
 * line, which is why refreshing bought a brief reprieve and made the bug look
 * like an animation problem rather than an arithmetic one.
 *
 * The cap is correct; using it as a clock was not. `state.battleLogSeq` counts
 * every line ever pushed and is never trimmed, and this module is the only
 * place allowed to turn it into a slice of the log — one shared reading instead
 * of the same three-line cursor copied into three components, which is how it
 * came to be wrong in three places at once.
 */

/**
 * The lines appended since a consumer last saw sequence `seenSeq`.
 *
 * `log` is the trimmed window, `seq` its current `battleLogSeq`. Returns an
 * empty array when nothing is new, so callers can bail on `.length === 0`.
 *
 * Two edges matter:
 *  - More lines were pushed than the window keeps (a long trainer battle
 *    resolving in one dispatch): the trimmed-away lines are simply gone, so
 *    return the whole window rather than reading off the front of the array.
 *  - `seq` moved BACKWARD, which a mid-session LOAD_SAVE can do if anything
 *    ever hands the reducer a blob with a lower counter. Treat that as "the log
 *    was replaced" and rescan the window, because the alternative — silently
 *    returning nothing until the counter climbs back — is the original bug.
 */
export function linesSince(log: string[], seq: number, seenSeq: number): string[] {
  if (seq === seenSeq) return [];
  const added = seq - seenSeq;
  if (added < 0 || added >= log.length) return log;
  return log.slice(log.length - added);
}
