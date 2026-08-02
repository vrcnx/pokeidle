// Where a signup came from: normalisation and channel classification.
//
// ── WHY THIS IS ONE FILE ────────────────────────────────────────────
// Attribution is written once (at signup) and read many times (every load of
// the admin Analytics page). If the write normalised one way and the read
// grouped another, the dashboard would show "google.com" and "www.google.com"
// as two acquisition channels and nobody would notice until the numbers were
// used to decide something. Normalising HERE, on the way in, means the stored
// row is already the grouping key and the read side does nothing but count.
//
// ── WHY WE STORE THE HOST, NOT THE REFERRER URL ─────────────────────
// A full referring URL is a tracking vector: it can carry the referring
// site's own session ids, search terms typed by the player, and in the worst
// case tokens in a query string. The host answers the only question the
// dashboard asks — "which site sent them" — and carries none of that. The
// path is deliberately dropped.

/** Channels, in the order they are tested. Order matters: a paid campaign
 *  landing from a Google ad is paid, not organic search. */
export type Channel = "paid" | "email" | "organic" | "social" | "referral" | "direct";

export const CHANNELS: Channel[] = ["organic", "social", "referral", "paid", "email", "direct"];

/**
 * Search engines. Matched as a domain suffix so every country variant
 * (google.co.uk, google.com.au, ...) collapses to one entry — otherwise the
 * single biggest acquisition channel arrives pre-shredded into forty rows
 * that individually look like noise.
 */
const SEARCH_HOSTS = [
  "google.", "bing.com", "duckduckgo.com", "yahoo.", "yandex.", "baidu.com",
  "ecosia.org", "search.brave.com", "startpage.com", "qwant.com", "naver.com",
  "ask.com", "aol.com", "search.marginalia.nu", "kagi.com", "perplexity.ai",
  "chatgpt.com", "chat.openai.com", "claude.ai", "gemini.google.com", "copilot.microsoft.com",
];

/**
 * Social and community platforms.
 *
 * Answer engines (chatgpt, perplexity, claude) are filed under search rather
 * than social on purpose: someone arriving from one asked a question and got
 * sent here, which is the organic-search shape, not the shared-a-link shape.
 */
const SOCIAL_HOSTS = [
  "discord.com", "discord.gg", "discordapp.com",
  "reddit.com", "redd.it",
  "twitter.com", "x.com", "t.co",
  "facebook.com", "fb.com", "fb.me", "m.facebook.com",
  "instagram.com", "tiktok.com", "youtube.com", "youtu.be",
  "twitch.tv", "linkedin.com", "lnkd.in", "tumblr.com",
  "bsky.app", "threads.net", "mastodon.social", "vk.com",
  "t.me", "telegram.me", "pinterest.com", "quora.com",
  "news.ycombinator.com", "lemmy.world", "kick.com",
];

/** utm_medium values that mean money changed hands. */
const PAID_MEDIUMS = new Set([
  "cpc", "ppc", "paid", "paidsearch", "paid-search", "paid_search",
  "cpm", "cpv", "cpa", "display", "banner", "retargeting", "affiliate",
]);

const EMAIL_MEDIUMS = new Set(["email", "e-mail", "newsletter", "mail"]);

/** Belt-and-braces cap. These strings come from a URL an attacker controls. */
const MAX_LEN = 96;

function clean(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().slice(0, MAX_LEN).toLowerCase();
  // Control characters would make the dashboard render nonsense and could
  // break a CSV export downstream.
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, "") || null;
}

/**
 * Referring URL → bare host.
 *
 * "www." is stripped because www.reddit.com and reddit.com are the same
 * acquisition source and splitting them halves both numbers. An unparseable
 * referrer yields null, which classifies as direct — the honest answer, since
 * we genuinely do not know where they came from.
 */
export function referrerHost(referrer: string | null | undefined, selfHost?: string | null): string | null {
  const raw = typeof referrer === "string" ? referrer.trim() : "";
  if (!raw) return null;
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "");
  if (!host) return null;
  // A referral from ourselves is not a referral. This happens when the player
  // wandered the site before signing up; the acquisition question is about
  // the visit that brought them, and by then we are not it.
  if (selfHost && (host === selfHost || host.endsWith(`.${selfHost}`))) return null;
  return host.slice(0, MAX_LEN);
}

function matchesHost(host: string, needles: string[]): boolean {
  return needles.some((n) => (n.endsWith(".") ? host.startsWith(n) || host.includes(`.${n}`) : host === n || host.endsWith(`.${n}`)));
}

export interface RawAttribution {
  referrer?: string | null;
  landingPath?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmTerm?: string | null;
  utmContent?: string | null;
}

export interface NormalizedAttribution {
  channel: Channel;
  /** The grouping key shown in the dashboard: utm_source when tagged, else
   *  the referring host, else "direct". Never null, so GROUP BY has no hole. */
  source: string;
  medium: string | null;
  campaign: string | null;
  term: string | null;
  content: string | null;
  referrerHost: string | null;
  landingPath: string | null;
}

/**
 * Landing path, without the query string.
 *
 * The query is where the UTM tags were, and they are already extracted into
 * their own columns; keeping the raw query as well would store the same data
 * twice and, more to the point, would store every OTHER parameter too —
 * including any a third party appended.
 */
function landingPath(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const raw = v.trim();
  if (!raw) return null;
  const path = raw.split("?")[0].split("#")[0];
  if (!path.startsWith("/")) return null;
  return path.slice(0, MAX_LEN) || "/";
}

export function normalizeAttribution(raw: RawAttribution, selfHost?: string | null): NormalizedAttribution {
  const host = referrerHost(raw.referrer, selfHost);
  const utmSource = clean(raw.utmSource);
  const utmMedium = clean(raw.utmMedium);

  let channel: Channel;
  if (utmMedium && PAID_MEDIUMS.has(utmMedium)) {
    channel = "paid";
  } else if (utmMedium && EMAIL_MEDIUMS.has(utmMedium)) {
    channel = "email";
  } else {
    // utm_source is checked against the host lists too, because a link shared
    // in Discord with ?utm_source=discord often arrives with no referrer at
    // all (the Discord client strips it), and calling that "direct" would
    // quietly credit the wrong channel for the campaign we can most easily
    // measure.
    const probe = host ?? utmSource;
    if (probe && matchesHost(probe, SEARCH_HOSTS)) channel = "organic";
    else if (probe && matchesHost(probe, SOCIAL_HOSTS)) channel = "social";
    else if (probe) channel = "referral";
    else channel = "direct";
  }

  return {
    channel,
    source: utmSource ?? host ?? "direct",
    medium: utmMedium,
    campaign: clean(raw.utmCampaign),
    term: clean(raw.utmTerm),
    content: clean(raw.utmContent),
    referrerHost: host,
    landingPath: landingPath(raw.landingPath),
  };
}

/**
 * How long after account creation an attribution POST is still believed.
 *
 * The endpoint is session-authenticated, so only the account owner can write
 * their own row — but without a window, a player who cleared storage and came
 * back through a Reddit link two years later would have their original
 * acquisition rewritten to "reddit". Thirty minutes is generous for the
 * signup → first-load round trip (including the Google OAuth redirect) and far
 * too short for a return visit.
 */
export const ATTRIBUTION_WINDOW_MS = 30 * 60_000;
