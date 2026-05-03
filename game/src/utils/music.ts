// Background music manager. One audio element per "deck" — two decks
// total — so we can crossfade smoothly when changing categories or
// rolling to the next track. Public API:
//
//   musicManager.setCategory("city" | "routes" | "challenge" | null)
//   musicManager.setVolume(0..1)
//   musicManager.setEnabled(boolean)
//
// Persisted in localStorage so the player's preferences survive
// reloads. The audio element is paused when the tab is hidden so a
// background-tab game doesn't keep streaming.
//
// Browsers block autoplay until the user interacts with the page —
// the manager catches the rejected play() and waits for the next
// click/keypress on document, then resumes. This is automatic; no
// "click to enable music" prompt.

import {
  musicPlaylists,
  trackUrl,
  type MusicCategory,
} from "../data/musicPlaylists";

const STORAGE_KEY = "pkmn-music";
const FADE_MS = 800;
const TICK_MS = 40;

interface Persisted {
  enabled: boolean;
  volume: number; // 0..1
}

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { enabled: true, volume: 0.5 };
    const v = JSON.parse(raw);
    return {
      enabled: typeof v.enabled === "boolean" ? v.enabled : true,
      volume: typeof v.volume === "number" ? clamp01(v.volume) : 0.5,
    };
  } catch {
    return { enabled: true, volume: 0.5 };
  }
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function shuffled<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

class MusicManager {
  private active: HTMLAudioElement | null = null;
  private incoming: HTMLAudioElement | null = null;
  private fadeTimer: number | null = null;
  private category: MusicCategory | null = null;
  private queue: string[] = [];
  private listeners = new Set<(s: PublicState) => void>();
  private state: Persisted;
  private waitingForGesture = false;

  constructor() {
    this.state = loadPersisted();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibility);
      // First-gesture unlock: browsers block autoplay until any user
      // interaction. Resume here once that happens.
      const onFirstGesture = () => {
        this.waitingForGesture = false;
        if (this.active && this.active.paused && this.state.enabled) {
          void this.active.play().catch(() => undefined);
        }
        document.removeEventListener("pointerdown", onFirstGesture);
        document.removeEventListener("keydown", onFirstGesture);
      };
      document.addEventListener("pointerdown", onFirstGesture);
      document.addEventListener("keydown", onFirstGesture);
    }
  }

  /** Subscribe to state updates. Returns an unsubscribe fn. */
  subscribe(fn: (s: PublicState) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => { this.listeners.delete(fn); };
  }

  snapshot(): PublicState {
    return {
      enabled: this.state.enabled,
      volume: this.state.volume,
      category: this.category,
      currentTrack: this.active?.src
        ? decodeURIComponent(this.active.src.split("/").pop() ?? "")
        : null,
      waitingForGesture: this.waitingForGesture,
    };
  }

  setCategory(category: MusicCategory | null): void {
    if (category === this.category) return;
    this.category = category;
    this.queue = [];
    if (!category) {
      this.fadeOut();
    } else {
      this.playNext();
    }
    this.emit();
  }

  setEnabled(on: boolean): void {
    this.state.enabled = on;
    this.persist();
    if (!on) {
      // Hard-stop both decks immediately when muted.
      if (this.active) { this.active.pause(); this.active.src = ""; this.active = null; }
      if (this.incoming) { this.incoming.pause(); this.incoming.src = ""; this.incoming = null; }
    } else if (this.category) {
      this.playNext();
    }
    this.emit();
  }

  setVolume(v: number): void {
    this.state.volume = clamp01(v);
    this.persist();
    if (this.active && !this.fadeTimer) this.active.volume = this.state.volume;
    this.emit();
  }

  /** Skip to the next track in the current playlist. */
  next(): void {
    if (!this.category) return;
    this.playNext();
  }

  // ── Internals ───────────────────────────────────────────────────

  private persist(): void {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state)); } catch { /* */ }
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners) fn(snap);
  }

  private nextFromQueue(): string | null {
    if (!this.category) return null;
    const playlist = musicPlaylists[this.category] ?? [];
    if (playlist.length === 0) return null;
    if (this.queue.length === 0) {
      // Re-shuffle when the queue empties so we don't replay tracks
      // in the same order every loop.
      this.queue = shuffled(playlist);
    }
    return this.queue.shift() ?? null;
  }

  private playNext(): void {
    if (!this.state.enabled) return;
    const track = this.nextFromQueue();
    if (!track || !this.category) {
      this.fadeOut();
      return;
    }
    const url = trackUrl(this.category, track);
    const next = new Audio(url);
    next.preload = "auto";
    next.volume = 0;
    next.addEventListener("ended", () => {
      // Auto-advance when a track ends (with crossfade into the next).
      this.playNext();
    });
    void next.play().catch((err) => {
      // Autoplay blocked — wait for the first user gesture.
      if (err?.name === "NotAllowedError") {
        this.waitingForGesture = true;
        this.emit();
      }
    });
    this.crossfade(next);
  }

  private crossfade(into: HTMLAudioElement): void {
    if (this.fadeTimer) {
      window.clearInterval(this.fadeTimer);
      this.fadeTimer = null;
    }
    const out = this.active;
    this.incoming = into;
    const targetVol = this.state.volume;
    const startTime = performance.now();
    this.fadeTimer = window.setInterval(() => {
      const t = Math.min(1, (performance.now() - startTime) / FADE_MS);
      if (out) out.volume = Math.max(0, targetVol * (1 - t));
      into.volume = targetVol * t;
      if (t >= 1) {
        if (out) { out.pause(); out.src = ""; }
        this.active = into;
        this.incoming = null;
        if (this.fadeTimer) {
          window.clearInterval(this.fadeTimer);
          this.fadeTimer = null;
        }
        this.emit();
      }
    }, TICK_MS);
  }

  private fadeOut(): void {
    if (!this.active) return;
    const out = this.active;
    const startVol = out.volume;
    const startTime = performance.now();
    if (this.fadeTimer) window.clearInterval(this.fadeTimer);
    this.fadeTimer = window.setInterval(() => {
      const t = Math.min(1, (performance.now() - startTime) / FADE_MS);
      out.volume = startVol * (1 - t);
      if (t >= 1) {
        out.pause();
        out.src = "";
        this.active = null;
        if (this.fadeTimer) {
          window.clearInterval(this.fadeTimer);
          this.fadeTimer = null;
        }
        this.emit();
      }
    }, TICK_MS);
  }

  private onVisibility = (): void => {
    if (!this.active) return;
    if (document.hidden) {
      this.active.pause();
    } else if (this.state.enabled) {
      void this.active.play().catch(() => undefined);
    }
  };
}

export interface PublicState {
  enabled: boolean;
  volume: number;
  category: MusicCategory | null;
  currentTrack: string | null;
  waitingForGesture: boolean;
}

// Singleton — one manager for the whole app.
export const musicManager = new MusicManager();
