// Thin API client. All requests are credentialed (sends cookies) so the
// Better Auth session travels with every call.

const SERVER_URL = (import.meta as any).env?.VITE_SERVER_URL ?? "http://localhost:8787";

export const SERVER_BASE = SERVER_URL;

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  };
  const res = await fetch(`${SERVER_URL}${path}`, init);
  if (!res.ok) {
    let err: any = null;
    try { err = await res.json(); } catch { /* */ }
    throw new ApiError(res.status, err?.error ?? res.statusText, err);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: any) {
    super(message);
    this.name = "ApiError";
  }
}

export const api = {
  // Auth (Better Auth endpoints — JSON-bodied)
  signUp: (input: { email: string; password: string; name: string; username: string }) =>
    request<{ user: ProfileUser }>("POST", "/api/auth/sign-up/email", input),
  signInEmail: (input: { email: string; password: string }) =>
    request<{ user: ProfileUser }>("POST", "/api/auth/sign-in/email", input),
  signInUsername: (input: { username: string; password: string }) =>
    request<{ user: ProfileUser }>("POST", "/api/auth/sign-in/username", input),
  signOut: () => request<void>("POST", "/api/auth/sign-out"),
  getSession: () => request<{ user: ProfileUser } | null>("GET", "/api/auth/get-session"),
  googleSignInUrl: () => `${SERVER_URL}/api/auth/sign-in/social/google`,

  // Profile
  meProfile: () => request<MeProfile>("GET", "/api/profile/me"),
  publicProfile: (username: string) =>
    request<PublicProfile>("GET", `/api/profile/${encodeURIComponent(username)}`),

  // Saves
  getSave: () => request<{ saveData: any | null; saveVersion: number; saveUpdatedAt: string }>(
    "GET",
    "/api/saves"
  ),
  putSave: (saveData: any) =>
    request<{ ok: true; saveVersion: number; saveUpdatedAt: string; accountLevel: number; totalCaughtLevels: number; pokedexCaughtCount: number }>(
      "POST",
      "/api/saves",
      { saveData }
    ),

  // Friends
  listFriends: () => request<FriendList>("GET", "/api/friends"),
  requestFriend: (username: string) =>
    request<{ ok: true; status: "pending" | "accepted"; friendshipId: string }>(
      "POST",
      "/api/friends/request",
      { username }
    ),
  acceptFriend: (id: string) => request<{ ok: true }>("POST", `/api/friends/${id}/accept`),
  removeFriend: (id: string) => request<{ ok: true }>("DELETE", `/api/friends/${id}`),

  // Chat history
  chatHistory: (channelId: string, limit = 50) =>
    request<{ channelId: string; messages: ChatMessage[] }>(
      "GET",
      `/api/chat/${encodeURIComponent(channelId)}/history?limit=${limit}`
    ),

  // Public map positions — overrides the hard-coded values in routes.ts
  // when an admin has saved bespoke positions via the dashboard.
  mapPositions: () =>
    request<{ positions: Record<string, { x: number; y: number }> }>(
      "GET",
      "/api/map/positions"
    ),

  // Public map crop — lets the game zoom into the playable region of
  // the source town map image, hiding decorative borders.
  mapCrop: () =>
    request<{ crop: { x: number; y: number; w: number; h: number } | null }>(
      "GET",
      "/api/map/crop"
    ),
};

export interface ProfileUser {
  id: string;
  email: string;
  name: string | null;
  username: string;
  image: string | null;
}

export interface MeProfile {
  id: string;
  username: string;
  email: string;
  name: string | null;
  image: string | null;
  accountLevel: number;
  totalCaughtLevels: number;
  pokedexCaughtCount: number;
  createdAt: string;
  lastSeenAt: string;
}

export interface PublicProfile {
  id: string;
  username: string;
  name: string | null;
  image: string | null;
  accountLevel: number;
  totalCaughtLevels: number;
  pokedexCaughtCount: number;
  createdAt: string;
  lastSeenAt: string;
}

export interface FriendEntry {
  friendshipId: string;
  status: "pending" | "accepted";
  id: string;
  username: string;
  name: string | null;
  image: string | null;
  accountLevel: number;
  pokedexCaughtCount: number;
  lastSeenAt: string;
}
export interface FriendList {
  accepted: FriendEntry[];
  incoming: FriendEntry[];
  outgoing: FriendEntry[];
}

export interface ChatMessage {
  id: string;
  channelId: string;
  content: string;
  createdAt: string;
  user: { id: string; username: string; name: string | null; accountLevel: number };
}
