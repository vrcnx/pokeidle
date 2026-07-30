import { useEffect, useRef } from "react";
import { useGame } from "../state/GameContext";
import { useStreamMode, getStreamConfig } from "../state/streamMode";
import { executeStreamCommand } from "../utils/streamCommands";
import { regions, regionForLocation, DEFAULT_REGION } from "../data/regions";
import { regionBadgeCount } from "../utils/unlocks";
import { encounters } from "../data/encounters";
import { evolutions } from "../data/evolutions";
import { routes } from "../data/routes";
import { getRouteTrainers } from "../utils/trainerFactory";
import { itemsCatalog } from "../data/itemsCatalog";
import { rewardShopCatalog } from "../data/eliteFour";
import { raidTiersOrdered, isTierUnlocked, type RaidTierId } from "../data/raidLegendaries";
import { pushToast } from "../components/Toast";
import { levelEvolutionFor, evolutionLocked } from "../utils/evolution";
import {
  bestTeamSwap,
  bestLeadIndex,
  bestBoxIndex,
  worstBoxRelease,
  worstBoxReleases,
  frontierTarget,
  scoreMon,
} from "../utils/streamTeam";
import {
  pickBallRestock,
  policyEnabledBalls,
  sameBallSet,
  shopEntry,
  usableBallCount,
} from "../utils/streamShop";
import { pickRematch, regionCleared, allRegionsCleared } from "../utils/streamRematch";
import {
  loadStreamMemory,
  persistStreamMemory,
  addStrike,
  strikeCount,
  pruneStrikes,
  pruneStamps,
  markStamp,
  stampActive,
  operatorHoldMsLeft,
  type StreamMemory,
} from "../utils/streamMemory";
import type { GameState, Stats } from "../types";

// Autonomous progression for the 24/7 stream account.
//
// The generic idle loop only ever grinds whatever route you're standing on —
// it never decides to challenge a gym, run the Elite Four, restock, or move
// somewhere more useful. Left alone a stream account therefore farms its
// starting route forever. This hook is the missing director: on a stream
// session it periodically looks at the game state and takes the single most
// sensible next action.
//
// It also LEARNS. A purely static "is my level high enough" rule keeps walking
// back into a fight it can't win — the stream then loops death → heal → death
// on the same route. So whiteouts are recorded per location and per boss: a
// place that keeps killing us is avoided and we drop to an easier route to
// level, and a gym that beat us has to be cleared by a wider margin next time.
// Both fade after a while so the account retries once it has actually grown.
// That notebook now lives in localStorage (utils/streamMemory.ts) rather than
// in refs — every frontend deploy force-reloads this page, and a director that
// forgets on every deploy re-learns the same lesson by dying on camera again.
//
// Deliberately conservative — from the idle gate down it only acts while idle
// and out of battle, one action per tick, so it can never fight the normal
// loop or the admin's manual remote commands.
//
// TWO structural exceptions, and between them they are the reason half of this
// file exists.
//
// The first is a small pre-guard tier that runs BEFORE the idle gate on the
// 6 s ladder. Every way this account can freeze — paused, stuck in `healing`,
// stuck in `evolution`, an endless raid, an empty party — is a state in which
// the old director refused to act. The guard that kept it safe was the same
// guard that stopped it rescuing itself, and a frozen stream is the worst
// thing a viewer can be shown. The pre-guards only ever fire on state that is
// provably not moving.
//
// The second is the fast lane, a 250 ms poll that owns save integrity and
// session policy outright. The arithmetic that forces it: at speed 5 the
// battle loop re-arms every 200 ms and starts the next encounter the instant
// the phase is idle, so `blocked()` is false for roughly 8% of wall clock and
// a 6 s ladder gets one action per ~75 s. Anything racing the game itself —
// stopping a catch that would push the box past the server's 9,999-entry cap
// and permanently break cloud saving, or clearing the `battleMode: "manual"`
// freeze — loses that race by two to three orders of magnitude. None of those
// dispatches needs an idle game (they are field assignments and a
// `box.filter`), so none of them belongs behind the idle gate.

const TICK_MS = 6000;
/** Services a pending travel-then-fight intent. The main tick is far too slow
 *  to win the race for an idle gap in a town: `useBattleLoop` re-arms every
 *  200 ms at speed 5 and immediately starts the next trainer battle, so a 6 s
 *  director would almost never see the town standing empty. */
const INTENT_POLL_MS = 250;
/** An intent that hasn't been satisfied by now is stale — something else
 *  (the operator, auto-proceed, a raid) moved us. Drop it rather than acting
 *  on a decision made a different lifetime ago. */
const INTENT_TTL_MS = 90_000;
/** Hands off for this long after the admin issues a manual command. Without
 *  it the director undoes the operator on its very next tick, which from the
 *  dashboard is indistinguishable from a broken remote control. */
const OPERATOR_HOLD_MS = 5 * 60_000;

/** Only challenge a boss when the party's best mon clears the boss's ace by
 *  this much — losing on stream repeatedly is worse than grinding. */
const GYM_LEVEL_MARGIN = 2;
const E4_LEVEL_MARGIN = 3;
/** Each recorded loss to a boss adds this to the margin it must clear. */
const LOSS_MARGIN_STEP = 3;
/** Whiteouts at a location before we treat it as too dangerous. */
const DANGER_LIMIT = 2;
/** Recorded losses fade after this, so nowhere is written off forever. */
const DANGER_TTL_MS = 15 * 60_000;

/** Consecutive ticks observed `paused` before we unpause ourselves. Two, so a
 *  human toggling the button gets a moment, but a leaked stream URL can't kill
 *  the broadcast until the next deploy. */
const PAUSE_TICKS = 2;
/** Ticks a blocked, byte-identical progress fingerprint must persist before
 *  the watchdog intervenes. Five ticks is 30 s; the battle loop's slowest
 *  cadence is 1 s, so 30 s of not one HP point and not one log line is not a
 *  slow turn, it's a freeze. */
const STALL_TICKS = 5;
/** Raids have deliberately NO terminal condition (reducer.ts:316) — waves keep
 *  arriving at +5 levels forever. A strong party that enters one never comes
 *  out, so the director hard-caps the visit. */
const RAID_MAX_MS = 12 * 60_000;
/** A raid loss is announced by two different reducer paths and one of them
 *  arrives a beat late (see the render body), so "did this whiteout come out
 *  of the raid we just left" needs a short grace window, not a single flag. */
const RAID_WIPE_BLAME_MS = 30_000;
/** START_RAID always parks the account here (reducer.ts:1989). Only used as
 *  the seed for the raid-location tracker; the tracker overwrites it the
 *  first time we actually render inside a raid. */
const RAID_LOCATION = "raidIsland";
/** Don't chain raids back-to-back even when a different tier is off cooldown;
 *  the rest of the ladder needs camera time too. Measured from the moment the
 *  account LEFT the island (see the render body and rung 0.2), never from when
 *  it arrived.
 *
 *  Strictly GREATER than RAID_MAX_MS, and that inequality is the whole point:
 *  it is what makes a raid punctuation rather than the programme. With the two
 *  equal — which is what they were — the gap was already satisfied at the
 *  instant of a time-boxed exit even when measured correctly, so the only
 *  thing standing between the account and a permanent raid was the per-tier
 *  5-minute cooldown, and with six tiers one is always ready. Every rung below
 *  the raid (gyms, the league, the frontier hold, the box trim, the grind)
 *  lives entirely inside this window, so the ladder is now guaranteed a run
 *  2.5x longer than the raid that preceded it. */
const RAID_MIN_GAP_MS = 30 * 60_000;
/** How far below a tier's starting level the party may be and still be worth
 *  sending in. A loss costs nothing but a cooldown (reducer.ts:2171 — no money
 *  penalty, no whiteout) so this can afford to be optimistic. */
const RAID_LEVEL_GRACE = 4;

/** Restock when usable balls fall below this, and buy back up to this. Low is
 *  generous on purpose: running dry stalls the dex, the box, team quality and
 *  raid value all at once, and it does so silently. */
const BALL_LOW = 20;
const BALL_TARGET = 80;
/** Never spend the account below this. Gym/E4 losses charge money, and an
 *  account at $0 can't restock its way out of a dry spell. */
const MONEY_FLOOR = 25_000;
/** A purchase that didn't arrive means the item is gated in a way we can't
 *  see. Stop trying for a while instead of buy-looping on camera. */
const UNBUYABLE_TTL_MS = 30 * 60_000;

/** The 10,000th box entry makes every future cloud save 400 forever
 *  (server MAX_BOX = 9999, GameContext latches `permanentlyRejectedRef` and
 *  NOTHING ever clears it) — the stream keeps playing while nothing persists.
 *  Stop the inflow well before that. */
const BOX_HARD_STOP = 9500;
/** Above this we drip-release genuine duplicates. Below it, the box is just a
 *  collection and none of this runs. */
const BOX_SOFT_CAP = 3000;
/** Releasing is irreversible and dull to watch, so it is a slow background
 *  drip, not a task the director can disappear into. One a minute still
 *  outpaces the post-"pokedex_new" inflow by orders of magnitude. */
const RELEASE_MIN_GAP_MS = 60_000;
/** ...but with only a handful of slots left, a single shiny is enough to brick
 *  the save, so the drip becomes a burst on the fast lane. Deliberately a
 *  NARROW band: it buys ~100 slots, vastly more than a day of new-dex-entry
 *  inflow. Using the hard stop for this instead would have meant fifty. */
const BOX_CRITICAL = 9900;
/** The server's own cap (server/src/lib/saveValidation.ts MAX_BOX): a save
 *  with box.length > 9999 comes back 400 and GameContext swallows it, so the
 *  stream keeps playing while nothing persists. The live account is parked on
 *  exactly 9999, which proves this is reachable and not theoretical. */
const BOX_SAVE_MAX = 9999;
/** Stop catching ENTIRELY this close to the cap. Throttling the inflow to
 *  "pokedex_new" is not enough on its own: a new species still gets caught,
 *  and `alwaysCatchShinies` ignores the catch mode outright — so at 9999 a
 *  single shiny is one unrecoverable save away. `autoCatch` is the only
 *  switch that stops all of it (useBattleLoop.ts:201). */
const BOX_FREEZE_AT = BOX_SAVE_MAX - 8;
/** ...and only turn catching back on once the drip has bought real headroom.
 *  The gap up to BOX_FREEZE_AT is deliberate hysteresis: a single threshold
 *  would toggle auto-catch on and off on alternate ticks. */
const BOX_RESUME_AT = BOX_CRITICAL;

/** A frontier counter that hasn't moved in this long isn't going to. Retire it
 *  for a while and let the next-best gate have a turn. */
const FRONTIER_STALL_MS = 20 * 60_000;
const FRONTIER_SKIP_TTL_MS = 60 * 60_000;

/** Grinding the single toughest route forever is optimal and unwatchable.
 *  Rotate around the top few survivable routes instead. */
const GRIND_VARIETY = 3;
const GRIND_ROTATE_MS = 4 * 60_000;

