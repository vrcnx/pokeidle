import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useGame } from "../state/GameContext";
import { useT } from "../i18n/useT";
import { itemSpriteUrl } from "../utils/sprites";
import { PokemonSprite } from "./Sprite";
import { routes } from "../data/routes";
import { pokemonTable } from "../data/pokemon";
import { useDamageFlash } from "../hooks/useDamageFlash";
import { TrainerIntro } from "./TrainerIntro";
import { WhiteoutOverlay } from "./WhiteoutOverlay";
import { MoveAnimation } from "./MoveAnimation";
import { HealOverlay } from "./HealOverlay";
import { BattleJuice } from "./BattleJuice";
import { displayName } from "../utils/pokemon";
import { flashMs, remainingMs, trainerIntroMs, trainerIntroPokemonDelayMs, typewriterCharMs } from "../utils/battleTiming";
import { linesSince } from "../utils/battleLogCursor";
import type { GameState, Pokemon, RouteType } from "../types";

// Aspect-ratio-locked battle arena that always shows the current scene.
// Both Pokémon are visible with floating HP cards; status text overlays
// the bottom of the arena.

// Per-biome fallbacks. Each location id can also override these by having
// its own /backgrounds/<id>.webp file. The bg <img> uses onError to swap
// to the type-level fallback if the per-location asset 404s.
const BG_BY_TYPE: Record<string, string> = {
  town: "/backgrounds/town.webp",
  cave: "/backgrounds/cave.webp",
  victoryRoad: "/backgrounds/mountain.webp",
  raid: "/backgrounds/town_port.webp",
  route: "/backgrounds/grassland.webp",
};

function fallbackBgFor(type: RouteType | undefined): string {
  return BG_BY_TYPE[type ?? "route"] ?? BG_BY_TYPE.route;
}

// Boss-specific background filename. Files live alongside the
// per-location ones: `/backgrounds/gym_brock.webp`, `e4_lorelei.webp`,
// `champion_blue.webp`. Returns null when the player isn't in a boss
// battle so the regular per-location fallback chain runs.
function bossBg(state: ReturnType<typeof useGame>["state"]): string | null {
  const b = state.bossBattle;
  if (!b) return null;
  const prefix = b.bossType === "champion" ? "champion" : b.bossType === "e4" ? "e4" : "gym";
  return `/backgrounds/${prefix}_${b.bossId}.webp`;
}

