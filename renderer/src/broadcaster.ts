import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { CONFIG } from "./config.js";
import type { DesiredState, ReportedStatus } from "./server.js";

const AUDIO_EXT = new Set([".mp3", ".m4a", ".aac", ".ogg", ".opus", ".wav", ".flac"]);
const PLAYLIST_PATH = "/tmp/music.txt";

// Manages the two long-lived children that make the stream: a headful Chromium
// (rendering the game inside Xvfb) and an ffmpeg that x11grabs the display and
// pushes RTMP to Twitch. The browser is keyed by the login URL; ffmpeg by the
// encode settings — so a quality change restarts only ffmpeg (fast), while the
// account/URL changing restarts the browser.
export class Broadcaster {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private browserUrl: string | null = null;
  private lastBrowserAttempt = 0;

  private ffmpeg: ChildProcess | null = null;
  private ffmpegSig: string | null = null;
  private ffmpegStartedAt = 0;
  private lastFfmpegExit = 0;
  private lastProgressAt = 0; // when ffmpeg's frame count last advanced
  private lastFrame = -1;
  private ffmpegErr: string[] = []; // ring buffer of recent stderr error lines

  private startedAt: number | null = null;
  private restarts = 0;
  private lastError: string | null = null;
  private musicCount = 0;
  private encoder: ReportedStatus["encoder"] = null;
  private account: string | null = null;

  status(): ReportedStatus {
    const live = !!this.browser?.isConnected() && !!this.ffmpeg && this.ffmpeg.exitCode === null && !this.isFfmpegStalled();
    return {
      live,
      account: this.account,
      startedAt: this.startedAt,
      restarts: this.restarts,
      lastError: this.lastError,
      encoder: live ? this.encoder : null,
      music: this.musicCount,
    };
  }

  // Reconcile toward the desired state. Called serially from the poll loop, so
  // no two starts overlap.
  async ensureRunning(state: DesiredState): Promise<void> {
    this.account = state.account;

    // Browser: (re)start if the login URL changed or it died — but not more
    // often than the backoff window, so a chromium that fails to launch doesn't
    // get respawned every single tick.
    const browserDead = this.browserUrl !== state.loginUrl || !this.browser?.isConnected();
    if (browserDead && Date.now() - this.lastBrowserAttempt >= CONFIG.restartBackoffMs) {
      await this.startBrowser(state.loginUrl!);
    }

    // ffmpeg: a stalled-but-alive encoder (wedged RTMP / frozen page) is killed
    // here so the normal restart path brings it back.
    if (this.isFfmpegStalled()) {
      this.lastError = "ffmpeg stalled (no frame progress) — restarting";
      console.error(`[ffmpeg] ${this.lastError}`);
      this.stopFfmpeg();
      this.lastFfmpegExit = Date.now();
      this.restarts++;
      return; // restart on a later tick, after the backoff window
    }

    const sig = `${state.width}x${state.height}@${state.fps}/${state.bitrateKbps}`;
    const dead = !this.ffmpeg || this.ffmpeg.exitCode !== null;
    if (dead && Date.now() - this.lastFfmpegExit < CONFIG.restartBackoffMs) return;
    if (this.ffmpegSig !== sig || dead) {
      if (dead && this.ffmpegSig) this.restarts++;
      this.startFfmpeg(state);
      this.ffmpegSig = sig;
    }
  }

  async stop(): Promise<void> {
    this.stopFfmpeg();
    this.ffmpegSig = null;
    await this.stopBrowser();
    this.startedAt = null;
    this.encoder = null;
  }

  // True when ffmpeg is running but has made no frame progress for stallMs.
  // A fresh spawn gets a 2× grace window before the first stats line.
  private isFfmpegStalled(): boolean {
    if (!this.ffmpeg || this.ffmpeg.exitCode !== null) return false;
    if (this.lastProgressAt === 0) {
      return Date.now() - this.ffmpegStartedAt > CONFIG.stallMs * 2;
    }
    return Date.now() - this.lastProgressAt > CONFIG.stallMs;
  }