/** Floor between two endgame rematches (rung 16c).
 *
 *  This is the rung's PRIMARY anti-spin guard, not a taste setting — see the
 *  rung for the full argument. Every other rung on this ladder is falsified
 *  by its own dispatch (a heal fills the HP it was chosen for, a release
 *  shortens the box, a badge lands in `defeatedGyms`); a rematch changes
 *  nothing the selector reads, so this gap is what stops it.
 *
 *  Four minutes, and the number is bounded from both sides:
 *   - Below, by the raid. RAID_MIN_GAP_MS is 30 min and RAID_MAX_MS is 12,
 *     so a raid-free stretch is ~18 min of ladder; at 4 min that stretch
 *     carries ~4 rematches instead of 18 min of Rattatas.
 *   - Above, by the lap. Kanto and Johto both have 8 gyms, so a lap is 9
 *     events ≈ 36 min: a viewer sees every leader in the region, and one
 *     full gauntlet, inside about half an hour. Doubling this to 8 min would
 *     put a lap at over an hour, which is longer than most of the audience
 *     stays — the rotation would read as "the same two leaders" to anyone
 *     watching a single sitting, which is the exact complaint this rung
 *     exists to answer.
 *   - And against the rest of the ladder: a rematch is one dispatch, so the
 *     rung takes at most 1 tick in 40 (TICK_MS 6 s into 240 s). Rung 17 and
 *     the stuck detector below it keep 97.5% of ticks. */
const REMATCH_GAP_MS = 4 * 60_000;
/** Floor between two League gauntlets, on top of the once-per-lap rotation.
 *
 *  The rotation alone already makes the gauntlet 8x rarer than gym rematches
 *  in general — one capstone per eight leaders. But the rotation SKIPS
 *  ineligible slots, and in the degenerate case where every gym slot is
 *  skipped (a run of losses widening each leader's margin past our level, a
 *  region whose gym towns re-lock) the cursor would land back on the League
 *  every single time — turning the hardest content in the game into the
 *  default at one gauntlet per REMATCH_GAP_MS, precisely when the party is
 *  demonstrably struggling. Twenty minutes never binds in normal operation
 *  (a healthy lap already spaces gauntlets ~36 min apart) and caps the
 *  degenerate case at 3/hour instead of 15. */
const REMATCH_LEAGUE_MIN_GAP_MS = 20 * 60_000;

/** Floor between two lead changes. The lead rung is already self-limiting
 *  (see rung 10), but a rung that physically cannot fire twice inside this
 *  window can never become a tick sink again however the reducer changes. */
const LEAD_ROTATE_MIN_MS = 30_000;
/** Floor between two HEAL_PARTY dispatches on the fast lane, so a heal that
 *  somehow doesn't take degrades into one dispatch a second rather than one
 *  every poll. */
const HEAL_MIN_GAP_MS = 1_000;

/** How often the "nothing matched" state is allowed to say so out loud. */
const STUCK_LOG_MS = 10 * 60_000;
/** Give up re-asserting a session setting after this many tries — if the
 *  dispatch isn't taking, repeating it forever won't help. */
const ASSERT_MAX_TRIES = 3;
/** Cadence of the fast lane's session-policy reconcile. The lane itself polls
 *  every 250 ms because the save guards have to be instant, but the settings
 *  block must not burn its whole ASSERT_MAX_TRIES budget in 750 ms — at this
 *  cadence three tries still span six seconds, exactly as they did when this
 *  block lived on the ladder. */
const POLICY_ASSERT_MS = 2_000;
/** Floor between two auto-catch writes. TOGGLE_AUTO_CATCH is a TOGGLE, not an
 *  assignment: two dispatches issued from the same not-yet-rendered state
 *  cancel out and leave catching ON at the cap, which is the one outcome this
 *  whole mechanism exists to prevent. */
const AUTOCATCH_MIN_GAP_MS = 1_000;

/** Releases per fast-lane burst while the box is at/over BOX_CRITICAL, and the
 *  floor between two bursts.
 *
 *  Sized against the ONE job the burst has: get from the server cap (9,999)
 *  back under BOX_RESUME_AT so catching — the entire point of the account —
 *  can start again. That is exactly 100 slots, so 4 bursts of 25, ~3 s. The
 *  alternatives are both bad: one release per effective ladder tick is ~75 s
 *  each, i.e. over two hours of a dead, non-catching stream, and a single
 *  100-wide burst would hand React one re-render carrying a hundred-element
 *  splice of a ten-thousand-element array with no chance to interleave.
 *  25 also keeps every burst under the 92-slot minimum the hysteresis band
 *  guarantees, so a burst can never overshoot BOX_RESUME_AT and start
 *  releasing into a box that is already healthy. */
const BOX_TRIM_BATCH = 25;
const BOX_TRIM_GAP_MS = 1_000;
/** Nothing in the box qualified for release. Stop rescanning ten thousand
 *  entries four times a second; the freeze holds, the save is safe, and the
 *  toast has already paged a human. */
const BOX_TRIM_RETRY_MS = 60_000;

type Intent =
  | { kind: "gym"; gymId: string; locationId: string; until: number }
  | { kind: "league"; locationId: string; until: number }
  // Endgame rematches carry their own kinds because the `gym` / `eliteFour`
  // commands refuse an already-beaten opponent outright.
  | { kind: "rematch"; gymId: string; locationId: string; until: number }
  | { kind: "leagueRematch"; regionId: string; locationId: string; until: number };

/** An item action whose effect we intend to confirm on the next tick. Every
 *  item path in the reducer fails SILENTLY — an unsellable price, a missing
 *  catalog entry, "not enough money" — by pushing a log line and returning the
 *  state unchanged. Without a receipt, one such failure is an infinite loop on
 *  camera, so nothing here is dispatched without one. */
interface PendingItem {
  itemId: string;
  /** "gain" = we bought it, "spend" = we consumed it. */
  want: "gain" | "spend";
  owned: number;
  /** For Exp. Share only: it never enters the inventory, so it is verified
   *  against `activeEffects.battlesRemaining` instead. */
  charge: number;
  at: number;
}
/** A receipt older than this is unverifiable (the operator took the wheel, a
 *  raid intervened) — drop it rather than blaming the item. */
const RECEIPT_TTL_MS = 60_000;
/** Keep this many Victory Tokens back so an evolution stone is always
 *  affordable; Exp Share may only spend the surplus. */
const TOKEN_RESERVE = 4;

function topLevel(state: GameState): number {
  return state.party.reduce((m, p) => Math.max(m, p.level), 0);
}
function healthyCount(state: GameState): number {
  return state.party.filter((p) => p.currentHp > 0).length;
}
/** The heal rung's predicate, and the reason it is this and not
 *  `healthyCount(s) < s.party.length`: HEAL_PARTY sets `currentHp = maxHp`,
 *  so a party member carrying a corrupt `maxHp` of 0 would come back out of
 *  the heal still counting as fainted and the rung would re-fire forever.
 *  Asking specifically for someone HEAL_PARTY can actually raise means the
 *  dispatch always falsifies the predicate it was chosen by. */
function needsHeal(state: GameState): boolean {
  return state.party.some((p) => p.currentHp <= 0 && p.maxHp > 0);
}
function aceLevel(team: { level: number }[]): number {
  return team.reduce((m, t) => Math.max(m, t.level), 0);
}
function routeTop(id: string): number {
  const list = encounters[id]?.encounters;
  if (!list || list.length === 0) return -1;
  return list.reduce((m, e) => Math.max(m, e.maxLevel), 0);
}

/** Everything that moves while the game is making progress. Identical across
 *  a whole stall window means nothing is happening at all — not a long turn,
 *  not a slow animation. */
function fingerprint(s: GameState): string {
  return [
    s.phase,
    s.enemyPokemon?.id ?? "-",
    s.enemyPokemon?.currentHp ?? -1,
    s.playerPokemon?.currentHp ?? -1,
    s.pendingEvents.length,
    // battleLogSeq, not battleLog.length: the log is trimmed to 50 lines, so
    // its length stops moving after a few battles and the watchdog's own
    // promise below — "one log line stands it down" — quietly stopped holding.
    // A false stall dispatches HEAL_PARTY, which bails out of a live battle.
    s.battleLogSeq,
    s.bossQueue.length,
    s.healingState?.step ?? -1,
    s.evolutionState?.step ?? -1,
    s.catchAnim?.key ?? -1,
    s.awaitingSwitch ? 1 : 0,
  ].join("|");
}

/** True while anything at all is blocking the idle gate. */
function blocked(s: GameState): boolean {
  return (
    s.phase !== "idle" ||
    s.enemyPokemon != null ||
    s.awaitingSwitch ||
    s.pendingEvents.length > 0 ||
    s.catchAnim != null ||
    s.evolutionState != null
  );
}

const IV_KEYS: (keyof Stats)[] = ["hp", "attack", "defense", "spAttack", "spDefense", "speed"];

/** An unlocked town that actually has trainers to re-fight — the game's only
 *  repeatable income, since wild battles pay nothing. Prefers where we already
 *  stand so the EARN rung settles instead of hopping between towns. */
function nearestTown(s: GameState): string | null {
  const towns = s.unlockedLocations.filter(
    (id) => routes[id]?.type === "town" && getRouteTrainers(id).length > 0,
  );
  if (towns.length === 0) return null;
  if (towns.includes(s.currentLocation)) return s.currentLocation;
  return towns[towns.length - 1] ?? null;
}

