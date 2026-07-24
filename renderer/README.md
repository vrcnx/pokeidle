# pkmn-renderer — 24/7 Twitch broadcast service

Runs the game unattended in a headless Chromium and pushes 1080p video to
Twitch via ffmpeg. Fully controlled from the **admin dashboard → Broadcast**
page. This is a **separate Railway service** from the API — it's CPU-heavy and
must not share a container with the server that real players depend on.

```
admin dashboard ──(desired state)──► server ──poll──► renderer
                                                        │  Chromium (stream-login → self-plays)
                                                        │  ffmpeg x11grab + music
                                                        └──RTMP──► Twitch
```

## How it works

1. The renderer polls `GET {SERVER_URL}/api/internal/broadcast/state` every few
   seconds (authed by `RENDERER_TOKEN`).
2. When the admin flips **Go live**, that endpoint returns `enabled: true` plus
   the stream-login URL for the chosen account.
3. The renderer opens that URL in Chromium on a virtual X display (Xvfb). The
   game auto-logs-in (restricted stream session), dismisses all popups, and
   self-plays. Steer it (fight E4, raids, travel) from the account's Users page.
4. ffmpeg screen-grabs the display, mixes in your music, encodes H.264/AAC, and
   pushes RTMP to Twitch.
5. It reports live status back, shown on the Broadcast page. A crashed browser
   or encoder is automatically brought back on the next poll — that's the 24/7
   watchdog.

## Deploy on Railway

Create a **new service** in the same Railway project:

- **Source:** this repo, **Root Directory = `renderer`**.
- **Builder:** Dockerfile (auto-detected from `renderer/Dockerfile`; `railway.json`
  pins it and sets `restartPolicyType: ALWAYS`).
- **Resources:** give it real CPU. 1080p60 software x264 wants ~3–4 vCPU;
  1080p30 ~2 vCPU. Start at 30fps and raise if you want.

### Environment variables (on the renderer service)

| Var | Required | Example | Notes |
|-----|----------|---------|-------|
| `TWITCH_STREAM_KEY` | ✅ | `live_1234…` | **Secret.** From Twitch → Creator Dashboard → Settings → Stream. Lives ONLY here. |
| `SERVER_URL` | ✅ | `https://api.pokeidle.com` | The game API origin. |
| `RENDERER_TOKEN` | ✅ | (32+ random chars) | Shared secret. **Must match the same var on the server service.** |
| `TWITCH_INGEST_URL` | — | `rtmp://live.twitch.tv/app` | Default auto-routes. Use a regional ingest for lower latency. |
| `MUSIC_DIR` | — | `/app/music` | Folder of looped audio (see below). |
| `X264_PRESET` | — | `veryfast` | `faster`/`fast` = better quality, more CPU. |
| `CHROMIUM_PATH` | — | `/usr/bin/chromium` | Set by the image; don't change. |
| `POLL_INTERVAL_MS` | — | `5000` | How often it reconciles with the server. |

### On the **server** service, add one var

| Var | Required | Notes |
|-----|----------|-------|
| `RENDERER_TOKEN` | ✅ | Same value as on the renderer. Without it, the internal API is off (fails closed). |

## Music

Drop your **owned** audio files into `renderer/music/` (`.mp3 .m4a .aac .ogg
.opus .wav .flac`). They're looped in filename order as the stream's audio bed.
An empty folder streams **silent**. Files are git-ignored — either commit them
to a private fork, bake them into the image, or attach a Railway volume mounted
at `/app/music`.

> Twitch's automated audio detection may still flag music it can't verify you
> own — usually muting the VOD, not the live stream. Since you own it, disputes
> are straightforward. Start silent if you want zero risk.

## Live browser control

The Broadcast page has a **Live browser** card: hit *Start control* and it shows
a ~1 fps screenshot of the streamed page that you can click, scroll and type
into. Input is relayed admin → server → renderer → Playwright, so expect ~1–2s
of latency — it's for occasional intervention (dismissing something, clicking a
menu), not twitch play.

Frames are only captured while that panel is open (it costs renderer CPU), and
they're held in server memory only — never written to the database. The renderer
also ticks faster (1s instead of 5s) while you're watching so clicks land
promptly.

## Operating it

1. On the streaming account's **Users** page, enable a **Stream login** and set
   its self-play config (start route, auto-buy balls, speed).
2. Go to **Broadcast**, type that account's username, pick resolution/fps, and
   hit **Go live**.
3. Watch the live status (encoder fps/bitrate, dropped frames, uptime). Drive
   gameplay from the account's **Remote control** (fight E4, raids, travel).
4. **Stop broadcast** ends it; the renderer idles until you go live again.

## Important: cookie / domain requirement

The stream session cookie is `SameSite=Lax`, so the **API must share a
registrable domain with the game** (e.g. `api.pokeidle.com` + `pokeidle.com`).
That's the standard setup and works with the headless browser. If the API and
game are on unrelated domains, the auto-login silently degrades to anonymous —
tell me and I'll switch the stream cookie to `SameSite=None; Secure`.

## Local dev

```
npm install
# needs a local chromium + ffmpeg + an X display (or Xvfb) to actually stream
SERVER_URL=http://localhost:8787 RENDERER_TOKEN=devtoken TWITCH_STREAM_KEY=... \
  CHROMIUM_PATH="/path/to/chrome" npm run dev
```
Without Xvfb it will try your real display. The Docker image is the intended
runtime.
