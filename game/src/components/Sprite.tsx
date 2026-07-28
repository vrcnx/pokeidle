import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ImgHTMLAttributes } from "react";
import { pokemonTable } from "../data/pokemon";
import { pokemonSpriteUrl, pokemonStaticSpriteUrl, trainerSpriteUrl } from "../utils/sprites";

// One <img> wrapper that owns the ENTIRE sprite failure policy.
//
// Why this exists
// ---------------
// Every Pokémon sprite in the app is one remote URL per species, shared by
// ~35 call sites (party, Pokédex, PC, battle, trade, detail modals…). Those
// call sites used to disagree about what a load failure means: nine hid the
// element with `display: none`, four with `opacity: 0`, one dimmed to 0.2,
// three had a real fallback chain, and about thirty had no handler at all.
//
// That mattered because a single transient failure poisons the URL for the
// whole session: the browser negatively-caches the failed response in its
// per-document memory cache, so every later <img> pointing at that exact URL
// fails instantly with no network request until a full page reload. Combined
// with a permanent `display: none`, one CDN hiccup / wifi handoff / tab
// suspend removed a species' sprite from every surface until reload — the
// "some Pokémon just stop rendering" report.
//
// The policy, in order:
//   1. the requested URL;
//   2. the same URL with a cache-busting token — a DISTINCT URL, so it
//      bypasses the poisoned cache entry and a blip self-heals;
//   3. `fallbackSrc` (for Pokémon: the static PNG, which lives on a
//      different CDN subtree and so also survives the ad-blocker rules that
//      match `/animated/`);
//   4. the fallback with its own cache-busting retry;
//   5. a visible placeholder — never `display: none`, never `opacity: 0`.
//      A missing sprite should leave a hole the player can report, not look
//      like an intentional blank.
//
// It also records each sprite's intrinsic pixel size as `--sw` / `--sh` on
// the element. The battle arena uses those to size sprites in proportion to
// each other instead of stretching every species to an identical box.

/** Pause before a cache-busting retry so a momentary blip has time to pass. */
const RETRY_DELAY_MS = 350;

/**
 * Intrinsic sizes keyed by base URL, so a species that has already loaded
 * once renders at the right size on first paint instead of popping.
 */
const naturalSizes = new Map<string, [number, number]>();

