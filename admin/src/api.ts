// Thin admin API client. Re-uses the game server (cookies travel via
// `credentials: include`) so admin authentication piggybacks the same
// Better Auth session a normal user has, gated by isAdmin on the server.

export const SERVER_URL =
  (import.meta as any).env?.VITE_SERVER_URL ?? "http://localhost:8787";

class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let err: any = null;
    try { err = await res.json(); } catch { /* */ }
    throw new ApiError(res.status, err?.error ?? res.statusText, err);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface AdminUser {
  id: string;
  username: string;
  email: string;
  name: string | null;
  accountLevel: number;
  pokedexCaughtCount: number;
  totalCaughtLevels: number;
  isAdmin: boolean;
  bannedUntil: string | null;
  banReason: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export interface Analytics {
  totals: {
    users: number;
    bannedUsers: number;
    admins: number;
    friendships: number;
    chatMessagesTotal: number;
    chatMessages7d: number;
  };
  activity: {
    activeDay: number;
    activeWeek: number;
    activeMonth: number;
    signups7d: number;
  };
  averages: {
    pokedexCaught: number;
    accountLevel: number;
  };
  signupSeries: Record<string, number>;
  leaderboards: {
    pokedex: { id: string; username: string; name: string | null; accountLevel: number; pokedexCaughtCount: number }[];
  };
}

export interface AdminMe { id: string; username: string; isAdmin: boolean }

export const api = {
  // Auth probe — returns 401 if not signed in, 403 if signed in but
  // not admin, 200 if admin. Used by the auth gate at app boot.
  me: () => req<AdminMe>("GET", "/api/admin/me"),
  signOut: () => req<void>("POST", "/api/auth/sign-out"),

  // Users
  listUsers: (q: string, page = 0, pageSize = 25) =>
    req<{ total: number; page: number; pageSize: number; users: AdminUser[] }>(
      "GET",
      `/api/admin/users?q=${encodeURIComponent(q)}&page=${page}&pageSize=${pageSize}`
    ),
  getUser: (id: string) => req<any>("GET", `/api/admin/users/${id}`),
  setAdmin: (id: string, isAdmin: boolean) =>
    req<{ id: string; isAdmin: boolean }>("POST", `/api/admin/users/${id}/admin`, { isAdmin }),
  ban: (id: string, until: string | null, reason: string | null) =>
    req<any>("POST", `/api/admin/users/${id}/ban`, { until, reason }),
  deleteUser: (id: string) => req<{ ok: true }>("DELETE", `/api/admin/users/${id}`),
  resetSave: (id: string) =>
    req<{ id: string; saveVersion: number }>("POST", `/api/admin/users/${id}/reset-save`),

  // Analytics
  analytics: () => req<Analytics>("GET", "/api/admin/analytics"),

  // Map editor
  getMapPositions: () =>
    req<{ positions: Record<string, { x: number; y: number }> }>(
      "GET",
      "/api/admin/map-positions"
    ),
  saveMapPositions: (positions: Record<string, { x: number; y: number }>) =>
    req<{ ok: true; count: number }>("PUT", "/api/admin/map-positions", { positions }),
  getMapCrop: () =>
    req<{ crop: { x: number; y: number; w: number; h: number } | null }>(
      "GET",
      "/api/admin/map-crop"
    ),
  saveMapCrop: (crop: { x: number; y: number; w: number; h: number } | null) =>
    req<{ ok: true; crop: { x: number; y: number; w: number; h: number } | null }>(
      "PUT",
      "/api/admin/map-crop",
      { crop }
    ),

  // Chat moderation
  recentChat: (limit = 50) =>
    req<{ messages: any[] }>("GET", `/api/admin/chat/recent?limit=${limit}`),
  deleteChat: (id: string) => req<{ ok: true }>("DELETE", `/api/admin/chat/${id}`),

  // Bug reports — list + status update
  listBugReports: (status = "", limit = 50, offset = 0) =>
    req<{ reports: BugReport[] }>(
      "GET",
      `/api/admin/bug-reports?status=${encodeURIComponent(status)}&limit=${limit}&offset=${offset}`,
    ),
  updateBugReport: (id: string, body: { status?: string; adminNotes?: string }) =>
    req<{ ok: true }>("PATCH", `/api/admin/bug-reports/${id}`, body),

  // Error log — server + client errors
  listErrors: (kind = "", limit = 100) =>
    req<{ errors: ErrorEntry[] }>(
      "GET",
      `/api/admin/errors?kind=${encodeURIComponent(kind)}&limit=${limit}`,
    ),
};

export interface BugReport {
  id: string;
  reporterId: string | null;
  reporterName: string;
  title: string;
  description: string;
  page: string | null;
  userAgent: string | null;
  context: string | null;
  status: "open" | "investigating" | "resolved" | "wontfix";
  adminNotes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ErrorEntry {
  id: string;
  kind: "server" | "client";
  level: "error" | "warn";
  message: string;
  stack: string | null;
  source: string | null;
  userId: string | null;
  username: string | null;
  userAgent: string | null;
  meta: unknown;
  createdAt: string;
}

export { ApiError };
