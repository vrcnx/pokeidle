// Sanitising player-supplied text that will be RENDERED somewhere.
//
// Extracted from the inline helper in socket.ts so the Discord noticeboard and
// the in-game trade channel cannot drift apart. They post to the same channel
// and render in the same card, so a rule enforced on one path and not the
// other is not a rule — it is a bypass with extra steps.
//
// ── WHAT IT REMOVES AND WHY ─────────────────────────────────────────
// C0/C1 control characters and U+202E RIGHT-TO-LEFT OVERRIDE. React escapes
// on render, so this is not about script injection; it is about a character
// that VISUALLY REVERSES the rest of the line and survives into the database.
// One of those in a trade listing turns "offering Mew" into something that
// reads as the opposite, in a card the reader has no reason to distrust.
//
// Applied to every user-supplied field that reaches a renderer, not just the
// message body — `offering` and `wanting` render into the same card and are
// exactly as spoofable.

/** Strip control characters and the RTL override, then trim. */
export function sanitizeChatText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f‮]/g, "").trim();
}

/** Trade-listing field bound. Matches the in-game composer's limit exactly —
 *  see the tradeOffer branch in socket.ts. */
export const TRADE_FIELD_MAX = 120;
