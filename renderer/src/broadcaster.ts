import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { CONFIG } from "./config.js";
import type { DesiredState, ReportedStatus, InputCommand } from "./server.js";

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

  // ── Live control (admin preview + input relay) ───────────────────────
  //
  // CRITICAL INVARIANT: nothing in here may block the reconcile loop
  // indefinitely. Playwright's mouse/keyboard/evaluate calls take NO timeout
  // option and are acked by the page's renderer thread — a wedged (but not
  // crashed) page never resolves them, which would freeze the 24/7 watchdog so
  // a dead ffmpeg/browser is never restarted. Every page call below is
  // therefore deadline-bounded, and a timeout is treated as "page is wedged":
  // we drop the rest of the batch and force a browser relaunch.

  /** JPEG screenshot of the page for the admin's control panel, base64. */
  async capture(): Promise<{ data: string; width: number; height: number } | null> {
    const page = this.page;
    if (!page || !this.browser?.isConnected() || page.isClosed()) return null;
    try {
      const buf = await withDeadline(
        page.screenshot({ type: "jpeg", quality: 45, timeout: 5000 }),
        6000,
        "screenshot",
      );
      // Deliberately NOT page.evaluate(innerWidth/innerHeight): that call is
      // unbounded and would hang on a wedged page. The window is forced
      // fullscreen on a fixed-size Xvfb screen, so the capture dimensions are
      // known statically.
      return { data: buf.toString("base64"), width: CONFIG.captureWidth, height: CONFIG.captureHeight };
    } catch (e) {
      console.error("[capture] failed:", (e as Error).message);
      return null;
    }
  }

  /** Apply admin-relayed input to the live page. Normalised coords are scaled
   *  against the fixed capture size (same basis the preview was taken with). */
  async applyInput(cmds: InputCommand[]): Promise<void> {
    if (cmds.length === 0) return;
    const page = this.page;
    if (!page || !this.browser?.isConnected() || page.isClosed()) {
      this.lastError = "live input dropped — the streamed browser isn't running";
      console.error(`[input] ${this.lastError} (${cmds.length} command(s))`);
      return;
    }
    const w = CONFIG.captureWidth;
    const h = CONFIG.captureHeight;
    // Whole-batch wall-clock budget, comfortably under the stall threshold so
    // the watchdog keeps ticking even if the operator queues a lot of input.
    const deadline = Date.now() + 8000;

    for (let i = 0; i < cmds.length; i++) {
      const cmd = cmds[i];
      if (Date.now() > deadline) {
        console.error(`[input] batch budget exceeded — dropping ${cmds.length - i} command(s)`);
        this.lastError = "live input batch timed out";
        return;
      }
      try {
        switch (cmd.kind) {
          case "click":
            await withDeadline(page.mouse.click(cmd.x * w, cmd.y * h, {
              button: cmd.button ?? "left",
              clickCount: cmd.clicks ?? 1,
            }), 2500, "click");
            break;
          case "move":
            await withDeadline(page.mouse.move(cmd.x * w, cmd.y * h), 2500, "move");
            break;
          case "scroll":
            await withDeadline(page.mouse.move(cmd.x * w, cmd.y * h), 2500, "move");
            await withDeadline(page.mouse.wheel(0, cmd.dy), 2500, "wheel");
            break;
          case "type":
            await withDeadline(page.keyboard.type(cmd.text, { delay: 8 }), 5000, "type");
            break;
          case "key":
            await withDeadline(page.keyboard.press(cmd.key), 2500, "key");
            break;
          // Navigations are bounded well under CONFIG.stallMs so a slow load
          // can't push the status report past the server's staleness window.
          case "reload":
            await withDeadline(page.reload({ waitUntil: "domcontentloaded", timeout: 9000 }), 10_000, "reload");
            break;
          case "home":
            if (this.browserUrl) {
              await withDeadline(page.goto(this.browserUrl, { waitUntil: "domcontentloaded", timeout: 9000 }), 10_000, "home");
            }
            break;
          case "navigate":
            await withDeadline(page.goto(cmd.url, { waitUntil: "domcontentloaded", timeout: 9000 }), 10_000, "navigate");
            break;
        }
      } catch (e) {
        const msg = (e as Error).message;
        this.lastError = `input ${cmd.kind} failed: ${msg}`;
        console.error(`[input] ${cmd.kind} failed:`, msg);
        // A deadline expiry means the page stopped acking input at all —
        // further commands would each burn their own budget, so abandon the
        // batch and force a relaunch on the next tick.
        if (msg.includes("deadline")) {
          console.error("[input] page appears wedged — forcing a browser relaunch");
          this.browserUrl = null;
          return;
        }
      }
    }
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
          "--start-fullscreen",
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
      // Force the OS window fullscreen via CDP so Chromium hides its tab strip
      // and address bar. --kiosk/--start-fullscreen alone are unreliable under
      // Xvfb (no window manager); setWindowBounds fullscreen is deterministic.
      try {
        const cdp = await this.context.newCDPSession(this.page);
        const { windowId } = await cdp.send("Browser.getWindowForTarget");
        await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "fullscreen" } });
      } catch (e) {
        console.error("[browser] fullscreen via CDP failed:", (e as Error).message);
      }
      // A renderer-process crash leaves browser.isConnected() true, so watch
      // for it explicitly and drop the browser so the next tick relaunches.
      this.page.on("crash", () => {
        console.error("[browser] page crashed — will relaunch");
        this.browserUrl = null;
      });
      // A closed page leaves the browser "connected" but unusable; clearing
      // browserUrl is what makes the next reconcile tick relaunch it.
      this.page.on("close", () => {
        if (this.browserUrl) {
          console.error("[browser] page closed — will relaunch");
          this.browserUrl = null;
        }
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
// Bound a promise that has no timeout of its own. Playwright's input and
// evaluate calls are acked by the page's renderer thread, so a wedged page
// would otherwise hang the caller forever.
function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} deadline exceeded after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

function redactSecret(s: string): string {
  let out = s.replace(/key=[^&\s]+/g, "key=***");
  if (CONFIG.twitchKey) out = out.split(CONFIG.twitchKey).join("***");
  return out;
}
