import { CONFIG } from "./config.js";

// The renderer's view of the desired broadcast state, fetched from the game
// server's token-authed internal endpoint.
export interface DesiredState {
  enabled: boolean;
  loginUrl: string | null;
  account: string | null;
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
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

export async function reportStatus(status: ReportedStatus): Promise<void> {
  try {
    await fetch(`${CONFIG.serverUrl}/api/internal/broadcast/status`, {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify(status),
    });
  } catch {
    // Status reporting is best-effort; a missed report just shows as stale.
  }
}
