/**
 * Every duration in the battle presentation that has to agree with the
 * simulation loop — in ONE place, scaled by the game-speed setting.
 *
 * ── THE BUG THIS EXISTS TO FIX (br_7362030de4444c8da8) ────────────────
 * The opponent-trainer slide-in ignored game speed entirely. At ×5 the loop
 * ticks every 200ms and the whole rest of the game is fast, but every trainer
 * mon — the first one AND every send-next swap — still cost a flat 1.8 seconds
 * of nothing happening. On a town route, where the loop starts a trainer battle
 * on every idle tick, that was most of the elapsed time.
 *
 * The timing was hardcoded THREE times, in two languages, and nothing linked
 * them: the CSS animation duration, the CSS animation-delay that holds the
 * Pokémon off-screen until the trainer clears, and the loop's own "don't fire
 * a turn yet" settle window. Scaling any one of them alone desynchronises the
 * set — shorten the loop's window and it starts swinging before the sprite has
 * appeared; shorten the CSS and the loop still idles through the leftover.
 *
 * So the numbers live here, the loop reads them directly, and BattleScene
 * publishes them to CSS as custom properties (`--trainer-intro-*`). One
 * source, three consumers, and `battleSpeedScale` is the only thing that
 * decides how fast any of it goes.
 */

/**
 * The simulation tick. Speed setting controls how fast (1=1000ms, 2=500ms,
 * 5=200ms). Lives here rather than in useBattleLoop because it is now also the
 * definition of "one unit of game time" that every animation scales against —
 * keeping the two in separate files is what let them drift apart.
 */
export function tickIntervalFor(speed: number): number {
  if (speed >= 5) return 200;
  if (speed >= 2) return 500;
  return 1000;
}

/**
 * How much to compress presentation timings at the current speed. 1× at speed
 * 1, 0.5× at speed 2, 0.2× at speed 5.
 *
 * Derived from the tick interval rather than from `1 / speed` on purpose: the
 * tick is what "game speed" actually means to the simulation, and the speed
 * buttons are not required to stay at 1/2/5 (stream chat can set any value via
 * the `speed` command, and the reducer does not clamp it). Anchoring to the
 * tick means animations track whatever the loop is really doing, and a speed
 * value nobody anticipated cannot produce a negative or absurd duration.
 */
export function battleSpeedScale(speed: number): number {
  return tickIntervalFor(speed) / 1000;
}

/** Full trainer slide-in → hold → slide-out beat, at ×1. */
export const TRAINER_INTRO_BASE_MS = 1500;

/**
 * When the opponent's pokeball-pop starts, at ×1 — i.e. how long the Pokémon
 * stays hidden while the trainer has the stage. Must stay in proportion to
 * TRAINER_INTRO_BASE_MS: it is the point in the slide-out where the two
 * sprites cross over (73% of the way through, matching the keyframe).
 */
export const TRAINER_INTRO_POKEMON_DELAY_BASE_MS = 1100;

/** Pokéball-pop (600ms) plus a little settle, at ×1, for a wild encounter. */
export const WILD_APPEAR_BASE_MS = 700;

export function trainerIntroMs(speed: number): number {
  return Math.round(TRAINER_INTRO_BASE_MS * battleSpeedScale(speed));
}

export function trainerIntroPokemonDelayMs(speed: number): number {
  return Math.round(TRAINER_INTRO_POKEMON_DELAY_BASE_MS * battleSpeedScale(speed));
}

/**
 * How long the loop must wait after a new opponent appears before firing the
 * first turn, so the swing does not land on a sprite that is still off-screen.
 *
 * This is the number that made the bug visible, and it is deliberately the
 * SAME arithmetic as the CSS: a trainer battle waits out the whole intro plus
 * the pop that follows it, a wild one waits out just the pop.
 */
export function enemySettleMs(speed: number, fromTrainer: boolean): number {
  const scale = battleSpeedScale(speed);
  const base = fromTrainer
    // Intro runs to TRAINER_INTRO_POKEMON_DELAY_BASE_MS, then the pop plays.
    ? TRAINER_INTRO_POKEMON_DELAY_BASE_MS + WILD_APPEAR_BASE_MS
    : WILD_APPEAR_BASE_MS;
  return Math.round(base * scale);
}