export function BattleScene() {
  const { state } = useGame();
  const t = useT();
  const route = routes[state.currentLocation];
  const locationBg = `/backgrounds/${state.currentLocation}.webp`;
  const fallbackBg = fallbackBgFor(route?.type);
  // Three-tier fallback during boss battles: boss-specific →
  // location-specific → biome default. The onError handler walks
  // through the chain in source order.
  const initialBg = bossBg(state) ?? locationBg;
  const fallbackChain = bossBg(state) ? [locationBg, fallbackBg] : [fallbackBg];

  const player = state.playerPokemon;
  const enemy = state.enemyPokemon;
  const status = statusLine(state, t);

  // Damage flash counters re-trigger when HP drops; reset on Pokemon switch.
  const playerBump = useDamageFlash(player?.id, player?.currentHp);
  const enemyBump = useDamageFlash(enemy?.id, enemy?.currentHp);
  const sceneRef = useRef<HTMLDivElement | null>(null);
  useHitShake(sceneRef, state);

  return (
    <div
      ref={sceneRef}
      className={`battle-scene speed-${state.speed}`}
      /* The trainer intro's timings, published to CSS so the stylesheet stops
         hardcoding them (br_7362030de4444c8da8 — the slide-in ignored game
         speed). Custom properties rather than the `speed-N` class already on
         this element: stream chat can set any speed value and the reducer does
         not clamp it, so a class-per-speed ruleset would silently fall back to
         full-speed for anything but 1/2/5. These also reach `::before`, which
         inline styles cannot, and every rule keeps a hardcoded fallback so the
         CSS and this component can ship independently. */
      style={{
        "--trainer-intro-dur": `${trainerIntroMs(state.speed)}ms`,
        "--trainer-intro-delay": `${trainerIntroPokemonDelayMs(state.speed)}ms`,
      } as CSSProperties}
    >
      {/* scene-content wraps everything that should rattle on Earthquake-
          class moves. .move-anim adds .shake-screen to itself; CSS uses
          :has() to apply the shake animation here. WhiteoutOverlay sits
          outside this wrapper because it shouldn't shake. */}
      <div className="scene-content">
      <img
        key={`bg-${state.bossBattle?.bossId ?? state.currentLocation}`}
        className="battle-bg"
        src={initialBg}
        alt=""
        aria-hidden
        draggable={false}
        onError={(e) => {
          const t = e.target as HTMLImageElement;
          // Walk the fallback chain in order, advancing to the next
          // candidate each time the current one 404s.
          for (const next of fallbackChain) {
            const abs = window.location.origin + next;
            if (t.src !== abs) {
              t.src = next;
              return;
            }
          }
        }}
      />
      {/* Enemy slot — top right */}
      {enemy && (
        <>
          {/* Card and trainer tag share one stack: the tag used to be pinned
              at a hardcoded offset guessed from the card's height, so
              anything that grew the card (a stat-stage row, the type tags)
              landed on top of it. Flow handles the spacing now. */}
          <div className="enemy-card-stack">
            <HpCard pokemon={enemy} className="enemy-card" showDexBall />
            {(state.trainerBattle || state.bossBattle) && (() => {
              const tb = state.trainerBattle ?? state.bossBattle!;
              const total = tb.trainerTeam.length;
              const spent = tb.currentTrainerPokemonIndex;
              return (
                <div className="trainer-tag">
                  <strong>{tb.trainerName}</strong>
                  <span className="trainer-tag-balls">
                    {Array.from({ length: total }, (_, i) => (
                      <img
                        key={i}
                        src={itemSpriteUrl("pokeball")}
                        alt={i < spent ? t("fainted") : t("ready")}
                        className={`trainer-ball ${i < spent ? "spent" : ""}`}
                        title={i < spent ? t("fainted") : t("ready")}
                        width={12}
                        height={12}
                        draggable={false}
                      />
                    ))}
                  </span>
                </div>
              );
            })()}
          </div>
          <div
            key={`enemy-slot-${enemy.id}`}
            className={[
              "sprite-slot enemy-slot",
              enemyBump > 0 ? `bump-${enemyBump % 2}` : "",
              enemy.currentHp <= 0 ? "fainted" : "",
              // When the enemy comes from a trainer, delay the pokeball-pop
              // until after the trainer-behind has slid in & paused.
              (state.trainerBattle || state.bossBattle) ? "trainer-delayed" : "",
            ].join(" ")}
            data-status={enemy.status ?? undefined}
          >
            {/* Sizing note: PokemonSprite publishes each sprite's intrinsic
                pixel size as --sw / --sh, and .enemy-sprite scales off those
                rather than stretching to fill the slot. See app.css. */}
            <PokemonSprite
              className="enemy-sprite"
              speciesKey={enemy.speciesKey}
              isShiny={enemy.isShiny}
              alt={displayName(enemy)}
              style={{ imageRendering: "pixelated" }}
            />
            {enemy.status && <SpriteStatusBadge status={enemy.status} />}
          </div>
        </>
      )}
      {/* Player slot — bottom left */}
      {player && (
        <>
          <div
            key={`player-slot-${player.id}`}
            className={`sprite-slot player-slot ${playerBump > 0 ? `bump-${playerBump % 2}` : ""} ${player.currentHp <= 0 ? "fainted" : ""}`}
            data-status={player.status ?? undefined}
          >
            <PokemonSprite
              className="player-sprite"
              speciesKey={player.speciesKey}
              isBack
              isShiny={player.isShiny}
              alt={displayName(player)}
              style={{ imageRendering: "pixelated" }}
            />
            {player.status && <SpriteStatusBadge status={player.status} />}
          </div>
          <HpCard pokemon={player} className="player-card" />
        </>
      )}
      <Typewriter text={status} />
      <TrainerIntro />
      <CatchAnimation />
      <MoveAnimation />
      {state.battleWeather && (
        <div className={`weather-badge weather-${state.battleWeather.type}`}>
          {weatherLabel(state.battleWeather.type, t)} <small>{state.battleWeather.turnsRemaining}T</small>
        </div>
      )}
      <ExpGainFlash />
      <DamageFlash side="player" />
      <DamageFlash side="enemy" />
      <EffectivenessFlash />
      <BattleJuice />
      </div>
      <WhiteoutOverlay />
      <HealOverlay />
    </div>
  );
}

