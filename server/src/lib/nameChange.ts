// Rename policy for the two names other players see: the public @handle
// (User.username) and the display name chat and the leaderboards actually
// print (User.name).
//
// This is a privacy control, not a convenience feature. OAuth signup
// ASSIGNS both without asking — Better Auth takes `name` straight off the
// Google profile, which for most people is their real full name, and
// auth.ts derives the handle from their email local-part (so
// first.last@gmail becomes @firstlast). The player never chose either,
// and both get published to every other player the moment they say
// anything in global chat. Handing that choice back is the point.
//
// The counter-pressure is impersonation: a handle that can be swapped at
// will is a way to borrow someone else's reputation for an evening and
// then hand it back. Hence the cooldowns below — and hence the fact that
// they live on the User row rather than in a process-local map, because
// an in-memory window resets on every deploy, which is exactly the wrong
// property for the thing standing between a griefer and a fresh identity.

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 20;
// The display name is free text, so it gets a floor (a one-character name
// is indistinguishable from a rendering glitch in a chat row) and the same
// ceiling the signup form has always used.
export const DISPLAY_NAME_MIN_LENGTH = 2;
export const DISPLAY_NAME_MAX_LENGTH = 40;

// ASCII-only, the same character class the signup form enforces
// client-side. auth.ts imports this so the signup validator and the rename
// validator cannot drift into accepting different things. Cyrillic/Greek
// homoglyphs stay excluded on purpose: Latin-`a`-bot and Cyrillic-`а`-bot
// render identically, which is a ready-made way to get a chat reader to
// trust the wrong account.
export const USERNAME_RE = new RegExp(
  `^[a-zA-Z0-9_]{${USERNAME_MIN_LENGTH},${USERNAME_MAX_LENGTH}}$`,
);

// Cooldowns. Different numbers because the two names carry different
// risk: the handle is the identity everything else keys off (friend
// requests, trainer-card lookups, @-mentions, client-side mute lists),
// so a fast switch sheds all of that at once. The display name keys
// nothing — it is only ever rendered — so it gets the short window that
// still stops someone cycling through four identities in one chat
// argument. Neither applies to the FIRST change: an account that has
// never renamed is sitting on a name it was assigned, not one it chose.
export const USERNAME_COOLDOWN_MS = 7 * 24 * 60 * 60_000;
export const DISPLAY_NAME_COOLDOWN_MS = 24 * 60 * 60_000;

/** Machine-readable refusal. Routes return `error` as the code and let
 *  the client map it to translated copy (same split LoginScreen already
 *  uses for Better Auth's codes); `message` is the English fallback. */
export interface NameRejection {
  code: string;
  message: string;
}

function reject(code: string, message: string): NameRejection {
  return { code, message };
}

export function isRejection(v: unknown): v is NameRejection {
  return !!v && typeof v === "object" && "code" in (v as object);
}

// Characters that are invisible or that reorder what follows them.
// Stripped rather than rejected: a player pasting their name out of a
// document shouldn't get a cryptic error over a zero-width space they
// can't see, but a right-to-left override in a display name can make
// "evil" render as "live" next to someone else's message.
const INVISIBLE_RE =
  /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;

// Handles we never hand out, because a player wearing one is claiming to
// be part of the operation. Matched against the squashed form so `4dm1n`
// and `admin_` are the same refusal, and by EQUALITY so the check can't
// swallow innocent handles that merely contain one (badminton).
const RESERVED_HANDLES = new Set([
  "admin", "admins", "administrator", "moderator", "mod", "mods", "staff",
  "system", "support", "official", "server", "announcement", "announcements",
  "pokeidle", "pokemonidle", "everyone", "here", "null", "undefined", "deleted",
  "anonymous",
]);

// A deliberately SHORT list of unambiguous slurs — not the chat filter's
// full wordlist (game/src/utils/profanity.ts). The chat filter can afford
// false positives: it bleeps a word and offers a "show original" link. A
// name check cannot — it refuses a player's identity outright — and the
// chat list's milder entries collide with real names the instant you drop
// word boundaries (Michelle contains "hell", Dickinson contains "dick").
// Same principle the chat filter states out loud, prefer false negatives,
// applied harder. The real backstop is the ban tool plus the audit trail
// every rename writes.
const SLURS = ["nigger", "nigga", "faggot", "tranny", "retard", "rapist"];

