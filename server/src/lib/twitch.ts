// Twitch Helix integration for controlling the channel's title, category, and
// tags from the admin dashboard. Uses a stored refresh token (confidential
// app) to mint short-lived access tokens on demand — the operator sets
// TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET / TWITCH_REFRESH_TOKEN (the refresh
// token must have the channel:manage:broadcast scope). All optional: with any
// of them unset the feature is simply "not configured".

interface TokenCache { accessToken: string; expiresAt: number; }
let tokenCache: TokenCache | null = null;
let broadcasterIdCache: string | null = null;

export function twitchConfigured(): boolean {
  return !!(
    process.env.TWITCH_CLIENT_ID?.trim() &&
    process.env.TWITCH_CLIENT_SECRET?.trim() &&
    process.env.TWITCH_REFRESH_TOKEN?.trim()
  );
}

async function getAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) return tokenCache.accessToken;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: process.env.TWITCH_REFRESH_TOKEN!.trim(),
    client_id: process.env.TWITCH_CLIENT_ID!.trim(),
    client_secret: process.env.TWITCH_CLIENT_SECRET!.trim(),
  });
  const r = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error(`Twitch token refresh failed (${r.status}). Check TWITCH_CLIENT_ID/SECRET/REFRESH_TOKEN.`);
  const j = (await r.json()) as { access_token: string; expires_in?: number; refresh_token?: string };
  tokenCache = { accessToken: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 14400) * 1000 };
  return tokenCache.accessToken;
}

async function helix(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken();
  return fetch(`https://api.twitch.tv/helix${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
      "Client-Id": process.env.TWITCH_CLIENT_ID!.trim(),
    },
  });
}

async function getBroadcasterId(): Promise<string> {
  if (broadcasterIdCache) return broadcasterIdCache;
  const r = await helix("/users");
  if (!r.ok) throw new Error(`Twitch /users failed (${r.status})`);
  const j = (await r.json()) as { data?: { id: string }[] };
  const id = j.data?.[0]?.id;
  if (!id) throw new Error("Could not resolve the broadcaster from the token.");
  broadcasterIdCache = id;
  return id;
}

export interface ChannelInfo {
  title: string;
  gameName: string;
  gameId: string;
  tags: string[];
  broadcasterLogin: string;
}

export async function getChannelInfo(): Promise<ChannelInfo> {
  const id = await getBroadcasterId();
  const r = await helix(`/channels?broadcaster_id=${id}`);
  if (!r.ok) throw new Error(`Twitch /channels GET failed (${r.status})`);
  const j = (await r.json()) as { data?: any[] };
  const c = j.data?.[0] ?? {};
  return {
    title: c.title ?? "",
    gameName: c.game_name ?? "",
    gameId: c.game_id ?? "",
    tags: c.tags ?? [],
    broadcasterLogin: c.broadcaster_login ?? "",
  };
}

async function resolveGameId(name: string): Promise<string> {
  const r = await helix(`/games?name=${encodeURIComponent(name.trim())}`);
  if (!r.ok) throw new Error(`Twitch /games lookup failed (${r.status})`);
  const j = (await r.json()) as { data?: { id: string }[] };
  const id = j.data?.[0]?.id;
  if (!id) throw new Error(`Twitch category "${name}" not found — use the exact category name.`);
  return id;
}

export async function setChannelInfo(patch: { title?: string; gameName?: string; tags?: string[] }): Promise<ChannelInfo> {
  const id = await getBroadcasterId();
  const body: Record<string, unknown> = {};
  if (patch.title !== undefined) body.title = patch.title.slice(0, 140);
  if (patch.tags !== undefined) {
    // Twitch tags: up to 10, ≤25 chars each, no spaces/special chars.
    body.tags = patch.tags
      .map((t) => t.replace(/[^a-zA-Z0-9]/g, "").slice(0, 25))
      .filter(Boolean)
      .slice(0, 10);
  }
  if (patch.gameName !== undefined && patch.gameName.trim()) {
    body.game_id = await resolveGameId(patch.gameName);
  }
  const r = await helix(`/channels?broadcaster_id=${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  // Success is 204 No Content.
  if (!r.ok) throw new Error(`Twitch /channels PATCH failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
  return getChannelInfo();
}
