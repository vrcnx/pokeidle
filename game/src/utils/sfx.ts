// Fire-and-forget sound effects manager. Different from music:
//   - No crossfade — short snappy clips
//   - One audio element per active sound (browsers are happy to spawn
//     a few simultaneous Audios; we cap to ~6 to avoid runaway)
//   - Per-event-type categories (currently "attack"; easy to extend)
//   - Volume + mute persisted in localStorage, independent of music
//
// Files live under /public/music/sound-effects/<category>/. Add a
// track by dropping it in and appending the filename to the list.

const STORAGE_KEY = "pkmn-sfx";
const MAX_CONCURRENT = 6;

interface Persisted {
  enabled: boolean;
  volume: number; // 0..1
}

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { enabled: true, volume: 0.55 };
    const v = JSON.parse(raw);
    return {
      enabled: typeof v.enabled === "boolean" ? v.enabled : true,
      volume: typeof v.volume === "number" ? clamp01(v.volume) : 0.55,
    };
  } catch {
    return { enabled: true, volume: 0.55 };
  }
}

function clamp01(n: number): number { return Math.max(0, Math.min(1, n)); }

// Multiplier applied to the slider value when actually playing — keeps
// SFX a touch quieter than music at the same nominal level so attack
// hits don't drown out the soundtrack. The user still sees and
// controls 0..100; we just scale down the output.
const SFX_VOLUME_TRIM = 0.7;

export type SfxCategory = "attack";
export const sfxLibrary: Record<SfxCategory, string[]> = {
  attack: [
    "hit.mp3",
    // Drop more attack files into public/music/sound-effects/attack/
    // and append filenames here to extend the rotation pool.
  ],
};

// Pokemon cries — hosted by PokeAPI on GitHub. `latest` is the
// modern Gen-5+ recording (every species has one); `legacy` is the
// retro 8-bit chiptune cry (only Gen 1-2, #1-251). Strategy: try
// latest first, fall back to legacy on 404 so newer species still
// chirp something instead of going silent.
const CRY_LATEST = (id: number) =>
  `https://raw.githubusercontent.com/PokeAPI/cries/main/cries/pokemon/latest/${id}.ogg`;
const CRY_LEGACY = (id: number) =>
  `https://raw.githubusercontent.com/PokeAPI/cries/main/cries/pokemon/legacy/${id}.ogg`;

function trackUrl(cat: SfxCategory, file: string): string {
  return `/music/sound-effects/${cat}/${encodeURIComponent(file)}`;
}

class SfxManager {
  private state: Persisted;
  private active: Set<HTMLAudioElement> = new Set();
  private listeners = new Set<(s: Persisted) => void>();
  // Per-category shuffle queue so we cycle through every clip before
  // any one repeats — feels more varied than independent random picks.
  private queues: Record<SfxCategory, string[]> = { attack: [] };

