import { catchRates } from "../data/catchRates";
import { pokeballs } from "../data/pokeballs";
import { pokemonTable } from "../data/pokemon";
import { BALL_ORDER } from "./items";
import { resolveCatchSettings } from "./catchSettings";
import { ownsSpecies } from "./pokemon";
import { maxSingleHitDamage } from "./battle";
import type { GameState, Pokemon, CatchSettings } from "../types";

export function speciesCatchRate(speciesKey: string): number {
  return catchRates[speciesKey] ?? 255;
}

// HP-dependent catch bonus. `hpFraction` is the target's currentHp/maxHp
// (1 = full). Canonical catch math weights LOW hp far higher, but applying
// it directly would NERF the long-standing full-HP odds every player is used
// to. So we treat full HP as the baseline (factor 1, unchanged) and only ADD
// a bonus as HP drops — pure upside, up to ~2.5x at a sliver of HP. This is
// what makes the opt-in "weaken before catching" setting actually pay off.
export function hpCatchFactor(hpFraction: number): number {
  const f = Math.max(0, Math.min(1, Number.isFinite(hpFraction) ? hpFraction : 1));
  return 1 + (1 - f) * 1.5; // 1.0 at full HP → 2.5 at ~0 HP
}

export function catchProbability(speciesKey: string, ballId: string, hpFraction = 1): number {
  const rate = speciesCatchRate(speciesKey);
  const ball = pokeballs[ballId];
  if (!ball) return 0;
  const base = (rate * ball.ballModifier) / 255;
  return Math.min(1, base * hpCatchFactor(hpFraction));
}

export function rollCatch(speciesKey: string, ballId: string, hpFraction = 1): boolean {
  return Math.random() < catchProbability(speciesKey, ballId, hpFraction);
}

// Cheapest enabled ball that has a guaranteed catch (rate * mod / 255 >= 1).
// Falls back to the highest enabled ball if no guarantee exists.
export function pickAutoBall(
  speciesKey: string,
  enabledBalls: string[],
  inventory: Record<string, number>
): string | null {
  const owned = BALL_ORDER.filter(
    (b) => enabledBalls.includes(b) && (inventory[b] ?? 0) > 0
  );
  if (owned.length === 0) return null;
  const rate = speciesCatchRate(speciesKey);
  for (const b of owned) {
    if ((rate * pokeballs[b].ballModifier) / 255 >= 1) return b;
  }
  return owned[owned.length - 1];
}

/**
 * @param encounter The wild Pokémon itself, when the caller has it.
 *
 *   OPTIONAL, and that is the whole migration story. This function used to
 *   take a species key and a level, which meant the advanced filters could
 *   not exist: IVs, nature and gender live on the individual, and the
 *   individual never reached here. Callers that pass it get the filters;
 *   callers that do not are unchanged, and a filter that cannot be evaluated
 *   is SKIPPED rather than treated as failed — refusing to throw a ball
 *   because the caller was thin would be a silent auto-catch outage, which
 *   is exactly the class of bug the shiny override at the top exists for.
 */
export function shouldAutoCatch(
  state: GameState,
  routeKey: string,
  speciesKey: string,
  level: number,
  isShiny: boolean,
  encounter?: Pokemon
): boolean {
  // ULTIMATE override — a shiny encounter is 1/8192 (or 1/4096 with
  // Shiny Charm). Player report from global chat: "5 shinies today,
  // didn't throw a ball at any of them" — caused by the v1 ordering
  // of this function which short-circuited on
  // `!settings.enabled || settings.enabledBalls.length === 0` BEFORE
  // checking alwaysCatchShinies. A per-route disable or an empty
  // ball list silently ate every shiny. Now the shiny gate fires
  // first; ballForAutoCatch will fall back to ANY owned ball.
  if (isShiny && state.alwaysCatchShinies) return true;
  const settings = resolveCatchSettings(state, routeKey, speciesKey);
  if (!settings.enabled || settings.enabledBalls.length === 0) return false;
  // The extra conditions AND with the mode below — "Adamant male Charmander
  // with IVs above 85%" is four rules, and `mode` only ever expressed one.
  if (!passesFilters(settings.filters, encounter)) return false;
  switch (settings.mode) {
    case "always":          return true;
    case "shiny_only":      return isShiny;
    case "level_threshold": return level >= settings.levelThreshold;
    // "Not registered". `pokedexCaught` is append-only — releasing, trading
    // away or evolving a species never un-registers it — so this stops for
    // good once the entry exists. Unchanged from the day it shipped; the split
    // below is what gives players the other reading they kept asking for.
    case "pokedex_new":     return !state.pokedexCaught.includes(speciesKey);
    // "Not owned". Asks what the player is HOLDING, which is a different
    // question and the one that lets a released / traded / evolved-away
    // species come back into scope. ownsSpecies short-circuits on the first
    // match instead of building a set of every species in a 9,999-slot PC —
    // this runs on every single wild encounter.
    case "not_owned":       return !ownsSpecies(state.party, state.box, speciesKey);
    default:                return true;
  }
}

