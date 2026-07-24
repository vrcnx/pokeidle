import { CONFIG } from "./config.js";

// The renderer's view of the desired broadcast state, fetched from the game
// server's token-authed internal endpoint.
// Live-control input relayed from the admin dashboard. Coordinates are
// normalised (0..1) against the page viewport.
export type InputCommand =
  | { kind: "click"; x: number; y: number; button?: "left" | "right"; clicks?: number }
  | { kind: "move"; x: number; y: number }
  | { kind: "scroll"; x: number; y: number; dy: number }
  | { kind: "type"; text: string }
  | { kind: "key"; key: string }
  | { kind: "reload" }
  | { kind: "home" }
  | { kind: "navigate"; url: string };

export interface DesiredState {
  enabled: boolean;
  loginUrl: string | null;
  account: string | null;
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  /** True while an admin has the live-control panel open — only then do we
   *  spend CPU capturing preview frames. */
  watching?: boolean;
  /** Queued clicks/keystrokes to apply to the page this tick. */
  input?: InputCommand[];
}

export interface ReportedStatus {
  live: boolean;
  account: string | null;
  loginUrl?: string | null;
  width?: number;
  height?: number;
  fps?: number;
  bitrateKbps?: number;
  startedAt?: number | null;
  restarts?: number;
  lastError?: string | null;
  encoder?: { fps?: number; bitrate?: string; frame?: number; dropped?: number; speed?: string } | null;
  music?: number;
}

const authHeaders = { authorization: `Bearer ${CONFIG.rendererToken}` };

export async function fetchDesiredState(): Promise<DesiredState | null> {
  try {
    const r = await fetch(`${CONFIG.serverUrl}/api/internal/broadcast/state`, {
      headers: authHeaders,
      // Bounded: an unresponsive server must never stall the reconcile loop.
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) {
      console.error(`[server] state fetch failed: ${r.status}`);
      return null;
    }
    return (await r.json()) as DesiredState;
  } catch (e) {
    console.error("[server] state fetch error:", (e as Error).message);
    return null;
  }
}

export async function postFrame(dataBase64: string, width: number, height: number): Promise<void> {
  try {
    await fetch(`${CONFIG.serverUrl}/api/internal/broadcast/frame`, {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ data: dataBase64, width, height }),
      signal: AbortSignal.timeout(6000),
    });
  } catch (e) {
    // Preview frames are best-effort — a dropped one just means a stale image.
    console.error("[server] frame post failed:", (e as Error).message);
  }
}

export async function reportStatus(status: ReportedStatus): Promise<void> {
  try {
    await fetch(`${CONFIG.serverUrl}/api/internal/broadcast/status`, {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify(status),
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    // Status reporting is best-effort; a missed report just shows as stale.
  }
}