export function useStreamAutoPlay(): void {
  const { state, dispatch } = useGame();
  // Subscribed, not sampled. `isStreamMode()` is a module singleton that
  // AuthContext sets when /api/profile/me resolves; reading it once inside an
  // effect keyed on [dispatch] means that if the flag ever lands after this
  // hook mounts, the director is dead for the whole session and nobody finds
  // out until the stream has been standing still for an hour.
  const streamMode = useStreamMode();
  const stateRef = useRef(state);
  stateRef.current = state;

  // Learned danger, now on disk. Still deliberately NOT in the save: it is
  // scratch heuristics, not player progress, so it has no business
  // round-tripping through the cloud, the save validator and the admin tools.
  const memory = useRef<StreamMemory>(loadStreamMemory());
  const flush = useRef(() => {
    const m = memory.current;
    pruneStrikes(m.routeDanger, DANGER_TTL_MS);
    pruneStrikes(m.bossLosses, DANGER_TTL_MS);
    pruneStamps(m.unbuyable);
    pruneStamps(m.frontierSkip);
    persistStreamMemory(m);
  }).current;

  const lastWhiteoutKey = useRef<number | null>(state.whiteoutAnim?.key ?? null);
  // Remember what we were fighting/where, so a whiteout can be attributed
  // after the fact (by then the battle state is already cleared).
  const lastBossId = useRef<string | null>(null);
  const lastLocation = useRef<string>(state.currentLocation);
  // Where the raid itself is. Tracked separately from `lastLocation` because
  // every raid-exit path rewrites `currentLocation` to the mainland.
  const raidLocation = useRef<string>(state.inRaid ? state.currentLocation : RAID_LOCATION);
  // The location a NEW whiteout should be blamed on, frozen at the moment the
  // whiteout is first observed rather than read later from the effect.
  const wipeBlame = useRef<string | null>(null);
  // When we last left a raid in a way that looked like a loss.
  const raidWipeAt = useRef(0);

  // Pre-guard bookkeeping.
  const pausedTicks = useRef(0);
  const stallPrint = useRef("");
  const stallTicks = useRef(0);
  const raidEnteredAt = useRef<number>(state.inRaid ? Date.now() : 0);

  // Ladder bookkeeping. All of it exists to stop a rung firing forever with
  // nothing changing underneath it.
  const intent = useRef<Intent | null>(null);
  const assertTries = useRef<Record<string, number>>({});
  /** Re-assert a session setting, with an anti-spin budget. `ensure` gives up
   *  on a dispatch that refuses to take, but resets the moment the setting is
   *  observed correct, so a LEGITIMATE later change (a new ball unlocking, the
   *  operator retuning something) still gets acted on instead of being starved
   *  by a lifetime budget. Shared by both timers; every caller's `needed` is
   *  falsified by its own action, so a healthy session runs this whole block
   *  and dispatches nothing. */
  const ensure = useRef((key: string, needed: boolean, action: () => void): boolean => {
    if (!needed) { assertTries.current[key] = 0; return false; }
    const tries = assertTries.current[key] ?? 0;
    if (tries >= ASSERT_MAX_TRIES) return false;
    assertTries.current[key] = tries + 1;
    action();
    return true;
  }).current;
  const pendingItem = useRef<PendingItem | null>(null);
  const lastRaidAt = useRef(0);
  const lastReleaseAt = useRef(0);
  const lastHealAt = useRef(0);
  const lastLeadMoveAt = useRef(0);
  /** Latched by the box guard, cleared with hysteresis. A ref because the
   *  policy reconcile must not flip it back on the very poll the trim drops
   *  one below the freeze line. */
  const catchFrozen = useRef(false);
  const catchFrozenNoted = useRef(false);
  const lastAutoCatchAt = useRef(0);
  const lastPolicyAt = useRef(0);
  /** Earliest wall-clock at which the next trim burst may run. */
  const trimNextAt = useRef(0);
  /** Box length the previous burst should leave behind. A burst computes
   *  INDICES, so a second burst must not be computed from a box the first has
   *  already shortened but React has not re-rendered yet. */
  // Box length the last trim burst was computed from, plus a bounded
  // count of polls skipped while waiting for it to render. See the burst
  // branch for why the bound is load-bearing.
  const trimSentinel = useRef<string | null>(null);
  // The autoCatch value we last asked for, or null when settled.
  const autoCatchAsked = useRef<boolean | null>(null);
  /** The box is over the line and NOTHING in it may be released. The ladder
   *  reads this to decide whether standing down would be waiting for progress
   *  that is never coming. */
  const trimStalled = useRef(false);
  const holdWatch = useRef<{ locationId: string; have: number; since: number } | null>(null);
  const grindPick = useRef<{ locationId: string; at: number } | null>(null);
  /** Where the rematch rotation is up to. Pinned to a region for the whole
   *  lap so the account cannot ping-pong between Kanto and Johto bosses; the
   *  region is only re-chosen at a lap boundary (see rung 16c). */
  const rematchLap = useRef<{ regionId: string; index: number } | null>(null);
  const lastRematchAt = useRef(0);
  const lastLeagueAt = useRef(0);
  const lastStuckLog = useRef(0);
  const strandedNoted = useRef(false);

  if (state.bossBattle) lastBossId.current = state.bossBattle.bossId;

  // Rematch cadence is measured from the END of the last boss fight, not from
  // when we asked for one. Stamping only at dispatch time would measure the
  // gap from the START, and a League gauntlet is five fights back to back —
  // so by the time it finished its own cooldown would already be satisfied
  // and a gym rematch would begin on the next tick, which is not a rotation,
  // it is wall-to-wall boss fights. Re-stamping on every render that still
  // shows a live boss keeps the gap meaning what the constant says.
  //
  // Reading the BATTLE rather than our own intent also means an operator's
  // manual gym run, and rung 12/13's genuine first-time progression fights,
  // cool the loop down exactly as a rematch does — the director will not
  // chase the champion's own coronation with a Falkner rematch four minutes
  // later. `pendingBossBattle` is included because START_BOSS_BATTLE parks
  // the boss there through the heal cinematic, when `bossBattle` is still
  // null.
  //
  // This is a REFINEMENT of the cooldown, never the whole of it: the rung
  // stamps `lastRematchAt` itself before dispatching, because a dispatch that
  // silently no-ops produces no boss battle at all and so would never reach
  // this line.
  if (state.bossBattle || state.pendingBossBattle) {
    lastRematchAt.current = Date.now();
    const type = state.bossBattle?.bossType ?? state.pendingBossBattle?.battle.bossType;
    if (type === "e4" || type === "champion") lastLeagueAt.current = Date.now();
  }

  // Blame for a whiteout has to be decided HERE, before the trackers below
  // adopt this render's state — otherwise a raid loss is recorded against an
  // innocent route and drops that route's grind ceiling by 4 for the next
  // fifteen minutes. Two separate reducer paths cause it:
  //   * handleFaint's raid branch (reducer.ts:2447) sets
  //     `currentLocation: preRaidLocation` AND `whiteoutAnim` in the SAME
  //     reduce, so read afterwards `currentLocation` is already the mainland
  //     route we were sent home to.
  //   * resolveTurnEnd's raid wipe (reducer.ts:2213) is worse: it moves us
  //     back to `preRaidLocation` with NO whiteoutAnim and the party still
  //     fainted, and the whiteout only appears a beat later when our own
  //     HEAL_PARTY runs with everyone down (HEAL_PARTY raises `whiteoutAnim`
  //     whenever `wasAllFainted`, reducer.ts:581). By then nothing in the
  //     state says "raid" at all — hence the grace window.
  const wipeKey = state.whiteoutAnim?.key ?? null;
  const newWipe = wipeKey != null && wipeKey !== lastWhiteoutKey.current;
  if (newWipe) {
    const fromRaid =
      state.inRaid ||
      raidEnteredAt.current !== 0 ||
      Date.now() - raidWipeAt.current < RAID_WIPE_BLAME_MS;
    wipeBlame.current = fromRaid ? raidLocation.current : lastLocation.current;
  }

  if (state.inRaid) {
    raidLocation.current = state.currentLocation;
    if (raidEnteredAt.current === 0) raidEnteredAt.current = Date.now();
  } else {
    if (raidEnteredAt.current !== 0) {
      // Any raid exit — wipe, time-box, operator bail — restarts the gap
      // clock, so the cool-off is measured from when the account LEFT the
      // island rather than when it arrived. This block is the SOLE owner of
      // both refs and rung 0.2 must not pre-empt it: while `raidEnteredAt`
      // was being zeroed before the exit dispatch, HEAL_PARTY cleared
      // `inRaid`, this branch never ran, and `lastRaidAt` kept the raid's
      // start time — already RAID_MAX_MS old, so the gap was satisfied at the
      // instant of exit and the stream lived on raid island.
      raidEnteredAt.current = 0;
      lastRaidAt.current = Date.now();
      // Arm the grace window when the exit looked like a loss, so the
      // late-arriving whiteout described above is still blamed on the island.
      if (newWipe || (state.party.length > 0 && state.party.every((p) => p.currentHp <= 0))) {
        raidWipeAt.current = Date.now();
      }
    }
    if (!state.enemyPokemon && state.phase === "idle") lastLocation.current = state.currentLocation;
  }

  // Record a loss whenever the party gets wiped.
  useEffect(() => {
    const key = state.whiteoutAnim?.key ?? null;
    if (key == null || key === lastWhiteoutKey.current) return;
    // Consumed unconditionally, even when we aren't the director yet: a
    // whiteout that predates the stream flag landing is not ours to learn
    // from, and leaving the key unclaimed would record it the moment the
    // flag flips.
    lastWhiteoutKey.current = key;
    const blame = wipeBlame.current ?? lastLocation.current;
    wipeBlame.current = null;
    raidWipeAt.current = 0;
    if (!streamMode) return;
    addStrike(memory.current.routeDanger, blame, DANGER_TTL_MS);
    if (lastBossId.current) {
      addStrike(memory.current.bossLosses, lastBossId.current, DANGER_TTL_MS);
      lastBossId.current = null;
    }
    flush();
  }, [streamMode, state.whiteoutAnim?.key, flush]);

  // ── Fast lane ────────────────────────────────────────────────────────────
  // The ladder below is a 6 s timer sitting under `if (blocked(s)) return;`,
  // and on a route the only idle window is the ~200 ms `useBattleLoop` leaves
  // between encounters at speed 5 (tickIntervalFor(5) === 200,
  // useBattleLoop.ts:26,138). Idle is therefore true for roughly 8% of wall
  // clock, the ladder lands on ~1 tick in 12, and its EFFECTIVE rate is about
  // one action every 75 seconds. Anything that has to win a race against the
  // game itself loses it by two to three orders of magnitude, so it does not
  // belong on the ladder at all. Four things qualify:
  //
  //   * Save integrity. The live account is parked on box.length === 9999 ==
  //     the server's MAX_BOX. The 10,000th entry makes putSave return 400,
  //     GameContext latches `permanentlyRejectedRef` and NOTHING ever clears
  //     it — the stream keeps playing while nothing persists, forever. The
  //     first wild catch lands 2–3 s after page load; a guard that needs six
  //     minutes is not a guard.
  //   * Session policy. `battleMode: "manual"` is a hard freeze
  //     (manualWaiting() makes useBattleLoop repoll forever waiting for a
  //     click nobody will make) and it is BOTH persisted and defaulted to
  //     manual, so a fresh save lands there. Every setting here is a pure
  //     field assignment in the reducer — none of them needs an idle game,
  //     and none of them reads another's field, so they reconcile as a batch
  //     instead of costing one 75-second action each.
  //   * Travel-then-fight. TRAVEL has to land before a gym challenge is even
  //     legal, and a town is full of trainers, so the coarse tick loses that
  //     race almost every time.
  //   * The Tier 1 heal. When a party member faints mid-battle nothing else
  //     in the app will ever heal it: resolveTurnEnd just sends in the next
  //     mon (reducer.ts:2235) and useBattleLoop's deadlock breaker switches
  //     AWAY from a fainted active and only auto-heals when the WHOLE party
  //     is down (useBattleLoop.ts:93,110). So a single faint leaves the
  //     account fighting gyms, raids and routes a mon short until the slow
  //     tick happens to catch a gap — which is exactly the level-100
  //     Bulbasaur sitting at 0 HP behind a healthy bench on the live account.
  //
  // The first two run ABOVE the idle gate; the last two below it.
  useEffect(() => {
    if (!streamMode) return;
    const id = setInterval(() => {
      const s = stateRef.current;
      const now = Date.now();

      // Intent housekeeping runs even while blocked, so a stale one still
      // expires instead of being acted on a lifetime later.
      const want = intent.current;
      if (want) {
        if (now > want.until) intent.current = null;
        // The operator taking the wheel cancels whatever we were mid-way
        // through.
        else if (operatorHoldMsLeft(OPERATOR_HOLD_MS) > 0) intent.current = null;
      }

      // ═══ SAVE INTEGRITY & SESSION POLICY (above the idle gate) ═══════════
      // Nothing in this section needs an idle game: RELEASE_POKEMON's box
      // branch is a bare `box.filter` (reducer.ts:1572) and the settings are
      // single-field assignments. Running them here is what turns a guard
      // that lost to the first catch by minutes into one that wins by
      // seconds.

      const boxLen = s.box.length;

      // A. The latch. Freeze at BOX_FREEZE_AT, release only under
      //    BOX_RESUME_AT — a single threshold would toggle auto-catch on and
      //    off on alternate polls as the burst walks the box past one line.
      //    Said once per freeze, then it goes quiet.
      if (boxLen >= BOX_FREEZE_AT) catchFrozen.current = true;
      else if (boxLen < BOX_RESUME_AT) catchFrozen.current = false;
      if (!catchFrozen.current) catchFrozenNoted.current = false;
      else if (!catchFrozenNoted.current) {
        catchFrozenNoted.current = true;
        dispatch({ type: "ADD_LOG", payload: { text: `Stream director: PC is full (${boxLen}/${BOX_SAVE_MAX}) — catching paused while the box is trimmed.` } });
        pushToast({ kind: "warn", icon: "📦", text: "PC full — catching paused until the box is trimmed." });
      }

      // B. The master catch switch, and the ONLY writer of it. `autoCatch` is
      //    the one flag that stops all of it: throttling the mode to
      //    "pokedex_new" is not enough on its own, because a new species
      //    still gets caught and `alwaysCatchShinies` bypasses the mode
      //    outright (catching.ts:67) — but useBattleLoop gates the entire
      //    catch block on `cur.autoCatch &&` (useBattleLoop.ts:201), so this
      //    single toggle closes both doors.
      //
      //    Turning catching back ON is a preference and yields to the
      //    operator; turning it OFF at the cap is save integrity and does
      //    not. Gap-guarded because TOGGLE_AUTO_CATCH is a toggle: two
      //    dispatches from the same not-yet-rendered state would cancel out.
      const wantAutoCatch = (getStreamConfig()?.autoCatch ?? true) && !catchFrozen.current;
      // Wait for the ECHO, not for a clock. TOGGLE_AUTO_CATCH flips a
      // boolean, so two dispatches from the same not-yet-rendered state
      // cancel out and leave catching in exactly the state we were trying to
      // escape. A time gap only makes that unlikely, and this is the one
      // guard deciding whether catching runs while the box sits at the
      // server cap — "unlikely" is the wrong strength for it. Remember what
      // we asked for and stay quiet until the state agrees.
      if (autoCatchAsked.current !== null && s.autoCatch === autoCatchAsked.current) {
        autoCatchAsked.current = null; // our dispatch landed
      }
      if (
        s.autoCatch !== wantAutoCatch &&
        autoCatchAsked.current === null &&
        (!wantAutoCatch || operatorHoldMsLeft(OPERATOR_HOLD_MS) === 0)
      ) {
        autoCatchAsked.current = wantAutoCatch;
        dispatch({ type: "TOGGLE_AUTO_CATCH" });
      }

      // C. The trim burst. While the box is at or over BOX_CRITICAL this is
      //    the only thing that will ever turn catching back on, and catching
      //    is the account's whole reason to exist — so it runs here at 4 Hz
      //    in batches, not at one-per-effective-tick on the ladder (which
      //    from 9,999 would have been ~100 actions x ~75 s = over two hours
      //    of a dead stream before the FIRST gym was even considered).
      //
      //    Terminates by construction: every burst strictly shortens the box,
      //    so `boxLen >= BOX_CRITICAL` is false after at most
      //    ceil(100 / BOX_TRIM_BATCH) bursts. Indices come back DESCENDING so
      //    a run of single-index dispatches against a shrinking array still
      //    removes exactly the Pokémon that were chosen.
      if (boxLen < BOX_CRITICAL) {
        trimStalled.current = false;
        trimSentinel.current = null;
      } else if (now >= trimNextAt.current) {
        // Refuse while a Pokemon the last burst released is STILL in the box:
        // that proves our dispatches have not rendered, so the indices we are
        // about to compute address different Pokemon than we think. Releases
        // are irreversible, so guessing is not an option.
        //
        // An identity sentinel rather than a length comparison, and rather
        // than a bounded wait. Two earlier attempts here failed: comparing
        // lengths and refusing outright was a one-way ratchet that killed the
        // director permanently the moment the box grew from a gift or trade;
        // bounding the wait instead capped tolerated lag at a fixed 2s, and
        // past that it bypassed the guard and destroyed 25 shinies. The
        // sentinel has neither failure mode. It cannot latch, because the id
        // is already gone from the real box, so whichever render lands clears
        // it — and box GROWTH is irrelevant, since a new arrival has a
        // different id. It also has no lag ceiling at all.
        if (trimSentinel.current != null) {
          if (s.box.some((m) => m.id === trimSentinel.current)) return;
          trimSentinel.current = null;
        }
        const batch = worstBoxReleases(s, BOX_TRIM_BATCH);
        if (batch.length === 0) {
          // Nothing qualifies. The freeze holds and the save stays intact —
          // which is the point — and the toast above has already paged a
          // human. Back off hard rather than rescanning 10k entries at 4 Hz.
          trimStalled.current = true;
          trimNextAt.current = now + BOX_TRIM_RETRY_MS;
        } else {
          trimStalled.current = false;
          trimNextAt.current = now + BOX_TRIM_GAP_MS;
          // Any one released id works as proof-of-render for the whole burst.
          // Never fall back to null: null means "no burst in flight", so a
          // mon without an id would silently disable the render check and
          // let the next burst compute indices against a stale box — the
          // shiny-destroying failure, through a different door. The
          // validator accepts id-less mons, so nothing upstream forbids it.
          // A synthetic marker is never found in the box, which fails SAFE:
          // it just costs one extra poll before the next burst.
          trimSentinel.current = s.box[batch[0]]?.id ?? "__pending__";
          lastReleaseAt.current = now;
          for (const index of batch) {
            dispatch({ type: "RELEASE_POKEMON", payload: { source: "box", index } });
          }
        }
      }

      // D. Session policy. Sub-cadenced (see POLICY_ASSERT_MS) so the
      //    ASSERT_MAX_TRIES budget still spans ~6 s. Every predicate is
      //    falsified by its own action, so in a healthy session this whole
      //    block costs a handful of dispatches once and is then invisible.
      if (now - lastPolicyAt.current >= POLICY_ASSERT_MS) {
        lastPolicyAt.current = now;

        //  Manual battle mode is a freeze, not a preference.
        ensure("battleMode", s.battleMode !== "auto", () =>
          dispatch({ type: "SET_BATTLE_MODE", payload: { mode: "auto" } }));

        //  Catch mode and ball policy are ONE dispatch, and they have to be:
        //  a per-species override is a full snapshot, so two separate
        //  `{ ...s.globalCatchDefaults, x }` spreads built from the same
        //  render would each clobber the other's field.
        //
        //  "pokedex_new" fixes the ball drain, the box growth and the
        //  spectacle at once: every catch on camera becomes a NEW DEX ENTRY.
        //  It also self-solves raids — an uncaught legendary is "new", a
        //  caught one isn't. NO `routeKey`: passing one silently rewrites
        //  every per-species override on that route.
        //
        //  `enabledBalls: ["pokeball"]` leaves any Great/Ultra Balls the
        //  account owns as dead stock — pickAutoBall filters them out
        //  entirely. Enabling them is strictly better, not wasteful: it walks
        //  the list cheapest-first and takes the first ball that GUARANTEES
        //  the catch, so Rattatas still get Poké Balls and only the Dratini
        //  reaches for an Ultra Ball.
        const defaults = s.globalCatchDefaults;
        const wantBalls = policyEnabledBalls(s);
        const needMode = defaults.mode !== "pokedex_new";
        const needBalls = wantBalls.length > 0 && !sameBallSet(defaults.enabledBalls ?? [], wantBalls);
        //  In the danger band the mode assert stops being a preference with a
        //  try budget — it is the second line of defence behind the freeze —
        //  so the budget is refunded while the box is over the hard stop.
        //  This cannot spin: `needMode || needBalls` is still false once the
        //  settings hold, and then nothing is dispatched at all.
        if (boxLen >= BOX_HARD_STOP) assertTries.current.catchDefaults = 0;
        ensure("catchDefaults", needMode || needBalls, () =>
          dispatch({
            type: "SET_GLOBAL_CATCH_DEFAULTS",
            payload: {
              settings: {
                ...defaults,
                mode: "pokedex_new",
                enabledBalls: needBalls ? wantBalls : defaults.enabledBalls,
              },
            },
          }));

        //  The "pokedex_new" policy leans on the shiny override for
        //  spectacle: it is the one rule that ignores mode, `enabled` and the
        //  ball list. Which is exactly why it must NOT be switched on while
        //  the box is frozen — that would be the director re-opening the one
        //  door the freeze exists to shut. `catchFrozen` is latched above in
        //  the same pass, so this can never run ahead of it.
        ensure("shinies", !s.alwaysCatchShinies && !catchFrozen.current, () =>
          dispatch({ type: "SET_ALWAYS_CATCH_SHINIES", payload: { value: true } }));

        //  A reload that lands on speed 1 halves the show. Discretionary, so
        //  it yields to the operator.
        const wantSpeed = Math.max(1, Math.min(5, Math.floor(getStreamConfig()?.speed ?? 5)));
        ensure("speed", s.speed !== wantSpeed && operatorHoldMsLeft(OPERATOR_HOLD_MS) === 0, () => {
          executeStreamCommand({ kind: "speed", value: wantSpeed }, s, dispatch, "director");
        });
      }

      // ═══ IDLE GATE (fast lane) ═══════════════════════════════════════════
      if (s.paused || blocked(s)) return;
      if (s.party.length === 0) return;

      // Heal first — same predicate and same position as ladder rung 1, just
      // polled fast enough to actually catch the gap. NOT in a raid: waves
      // never pass through idle (spawnNextRaidWave keeps the phase at
      // "battle", reducer.ts:339) so this cannot fire there anyway, and if it
      // ever could, HEAL_PARTY would end the raid and stamp a cooldown —
      // rung 0.2 owns that exit.
      if (!s.inRaid && needsHeal(s) && now - lastHealAt.current > HEAL_MIN_GAP_MS) {
        lastHealAt.current = now;
        dispatch({ type: "HEAL_PARTY" });
        return;
      }

      const go = intent.current;
      if (!go) return;
      if (healthyCount(s) === 0) return;
      if (s.currentLocation !== go.locationId) return;

      intent.current = null;
      switch (go.kind) {
        case "gym":
          executeStreamCommand({ kind: "gym", gymId: go.gymId }, s, dispatch, "director");
          break;
        case "league":
          executeStreamCommand({ kind: "eliteFour" }, s, dispatch, "director");
          break;
        case "rematch":
          executeStreamCommand({ kind: "rematch", bossId: go.gymId }, s, dispatch, "director");
          break;
        case "leagueRematch":
          executeStreamCommand({ kind: "leagueRematch", regionId: go.regionId }, s, dispatch, "director");
          break;
      }
    }, INTENT_POLL_MS);
    return () => clearInterval(id);
  }, [streamMode, dispatch]);

  // ── The ladder ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!streamMode) return;
    const id = setInterval(() => {
      const s = stateRef.current;
      const mem = memory.current;
      const now = Date.now();

      // ═══ TIER 0 — PRE-GUARDS (before the idle gate, on purpose) ═══════════

      // 0.1 Unpause. `useBattleLoop` returns without rescheduling while paused
      //     and NOTHING in the app ever unpauses itself; the only dispatcher is
      //     the manual Heal button, which stream mode does not hide. One
      //     stray click on a leaked stream URL is otherwise a dead broadcast
      //     until the next deploy. There is no admin `pause` command in the
      //     StreamCommand union, so this can never fight the operator.
      if (s.paused) {
        pausedTicks.current += 1;
        if (pausedTicks.current >= PAUSE_TICKS) {
          pausedTicks.current = 0;
          dispatch({ type: "TOGGLE_PAUSE" });
        }
        return;
      }
      pausedTicks.current = 0;

      // 0.2 Time-box the raid. Waves respawn on a KO *and* on a catch at +5
      //     levels with no terminal condition, so a strong party that walks in
      //     never walks out. HEAL_PARTY is the only correct exit: TRAVEL clears
      //     `inRaid` but sets no cooldown (infinite raid chaining, on camera)
      //     and END_RAID leaves `pendingEvents` behind.
      //
      //     `raidEnteredAt` is DELIBERATELY not cleared here, and that is the
      //     whole fix. Clearing it first destroyed the exit's own re-entry
      //     gap: HEAL_PARTY clears `inRaid`, so the render body's raid-exit
      //     block — which is keyed on `raidEnteredAt.current !== 0` — was
      //     skipped, and `lastRaidAt` therefore kept the raid's START time.
      //     That timestamp is exactly RAID_MAX_MS old at the moment of exit,
      //     so rung 15's gap check passed instantly; HEAL_PARTY only cools the
      //     tier just run and there are six tiers, so another was always
      //     eligible. The account left one raid and entered the next within a
      //     tick, forever, and inside a raid `blocked()` is always true — so
      //     gyms, the league, the frontier, the box trim and the grind never
      //     ran at all. The render body owns BOTH refs; this rung only asks
      //     for the exit.
      //
      //     `lastRaidAt` is stamped here as well, purely as belt and braces:
      //     if HEAL_PARTY ever stopped clearing `inRaid`, the gap would still
      //     be measured from the attempt rather than from the entry.
      if (
        s.inRaid &&
        raidEnteredAt.current > 0 &&
        now - raidEnteredAt.current > RAID_MAX_MS &&
        s.pendingEvents.length === 0 &&
        !s.catchAnim &&
        !s.awaitingSwitch &&
        !s.evolutionState
      ) {
        lastRaidAt.current = now;
        dispatch({ type: "HEAL_PARTY" });
        return;
      }

      // 0.3 Phase watchdog. A stuck phase makes the entire rest of the ladder
      //     unreachable, and the ways to get stuck are real: START_BOSS_BATTLE
      //     doesn't start the fight, it parks the boss and sets phase
      //     "healing", which only HealOverlay can advance — and HealOverlay
      //     builds its safety timer inside a `loadedmetadata` handler that a
      //     headless Chromium can plausibly never fire. That is a permanent
      //     freeze on the first gym attempt. This only ever fires on a
      //     fingerprint that has not moved by one byte for STALL_TICKS, so any
      //     real progress — one HP point, one log line — stands it down.
      if (blocked(s)) {
        const print = fingerprint(s);
        if (print === stallPrint.current) stallTicks.current += 1;
        else { stallPrint.current = print; stallTicks.current = 1; }

        if (stallTicks.current >= STALL_TICKS) {
          stallTicks.current = 0;
          stallPrint.current = "";
          if (s.phase === "starterSelect") {
            // Not ours to answer. Picking a starter for someone is destructive
            // and this phase is unreachable on a real stream account anyway —
            // if we ever see it, a human is the right escalation.
            return;
          }
          if (s.phase === "regionStarterSelect") {
            // RegionStarterSelect auto-picks for stream sessions after 2.5 s,
            // so 30 s of nothing means that effect never ran. Make the same
            // choice it would have made rather than forcing the phase to idle
            // and skipping the region's starter entirely.
            const rid = regionForLocation(s.currentLocation);
            const r = rid ? regions[rid] : undefined;
            const sp = r?.starters[0];
            if (r && sp) dispatch({ type: "SELECT_REGION_STARTER", payload: { region: r.id, speciesKey: sp } });
            return;
          }
          if (s.phase === "healing") {
            dispatch({ type: "COMPLETE_HEALING" });
          } else if (s.catchAnim) {
            dispatch({ type: "CATCH_RESOLVE" });
          } else if (s.awaitingSwitch && healthyCount(s) > 0) {
            const lead = bestLeadIndex(s);
            if (lead >= 0) dispatch({ type: "SWITCH_PLAYER_POKEMON", payload: { partyIndex: lead } });
            else dispatch({ type: "HEAL_PARTY" });
          } else if (s.pendingEvents.length > 0) {
            dispatch({ type: "CONSUME_EVENT" });
          } else if (s.phase === "evolution") {
            dispatch({ type: "COMPLETE_EVOLUTION" });
          } else {
            // Universal bail — HEAL_PARTY clears every battle field and forces
            // phase back to "idle".
            dispatch({ type: "HEAL_PARTY" });
          }
          return;
        }
      } else {
        stallTicks.current = 0;
        stallPrint.current = "";
      }

      // 0.4 Party rescue. This has to precede the old `party.length === 0`
      //     bail, which was an unconditional permanent freeze. GameContext
      //     explicitly manufactures a `playerPokemon` that need not be in the
      //     party; once that mon faints, handleFaint sets it to `party[0] ??
      //     null` = null and every branch of useBattleLoop stops matching.
      //     Nothing on camera, forever, with no in-game way out.
      if (s.party.length === 0) {
        const box = bestBoxIndex(s);
        if (box >= 0) {
          dispatch({ type: "BOX_TO_PARTY", payload: { boxIndex: box } });
          return;
        }
        // Party AND box empty: there is no in-game recovery. Say so once and
        // page a human rather than looping silently.
        if (!strandedNoted.current) {
          strandedNoted.current = true;
          dispatch({ type: "ADD_LOG", payload: { text: "Stream director: no Pokémon in the party or the PC — operator intervention required." } });
          pushToast({ kind: "warn", icon: "🚨", text: "Stream account has no Pokémon at all — needs an operator." });
        }
        return;
      }
      strandedNoted.current = false;
      if (!s.playerPokemon) {
        const lead = bestLeadIndex(s);
        if (lead >= 0) {
          dispatch({ type: "SWITCH_PLAYER_POKEMON", payload: { partyIndex: lead } });
          return;
        }
      }

      // ═══ IDLE GATE ═══════════════════════════════════════════════════════
      // Never interfere mid-battle, mid-animation, or while paused. `catchAnim`
      // and `evolutionState` are new here: talking over an animation is how
      // the director used to drop a ball that was still in the air.
      if (blocked(s)) return;

      // ═══ TIER 1 — SAFETY ═════════════════════════════════════════════════

      // 1. Patch up. A half-fainted party loses gyms and stalls the grind, and
      //    it is what makes a raid loss free: the wipe path leaves the party
      //    fainted with no money penalty and this heals it on the next tick.
      //    The fast lane above normally gets here first; this is the backstop
      //    for the case where the fast lane's own gap has not elapsed.
      if (needsHeal(s) && now - lastHealAt.current > HEAL_MIN_GAP_MS) {
        lastHealAt.current = now;
        dispatch({ type: "HEAL_PARTY" });
        return;
      }

      // Everything below is discretionary, so it yields to the operator.
      if (operatorHoldMsLeft(OPERATOR_HOLD_MS) > 0) return;

      // Redeem the previous tick's receipt. BUY_ITEM, BUY_REWARD_ITEM and
      // USE_BOTTLE_CAP all fail SILENTLY — a null price, "not enough money",
      // an already-perfect stat: a log line, and the state comes back
      // unchanged. Without this check a single such failure is an infinite
      // loop, on camera, forever. An item that didn't move goes on the
      // do-not-touch list until the TTL expires.
      if (pendingItem.current) {
        const p = pendingItem.current;
        pendingItem.current = null;
        if (now - p.at <= RECEIPT_TTL_MS) {
          const owned = s.inventory[p.itemId] ?? 0;
          const landed = p.itemId === "expShare"
            ? (s.activeEffects.find((e) => e.itemId === "expShare")?.battlesRemaining ?? 0) > p.charge
            : p.want === "gain" ? owned > p.owned : owned < p.owned;
          if (!landed) {
            markStamp(mem.unbuyable, p.itemId, UNBUYABLE_TTL_MS);
            flush();
          }
        }
      }

      // ═══ TIER 2 — SAVE INTEGRITY ═════════════════════════════════════════

      // 2/3. Session policy and the box emergency stop USED to live here, and
      //      that was the bug. Both are pure field writes that never needed an
      //      idle game, but sitting under the idle gate they were sampled at
      //      an 8% duty cycle: ~75 s per action, against a first wild catch
      //      that lands 2–3 s after page load and a box already sitting on the
      //      server's cap. The guard lost by two to three orders of magnitude,
      //      and the shiny override — the one flag that bypasses catch mode —
      //      was asserted two effective ticks BEFORE the freeze landed. They
      //      now run on the fast lane above, which reaches them in ≤250 ms.
      //
      //      What is left here is the ladder's half of the contract: STAND
      //      DOWN while the burst is running. Everything below addresses the
      //      box by INDEX (rung 9's SWAP_PARTY_BOX, rung 16's
      //      RELEASE_POKEMON) and a trim in flight makes those indices point
      //      at different Pokémon.
      //
      //      Self-falsifying twice over: each burst strictly shortens the box,
      //      so `box.length >= BOX_CRITICAL` goes false within
      //      ceil(overshoot / BOX_TRIM_BATCH) bursts (~3 s from 9,999); and if
      //      nothing at all is releasable the fast lane sets `trimStalled`,
      //      which drops this guard entirely so progression is never held
      //      hostage to a trim that can never finish.
      if (s.box.length >= BOX_CRITICAL && !trimStalled.current) return;

      // 4. Ball supply, above all progression. Running dry stalls the dex, and
      //    therefore team quality and raid value, forever — and it does it
      //    silently. BUY_ITEM has no location or mart guard and the mart is the
      //    union of every unlocked town, so the bot never travels to shop; the
      //    shop-membership and battle-count checks live in streamShop purely so
      //    the stream is only ever seen doing what a player could do.
      if (usableBallCount(s) < BALL_LOW) {
        const buy = pickBallRestock(s, mem, { target: BALL_TARGET, moneyFloor: MONEY_FLOOR });
        // No affordable ball → don't fire at all, and fall through to the
        // rungs that actually EARN money.
        if (buy) {
          pendingItem.current = { itemId: buy.itemId, want: "gain", owned: s.inventory[buy.itemId] ?? 0, charge: 0, at: now };
          dispatch({ type: "BUY_ITEM", payload: { itemId: buy.itemId, quantity: buy.quantity } });
          return;
        }
      }

      // ═══ TIER 3 — TEAM ═══════════════════════════════════════════════════

      // 5. Spend Victory Tokens. Tokens are the ONLY sane way this account
      //    will ever own an evolution stone: the mart wants $100,000 for one
      //    and the reward shop wants 1–2 tokens, which the League hands out
      //    for free. Left alone they simply accumulate, which is why a stone
      //    evolution has never once happened here. Priced from the catalog,
      //    because BUY_REWARD_ITEM trusts whatever `cost` it is handed.
      const stoneNeed = (() => {
        for (const mon of s.party) {
          const evo = (evolutions[mon.speciesKey] ?? []).find((e) => {
            const a = e as { item?: string; trade?: boolean };
            return !!a.item && !a.trade && (s.inventory[a.item] ?? 0) === 0;
          }) as { item?: string } | undefined;
          if (!evo?.item) continue;
          if (stampActive(mem.unbuyable, evo.item)) continue;
          const cost = rewardShopCatalog.find((e) => e.itemId === evo.item)?.tokenCost;
          if (cost != null && s.victoryTokens >= cost) return { itemId: evo.item, cost };
        }
        return null;
      })();
      if (stoneNeed) {
        pendingItem.current = { itemId: stoneNeed.itemId, want: "gain", owned: s.inventory[stoneNeed.itemId] ?? 0, charge: 0, at: now };
        dispatch({ type: "BUY_REWARD_ITEM", payload: { itemId: stoneNeed.itemId, cost: stoneNeed.cost } });
        return;
      }

      // 6. Evolve anything it can with an item. Stone / Link Cable evolutions
      //    need the item used from the Bag, so the bot would sit on a Moon
      //    Stone next to an eligible Nidorina forever.
      for (let i = 0; i < s.party.length; i++) {
        const mon = s.party[i];
        const trigger = (evolutions[mon.speciesKey] ?? []).find((e) => {
          const anyE = e as { item?: string; trade?: boolean; into?: string };
          if (!anyE.item || !anyE.into) return false;
          // Only what the bot can actually action from the Bag.
          if (anyE.trade) {
            return (s.inventory.linkcable ?? 0) > 0 && mon.heldItem === anyE.item;
          }
          return (s.inventory[anyE.item] ?? 0) > 0;
        }) as { item?: string; trade?: boolean } | undefined;
        if (!trigger) continue;
        if (trigger.trade) {
          dispatch({ type: "USE_LINK_CABLE", payload: { partyIndex: i } });
        } else {
          dispatch({ type: "USE_STONE", payload: { itemId: trigger.item!, partyIndex: i } });
        }
        return;
      }

      // 7. Evolve by level. This is not a nicety: `useEvolutionTrigger` is
      //    imported by nothing, App mounts six other hooks and not that one,
      //    and the only other START_EVOLUTION dispatchers are click handlers.
      //    So level-up evolutions have NEVER fired on this account — the old
      //    comment here claiming the reducer handled them was simply wrong.
      //    The visible cost is a level-93 Pidgey and a level-100 Bulbasaur on
      //    camera, and scoreMon's isFullyEvolved bonus permanently withheld
      //    from the whole team. Placed above team selection for that reason:
      //    bestTeamSwap scores on species, and would otherwise decide on
      //    stale ones.
      // This is a SECOND automatic level-evolution path, alongside
      // hooks/useAutoEvolve. It has to honour the same two controls or the
      // Settings toggle and the per-Pokemon lock silently do nothing on the
      // stream account — the operator would set them and watch the bot
      // ignore both. levelEvolutionFor also picks the branch this individual
      // qualifies for (Tyrogue), which the old first-match scan got wrong.
      if (s.autoEvolve !== false) {
        for (let i = 0; i < s.party.length; i++) {
          const mon = s.party[i];
          if (evolutionLocked(mon)) continue;
          const evo = levelEvolutionFor(mon);
          if (!evo?.into) continue;
          dispatch({
            type: "START_EVOLUTION",
            payload: { partyIndex: i, pokemonId: mon.id, toSpeciesKey: evo.into },
          });
          return;
        }
      }

      // 8. Exp Share. It is a buff, not an item: BUY_ITEM special-cases
      //    "expShare" and stacks the active effect directly without ever
      //    touching the inventory, while USE_EXP_SHARE requires an inventory
      //    count that the purchase path never creates. Buying IS the
      //    activation. Only worth it with a bench to feed.
      const expShareEffect = s.activeEffects.find((e) => e.itemId === "expShare");
      const expShareCharge = expShareEffect?.battlesRemaining ?? 0;
      if (s.party.length >= 4 && !stampActive(mem.unbuyable, "expShare")) {
        // A PAUSED Exp Share is charged but contributes nothing and doesn't
        // tick down — and "is it live" would stay false forever while we bought
        // another one every tick. That is an unbounded money drain, so it gets
        // its own branch ahead of every purchase path.
        if (expShareEffect?.paused && expShareCharge > 0) {
          dispatch({ type: "TOGGLE_EFFECT_PAUSED", payload: { itemId: "expShare" } });
          return;
        }
        if (expShareCharge <= 0) {
          // Free first: an Exp Share that somehow reached the inventory (admin
          // grant, daily reward) is the one case USE_EXP_SHARE is for.
          if ((s.inventory.expShare ?? 0) > 0) {
            pendingItem.current = { itemId: "expShare", want: "spend", owned: s.inventory.expShare ?? 0, charge: expShareCharge, at: now };
            dispatch({ type: "USE_EXP_SHARE" });
            return;
          }
          // Then tokens — 2 of them versus $20,000 — keeping a stone's worth
          // in reserve. Then, only then, cash.
          const tokenCost = rewardShopCatalog.find((e) => e.itemId === "expShare")?.tokenCost;
          if (tokenCost != null && s.victoryTokens >= tokenCost + TOKEN_RESERVE) {
            pendingItem.current = { itemId: "expShare", want: "gain", owned: 0, charge: expShareCharge, at: now };
            dispatch({ type: "BUY_REWARD_ITEM", payload: { itemId: "expShare", cost: tokenCost } });
            return;
          }
          const expSharePrice = itemsCatalog.expShare?.buyPrice ?? null;
          if (expSharePrice != null && shopEntry(s, "expShare") && s.money >= expSharePrice + MONEY_FLOOR) {
            pendingItem.current = { itemId: "expShare", want: "gain", owned: 0, charge: expShareCharge, at: now };
            dispatch({ type: "BUY_ITEM", payload: { itemId: "expShare", quantity: 1 } });
            return;
          }
        }
      }

      // 9. Field the best six it owns. Without this the party fills with
      //    whatever it caught first while a rare, far stronger mon sits
      //    forgotten in the PC — weaker AND worse to watch. It is also what
      //    puts a fresh shiny (+260) or a caught legendary (+220) on screen
      //    within one tick of the catch.
      const swap = bestTeamSwap(s);
      if (swap) {
        dispatch({ type: "SWAP_PARTY_BOX", payload: { partyIndex: swap.partyIndex, boxIndex: swap.boxIndex } });
        return;
      }

      // 10. Train the whole team, not one carry: move the strongest mon that's
      //     lagging the party's top level into SLOT 0 so EXP spreads evenly.
      //
      //     It has to be a reorder, not SWITCH_PLAYER_POKEMON.
      //     `activePlayerPokemonIndex` is not the director's to own — the
      //     reducer re-derives it to `firstHealthyIndex(party)` at the start
      //     of every fight and on every party edit: START_ENCOUNTER
      //     (reducer.ts:490,497), START_TRAINER_BATTLE (:1778,1787),
      //     COMPLETE_HEALING (:1906,1928), spawnNextRaidWave (:333,345), and
      //     `rederiveActive` (:110) via TRAVEL / SWAP_PARTY / SWAP_PARTY_BOX /
      //     BOX_TO_PARTY / PARTY_TO_BOX. A SWITCH was therefore reverted
      //     within ~200 ms, the predicate was true again on the very next
      //     tick, and this rung `return`ed forever — starving bottle caps,
      //     gyms, the Elite Four, the frontier hold, raids, box trim, the
      //     grind rotation and stuck detection. That is why the production
      //     account has zero badges after thousands of battles, and it also
      //     defeated the rung's own purpose: the switch never survived to the
      //     first turn, so EXP concentrated on slot 0 instead of spreading.
      //     REORDER_PARTY survives precisely because firstHealthyIndex reads
      //     SLOT ORDER — the same action the party UI uses for "make lead"
      //     (PartyColumn.tsx:260).
      //
      //     Self-limiting: rung 1 guarantees a fully healthy party here, and
      //     bestLeadIndex breaks ties toward the LOWEST index, so once the
      //     winner is in slot 0 it keeps winning and `lead > 0` is false until
      //     the team's levels actually change. The cooldown is belt and
      //     braces: even if a future reducer change undid the order, this
      //     rung could then cost one tick per LEAD_ROTATE_MIN_MS instead of
      //     every tick.
      if (now - lastLeadMoveAt.current > LEAD_ROTATE_MIN_MS) {
        const lead = bestLeadIndex(s);
        if (lead > 0) {
          lastLeadMoveAt.current = now;
          dispatch({ type: "REORDER_PARTY", payload: { from: lead, to: 0 } });
          return;
        }
      }

      // 11. Spend Bottle Caps. Raids are their only source (a 15% / 3% roll on
      //     a CATCH, nowhere else), they do nothing sitting in the bag, and a
      //     perfect-IV carry is the difference between clearing a gym and
      //     losing to it twice. Self-clearing: the cap is consumed and the
      //     imperfect-IV guard stops it firing on an already-perfect mon.
      const bestPartyIdx = s.party.reduce(
        (bi, p, i) => (scoreMon(p) > scoreMon(s.party[bi]) ? i : bi),
        0,
      );
      const capTarget = s.party[bestPartyIdx];
      if (capTarget) {
        const imperfect = IV_KEYS.filter((k) => (capTarget.ivs?.[k] ?? 0) < 31);
        if (imperfect.length > 0 && (s.inventory.goldbottlecap ?? 0) > 0 && !stampActive(mem.unbuyable, "goldbottlecap")) {
          pendingItem.current = { itemId: "goldbottlecap", want: "spend", owned: s.inventory.goldbottlecap ?? 0, charge: 0, at: now };
          dispatch({ type: "USE_BOTTLE_CAP", payload: { itemId: "goldbottlecap", source: "party", index: bestPartyIdx } });
          return;
        }
        if (imperfect.length > 0 && (s.inventory.silverbottlecap ?? 0) > 0 && !stampActive(mem.unbuyable, "silverbottlecap")) {
          const worstStat = imperfect.reduce((a, b) =>
            (capTarget.ivs?.[b] ?? 0) < (capTarget.ivs?.[a] ?? 0) ? b : a,
          );
          pendingItem.current = { itemId: "silverbottlecap", want: "spend", owned: s.inventory.silverbottlecap ?? 0, charge: 0, at: now };
          dispatch({
            type: "USE_BOTTLE_CAP",
            payload: { itemId: "silverbottlecap", source: "party", index: bestPartyIdx, stat: worstStat },
          });
          return;
        }
      }

      // ═══ TIER 4 — PROGRESSION ════════════════════════════════════════════

      const region = regions[regionForLocation(s.currentLocation) ?? DEFAULT_REGION] ?? regions[DEFAULT_REGION];
      const best = topLevel(s);

      // 12. Beat the next gym once the party can plausibly win — and if this
      //     gym has already beaten us, demand a wider margin each time.
      //     Travel and challenge are separate steps now: the challenge is only
      //     legal once we've landed, and a 6 s tick loses the race for an idle
      //     gap in a town full of trainers, so the arrival is handed to the
      //     fast intent poll.
      //     `team.length > 0` is not paranoia: START_BOSS_BATTLE returns the
      //     state UNCHANGED when `trainerTeam[0]` is missing (reducer.ts:1811),
      //     so an empty roster would make this rung dispatch a no-op and
      //     `return` on every tick, forever — the same failure mode as rung 10.
      //     Pick the first undefeated gym we can actually REACH, not simply the
      //     first one on the roster. Roster order and unlock order are not the
      //     same chain: Johto's roster head is Chuck at cianwoodCity, whose
      //     unlock needs 5 badges, but only ever having beaten roster-order
      //     gyms guarantees 4 — while Jasmine at olivineCity sits unlocked and
      //     ignored. Targeting the roster head alone therefore dead-ends the
      //     account permanently at 12 of 16 badges: rung 13 needs all 8 Johto
      //     badges, the frontier hold returns null once the remaining routes
      //     are badge-gated rather than battle-gated, and nothing else can
      //     raise a badge. The fallback keeps the old behaviour when nothing
      //     is reachable, so the level/margin checks below still gate it.
      const nextGym =
        region.gymLeaders.find(
          (g) => !s.defeatedGyms.includes(g.id) && s.unlockedLocations.includes(g.locationKey),
        ) ?? region.gymLeaders.find((g) => !s.defeatedGyms.includes(g.id));
      if (nextGym && nextGym.team.length > 0 && s.unlockedLocations.includes(nextGym.locationKey)) {
        const need = aceLevel(nextGym.team)
          + GYM_LEVEL_MARGIN
          + strikeCount(mem.bossLosses, nextGym.id, DANGER_TTL_MS) * LOSS_MARGIN_STEP;
        if (best >= need) {
          if (s.currentLocation !== nextGym.locationKey) {
            intent.current = { kind: "gym", gymId: nextGym.id, locationId: nextGym.locationKey, until: now + INTENT_TTL_MS };
            executeStreamCommand({ kind: "travel", locationId: nextGym.locationKey }, s, dispatch, "director");
          } else {
            executeStreamCommand({ kind: "gym", gymId: nextGym.id }, s, dispatch, "director");
          }
          return;
        }
      }

      // 13. All badges in hand → run the league gauntlet once strong enough.
      //     We now travel to the League town first. executeStreamCommand's
      //     eliteFour branch fights from wherever it stands, which meant the
      //     Indigo Plateau battle counter never moved and Cerulean Cave — the
      //     best grinding route in Kanto — never unlocked.
      if (regionBadgeCount(s, region) >= region.gymLeaders.length) {
        const champ = region.champion;
        // Same no-op hazard as rung 12, and it has to be tested on the HEAD of
        // the gauntlet specifically: executeStreamCommand queues every
        // undefeated member in order and START_BOSS_BATTLE returns the state
        // unchanged when the head's `trainerTeam[0]` is missing
        // (reducer.ts:1811), which here would be an every-tick `return` that
        // starves everything below.
        const head =
          region.eliteFour.find((m) => !s.defeatedEliteFour.includes(m.id)) ??
          (champ && !s.defeatedChampions.includes(champ.id) ? champ : undefined);
        if (head && head.team.length > 0) {
          const bar = Math.max(
            ...region.eliteFour.map((m) => aceLevel(m.team)),
            champ ? aceLevel(champ.team) : 0,
          );
          const lost = Math.max(
            ...region.eliteFour.map((m) => strikeCount(mem.bossLosses, m.id, DANGER_TTL_MS)),
            champ ? strikeCount(mem.bossLosses, champ.id, DANGER_TTL_MS) : 0,
          );
          if (best >= bar + E4_LEVEL_MARGIN + lost * LOSS_MARGIN_STEP) {
            const hall = region.eliteFour[0]?.locationKey ?? champ?.locationKey;
            if (hall && s.unlockedLocations.includes(hall) && s.currentLocation !== hall) {
              intent.current = { kind: "league", locationId: hall, until: now + INTENT_TTL_MS };
              executeStreamCommand({ kind: "travel", locationId: hall }, s, dispatch, "director");
            } else {
              executeStreamCommand({ kind: "eliteFour" }, s, dispatch, "director");
            }
            return;
          }
        }
      }

      // 14. Stand on the progression gate. Every route unlock in both regions
      //     is bought with `battlesAtLocation` counters, and most of those sit
      //     on TOWNS — which have no wild encounters, so the grind rule's
      //     "routes with encounters" filter can never target one. That single
      //     omission is why this account could not finish Kanto, let alone
      //     reach Johto: New Bark Town has no gym and no grass, so nothing had
      //     any reason to send the bot there, and any tick it spent there the
      //     grind rule dragged it straight back to Victory Road. So the hold
      //     is STICKY — once chosen it also suppresses the grind rung below.
      const hold = frontierTarget(s, (id) => stampActive(mem.frontierSkip, id));
      let holding = false;
      if (hold) {
        const dangerous = strikeCount(mem.routeDanger, hold.locationId, DANGER_TTL_MS) >= DANGER_LIMIT;
        const tooHot = routeTop(hold.locationId) > best + 3;
        if (!dangerous && !tooHot) {
          holding = true;
          // Retire a counter that isn't moving rather than standing on it for
          // the rest of the broadcast.
          const w = holdWatch.current;
          if (!w || w.locationId !== hold.locationId) {
            holdWatch.current = { locationId: hold.locationId, have: hold.have, since: now };
          } else if (hold.have > w.have) {
            holdWatch.current = { locationId: hold.locationId, have: hold.have, since: now };
          } else if (s.currentLocation === hold.locationId && now - w.since > FRONTIER_STALL_MS) {
            markStamp(mem.frontierSkip, hold.locationId, FRONTIER_SKIP_TTL_MS);
            holdWatch.current = null;
            flush();
            holding = false;
          }
          if (holding && s.currentLocation !== hold.locationId) {
            executeStreamCommand({ kind: "travel", locationId: hold.locationId }, s, dispatch, "director");
            return;
          }
        }
      }

      // ═══ TIER 5 — CONTENT ════════════════════════════════════════════════

      // 15. Raid. The best EXP in the game (a wave is ~2x a Cerulean Cave mon
      //     and every wave is +5 levels), the only source of Bottle Caps, the
      //     only source of a dozen dex entries — and by a distance the most
      //     watchable thing the account can do. Cheap to lose: the wipe path
      //     charges no money and stamps a 5-minute cooldown, and rung 1 heals
      //     on the next tick. Rung 0.2 owns the exit.
      //
      //     Now that a raid wipe is attributed to the island instead of to
      //     whatever route we were dragged home to, that strike is worth
      //     reading: DANGER_LIMIT losses inside DANGER_TTL_MS means the party
      //     genuinely cannot hold a wave yet, so stop feeding it until the
      //     strike ages out. Self-clearing for the same reason every other
      //     routeDanger entry is.
      const raidDanger = strikeCount(mem.routeDanger, raidLocation.current, DANGER_TTL_MS);
      if (raidDanger < DANGER_LIMIT && !s.inRaid && now - lastRaidAt.current > RAID_MIN_GAP_MS && !needsHeal(s)) {
        const tier = pickRaidTier(s, best);
        if (tier) {
          lastRaidAt.current = now;
          executeStreamCommand({ kind: "raid", tier }, s, dispatch, "director");
          return;
        }
      }

      // ═══ TIER 6 — HOUSEKEEPING ═══════════════════════════════════════════

      // 16. Drip-release genuine duplicates. Deliberately the lowest real rung
      //     and rate-limited, because this is the NON-urgent half of the job:
      //     everything from BOX_CRITICAL up is the fast lane's burst, and
      //     below that line the box is merely large. A bot that disappeared
      //     into releasing thousands of Rattatas would be worse television
      //     than the problem it solves, so the drip is capped at one a minute
      //     — which still outpaces the post-"pokedex_new" inflow by orders of
      //     magnitude. `worstBoxRelease` refuses shinies, anything
      //     unobtainable in the wild, the last copy of any species, and
      //     anything whose level/rarity puts it over the score cap.
      //
      //     Self-falsifying: each fire removes one entry and stamps
      //     `lastReleaseAt`, so it cannot fire again for RELEASE_MIN_GAP_MS
      //     and it stops entirely once `box.length < BOX_SOFT_CAP`. When
      //     nothing is releasable it returns null and the ladder simply
      //     carries on.
      if (s.box.length >= BOX_SOFT_CAP && now - lastReleaseAt.current > RELEASE_MIN_GAP_MS) {
        const idx = worstBoxRelease(s);
        if (idx != null) {
          lastReleaseAt.current = now;
          dispatch({ type: "RELEASE_POKEMON", payload: { source: "box", index: idx } });
          return;
        }
      }

      // ═══ TIER 7 — GRIND ══════════════════════════════════════════════════

      // 16b. EARN. Wild battles pay nothing — money enters the save only from
      //      endTrainerBattle and endBossBattle, and the battle loop only
      //      starts trainer fights when the current location is a town. But
      //      rung 17's candidate filter is "has wild encounters", which
      //      excludes every town by construction, and the frontier hold is the
      //      only other rung that ever parks us in one — and it returns null
      //      once nothing is battle-gated any more. So once the last gate
      //      closes, income is exactly $0/hour forever while the Exp Share
      //      re-buy and ball restocks keep spending, and the account slides
      //      into a terminal broke-and-ballless state that no rung can leave:
      //      catching stops, the dex freezes, and the stream is a level-100
      //      party punching wild Pokémon for nothing.
      //
      //      Standing in a town fixes it: town trainers re-fight with
      //      level-scaled rematch teams, so they are the game's only
      //      repeatable income. Deliberately placed ABOVE the grind rung
      //      (which would otherwise pull us straight back out to a route) and
      //      OUTSIDE the `holding` guard, because being broke matters more
      //      than the frontier hold and the hold is null in the end game.
      const broke = usableBallCount(s) < BALL_LOW
        && pickBallRestock(s, mem, { target: BALL_TARGET, moneyFloor: MONEY_FLOOR }) == null;
      if (broke) {
        const town = nearestTown(s);
        // Only travel if we are not already earning. Standing in a town with
        // trainers is the goal state, so this rung stops firing the moment it
        // succeeds rather than re-issuing TRAVEL to where we already are.
        if (town && town !== s.currentLocation) {
          executeStreamCommand({ kind: "travel", locationId: town }, s, dispatch, "director");
          return;
        }
        if (town) return; // already earning — hold here, don't fall through to grind
      }

      // 16c. ENDGAME REMATCH LOOP. Once a region is finished this ladder has
      //      nothing left below the raid but the wild-route rotation, and that
      //      is a dead broadcast: wild battles pay NOTHING (reducer.ts:2301 —
      //      money enters the save only via endTrainerBattle and
      //      endBossBattle, which is also why `wildMoneyReward` is dead code),
      //      the dex stops moving once the reachable species are caught, and a
      //      level-100 party punching Rattatas is what the account does for
      //      the other 29 minutes of every raid cycle. Refighting bosses fixes
      //      all three at once: endBossBattle pays its full prize on EVERY win
      //      (32 x the roster's ace — the money is computed before any
      //      first-time check), the champion hands over a Victory Token every
      //      single time, and a gym leader with a real roster and sprites is
      //      the most watchable thing the game owns.
      //
      //      POSITION IS LOAD-BEARING, in both directions:
      //       - BELOW the raid (15), the box trim's stand-down (Tier 2), the
      //         release drip (16) and the EARN rung (16b), so a rematch can
      //         never take a tick any of those wanted. It also sits under the
      //         `operatorHoldMsLeft` return at the top of the discretionary
      //         section, so the operator always outranks it. Inside a raid
      //         `blocked()` is true and this is unreachable anyway; `!inRaid`
      //         is belt and braces for the same reason rung 0.2 stamps twice.
      //       - ABOVE the grind (17), which is not a preference but a
      //         requirement: rung 17 `return`s on every path once it has a
      //         target — travelling, or standing where it wants to be — so
      //         anything below it is unreachable code. This rung has to
      //         out-rank the thing it was written to replace.
      //
      //      WHAT STOPS IT — the whole design problem, stated plainly. Every
      //      other rung here is falsified by its own dispatch: a heal fills
      //      the HP that selected it, a release shortens the box, a badge
      //      lands in `defeatedGyms` and rung 12 moves on. A rematch changes
      //      NOTHING the selector reads — `defeatedGyms` and
      //      `defeatedEliteFour` already contain these ids and endBossBattle
      //      re-adds neither — so "region is finished" is still true one
      //      millisecond after the win, and will be true for the rest of the
      //      broadcast. That is the shape that has produced six defects in
      //      this file, so the guard is explicit and layered:
      //
      //       1. THE COOLDOWN, and it alone is sufficient. `lastRematchAt` is
      //          stamped HERE, before dispatching, exactly as rung 15 stamps
      //          `lastRaidAt`. It is therefore stamped even if the command
      //          refuses, even if the dispatch no-ops, even if the fight is
      //          lost, and even if a future reducer stops changing state at
      //          all. The rung physically cannot fire twice inside
      //          REMATCH_GAP_MS — one tick in 40 — regardless of what the
      //          rest of the app does. That is the starvation proof for rung
      //          17 and the stuck detector below, and it depends on this ref
      //          and nothing else.
      //       2. THE CURSOR. `pickRematch` advances the lap on every fire, so
      //          even in the impossible case that the cooldown were bypassed
      //          the rung would walk the roster rather than hammer one
      //          leader, and would reach the League within one lap. It is
      //          also what makes the rotation watchable rather than correct.
      //       3. THE IDLE GATE, which does most of the work in practice but
      //          is deliberately NOT relied upon. START_BOSS_BATTLE sets
      //          `phase: "healing"` (reducer.ts:1932-1935), so `blocked()` is
      //          true on the very next tick and stays true through the
      //          cinematic, the fight, and all five fights of a gauntlet. The
      //          reason it is not trusted alone is concrete: the same action
      //          returns the state UNCHANGED when `trainerTeam[0]` is missing
      //          (reducer.ts:1920), and a no-op dispatch leaves the phase at
      //          idle — which is how rungs 10 and 12 came to fire forever. So
      //          `pickRematch` skips any roster entry with an empty team, and
      //          the command re-checks the BUILT team before dispatching.
      //
      //      And when nothing qualifies it does not fire at all: no dispatch,
      //      no cooldown stamp, no `return` — it falls through to the grind.
      //      The scan is bounded at one lap, so that costs nine comparisons.
      //
      //      It cannot pre-empt progression, either. `regionCleared` is false
      //      while ANY gym, Elite Four member or champion in the region is
      //      still undefeated, and rungs 12 and 13 sit far above this one, so
      //      a region with anything left to win still pushes forward. On the
      //      live account — Johto, seven gyms to go — this rung is dormant by
      //      construction and stays dormant until Clair and the League fall.
      if (
        !holding &&
        !s.inRaid &&
        now - lastRematchAt.current > REMATCH_GAP_MS &&
        // Global, not per-region: standing in a finished Kanto must not make
        // this rung agree with rungs 12/13 that there is nothing left while
        // Johto still has gyms. Rematching is the last resort.
        allRegionsCleared(s)
      ) {
        // Prefer the region we are standing in, but only re-choose it at a
        // LAP BOUNDARY. Re-deriving it every tick would hand the choice to
        // rung 17, which ranks routes across both regions at once — so a
        // grind pick in the other region between two rematches would strand
        // the rotation halfway through one roster and restart it in the
        // other, which is the ping-pong this pin exists to prevent. Pinning
        // also means a lap is a coherent piece of television: eight leaders
        // and a gauntlet from one region, in badge order.
        const lap = rematchLap.current;
        const pinned = lap ? regions[lap.regionId] : undefined;
        const repin = !lap || !pinned || lap.index === 0 || !regionCleared(s, pinned);
        const where = repin ? region : pinned!;
        const cursor = lap && lap.regionId === where.id ? lap.index : 0;

        const target = pickRematch(s, where, cursor, {
          best,
          // Reuses the ladder's existing level-margin idea and the bossLosses
          // strike map rather than inventing a parallel one: a leader who has
          // beaten us recently demands LOSS_MARGIN_STEP more headroom each
          // time, and is simply skipped while we cannot clear the bar. Losing
          // a rematch on camera is worse than not having one.
          gymMargin: GYM_LEVEL_MARGIN,
          leagueMargin: E4_LEVEL_MARGIN,
          lossStep: LOSS_MARGIN_STEP,
          losses: (id) => strikeCount(mem.bossLosses, id, DANGER_TTL_MS),
          now,
          leagueReadyAt: lastLeagueAt.current + REMATCH_LEAGUE_MIN_GAP_MS,
        });

        if (target) {
          const lapLength = where.gymLeaders.length + 1;
          rematchLap.current = { regionId: where.id, index: (target.slot + 1) % lapLength };
          // Guard 1. Before the dispatch, unconditionally — see above.
          lastRematchAt.current = now;
          if (target.kind === "league") lastLeagueAt.current = now;
          // Travel and challenge are separate steps for the same reason as
          // rung 12: the challenge is only legal once we have landed, and a
          // 6 s tick loses the race for an idle gap in a town full of
          // trainers, so the arrival is handed to the fast intent poll.
          if (s.currentLocation !== target.locationId) {
            intent.current = target.kind === "gym"
              ? { kind: "rematch", gymId: target.bossId, locationId: target.locationId, until: now + INTENT_TTL_MS }
              : { kind: "leagueRematch", regionId: where.id, locationId: target.locationId, until: now + INTENT_TTL_MS };
            executeStreamCommand({ kind: "travel", locationId: target.locationId }, s, dispatch, "director");
          } else if (target.kind === "gym") {
            executeStreamCommand({ kind: "rematch", bossId: target.bossId }, s, dispatch, "director");
          } else {
            executeStreamCommand({ kind: "leagueRematch", regionId: where.id }, s, dispatch, "director");
          }
          return;
        }
      }

      // 17. Otherwise grind somewhere useful. Normally that's near the top of
      //     what we can handle (fastest EXP), but every whiteout here pulls the
      //     ceiling DOWN, so a run of deaths makes the account retreat to
      //     easier ground and level up instead of feeding the same route.
      //     Suppressed entirely while holding a progression gate — that fight
      //     between the two rules is what stranded the account in Kanto.
      if (!holding) {
        // The danger penalty belongs to the CANDIDATE, not to wherever we
        // happen to be standing. Deriving one shared ceiling from
        // `s.currentLocation` made the candidate SET depend on our own
        // position, so A and B could each rank the other first and the
        // account flipped between them every 6 s — location banner,
        // background and all — for as long as the strike lived. Arriving
        // somewhere must not change what that place is worth.
        const rank = s.unlockedLocations
          .map((id) => ({ id, top: routeTop(id), danger: strikeCount(mem.routeDanger, id, DANGER_TTL_MS) }))
          .filter((c) => c.top >= 0);
        const candidates = rank
          // Somewhere that has wiped us repeatedly is off the table until the
          // strike ages out.
          .filter((c) => c.danger < DANGER_LIMIT)
          .filter((c) => c.top <= best + 3 - c.danger * 4)
          // Total order, so the ranking cannot depend on the (stable) input
          // order of `unlockedLocations` either.
          .sort((a, b) => b.top - a.top || (a.id < b.id ? -1 : 1));

        // If everything unlocked is now considered too hard, fall back to the
        // single easiest route rather than standing still doing nothing.
        const easiest = [...rank].sort((a, b) => a.top - b.top || (a.id < b.id ? -1 : 1))[0];

        // Always taking the single toughest route is optimal and visually
        // identical hour after hour. Rotate through the best few instead —
        // the EXP difference is marginal, the difference on camera is not.
        const pool = candidates.slice(0, GRIND_VARIETY);
        const pick = grindPick.current;
        // "Still a legal place to grind" is the test, NOT "still in the top
        // three". A route that merely slipped down the ranking is still a
        // fine place to be, and re-picking on every marginal reshuffle is the
        // other half of what made the banner flip.
        const pinned = pick ? candidates.find((c) => c.id === pick.locationId) : undefined;

        let target: { id: string; top: number } | undefined;
        if (pinned && now - pick!.at < GRIND_ROTATE_MS) {
          target = pinned;
        } else if (pool.length > 0) {
          const at = pinned ? pool.findIndex((c) => c.id === pinned.id) : -1;
          target = pool[(at + 1) % pool.length];
        } else {
          target = easiest;
        }

        if (target) {
          if (target.id !== s.currentLocation) {
            grindPick.current = { locationId: target.id, at: now };
            executeStreamCommand({ kind: "travel", locationId: target.id }, s, dispatch, "director");
            return;
          }
          // Pin without resetting `at` when it is already ours, so the
          // rotation timer actually elapses instead of being pushed forward
          // every tick.
          if (!pick || pick.locationId !== target.id) grindPick.current = { locationId: target.id, at: now };
          return; // already standing in the right place — nothing to do
        }
      } else {
        return; // parked on the gate, and the battle loop is doing the work
      }

      // ═══ TIER 8 — STUCK ══════════════════════════════════════════════════
      // Nothing above matched. That used to mean the account simply sat there,
      // on camera, indefinitely. Say so (rarely) and go stand somewhere a
      // battle can start.
      //
      // "Somewhere a battle can start" is the whole point, and it is also what
      // makes this terminate: `unlockedLocations.find(id => id !== here)`
      // returns a DIFFERENT first entry depending on where we are, which is
      // the same position-dependent-choice bug as the grind ceiling and would
      // hop between the first two unlocked locations forever. So: if we are
      // already somewhere that can produce a battle, stay put; otherwise walk
      // to the first place that can, which is a fixed target regardless of
      // where we're standing.
      if (now - lastStuckLog.current > STUCK_LOG_MS) {
        lastStuckLog.current = now;
        dispatch({ type: "ADD_LOG", payload: { text: "Stream director: no useful action available here." } });
      }
      const canFight = (id: string) =>
        !!routes[id] &&
        routes[id].type !== "raid" &&
        (routeTop(id) >= 0 || getRouteTrainers(id).length > 0);
      if (!canFight(s.currentLocation)) {
        const anywhere = s.unlockedLocations.find(canFight);
        if (anywhere) {
          executeStreamCommand({ kind: "travel", locationId: anywhere }, s, dispatch, "director");
        }
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [streamMode, dispatch, flush]);
}

/**
 * The best raid tier we can plausibly survive right now, or null.
 *
 * Cooldown resolution mirrors the UI exactly (ContextPanel): old saves only
 * have the single global `raidCooldownEnd`, so honour that for every tier
 * until the per-tier map exists, otherwise an upgrading account would appear
 * to have every tier ready mid-cooldown.
 */
function pickRaidTier(s: GameState, best: number): RaidTierId | null {
  const now = Date.now();
  const cooldownEnd = (id: string) =>
    s.raidCooldowns ? s.raidCooldowns[id] ?? 0 : s.raidCooldownEnd ?? 0;

  const eligible = raidTiersOrdered.filter(
    (t) =>
      isTierUnlocked(t, s) &&
      cooldownEnd(t.id) <= now &&
      best >= t.startLevel - RAID_LEVEL_GRACE,
  );
  if (eligible.length === 0) return null;

  // Prefer a pool that still owes us a dex entry. With catching set to
  // "pokedex_new" that is also exactly the condition under which the raid
  // throws any balls at all — once a pool is complete the bot would just be
  // punching legendaries for EXP, which is fine but not why we're here.
  const withNew = eligible.filter((t) =>
    Object.keys(t.pool).some((k) => !s.pokedexCaught.includes(k)),
  );
  const pool = withNew.length > 0 ? withNew : eligible;

  // Hardest we can stand up to: best EXP, biggest names on screen.
  return pool.reduce((a, b) => (b.startLevel > a.startLevel ? b : a)).id;
}