  // ── Browser ──────────────────────────────────────────────────────────
  private async startBrowser(loginUrl: string): Promise<void> {
    this.lastBrowserAttempt = Date.now();
    await this.stopBrowser();
    try {
      console.log(`[browser] launching → ${redactSecret(loginUrl)}`);
      this.browser = await chromium.launch({
        executablePath: CONFIG.chromiumPath,
        headless: false,
        args: [
          `--window-position=0,0`,
          `--window-size=${CONFIG.captureWidth},${CONFIG.captureHeight}`,
          "--kiosk",
          "--no-sandbox",
          "--disable-gpu",
          "--disable-dev-shm-usage",
          "--autoplay-policy=no-user-gesture-required",
          "--disable-infobars",
          "--hide-scrollbars",
          "--no-first-run",
          "--disable-features=Translate,site-per-process",
          "--force-device-scale-factor=1",
          "--check-for-update-interval=31536000",
        ],
      });
      this.browser.on("disconnected", () => {
        if (this.browserUrl) console.error("[browser] disconnected unexpectedly");
        this.browser = null;
        this.browserUrl = null;
      });
      this.context = await this.browser.newContext({ viewport: null });
      this.page = await this.context.newPage();
      // A renderer-process crash leaves browser.isConnected() true, so watch
      // for it explicitly and drop the browser so the next tick relaunches.
      this.page.on("crash", () => {
        console.error("[browser] page crashed — will relaunch");
        this.browserUrl = null;
      });
      // The stream-login URL 302s to the game origin, sets the session cookie,
      // and the client self-plays. domcontentloaded + a settle wait rather than
      // networkidle (the game holds a websocket open, so networkidle never
      // fires).
      await this.page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await this.page.waitForTimeout(8000);
      this.browserUrl = loginUrl;
      this.startedAt = this.startedAt ?? Date.now();
      this.lastError = null;
      console.log("[browser] game loaded");
    } catch (e) {
      this.lastError = `browser: ${(e as Error).message}`;
      console.error("[browser] launch failed:", this.lastError);
      await this.stopBrowser();
    }
  }

  private async stopBrowser(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.browserUrl = null;
    if (b) await b.close().catch(() => {});
  }