  constructor() {
    this.state = loadPersisted();
    if (typeof document !== "undefined") {
      // Pause anything mid-play when the tab loses focus and resume
      // it when it comes back — keeps SFX consistent with the music
      // bus, which already handles visibility. Otherwise short hits
      // queued just before the tab hid would keep firing in the
      // background.
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
          for (const a of this.active) a.pause();
        } else if (this.state.enabled) {
          for (const a of this.active) {
            void a.play().catch(() => undefined);
          }
        }
      });
    }
  }

  subscribe(fn: (s: Persisted) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => { this.listeners.delete(fn); };
  }

  snapshot(): Persisted { return { ...this.state }; }

  setEnabled(on: boolean): void {
    this.state.enabled = on;
    this.persist();
    if (!on) this.stopAll();
    this.emit();
  }

  setVolume(v: number): void {
    this.state.volume = clamp01(v);
    this.persist();
    // Adjust any currently-playing clips so the slider responds live.
    for (const a of this.active) a.volume = this.state.volume * SFX_VOLUME_TRIM;
    this.emit();
  }

  /** Play a random clip from the given category, with a small random
   *  pitch shift so consecutive hits don't sound identical. No-op if
   *  muted / category empty / browser-blocked. */
  play(category: SfxCategory): void {
    if (!this.state.enabled) return;
    const file = this.dequeue(category);
    if (!file) return;
    if (this.active.size >= MAX_CONCURRENT) {
      // Drop the oldest — keeps overlapping noise under control.
      const oldest = this.active.values().next().value as HTMLAudioElement | undefined;
      if (oldest) {
        oldest.pause();
        this.active.delete(oldest);
      }
    }
    const audio = new Audio(trackUrl(category, file));
    audio.volume = this.state.volume * SFX_VOLUME_TRIM;
    audio.preload = "auto";
    // Pitch variation: pick a playbackRate in [0.85, 1.20]. Setting
    // preservesPitch=false makes playbackRate also shift pitch (the
    // default keeps pitch fixed and only changes tempo). Result: each
    // attack sounds slightly different even when the same source clip
    // is played repeatedly. Cross-browser quirks on the property name
    // — Safari uses webkitPreservesPitch — so set both.
    const rate = 0.85 + Math.random() * 0.35;
    audio.playbackRate = rate;
    type WithPitch = HTMLAudioElement & {
      preservesPitch?: boolean;
      mozPreservesPitch?: boolean;
      webkitPreservesPitch?: boolean;
    };
    const a = audio as WithPitch;
    a.preservesPitch = false;
    a.mozPreservesPitch = false;
    a.webkitPreservesPitch = false;
    this.active.add(audio);
    audio.addEventListener("ended", () => { this.active.delete(audio); });
    audio.addEventListener("error", () => { this.active.delete(audio); });
    void audio.play().catch(() => {
      // Autoplay-blocked or 404 — drop quietly. Music's first-gesture
      // unlock will eventually clear the autoplay block.
      this.active.delete(audio);
    });
  }

  /** Play a Pokemon's species cry. Tries the modern (latest) cry
   *  first; on 404 falls back to the legacy 8-bit cry. Honours the
   *  same enabled / volume settings as other SFX. */
  playCry(dexId: number): void {
    if (!this.state.enabled) return;
    if (!Number.isFinite(dexId) || dexId <= 0) return;
    if (this.active.size >= MAX_CONCURRENT) {
      const oldest = this.active.values().next().value as HTMLAudioElement | undefined;
      if (oldest) { oldest.pause(); this.active.delete(oldest); }
    }
    const audio = new Audio(CRY_LATEST(dexId));
    audio.volume = this.state.volume * SFX_VOLUME_TRIM;
    audio.preload = "auto";
    this.active.add(audio);
    let triedLegacy = false;
    audio.addEventListener("ended", () => { this.active.delete(audio); });
    audio.addEventListener("error", () => {
      if (!triedLegacy) {
        triedLegacy = true;
        audio.src = CRY_LEGACY(dexId);
        void audio.play().catch(() => { this.active.delete(audio); });
      } else {
        this.active.delete(audio);
      }
    });
    void audio.play().catch(() => {
      // Same fallback path: try legacy if the initial play() rejects.
      if (!triedLegacy) {
        triedLegacy = true;
        audio.src = CRY_LEGACY(dexId);
        void audio.play().catch(() => { this.active.delete(audio); });
      } else {
        this.active.delete(audio);
      }
    });
  }

  private dequeue(category: SfxCategory): string | null {
    const pool = sfxLibrary[category];
    if (!pool || pool.length === 0) return null;
    if (this.queues[category].length === 0) {
      // Re-shuffle so the next pass through doesn't repeat the same
      // order. With one clip in the pool this is a no-op.
      const arr = pool.slice();
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j]!, arr[i]!];
      }
      this.queues[category] = arr;
    }
    return this.queues[category].shift() ?? null;
  }

  private stopAll(): void {
    for (const a of this.active) {
      a.pause();
      a.src = "";
    }
    this.active.clear();
  }

  private persist(): void {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state)); } catch { /* */ }
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners) fn(snap);
  }
}

export const sfxManager = new SfxManager();