/** Perfect IV total — six stats at 31. Exported so the settings UI shows the
 *  same denominator the rule uses. */
export const IV_TOTAL_MAX = 31 * 6;

export function ivPercent(p: Pokemon): number | null {
  const iv = p.ivs;
  if (!iv) return null;
  const total = iv.hp + iv.attack + iv.defense + iv.spAttack + iv.spDefense + iv.speed;
  return (total / IV_TOTAL_MAX) * 100;
}

/**
 * Every extra condition, ANDed. Absent filters and unknowable ones pass.
 *
 * "Unknowable passes" is deliberate and worth stating: a caller with no
 * encounter object, or a Pokémon with no IVs (older saves), must not silently
 * stop auto-catching. A filter that cannot be judged is not a filter that
 * failed.
 */
export function passesFilters(
  filters: CatchSettings["filters"],
  p?: Pokemon,
): boolean {
  if (!filters) return true;
  if (!p) return true;

  if (filters.minIvPct != null) {
    const pct = ivPercent(p);
    if (pct != null && pct < filters.minIvPct) return false;
  }
  if (filters.natures && filters.natures.length > 0) {
    // A Pokémon with no nature recorded cannot be judged, so it passes.
    if (p.nature && !filters.natures.includes(p.nature)) return false;
  }
  if (filters.gender) {
    // Genderless (null) fails a gender filter, and that is correct — asking
    // for males is a statement about gender, and a Magnemite has none.
    // `undefined` is different: it means we never derived one (a Pokémon
    // from before the field existed), so it passes.
    if (p.gender !== undefined && p.gender !== filters.gender) return false;
  }
  return true;
}

export function ballForAutoCatch(
  state: GameState,
  routeKey: string,
  speciesKey: string,
  isShiny = false,
): string | null {
  const settings = resolveCatchSettings(state, routeKey, speciesKey);
  // Shiny override extends to ball selection: if the user has
  // alwaysCatchShinies on and we're picking a ball for a shiny, fall
  // back to ANY owned ball when the configured enabledBalls list is
  // empty or out of stock. Better to use the wrong ball than to let
  // the encounter walk away.
  if (isShiny && state.alwaysCatchShinies) {
    const fromEnabled = pickAutoBall(speciesKey, settings.enabledBalls, state.inventory);
    if (fromEnabled) return fromEnabled;
    // Emergency fallback for a shiny whose configured balls are all out of
    // stock: better the wrong ball than watching it walk away.
    //
    // But NEVER the Master Ball. BALL_ORDER ends with "masterball", so this
    // used to be `BALL_ORDER.find(owned > 0)` — and a player down to their
    // last Poke Ball, with one Master Ball banked, silently spent it on a
    // shiny they never chose it for (br_3a5bc2b26425b58611: "my Master Ball
    // was used directly. I never selected it"). The most valuable item in the
    // game, gone with no prompt.
    //
    // A Master Ball is only ever thrown when the player put it in
    // enabledBalls themselves — which the pickAutoBall call above honours.
    // The fallback exists to avoid losing a shiny, and losing the ball that
    // guarantees a catch in order to maybe catch one is not that trade.
    const anyOwned = BALL_ORDER.find(
      (b) => b !== "masterball" && (state.inventory[b] ?? 0) > 0,
    );
    if (anyOwned) return anyOwned;
    return null;
  }
  return pickAutoBall(speciesKey, settings.enabledBalls, state.inventory);
}

// Weaken-before-catch: keep attacking until the wild Pokémon is at or below
// this fraction of max HP, then throw. 0.30 is deep enough into the HP window
// to earn most of the low-HP catch bonus (hpCatchFactor) while, for an
// even-levelled fight, leaving room above fainting.
export const WEAKEN_HP_THRESHOLD = 0.30;

/**
 * Should the auto-catch loop spend this turn ATTACKING instead of throwing?
 *
 * Lives here rather than inline in useBattleLoop because the fraction test
 * alone is wrong and was shipping: a Route 1 Pidgey has 15 max HP, so "chip it
 * to 30%" means "get it to 4 HP", and one hit from a level-100 lead does 15+.
 * The mon fainted every time and was never caught — which is what auto-catch
 * looking broken on a starter route actually feels like. So the last question
 * is whether the hit we are about to throw would kill the thing we are trying
 * to catch; if it would, throw the ball now and take the full-HP odds.
 *
 * Shinies never weaken at all — one wasted hit on a 1/8192 encounter is not a
 * trade worth making, and hpCatchFactor is pure upside rather than a
 * requirement.
 */
