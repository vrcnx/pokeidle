// Where "join the Discord" actually goes.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────
// It didn't, and that was the bug. The Rewards page carried a promo titled
// "Join the Discord" whose button read "Get the code" and led to
// /link-discord, a page that says "run /link in the Pokémon Idle Discord" —
// and nothing anywhere in the client, the server, or the 3.4MB deployed
// bundle was a link to that server. A player who was not already a member
// hit a dead end on a card whose entire proposition was joining, and the
// button promised a code the page does not give you (it ASKS for one; the
// code is DM'd by the bot, after you are in the server, which was the step
// with no door).
//
// ── WHY AN ENV VAR WITH A DEFAULT ───────────────────────────────────
// A Discord invite is a revocable, rotatable credential-ish string, not a
// constant: a raid, an expiry or a server change means a new one, and that
// should be a config edit and a restart rather than a code change and a
// deploy. But an unset var here must not mean "no invite" — that is the
// state this file exists to end — so the working invite is the default and
// the var is an override.
//
// It is deliberately NOT validated beyond its shape. Whether an invite is
// live is Discord's answer and it changes without telling us; the honest
// failure is Discord's own "invite invalid" page, which at least names what
// went wrong, rather than us guessing at startup and hiding the button.
const DEFAULT_INVITE = "https://discord.gg/6QjHaDxY4c";

/**
 * The server's public invite URL.
 *
 * Read once at module load: this is configuration, not state, and re-reading
 * `process.env` per request would let a half-applied change split the site's
 * answers between two invites mid-session.
 */
export const DISCORD_INVITE_URL: string = (() => {
  const raw = process.env.DISCORD_INVITE_URL?.trim();
  if (!raw) return DEFAULT_INVITE;
  // Shape only — an absolute http(s) URL. A relative path or a typo'd scheme
  // here would render as a link that silently resolves against our own
  // origin, which is a 404 on our site rather than a visible misconfiguration.
  if (!/^https?:\/\/\S+$/i.test(raw)) {
    console.warn(
      "[discord] DISCORD_INVITE_URL is not an absolute http(s) URL; using the built-in invite instead.",
    );
    return DEFAULT_INVITE;
  }
  return raw;
})();
