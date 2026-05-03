import { useEffect, useRef, useState } from "react";
import { useGame } from "../state/GameContext";
import { pokemonSpriteUrl, itemSpriteUrl } from "../utils/sprites";
import { routes } from "../data/routes";
import { useDamageFlash } from "../hooks/useDamageFlash";
import { TrainerIntro } from "./TrainerIntro";
import { WhiteoutOverlay } from "./WhiteoutOverlay";
import { MoveAnimation } from "./MoveAnimation";
import { HealOverlay } from "./HealOverlay";
import type { Pokemon, RouteType } from "../types";

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
  const status = statusLine(state);

  // Damage flash counters re-trigger when HP drops; reset on Pokemon switch.
  const playerBump = useDamageFlash(player?.id, player?.currentHp);
  const enemyBump = useDamageFlash(enemy?.id, enemy?.currentHp);

  return (
    <div className={`battle-scene speed-${state.speed}`}>
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
          <HpCard pokemon={enemy} className="enemy-card" />
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
                      alt={i < spent ? "fainted" : "ready"}
                      className={`trainer-ball ${i < spent ? "spent" : ""}`}
                      title={i < spent ? "fainted" : "ready"}
                      width={12}
                      height={12}
                      draggable={false}
                    />
                  ))}
                </span>
              </div>
            );
          })()}
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
          >
            <img
              className="enemy-sprite"
              src={pokemonSpriteUrl(enemy.speciesKey, false, enemy.isShiny)}
              alt={enemy.name}
              style={{ imageRendering: "pixelated" }}
              onError={(e) => ((e.target as HTMLImageElement).style.opacity = "0")}
            />
          </div>
        </>
      )}
      {/* Player slot — bottom left */}
      {player && (
        <>
          <div
            key={`player-slot-${player.id}`}
            className={`sprite-slot player-slot ${playerBump > 0 ? `bump-${playerBump % 2}` : ""} ${player.currentHp <= 0 ? "fainted" : ""}`}
          >
            <img
              className="player-sprite"
              src={pokemonSpriteUrl(player.speciesKey, true, player.isShiny)}
              alt={player.name}
              style={{ imageRendering: "pixelated" }}
              onError={(e) => ((e.target as HTMLImageElement).style.opacity = "0")}
            />
          </div>
          <HpCard pokemon={player} className="player-card" />
        </>
      )}
      <Typewriter text={status} key={status} />
      <TrainerIntro />
      <CatchAnimation />
      <MoveAnimation />
      {state.battleWeather && (
        <div className={`weather-badge weather-${state.battleWeather.type}`}>
          {weatherLabel(state.battleWeather.type)} <small>{state.battleWeather.turnsRemaining}T</small>
        </div>
      )}
      <ExpGainFlash />
      </div>
      <WhiteoutOverlay />
      <HealOverlay />
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
  const prevLen = useRef(state.battleLog.length);
  const [pop, setPop] = useState<{ key: number; amount: number; share: boolean } | null>(null);
  useEffect(() => {
    const start = prevLen.current;
    const end = state.battleLog.length;
    prevLen.current = end;
    if (end <= start) return;
    // Find the *active mon's* EXP line in the new slice. Lines marked
    // "from Exp Share" are quieter; the headline is the active gain.
    let active: { amount: number } | null = null;
    let share: { amount: number } | null = null;
    for (let i = start; i < end; i++) {
      const line = state.battleLog[i] ?? "";
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
    setPop({ key: Date.now(), amount: chosen.amount, share: !active });
    const ms = state.speed >= 5 ? 700 : state.speed >= 2 ? 1000 : 1400;
    const t = setTimeout(() => setPop(null), ms);
    return () => clearTimeout(t);
  }, [state.battleLog, state.speed]);
  if (!pop) return null;
  // Scale the CSS animation duration to the game's speed so the
  // pop's keyframes finish in the same window the JS unmount timer
  // is using. Otherwise at 5× speed the element is removed at 700ms
  // while the (fixed-1400ms) animation has only completed half its
  // travel — looked broken / out of sync. Match the JS timing
  // exactly: ×1 → 1400ms, ×2 → 1000ms, ×5 → 700ms.
  const animMs = state.speed >= 5 ? 700 : state.speed >= 2 ? 1000 : 1400;
  return (
    <div
      key={pop.key}
      className={`exp-gain-flash ${pop.share ? "share" : "active"}`}
      style={{ animationDuration: `${animMs}ms` }}
      aria-hidden
    >
      +{pop.amount} EXP
    </div>
  );
}

function weatherLabel(w: string): string {
  switch (w) {
    case "sun":  return "☀ Sun";
    case "rain": return "☂ Rain";
    case "sand": return "🌪 Sand";
    case "hail": return "❄ Hail";
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
          <span className="catch-success-flash" />
        </>
      ) : (
        <span className="catch-crack" />
      )}
    </div>
  );
}

// Types one character at a time. Speed comes from the game's speed multiplier.
function Typewriter({ text }: { text: string }) {
  const { state } = useGame();
  const [shown, setShown] = useState("");
  const charMs = state.speed >= 5 ? 7 : state.speed >= 2 ? 16 : 30;

  useEffect(() => {
    if (!text) {
      setShown("");
      return;
    }
    let i = 0;
    setShown(text.slice(0, 1));
    const id = window.setInterval(() => {
      i++;
      if (i >= text.length) {
        setShown(text);
        clearInterval(id);
      } else {
        setShown(text.slice(0, i + 1));
      }
    }, charMs);
    return () => clearInterval(id);
  }, [text, charMs]);

  return <div className="scene-status">{shown}</div>;
}

function HpCard({ pokemon, className }: { pokemon: Pokemon; className: string }) {
  const hpPct = (pokemon.currentHp / pokemon.maxHp) * 100;
  const hpClass = hpPct > 50 ? "ok" : hpPct > 20 ? "warn" : "low";
  return (
    <div className={`hp-card ${className}`}>
      <div className="hp-card-name">
        <strong>{pokemon.name.toUpperCase()}{pokemon.isShiny ? " ✨" : ""}</strong>
        <span>Lv.{pokemon.level}</span>
      </div>
      <div className="hp-card-row">
        <span className="hp-card-label">HP</span>
        <div className={`hp-card-bar ${hpClass}`}>
          <div className="hp-card-fill" style={{ width: `${hpPct}%` }} />
        </div>
        {pokemon.status && (
          <span className={`hp-status-badge status-${pokemon.status}`}>
            {statusBadgeLabel(pokemon.status)}
          </span>
        )}
        {(pokemon.confusedTurns ?? 0) > 0 && (
          <span className="hp-status-badge status-confused">CNF</span>
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

function statusBadgeLabel(status: string): string {
  switch (status) {
    case "paralyzed":     return "PAR";
    case "asleep":        return "SLP";
    case "burned":        return "BRN";
    case "frozen":        return "FRZ";
    case "poisoned":      return "PSN";
    case "badlyPoisoned": return "TOX";
    default: return status.slice(0, 3).toUpperCase();
  }
}

// The status bar doubles as the battle ticker. We surface the most recent
// battle-log line whenever there is one, falling back to a contextual phase
// message when the log is empty (e.g. just-started game).
function statusLine(state: ReturnType<typeof useGame>["state"]): string {
  const last = state.battleLog[state.battleLog.length - 1];
  if (last) return last;
  if (state.awaitingSwitch) return "Choose your next Pokémon!";
  if (state.paused) return "Paused.";
  if (state.phase === "evolution") return "Evolving…";
  if (state.phase === "healing") return "Healing…";
  return "Looking for trainers…";
}