  // ── ffmpeg ───────────────────────────────────────────────────────────
  private startFfmpeg(state: DesiredState): void {
    this.stopFfmpeg();
    if (!CONFIG.twitchKey) {
      this.lastError = "TWITCH_STREAM_KEY is not set on the renderer";
      console.error(`[ffmpeg] ${this.lastError}`);
      return;
    }
    const args = this.buildFfmpegArgs(state);
    console.log(`[ffmpeg] starting ${state.width}x${state.height}@${state.fps} ${state.bitrateKbps}k (music: ${this.musicCount} tracks)`);
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    this.ffmpeg = proc;
    this.ffmpegStartedAt = Date.now();
    this.lastProgressAt = 0;
    this.lastFrame = -1;
    this.ffmpegErr = [];
    this.startedAt = this.startedAt ?? Date.now();

    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => this.onFfmpegStderr(chunk));
    proc.on("exit", (code, signal) => {
      this.lastFfmpegExit = Date.now();
      if (this.ffmpeg === proc) this.ffmpeg = null;
      if (code && code !== 0) {
        const tail = this.ffmpegErr.slice(-3).join(" | ");
        this.lastError = `ffmpeg exited code ${code}${tail ? `: ${tail}` : ""}`;
        console.error(`[ffmpeg] exited code ${code} signal ${signal}${tail ? ` — ${tail}` : ""}`);
      }
    });
    proc.on("error", (e) => {
      this.lastError = `ffmpeg: ${e.message}`;
      console.error("[ffmpeg] spawn error:", e.message);
    });
  }

  private stopFfmpeg(): void {
    const p = this.ffmpeg;
    this.ffmpeg = null;
    this.encoder = null;
    if (p && p.exitCode === null) p.kill("SIGKILL");
  }

  // Split ffmpeg's stderr into stats lines (parsed for the encoder readout) and
  // real error lines (logged, redacted, and buffered for the exit message).
  private onFfmpegStderr(chunk: string): void {
    for (const raw of chunk.split(/[\r\n]+/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.includes("frame=")) {
        this.parseFfmpegStats(line);
      } else {
        const safe = redactSecret(line);
        this.ffmpegErr.push(safe);
        if (this.ffmpegErr.length > 10) this.ffmpegErr.shift();
        console.error(`[ffmpeg] ${safe}`);
      }
    }
  }

  private buildFfmpegArgs(state: DesiredState): string[] {
    const { captureWidth: cw, captureHeight: ch, display } = CONFIG;
    const scale = state.width === cw && state.height === ch ? [] : ["-vf", `scale=${state.width}:${state.height}`];
    const audio = this.buildAudioInput();
    const b = state.bitrateKbps;
    return [
      "-hide_banner", "-loglevel", "error", "-stats",
      // input 0: the Xvfb display
      "-f", "x11grab", "-draw_mouse", "0", "-framerate", String(state.fps),
      "-video_size", `${cw}x${ch}`, "-i", display,
      // input 1: looped music or silence
      ...audio,
      // video encode
      "-c:v", "libx264", "-preset", CONFIG.x264Preset, "-tune", "zerolatency",
      "-pix_fmt", "yuv420p",
      "-b:v", `${b}k`, "-maxrate", `${b}k`, "-bufsize", `${b * 2}k`,
      "-g", String(state.fps * 2), "-keyint_min", String(state.fps), "-r", String(state.fps),
      ...scale,
      // audio encode
      "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2",
      "-map", "0:v:0", "-map", "1:a:0",
      "-f", "flv", `${CONFIG.twitchIngestUrl}/${CONFIG.twitchKey}`,
    ];
  }

  private buildAudioInput(): string[] {
    const tracks = this.scanMusic();
    this.musicCount = tracks.length;
    if (tracks.length === 0) {
      return ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"];
    }
    // concat demuxer over a playlist, looped forever. Re-encoded to AAC, so
    // mixed source formats are tolerated (genpts smooths timestamps).
    const list = tracks.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n");
    writeFileSync(PLAYLIST_PATH, list + "\n");
    return ["-stream_loop", "-1", "-fflags", "+genpts", "-f", "concat", "-safe", "0", "-i", PLAYLIST_PATH];
  }

  private scanMusic(): string[] {
    try {
      return readdirSync(CONFIG.musicDir)
        .filter((f) => AUDIO_EXT.has((f.slice(f.lastIndexOf(".")) || "").toLowerCase()))
        .sort()
        .map((f) => join(CONFIG.musicDir, f));
    } catch {
      return [];
    }
  }

  private parseFfmpegStats(line: string): void {
    // ffmpeg -stats emits carriage-return-updated lines like:
    // frame= 512 fps= 60 q=24.0 size=... time=... bitrate=6000.1kbits/s speed=1x drop=0
    const frame = /frame=\s*(\d+)/.exec(line)?.[1];
    const fps = /fps=\s*([\d.]+)/.exec(line)?.[1];
    const bitrate = /bitrate=\s*([\d.]+\s*\w+\/s)/.exec(line)?.[1];
    const speed = /speed=\s*([\d.]+x)/.exec(line)?.[1];
    const dropped = /drop=\s*(\d+)/.exec(line)?.[1];
    const frameNum = frame ? Number(frame) : undefined;
    // Frame progress is the liveness signal (see isFfmpegStalled).
    if (frameNum != null && frameNum > this.lastFrame) {
      this.lastFrame = frameNum;
      this.lastProgressAt = Date.now();
    }
    this.encoder = {
      frame: frameNum,
      fps: fps ? Number(fps) : undefined,
      bitrate: bitrate?.replace(/\s+/g, ""),
      speed,
      dropped: dropped ? Number(dropped) : undefined,
    };
  }
}

// Strip secrets from any string before logging: both the path-form Twitch key
// (rtmp://…/app/<key>) and the query-form stream-login key (…?key=<key>).
function redactSecret(s: string): string {
  let out = s.replace(/key=[^&\s]+/g, "key=***");
  if (CONFIG.twitchKey) out = out.split(CONFIG.twitchKey).join("***");
  return out;
}
