import { describe, expect, it } from "vitest";
import { normalizeAttribution, referrerHost } from "../src/lib/acquisition.js";

// The normaliser is the only place attribution is interpreted, and its output
// IS the grouping key in the dashboard. A change that splits google.com from
// www.google.com, or that files a paid campaign under organic, produces
// numbers that look plausible and are wrong — which is the failure mode worth
// spending tests on.

describe("referrerHost", () => {
  it("reduces a URL to a bare host", () => {
    expect(referrerHost("https://www.reddit.com/r/pokemon/comments/abc/def")).toBe("reddit.com");
  });

  it("collapses www so one source is not counted as two", () => {
    expect(referrerHost("https://www.google.com/")).toBe(referrerHost("https://google.com/"));
  });

  it("drops the path and query — the referring URL can carry the other site's session data", () => {
    const host = referrerHost("https://example.com/search?q=my+private+query&sid=abc123");
    expect(host).toBe("example.com");
    expect(host).not.toContain("private");
    expect(host).not.toContain("abc123");
  });

  it("treats an unparseable referrer as unknown rather than guessing", () => {
    expect(referrerHost("not a url")).toBeNull();
    expect(referrerHost("")).toBeNull();
    expect(referrerHost(undefined)).toBeNull();
  });

  it("does not count our own site as a referral", () => {
    expect(referrerHost("https://pokeidle.com/play", "pokeidle.com")).toBeNull();
    expect(referrerHost("https://www.pokeidle.com/", "pokeidle.com")).toBeNull();
    // Subdomains too — the game and the marketing page are the same product.
    expect(referrerHost("https://beta.pokeidle.com/", "pokeidle.com")).toBeNull();
    // But a lookalike domain is somebody else.
    expect(referrerHost("https://notpokeidle.com/", "pokeidle.com")).toBe("notpokeidle.com");
  });
});

describe("normalizeAttribution — channels", () => {
  it("no referrer and no tags is direct", () => {
    const n = normalizeAttribution({});
    expect(n.channel).toBe("direct");
    expect(n.source).toBe("direct");
  });

  it("classifies search engines as organic, across country domains", () => {
    for (const r of ["https://www.google.com/", "https://google.co.uk/", "https://www.bing.com/", "https://duckduckgo.com/"]) {
      expect(normalizeAttribution({ referrer: r }).channel).toBe("organic");
    }
  });

  it("classifies social and community platforms as social", () => {
    for (const r of ["https://www.reddit.com/r/x", "https://discord.com/channels/1/2", "https://t.co/abc", "https://news.ycombinator.com/item?id=1"]) {
      expect(normalizeAttribution({ referrer: r }).channel).toBe("social");
    }
  });

  it("classifies anything else with a referrer as a referral", () => {
    expect(normalizeAttribution({ referrer: "https://somebodysblog.dev/post" }).channel).toBe("referral");
  });

  it("files answer engines under organic, not social", () => {
    // Someone arriving from ChatGPT asked a question and was pointed here.
    // That is the organic-search shape, not the shared-a-link shape.
    expect(normalizeAttribution({ referrer: "https://chatgpt.com/c/abc" }).channel).toBe("organic");
  });

  it("paid beats the referring host — an ad clicked on Google is paid, not organic", () => {
    const n = normalizeAttribution({ referrer: "https://www.google.com/", utmMedium: "cpc", utmSource: "google" });
    expect(n.channel).toBe("paid");
  });

  it("recognises email campaigns", () => {
    expect(normalizeAttribution({ utmMedium: "newsletter", utmSource: "mailchimp" }).channel).toBe("email");
  });

  it("credits a tagged link with no referrer, which is the normal Discord case", () => {
    // Discord's client strips the referrer, so a link shared there arrives
    // looking exactly like direct traffic. The utm_source is the only signal
    // left, and ignoring it would mean the one campaign we can measure reads
    // as unattributed.
    const n = normalizeAttribution({ referrer: "", utmSource: "discord.com" });
    expect(n.channel).toBe("social");
    expect(n.source).toBe("discord.com");
  });
});

describe("normalizeAttribution — fields", () => {
  it("prefers utm_source over the host as the grouping key", () => {
    const n = normalizeAttribution({ referrer: "https://t.co/xyz", utmSource: "twitter-launch-post" });
    expect(n.source).toBe("twitter-launch-post");
    expect(n.referrerHost).toBe("t.co");
  });

  it("lowercases so one campaign is not counted twice", () => {
    expect(normalizeAttribution({ utmCampaign: "Summer_Launch" }).campaign).toBe("summer_launch");
  });

  it("keeps the landing path but drops its query string", () => {
    const n = normalizeAttribution({ landingPath: "/play?utm_source=x&token=secret" });
    expect(n.landingPath).toBe("/play");
  });

  it("rejects a landing path that is not a path", () => {
    // A full URL here would mean an absolute redirect target got stored as if
    // it were one of our own pages.
    expect(normalizeAttribution({ landingPath: "https://evil.example/" }).landingPath).toBeNull();
  });

  it("caps length — every one of these comes from a URL the visitor controls", () => {
    const n = normalizeAttribution({ utmCampaign: "x".repeat(5000) });
    expect(n.campaign!.length).toBeLessThanOrEqual(96);
  });

  it("strips control characters", () => {
    const n = normalizeAttribution({ utmSource: "spa\u0000m\u001bco" });
    expect(n.source).toBe("spamco");
  });

  it("never returns a null source, so the dashboard's GROUP BY has no hole", () => {
    for (const raw of [{}, { referrer: "garbage" }, { utmSource: "   " }]) {
      expect(normalizeAttribution(raw).source).toBeTruthy();
    }
  });
});