// Floating damage popup over a fighter's slot. Watches that side's
// currentHp; when it drops, paints a "-N" in red rising up from the
// HP card. When it rises (heal / Sitrus berry / drain), paints "+N"
// in green. Decoupled from the battle log so it triggers regardless
// of whether the log line was emitted (covers passive damage like
// Leftovers / Toxic / hail). Scales to game speed like ExpGainFlash.
/**
 * A floating flash that clears itself after a speed-scaled window.
 *
 * ── THE BUG THIS HOOK EXISTS FOR ──────────────────────────────────────
 * All three flashes below used to arm their own expiry timer INSIDE the effect
 * that detects the thing to show, with `state.speed` in the dep list. Changing
 * speed re-ran that effect; the cleanup killed the pending timer; and then the
 * detection guard at the top (`delta === 0`, `fresh.length === 0` — the
 * detection had already consumed its input on the previous run) returned early
 * without arming a replacement. The result: change speed while a damage
 * number, an EXP pop or a "Super effective!" banner is up, and it stays on
 * screen for the rest of the battle. Part of pani's speed-switching report.
 *
 * Detecting and expiring are separate concerns, so they are separate effects.
 * The expiry keys on the pop itself and schedules against elapsed time, which
 * makes re-running it harmless — and makes a speed change retime the window
 * that is already open rather than restart or strand it.
 */
function useFlashPop<T extends { key: number }>(speed: number) {
  const [pop, setPop] = useState<T | null>(null);
  const shownAt = useRef(0);
  const show = useCallback((next: T) => {
    shownAt.current = Date.now();
    setPop(next);
  }, []);
  useEffect(() => {
    if (!pop) return;
    const t = setTimeout(() => setPop(null), remainingMs(shownAt.current, flashMs(speed), Date.now()));
    return () => clearTimeout(t);
  }, [pop, speed]);
  return [pop, show] as const;
}

/**
 * Rattle the arena in proportion to how hard the hit landed.
 *
 * ── WHY DAMAGE AND NOT THE MOVE ──────────────────────────────────────────
 * The screen shake used to fire for four hardcoded moves and nothing else, so
 * a Hyper Beam that missed most of its damage shook the arena and a critical
 * hit taking half your HP did not move it at all. The number the player is
 * actually reacting to is how much HP just vanished, so that is what drives
 * it. The move list still exists and still wins on top — Earthquake should
 * rattle whether or not it did much.
 *
 * Watches HP rather than the battle log for the same reason DamageFlash does:
 * it catches passive damage (Leftovers, Toxic, hail, recoil) that never
 * produces an attack animation to hang off.
 */
function useHitShake(ref: React.RefObject<HTMLElement | null>, state: GameState): void {
  const prev = useRef<Record<string, number>>({});
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let worst = 0;
    for (const mon of [state.playerPokemon, state.enemyPokemon]) {
      if (!mon) continue;
      const before = prev.current[mon.id];
      prev.current[mon.id] = mon.currentHp;
      if (before === undefined || mon.currentHp >= before) continue;
      worst = Math.max(worst, (before - mon.currentHp) / Math.max(1, mon.maxHp));
    }
    if (worst <= 0) return;
    // A chip hit still registers, a huge one does not throw the screen off
    // its axis. Square-rooted so the low end — where most hits live — is
    // where the range actually spreads out.
    const intensity = Math.min(1.6, 0.35 + Math.sqrt(worst) * 1.25);
    el.style.setProperty("--shake", intensity.toFixed(2));
    // Remove, force a reflow, re-add: consecutive hits must restart the
    // animation, and re-adding a class the element already has does nothing.
    el.classList.remove("hit-shake");
    void el.offsetWidth;
    el.classList.add("hit-shake");
    const t = setTimeout(() => el.classList.remove("hit-shake"), 300);
    return () => clearTimeout(t);
  }, [ref, state.playerPokemon, state.enemyPokemon]);
}

