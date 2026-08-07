// Things typed into the game's chat box that are not chat.
//
// There is exactly one so far, and it earns a file because the rule is
// easy to get subtly wrong in a way that eats people's messages.

/**
 * Is this message somebody reaching for the DISCORD bot's `/link` command?
 *
 * The Rewards card tells players to run `/link`, and this is the only text
 * box in the game — so some of them run it here. Catching it lets us point
 * them at the server instead of broadcasting a command nobody can answer.
 *
 * ── DELIBERATELY EXACT ──────────────────────────────────────────────
 * The whole message, trimmed, and nothing else. The failure that matters is
 * not missing a variant — it is SWALLOWING a real message, and a chat
 * intercept that eats "how do I /link?" is worse than one that misses it,
 * because the player watches their message vanish and cannot tell why.
 *
 * So: no prefix match (`/linked` is a different word), no "contains", and
 * nothing with arguments after it. Case and surrounding whitespace are
 * forgiven, because those are typing, not intent.
 */
export function isDiscordLinkCommand(content: string): boolean {
  return /^\/link$/i.test(content.trim());
}
