import { hasProfanity } from "./profanity";

/**
 * THE nickname rule — one definition, shared by the editor and the reducer.
 *
 * It lived in the SET_NICKNAME case alone, with the length cap ALSO written
 * into the input's `maxLength` and the sanitize written nowhere else. That
 * split is why a rejected rename looked like a broken rename: the editor
 * happily accepted text the reducer then dropped on the floor, and the field
 * had no way to know which of the two had happened.
 *
 * Now the editor calls this to decide what to show the player, and the reducer
 * calls it to decide what to store. Same answer, by construction.
 */

/**
 * Longest nickname we store. Deliberately far below the server validator's
 * MAX_NICKNAME (32, see server/src/lib/saveValidation.ts): the client being
 * the stricter of the two means every nickname this game can produce passes
 * the validator, so a rename can never be the reason a save is refused. If
 * this ever needs to grow past 32, the validator has to move FIRST.
 */
export const NICKNAME_MAX_LENGTH = 12;

export type NicknameResult =
  /** Store this. `value` is undefined when the player cleared the name —
   *  an absent field is how "no nickname" has always been represented, so
   *  clearing restores the original shape rather than leaving a `""` behind. */
  | { ok: true; value: string | undefined }
  /** Refuse, and show `reason`. */
  | { ok: false; reason: string };

/**
 * Strip control characters and angle brackets (defence-in-depth — React
 * escapes text nodes, but keeping bad bytes out of state also keeps the save
 * file clean and the server validator happy), collapse runs of whitespace,
 * trim, and cap the length.
 */
export function sanitizeNickname(raw: string): string {
  return raw
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NICKNAME_MAX_LENGTH);
}

export function normalizeNickname(raw: string): NicknameResult {
  const cleaned = sanitizeNickname(raw);
  if (cleaned.length === 0) return { ok: true, value: undefined };

  // A nickname is NOT private state. It rides along on trades
  // (state/trade.ts copies it), it is the label on an auction listing
  // (AuctionBoard), and PvP uses it as the mon's display name for the
  // opponent and every spectator (server/src/pvp.ts). So it is
  // player-authored text that reaches other players' screens without ever
  // passing through the chat filter — the one path in the game like that.
  //
  // Screened here rather than at display time, because the display-time censor
  // is a per-viewer preference that defaults on but can be turned off, and
  // "off" must not mean "now you see the slur someone named their Gengar".
  if (hasProfanity(cleaned)) {
    return { ok: false, reason: "That nickname isn't allowed. Try another one." };
  }

  return { ok: true, value: cleaned };
}