function DamageFlash({ side }: { side: "player" | "enemy" }) {
  const { state } = useGame();
  const mon = side === "player" ? state.playerPokemon : state.enemyPokemon;
  const id = mon?.id ?? null;
  const hp = mon?.currentHp ?? null;
  const prev = useRef<{ id: string | null; hp: number | null }>({ id: null, hp: null });
  const [pop, show] = useFlashPop<{ key: number; delta: number }>(state.speed);
  useEffect(() => {
    const last = prev.current;
    prev.current = { id, hp };
    // Reset on switch (mon changed) — different mon, no comparison.
    if (last.id !== id) return;
    if (last.hp == null || hp == null) return;
    const delta = hp - last.hp;
    if (delta === 0) return;
    show({ key: Date.now() + (side === "player" ? 0 : 1), delta });
  }, [id, hp, side, show]);
  if (!pop) return null;
  const animMs = flashMs(state.speed);
  const isHeal = pop.delta > 0;
  const sign = isHeal ? "+" : "";
  return (
    <div
      key={pop.key}
      className={`damage-flash side-${side} ${isHeal ? "heal" : "hit"}`}
      style={{ animationDuration: `${animMs}ms` }}
      aria-hidden
    >
      {sign}{pop.delta}
    </div>
  );
}

// Floating "+N EXP" pop-up over the player slot. Watches the battle log
// for "<name> gained <n> EXP!" lines and renders a brief gold burst when
// one appears. Has to scan ALL newly-appended log lines (not just the
// last one) because trainer-battle send-next pushes more lines AFTER the
// EXP line in the same dispatch — the EXP line is already a few back by
// the time we re-render.
function ExpGainFlash() {
  const { state } = useGame();
  const t = useT();
  const seenSeq = useRef(state.battleLogSeq);
  const [pop, show] = useFlashPop<{ key: number; amount: number; share: boolean }>(state.speed);
  useEffect(() => {
    const fresh = linesSince(state.battleLog, state.battleLogSeq, seenSeq.current);
    seenSeq.current = state.battleLogSeq;
    if (fresh.length === 0) return;
    // Find the *active mon's* EXP line in the new slice. Lines marked
    // "from Exp Share" are quieter; the headline is the active gain.
    let active: { amount: number } | null = null;
    let share: { amount: number } | null = null;
    for (const line of fresh) {
      const m = /gained (\d+) EXP/.exec(line);
      if (!m) continue;
      const amount = parseInt(m[1], 10);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      if (/from Exp Share/.test(line)) {
        if (!share) share = { amount };
      } else {
        active = { amount };
      }
    }
    const chosen = active ?? share;
    if (!chosen) return;
    show({ key: Date.now(), amount: chosen.amount, share: !active });
  }, [state.battleLog, state.battleLogSeq, show]);
  if (!pop) return null;
  // Scale the CSS animation duration to the game's speed so the pop's
  // keyframes finish in the same window the JS unmount timer is using.
  // Otherwise at 5× speed the element is removed at 700ms while the
  // (fixed-1400ms) animation has only completed half its travel — looked
  // broken / out of sync. Same function on both sides so they cannot drift.
  const animMs = flashMs(state.speed);
  return (
    <div
      key={pop.key}
      className={`exp-gain-flash ${pop.share ? "share" : "active"}`}
      style={{ animationDuration: `${animMs}ms` }}
      aria-hidden
    >
      +{pop.amount} {t("EXP")}
    </div>
  );
}

// Inline floating caption for super-effective / not-very-effective /
// no-effect / critical-hit hits. Scans the battle log for the
// canonical message lines and overlays a tinted banner above the
// arena. Reinforces the log message at the action site so the player
// doesn't have to flick their eyes to the log to know how their
// move landed.
type EffPop =
  | { key: number; kind: "se"; text: string }
  | { key: number; kind: "nve"; text: string }
  | { key: number; kind: "none"; text: string }
  | { key: number; kind: "crit"; text: string };

