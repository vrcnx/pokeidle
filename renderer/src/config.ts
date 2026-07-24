// All runtime configuration comes from env vars so the renderer is a pure
// 12-factor service. The Twitch stream key lives ONLY here (on the renderer's
// own Railway service) — the game server never sees it.

function req(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`[config] missing required env var ${name}`);
    process.exit(1);
  }
  return v;
}

function opt(name: string, fallback: string): string {
  const v = process.env[name]?.trim();
  return v && v.length > 0 ? v : fallback;
}

function num(name: string, fallback: number): number {
  // Treat unset OR set-but-empty/whitespace as "use the fallback" (Number("")
  // is 0, which would silently zero out an interval/backoff). Reject
  // non-positive values too — none of our numeric knobs are meaningfully 0.
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const CONFIG = {
  // Where the game server lives (the API origin, e.g. https://api.pokeidle.com).
  serverUrl: req("SERVER_URL").replace(/\/$/, ""),
  // Shared secret matching RENDERER_TOKEN on the server.
  rendererToken: req("RENDERER_TOKEN"),
  // Twitch RTMP ingest. Default is Twitch's auto-routing primary ingest; the
  // stream key is appended per-stream. Override TWITCH_INGEST_URL with a
  // regional ingest for lower latency if desired.
  twitchIngestUrl: opt("TWITCH_INGEST_URL", "rtmp://live.twitch.tv/app").replace(/\/$/, ""),
  twitchKey: opt("TWITCH_STREAM_KEY", ""),
  // System Chromium installed in the Docker image.
  chromiumPath: opt("CHROMIUM_PATH", "/usr/bin/chromium"),
  // The Xvfb display the entrypoint starts. ffmpeg x11grabs this.
  display: opt("DISPLAY", ":99"),
  // Xvfb is always 1920x1080; ffmpeg scales down to the requested output size.
  captureWidth: 1920,
  captureHeight: 1080,
  // Directory of audio files looped as the stream's music bed. Empty/missing
  // → the stream runs silent (a required-by-Twitch anullsrc track).
  musicDir: opt("MUSIC_DIR", "/app/music"),
  // How often to reconcile desired-state with the server, ms.
  pollIntervalMs: num("POLL_INTERVAL_MS", 5000),
  // Backoff before restarting a crashed ffmpeg/browser, ms.
  restartBackoffMs: num("RESTART_BACKOFF_MS", 4000),
  // If ffmpeg stops making frame progress for this long while still "alive"
  // (e.g. a wedged RTMP push or a frozen page), treat it as stalled and
  // restart it. Catches the silent-failure modes process-exit can't.
  stallMs: num("STALL_MS", 20000),
  // ffmpeg x264 preset. veryfast keeps 1080p60 within a couple of vCPUs.
  x264Preset: opt("X264_PRESET", "veryfast"),
} as const;