// Fold the cheap evasions — l33t digits, punctuation padding, case — so
// one spelling of a refusal covers the obvious rewrites of it. Repeated
// letters are deliberately NOT collapsed: doing so folds "nigerian" onto
// the slur it isn't.
const LEET: Record<string, string> = {
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t",
  "@": "a", "$": "s", "!": "i", "|": "i",
};

function squash(s: string): string {
  return s
    .toLowerCase()
    .replace(/[013457@$!|]/g, (ch) => LEET[ch] ?? ch)
    .replace(/[^a-z0-9]/g, "");
}

function hasSlur(s: string): boolean {
  const flat = squash(s);
  return SLURS.some((w) => flat.includes(w));
}

/** Validate a requested @handle. Returns the pair to store: `username` is
 *  the lowercase form Better Auth's username plugin looks sign-ins up by,
 *  `displayUsername` preserves the casing the player typed. */
export function validateUsername(
  raw: unknown,
): { username: string; displayUsername: string } | NameRejection {
  if (typeof raw !== "string") {
    return reject("username_invalid", "Enter a username.");
  }
  const typed = raw.trim();
  if (typed.length < USERNAME_MIN_LENGTH) {
    return reject("username_too_short", `Username must be at least ${USERNAME_MIN_LENGTH} characters.`);
  }
  if (typed.length > USERNAME_MAX_LENGTH) {
    return reject("username_too_long", `Username must be ${USERNAME_MAX_LENGTH} characters or fewer.`);
  }
  if (!USERNAME_RE.test(typed)) {
    return reject(
      "username_invalid",
      "Username can only contain letters, digits, and underscores.",
    );
  }
  const flat = squash(typed);
  if (RESERVED_HANDLES.has(flat)) {
    return reject("username_reserved", "That username is reserved.");
  }
  if (hasSlur(typed)) {
    return reject("username_rejected", "That username isn't allowed. Pick another.");
  }
  return { username: typed.toLowerCase(), displayUsername: typed };
}

/** Validate a requested display name. Returns the cleaned string to store. */
export function validateDisplayName(raw: unknown): { name: string } | NameRejection {
  if (typeof raw !== "string") {
    return reject("name_invalid", "Enter a display name.");
  }
  // Collapse whitespace too — "Ash          Ketchum" is a layout attack on
  // a chat row, not a name.
  const name = raw.replace(INVISIBLE_RE, "").replace(/\s+/g, " ").trim();
  if (name.length < DISPLAY_NAME_MIN_LENGTH) {
    return reject("name_too_short", `Display name must be at least ${DISPLAY_NAME_MIN_LENGTH} characters.`);
  }
  if (name.length > DISPLAY_NAME_MAX_LENGTH) {
    return reject("name_too_long", `Display name must be ${DISPLAY_NAME_MAX_LENGTH} characters or fewer.`);
  }
  // Non-ASCII is allowed here on purpose — José and 李 are names, and this
  // is the field a player uses to be called what they're actually called.
  // But it still has to READ as a name, not as punctuation art.
  if (!/[\p{L}\p{N}]/u.test(name)) {
    return reject("name_invalid", "Display name needs at least one letter or number.");
  }
  if (hasSlur(name)) {
    return reject("name_rejected", "That display name isn't allowed. Pick another.");
  }
  return { name };
}

/** Milliseconds left on a cooldown. 0 when the change is allowed now,
 *  including the never-renamed case. */
export function cooldownRemainingMs(changedAt: Date | null, windowMs: number): number {
  if (!changedAt) return 0;
  return Math.max(0, changedAt.getTime() + windowMs - Date.now());
}

/** ISO instant the next change unlocks, or null when it's available now.
 *  Sent with the profile so the UI can say "again on the 4th" instead of
 *  letting the player type into a form that is going to bounce. */
export function cooldownUnlocksAt(changedAt: Date | null, windowMs: number): string | null {
  const left = cooldownRemainingMs(changedAt, windowMs);
  return left > 0 ? new Date(Date.now() + left).toISOString() : null;
}