function EffectivenessFlash() {
  const { state } = useGame();
  const t = useT();
  const seenSeq = useRef(state.battleLogSeq);
  const [pop, show] = useFlashPop<EffPop>(state.speed);
  useEffect(() => {
    const fresh = linesSince(state.battleLog, state.battleLogSeq, seenSeq.current);
    seenSeq.current = state.battleLogSeq;
    if (fresh.length === 0) return;
    // Crits and effectiveness can both fire in the same turn — crit
    // wins the headline since it's the rarer / louder event.
    let crit = false;
    let eff: { kind: "se" | "nve" | "none"; text: string } | null = null;
    for (const line of fresh) {
      if (line === "A critical hit!") crit = true;
      else if (line === "It's super effective!")     eff = { kind: "se",   text: t("Super effective!") };
      else if (line === "It's not very effective...") eff = { kind: "nve",  text: t("Not very effective") };
      else if (line === "It had no effect!")          eff = { kind: "none", text: t("No effect") };
    }
    if (!crit && !eff) return;
    const next: EffPop = crit
      ? { key: Date.now(), kind: "crit", text: t("Critical hit!") }
      : { key: Date.now(), kind: eff!.kind, text: eff!.text };
    show(next);
  }, [state.battleLog, state.battleLogSeq, show]);
  if (!pop) return null;
  const animMs = flashMs(state.speed);
  return (
    <div
      key={pop.key}
      className={`effectiveness-flash effectiveness-${pop.kind}`}
      style={{ animationDuration: `${animMs}ms` }}
      aria-live="polite"
    >
      {pop.text}
    </div>
  );
}

function weatherLabel(w: string, t: (str: string) => string): string {
  switch (w) {
    case "sun":  return t("☀ Sun");
    case "rain": return t("☂ Rain");
    case "sand": return t("🌪 Sand");
    case "hail": return t("❄ Hail");
    default: return w;
  }
}

// Pokeball throw + 3-shake overlay. Mounts when state.catchAnim is set
// (TRY_CATCH dispatched). The reducer pre-rolled the success outcome; we
// just play the visual sequence and useCatchAnimation fires CATCH_RESOLVE
// at the end. Each new throw bumps the `key` so the CSS keyframes restart.
//
// Layers (back to front):
//   1. .catch-absorb — red/white energy ribbon pulling the Pokémon into the ball
//   2. .catch-flash  — bright burst when the ball lands
//   3. .catch-ball   — the actual pokeball image, throw arc + shakes
//   4. .catch-spark  — radial gold sparkles on success
//   5. .catch-crack  — bright vertical crack on failure
function CatchAnimation() {
  const { state } = useGame();
  const t = useT();
  const anim = state.catchAnim;
  if (!anim) return null;
  const resultClass = anim.success ? "result-success" : "result-fail";
  return (
    <div className={`catch-anim-layer ${resultClass}`} key={anim.key}>
      <span className="catch-absorb" aria-hidden />
      <span className="catch-flash" aria-hidden />
      <img
        className={`catch-ball ${resultClass}`}
        src={itemSpriteUrl(anim.ballId)}
        alt=""
        draggable={false}
      />
      {anim.success ? (
        <>
          <span className="catch-spark s1" />
          <span className="catch-spark s2" />
          <span className="catch-spark s3" />
          <span className="catch-spark s4" />
          <span className="catch-spark s5" />
          <span className="catch-spark s6" />
          <span className="catch-spark s7" />
          <span className="catch-spark s8" />
          <span className="catch-success-flash" />
          <span className="catch-success-ring2" />
          <span className="catch-success-caption">{t("Gotcha!")}</span>
        </>
      ) : (
        <>
          <span className="catch-crack" />
          <span className="catch-escape-burst" />
          <span className="catch-escape-pulse" />
        </>
      )}
    </div>
  );
}