// Unique per attempt. A constant token only busts the cache the FIRST time:
// once both the bare URL and `?spriteRetry=1` are negatively cached, a later
// remount issues no network request at all and the sprite never comes back
// even after the CDN recovers (measured: 3 remounts, 0 requests). A counter
// gives every retry a URL the cache has never seen.
let retrySeq = 0;
function withRetryToken(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}spriteRetry=${++retrySeq}`;
}

interface Step {
  /** What to put in `src`. */
  url: string;
  /** Token-free URL — the key for the intrinsic-size cache. */
  base: string;
  /** How long to wait before switching to this step. */
  delay: number;
}

function buildChain(src: string, fallbackSrc?: string): Step[] {
  const steps: Step[] = [];
  if (src) {
    steps.push({ url: src, base: src, delay: 0 });
    steps.push({ url: withRetryToken(src), base: src, delay: RETRY_DELAY_MS });
  }
  if (fallbackSrc && fallbackSrc !== src) {
    steps.push({ url: fallbackSrc, base: fallbackSrc, delay: 0 });
    steps.push({ url: withRetryToken(fallbackSrc), base: fallbackSrc, delay: RETRY_DELAY_MS });
  }
  return steps;
}

export interface SpriteProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> {
  src: string;
  /** Second source, tried after `src` and its retry are exhausted. */
  fallbackSrc?: string;
  /**
   * What to render once every source has failed. "glyph" (default) leaves a
   * visible placeholder box; "hidden" renders nothing and is reserved for
   * purely decorative sprites that duplicate information shown elsewhere.
   */
  missing?: "glyph" | "hidden";
}

export function Sprite({
  src,
  fallbackSrc,
  missing = "glyph",
  className,
  style,
  alt,
  width,
  height,
  onLoad,
  onError,
  ...rest
}: SpriteProps) {
  const chainKey = `${src}|${fallbackSrc ?? ""}`;
  const [attempt, setAttempt] = useState<{ key: string; n: number }>({ key: chainKey, n: 0 });
  const timer = useRef<number | null>(null);

  // Restart the chain when this element is pointed at a different sprite.
  // Done during render (React's supported "adjust state on prop change"
  // escape hatch) so we never paint a frame of the previous sprite's
  // failure state against the new species.
  if (attempt.key !== chainKey) setAttempt({ key: chainKey, n: 0 });
  const n = attempt.key === chainKey ? attempt.n : 0;

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    []
  );

  const chain = buildChain(src, fallbackSrc);
  const step = chain[n];

  // Every source failed (or there was never a valid one — an unknown
  // species key yields an empty URL).
  if (!step) {
    if (missing === "hidden") return null;
    const label = alt || undefined;
    const boxStyle: CSSProperties = { ...style };
    if (width !== undefined && boxStyle.width === undefined) boxStyle.width = width;
    if (height !== undefined && boxStyle.height === undefined) boxStyle.height = height;
    return (
      <span
        className={`sprite-missing${className ? ` ${className}` : ""}`}
        style={boxStyle}
        role="img"
        aria-label={label ?? "Sprite unavailable"}
        title={label}
      >
        <span aria-hidden>?</span>
      </span>
    );
  }

  const known = naturalSizes.get(step.base);
  const imgStyle = known
    ? ({ ...style, "--sw": known[0], "--sh": known[1] } as CSSProperties)
    : style;

  return (
    <img
      {...rest}
      className={className}
      style={imgStyle}
      alt={alt}
      width={width}
      height={height}
      src={step.url}
      onLoad={(e) => {
        const img = e.currentTarget;
        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
          naturalSizes.set(step.base, [img.naturalWidth, img.naturalHeight]);
          img.style.setProperty("--sw", String(img.naturalWidth));
          img.style.setProperty("--sh", String(img.naturalHeight));
        }
        onLoad?.(e);
      }}
      onError={(e) => {
        onError?.(e);
        const next = n + 1;
        const delay = chain[next]?.delay ?? 0;
        if (timer.current !== null) window.clearTimeout(timer.current);
        if (delay > 0) {
          timer.current = window.setTimeout(() => {
            timer.current = null;
            setAttempt({ key: chainKey, n: next });
          }, delay);
        } else {
          timer.current = null;
          setAttempt({ key: chainKey, n: next });
        }
      }}
    />
  );
}

export interface PokemonSpriteProps extends Omit<SpriteProps, "src" | "fallbackSrc"> {
  speciesKey: string;
  isBack?: boolean;
  isShiny?: boolean;
}

/** Animated Gen-V sprite, degrading to the static PNG of the same facing. */
export function PokemonSprite({
  speciesKey,
  isBack = false,
  isShiny = false,
  ...rest
}: PokemonSpriteProps) {
  const id = pokemonTable[speciesKey]?.id;
  return (
    <Sprite
      src={pokemonSpriteUrl(speciesKey, isBack, isShiny)}
      fallbackSrc={id != null ? pokemonStaticSpriteUrl(id, isShiny, isBack) : undefined}
      {...rest}
    />
  );
}

export interface TrainerSpriteProps extends Omit<SpriteProps, "src" | "fallbackSrc"> {
  spriteKey: string;
}

/**
 * Showdown trainer portrait. No second CDN to fall back to, so the chain is
 * just "try, retry, placeholder" — which is still strictly better than the
 * permanent `display: none` these call sites used to carry.
 */
export function TrainerSprite({ spriteKey, ...rest }: TrainerSpriteProps) {
  return <Sprite src={trainerSpriteUrl(spriteKey)} {...rest} />;
}
