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

// ── THE REST OF THE PRESENTATION LADDERS ──────────────────────────────
//
// Everything below was written inline at its call site, and the same ladder
// appeared more than once for the same element: BattleScene computed the flash
// duration six times, once as a JS unmount timer and once as an inline
// `animationDuration` on the very element that timer removes. A duration that
// exists twice is a duration that will eventually disagree with itself — which
// is the whole reason this file was created.
//
// All of them key off `tickIntervalFor` rather than reading `speed` directly.
// Stream chat can set any speed and the reducer does not clamp it, so a bare
// `speed >= 5` ladder answers "×1" for a speed of 3 while the loop is really
// ticking at some other rate.

/**
 * How much of a presentation window that OPENED at `startedAt` is left, given
 * the total that the speed in force right now implies.
 *
 * ── THE ENTIRE "SWITCHING SPEED STALLS THE GAME" FIX, IN ONE LINE ─────
 * Three places — the event driver, the floating flashes and the move-effect
 * layer — armed a timer for the FULL duration inside an effect that had
 * `state.speed` in its dep list. Every speed change tore that effect down and
 * started the window over from zero, and while the event queue is draining
 * nothing else in the game moves. Clicking between the speed buttons therefore
 * froze the battle for exactly as long as you kept clicking.
 *
 * Anchoring to when the window OPENED rather than to when the effect last ran
 * is what makes a speed change RETIME the window instead of restarting it.
 * The property that matters, and the one the tests pin: re-asking part-way
 * through can only ever shorten what is left, never extend it.
 */
export function remainingMs(startedAt: number, totalMs: number, now: number): number {
  return Math.max(0, startedAt + totalMs - now);
}

/** Typewriter pace for the scene status bar. */
export function typewriterCharMs(speed: number): number {
  const tick = tickIntervalFor(speed);
  return tick >= 1000 ? 30 : tick >= 500 ? 16 : 7;
}

/** How long a floating flash (damage, EXP, effectiveness) stays on screen. */
export function flashMs(speed: number): number {
  const tick = tickIntervalFor(speed);
  return tick >= 1000 ? 1400 : tick >= 500 ? 1000 : 700;
}

/**
 * How long the event driver holds one battle event before consuming it.
 *
 * Split out of the hook because the rule that matters is not the number, it is
 * that changing speed mid-event must RESCHEDULE the event rather than restart
 * it — and that is only testable if the total is a function of the event.
 *
 * The body is the typewriter's own pace, because that is literally what the
 * player is waiting for: the line has to finish typing.
 */
export function eventDurationMs(kind: string, messageLength: number, speed: number): number {
  const tick = tickIntervalFor(speed);
  const tailMs = tick >= 1000 ? 200 : tick >= 500 ? 120 : 60;
  let dur = messageLength * typewriterCharMs(speed) + tailMs;
  if (kind === "damage" || kind === "recoil") {
    // Let the HP bar transition settle before the next line lands.
    dur += tick >= 1000 ? 480 : tick >= 500 ? 320 : 200;
  } else if (kind === "faint") {
    // The sprite fade-out is a fixed CSS animation, so this does not scale.
    dur += 600;
  }
  return Math.max(80, dur);
}

/**
 * ── MOVE EFFECTS: A LIFETIME *AND* A PLAYBACK RATE ────────────────────
 *
 * THE BUG (reported by pani): "attack animations ignore game speed".
 *
 * The JS unmount timer already scaled — 600 / 420 / 280ms — but every keyframe
 * duration in app.css is a hardcoded literal, forty-odd of them across the
 * archetypes, each with its own literal delay carrying the stagger that makes
 * a particle stream read as a stream. So at ×5 the effect was not played
 * faster, it was CUT OFF: the element vanished 280ms into a 600ms animation
 * and the player saw the first half of a Flamethrower.
 *
 * The fix is a playback RATE rather than forty edited durations and forty
 * re-derived staggers — see `setCssAnimationRate`. Both numbers come off this
 * one ladder, so the element and its keyframes cannot drift apart, and an
 * archetype added later is scaled without being told about it.
 */
export const MOVE_ANIM_BASE_MS = 600;

export function moveAnimMs(speed: number): number {
  const tick = tickIntervalFor(speed);
  return tick >= 1000 ? MOVE_ANIM_BASE_MS : tick >= 500 ? 420 : 280;
}

/** How fast the keyframes must run to fit `moveAnimMs` — 1× at speed 1. */
export function moveAnimRate(speed: number): number {
  return MOVE_ANIM_BASE_MS / moveAnimMs(speed);
}