// Types one character at a time. Speed comes from the game's speed multiplier.
//
// The caller used to pass `key={text}` to restart the typing on every new
// line, which threw away the .scene-status div and built a fresh one each
// time — and that div carries a backdrop blur, so the black bar behind the
// text visibly flashed on every single log line. The effect below already
// restarts on a `text` change, so the element only has to stay mounted;
// resetting `shown` during render (rather than in the effect) keeps the swap
// frame-perfect, which is the one thing remounting was actually buying.
//
// ── AND IT MUST NOT RETYPE WHEN THE SPEED CHANGES ─────────────────────
// `charMs` was in the dep list and the cursor was an effect-local `let i`, so
// changing game speed re-ran the effect and threw the cursor away: whatever
// line was on screen jumped back to its first character and typed itself out
// again. That is the "changing game speed reloads the scene status text" half
// of pani's report — the text was not reloading, it was being retyped.
//
// The cursor lives in a ref now, so restarting the interval at a new pace
// picks up exactly where the old one stopped. Which is the whole point of the
// speed control: the line you are reading should finish faster, not start over.
function Typewriter({ text }: { text: string }) {
  const { state } = useGame();
  const [shown, setShown] = useState("");
  const charMs = typewriterCharMs(state.speed);

  // Index of the LAST character shown, so `shown === text.slice(0, i + 1)`.
  const iRef = useRef(0);
  const lastTextRef = useRef<string | null>(null);
  if (lastTextRef.current !== text) {
    lastTextRef.current = text;
    iRef.current = 0;
    setShown(text.slice(0, 1));
  }

  useEffect(() => {
    if (!text) {
      setShown("");
      return;
    }
    // Already finished — nothing to resume. Without this, a speed change
    // after the line had settled would arm a pointless interval.
    if (iRef.current >= text.length - 1) {
      setShown(text);
      return;
    }
    const id = window.setInterval(() => {
      iRef.current++;
      if (iRef.current >= text.length - 1) {
        setShown(text);
        clearInterval(id);
      } else {
        setShown(text.slice(0, iRef.current + 1));
      }
    }, charMs);
    return () => clearInterval(id);
  }, [text, charMs]);

  return <div className="scene-status">{shown}</div>;
}

// `showDexBall` is only passed for the opponent. Your own Pokémon is
// registered in the dex by definition, so a ball on that card would be lit
// 100% of the time and answer nothing; on the other side of the field
// "do I already have one of these?" is the whole question.
function HpCard({
  pokemon,
  className,
  showDexBall,
}: {
  pokemon: Pokemon;
  className: string;
  showDexBall?: boolean;
}) {
  const { state } = useGame();
  const t = useT();
  const hpPct = (pokemon.currentHp / pokemon.maxHp) * 100;
  const hpClass = hpPct > 50 ? "ok" : hpPct > 20 ? "warn" : "low";
  // Types come from the species table rather than the individual: a Pokemon
  // instance only carries its stats, and the table is the same source the
  // dex and the wild-encounter detail read from.
  const types = pokemonTable[pokemon.speciesKey]?.types ?? [];
  const registered = showDexBall && state.pokedexCaught.includes(pokemon.speciesKey);
  return (
    <div className={`hp-card ${className}`}>
      <div className="hp-card-name">
        <strong>{displayName(pokemon).toUpperCase()}{pokemon.isShiny ? " ✨" : ""}</strong>
        <span>{t("Lv.")}{pokemon.level}</span>
      </div>
      {(types.length > 0 || registered) && (
        <div className="hp-card-meta">
          <span className="hp-card-types">
            {/* Type names are rendered untranslated here to match the dex and
                wild-detail badges — they're one shared vocabulary. */}
            {types.map((ty) => (
              <span key={ty} className={`type-badge type-${ty.toLowerCase()}`}>{ty}</span>
            ))}
          </span>
          {registered && (
            <img
              className="hp-card-caught"
              src={itemSpriteUrl("pokeball")}
              alt={t("Already in your Pokédex")}
              title={t("Already in your Pokédex")}
              width={12}
              height={12}
              draggable={false}
            />
          )}
        </div>
      )}
      <div className="hp-card-row">
        <span className="hp-card-label">{t("HP")}</span>
        <div className={`hp-card-bar ${hpClass}`}>
          <div className="hp-card-fill" style={{ width: `${hpPct}%` }} />
        </div>
        {pokemon.status && (
          <span className={`hp-status-badge status-${pokemon.status}`}>
            {statusBadgeLabel(pokemon.status, t)}
          </span>
        )}
        {(pokemon.confusedTurns ?? 0) > 0 && (
          <span className="hp-status-badge status-confused">{t("CNF")}</span>
        )}
      </div>
      <StatStagesRow stages={pokemon.statStages} />
      <div className="hp-card-numbers">{pokemon.currentHp}/ {pokemon.maxHp}</div>
    </div>
  );
}

