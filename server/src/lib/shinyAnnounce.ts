import { sanitizeChatText } from "./chatText.js";

/**
 * Turn a client's "I caught a shiny" claim into the row that goes in chat.
 *
 * Pure, and split out of socket.ts for the same reason chatText.ts was:
 * this is the part with a security argument in it, and a security argument
 * that cannot be tested is a comment.
 *
 * WHAT THIS CAN AND CANNOT DO
 * The save is client-authoritative — there is no server-side record of an
 * encounter — so nothing here verifies that a catch happened. It is the
 * same trust model as a trade offer's free-text "offering". What it DOES
 * guarantee is that the sentence is written from the authenticated account
 * and that every player-supplied string in the row has been through the
 * sanitiser: you cannot announce someone else's shiny, and you cannot word
 * your own announcement however you like.
 *
 * The ceiling on how OFTEN is the caller's job (a rate limiter). Returning
 * null here means the claim was malformed, not that it was too frequent.
 */
export interface ShinyAnnouncement {
  content: string;
  meta: { speciesKey: string; name: string; level: number | null; username: string };
}

/** Species keys are `[a-z0-9_-]`-ish in this codebase; the cap stops a
 *  megabyte of "species key" reaching the database. */
const SPECIES_RE = /^[a-zA-Z0-9_-]{1,60}$/;

export function buildShinyAnnouncement(input: {
  speciesKey: unknown;
  name: unknown;
  level: unknown;
  /** The AUTHENTICATED account. Never taken from the payload. */
  username: string;
  /** Display name, if the account has one — same fallback chat uses. */
  displayName?: string | null;
}): ShinyAnnouncement | null {
  const { speciesKey } = input;
  if (typeof speciesKey !== "string" || !SPECIES_RE.test(speciesKey)) return null;

  // The species key is the fallback, not "Unknown": it is already validated,
  // it is always present, and it says something true. A name that sanitises
  // away to nothing was either empty or entirely control characters.
  const name = sanitizeChatText(typeof input.name === "string" ? input.name : "")
    .slice(0, 40)
    .trim() || speciesKey;

  // Out-of-range levels are dropped rather than clamped. Clamping 9999 to
  // 100 would print a confident lie; null just omits it.
  const lv = typeof input.level === "number"
    && Number.isInteger(input.level)
    && input.level >= 1
    && input.level <= 100
    ? input.level
    : null;

  // The display name is sanitised too. It is set through the account's own
  // name field, which is a different write path from chat — so it has not
  // necessarily been through this on the way in.
  const who = sanitizeChatText(input.displayName || input.username).slice(0, 40).trim()
    || input.username;

  return {
    content: `${who} caught a shiny ${name}!`,
    // `username`, not the display name: the card's trainer click-through
    // needs the handle that identifies the account, and display names are
    // neither unique nor stable.
    meta: { speciesKey, name, level: lv, username: input.username },
  };
}