export function shouldWeakenBeforeCatch(
  state: GameState,
  routeKey: string,
  player: Pokemon,
  enemy: Pokemon,
): boolean {
  const settings = resolveCatchSettings(state, routeKey, enemy.speciesKey);
  if (!settings.weakenFirst) return false;
  if (enemy.isShiny) return false;
  const hpFrac = enemy.maxHp > 0 ? enemy.currentHp / enemy.maxHp : 1;
  if (hpFrac <= WEAKEN_HP_THRESHOLD) return false;
  const incoming = maxSingleHitDamage(
    {
      ...player,
      types: pokemonTable[player.speciesKey]?.types ?? [],
      // The live Attack/Sp. Atk stages, which is the whole point of asking.
      // `player` is a Pokemon and Pokemon has no stat stages — they live in
      // state.playerVolatile, and EXECUTE_TURN merges them onto its BattleSide
      // (reducer.ts `Object.assign(player, state.playerVolatile ?? {})`) before
      // computing real damage. Estimating at neutral while the turn resolves at
      // +4 is how the guard cleared a hit that then killed the catch target:
      // machop L20 vs geodude L20 (47 HP) estimates 45 unboosted and lands 129
      // boosted. 144 such pairs exist in a small species/level grid.
      // The defender has no persisted volatile in game state, so there is no
      // enemy-side stage to read.
      statStages: state.playerVolatile?.statStages,
    },
    { ...enemy, types: pokemonTable[enemy.speciesKey]?.types ?? [] },
  );
  // A zero estimate does NOT mean "a harmless hit". It means we found no
  // usable damaging move, and both ways that happens argue for throwing now:
  //   - every slot at 0 PP: the turn resolves as Struggle, which is typeless
  //     and unmodelled here, so the loop would keep swinging and could faint
  //     the very Pokemon it is trying to catch;
  //   - a status-only moveset: the target's HP never falls, so the fraction
  //     test never clears and no ball is EVER thrown for the encounter.
  // Comparing `0 < currentHp` answered "true" to both.
  if (incoming <= 0) return false;
  return incoming < enemy.currentHp;
}

/**
 * What the Catch Settings badge should say for a species on a route.
 *
 * `enabled` is NOT the answer, and printing it as if it were is the whole of
 * br_6fcb7c411f3c317ccc: the reporter's Route 1 rules were all "Not registered"
 * with all five species already registered, so shouldAutoCatch correctly
 * declined every one — while the screen that exists to explain auto-catch
 * showed a green "✓ CATCH" on all five and a tooltip saying auto-catch was ON.
 * 769 real saves have at least one badge lying this way. The engine was right;
 * only the label was wrong, so this reports the RESOLVED decision.
 *
 * `inert` means on-but-nothing-will-be-thrown, and is only ever claimed for the
 * two modes whose condition is fixed for the species — the level and shiny
 * modes genuinely depend on the encounter, so they stay "on". The verdict is
 * delegated to shouldAutoCatch rather than re-deriving it; a second copy of
 * that predicate is exactly how the two drifted apart in the first place.
 *
 * `shinyOverride` is the other half, and the first version of this badge got it
 * wrong in the opposite direction to the bug it fixed. alwaysCatchShinies is ON
 * by default and its check sits at the very TOP of shouldAutoCatch — above
 * `enabled`, above the ball list, above the mode — so for a shiny encounter
 * NONE of the reasons below apply. A row reading "⊘ NO MATCH" with a tooltip
 * promising "nothing will be thrown" was therefore still lying, just more
 * quietly: a shiny of that species gets a ball every time. The flag is reported
 * separately from `verdict` because both facts are true at once — nothing for an
 * ordinary encounter, a ball for a shiny one — and collapsing them into one
 * label is what made the first version wrong.
 */
export type AutoCatchOutlook =
  | { verdict: "on"; shinyOverride: boolean }
  | { verdict: "off"; shinyOverride: boolean }
  | {
      verdict: "inert";
      reason: "no_balls" | "already_registered" | "already_owned";
      shinyOverride: boolean;
    };

export function autoCatchOutlook(
  state: GameState,
  routeKey: string,
  speciesKey: string,
): AutoCatchOutlook {
  const settings = resolveCatchSettings(state, routeKey, speciesKey);
  // Asked via ballForAutoCatch rather than the raw flag: the override only
  // actually throws if a ball can be found, and for a shiny that search falls
  // back to ANY owned ball, so neither an empty enabledBalls list nor a
  // disabled row can stop it. An empty BAG can.
  const shinyOverride =
    state.alwaysCatchShinies &&
    ballForAutoCatch(state, routeKey, speciesKey, true) !== null;
  if (!settings.enabled) return { verdict: "off", shinyOverride };
  if (settings.enabledBalls.length === 0) {
    return { verdict: "inert", reason: "no_balls", shinyOverride };
  }
  if (settings.mode !== "pokedex_new" && settings.mode !== "not_owned") {
    return { verdict: "on", shinyOverride };
  }
  // Level and shininess are the encounter's, not the species'. Level is
  // irrelevant to these two modes so the extreme makes that explicit; shininess
  // is NOT irrelevant, which is why it is reported as shinyOverride above
  // instead of being folded into this call.
  if (shouldAutoCatch(state, routeKey, speciesKey, 100, false)) {
    return { verdict: "on", shinyOverride };
  }
  return {
    verdict: "inert",
    reason: settings.mode === "pokedex_new" ? "already_registered" : "already_owned",
    shinyOverride,
  };
}