// Compact display of any non-zero stat stages (Atk/Def/SpA/SpD/Spe/Acc/Eva).
// Hidden when the Pokémon has none — no clutter when nothing to show.
function StatStagesRow({ stages }: { stages?: Partial<Record<string, number>> }) {
  if (!stages) return null;
  const entries = Object.entries(stages).filter(([, v]) => v !== 0 && v !== undefined);
  if (entries.length === 0) return null;
  return (
    <div className="hp-stages-row">
      {entries.map(([stat, val]) => (
        <span
          key={stat}
          className={`hp-stage-chip ${(val as number) > 0 ? "up" : "down"}`}
          title={`${statStageLabel(stat)} ${(val as number) > 0 ? "+" : ""}${val}`}
        >
          {statStageLabel(stat)}{(val as number) > 0 ? "+" : ""}{val}
        </span>
      ))}
    </div>
  );
}

function statStageLabel(stat: string): string {
  switch (stat) {
    case "attack": return "Atk";
    case "defense": return "Def";
    case "spAttack": return "SpA";
    case "spDefense": return "SpD";
    case "speed": return "Spe";
    case "accuracy": return "Acc";
    case "evasion": return "Eva";
    default: return stat;
  }
}

function statusBadgeLabel(status: string, t: (str: string) => string): string {
  switch (status) {
    case "paralyzed":     return t("PAR");
    case "asleep":        return t("SLP");
    case "burned":        return t("BRN");
    case "frozen":        return t("FRZ");
    case "poisoned":      return t("PSN");
    case "badlyPoisoned": return t("TOX");
    default: return status.slice(0, 3).toUpperCase();
  }
}

// Per-sprite status ribbon — a small floating chip in the slot's top
// corner that mirrors the HP-card badge but is positioned at the
// fighter itself, so the player can read status without scanning the
// HP card or log line. CSS handles the corner placement + colour-coded
// pulse animation per status.
function SpriteStatusBadge({ status }: { status: string }) {
  const t = useT();
  return (
    <span
      className={`sprite-status-badge status-${status}`}
      aria-label={`Status: ${status}`}
      title={`Status: ${status}`}
    >
      {statusBadgeLabel(status, t)}
    </span>
  );
}

// The status bar doubles as the battle ticker. We surface the most recent
// Boot / restore log lines that we don't want lingering as the
// battle-scene status line. They're useful in the scrollable log
// panel but feel stale on the headline once the player is back in
// the world.
const BOOT_LOG_LINES = new Set(["Game loaded!", "Welcome back!"]);

// battle-log line whenever there is one, falling back to a contextual phase
// message when the log is empty (e.g. just-started game).
function statusLine(state: ReturnType<typeof useGame>["state"], t: (str: string) => string): string {
  const last = state.battleLog[state.battleLog.length - 1];
  if (last && !BOOT_LOG_LINES.has(last)) return last;
  if (state.awaitingSwitch) return t("Choose your next Pokémon!");
  if (state.paused) return t("Paused.");
  if (state.phase === "evolution") return t("Evolving…");
  if (state.phase === "healing") return t("Healing…");
  // Manual mode mid-battle with no pending events: the player is being
  // asked to pick a move. Canonical Pokémon games show this prompt.
  // Without it the scene reads as idle even though the moves panel is
  // live and waiting for input.
  const inBattle =
    state.phase === "battle" || state.phase === "trainerBattle" || state.phase === "bossBattle";
  if (
    inBattle
    && state.battleMode === "manual"
    && state.pendingEvents.length === 0
    && state.playerPokemon
    && state.enemyPokemon
    && !state.playerVolatile?.mustRecharge
    && !state.playerVolatile?.lockedMove
  ) {
    return `What will ${displayName(state.playerPokemon)} do?`;
  }
  return t("Looking for trainers…");
}
