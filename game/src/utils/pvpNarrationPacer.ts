// The narration pacer: turning bursty protocol output into a readable
// message box without ever letting the box lie about the board.
//
// THE PROBLEM, MEASURED
//
// The idle game paces its battle text for free because it GENERATES one event
// at a time and the loop waits. PvP has no such luxury: the server forwards
// whatever the simulator flushed, so a single `battle:state` socket message can
// carry a whole turn — measured on a live battle, one 19-protocol-line chunk
// produced 13 narration lines and a two-turn board jump in ONE React commit
// (the foe fainted, the replacement switched in, Sandstorm started, a +2 boost
// row appeared and the turn chip went from 5 to 7). A message box that renders
// `narration[narration.length - 1]` would flicker through ten states inside one
// frame and the player would read none of them, and every effect would fire
// simultaneously.
//
// So the lines have to be QUEUED and drained. That queue has four hard
// requirements, and this class exists to make each one a property that can be
// asserted in a test rather than a hope:
//
//  1. NEVER FALL BEHIND THE BOARD. The board is applied instantly (the view is
//     the decoder's output and this class never touches it), so any queue is by
//     definition describing the past. What must be bounded is HOW FAR past.
//     `backlogMs()` is that bound and it is capped at LAG_BUDGET_MS: when the
//     raw playout time of the queue exceeds the budget every remaining beat is
//     scaled down to fit it, and if even the floor-length beats cannot fit
//     (MAX_QUEUE * MIN_HOLD_MS is deliberately UNDER the budget) the oldest
//     minor lines are dropped. The player can therefore never be reading about
//     a move from two turns ago.
//
//  2. NEVER BLOCK OR DELAY INPUT. Nothing here is on the input path. The class
//     is pure: it takes lines and a clock, and returns which line to show. It
//     holds no reference to the request, cannot disable a move tile, and the
//     component that owns it renders in its own subtree, so a drain tick
//     re-renders the message box and the effect layer and nothing else. The
//     move picker renders from `room.request` and stays live throughout a
//     drain — verified against a live battle by clicking a move mid-burst.
//
//  3. DRAIN INSTANTLY, NOT STALL, AT THE END. `hurry()` collapses every
//     remaining hold to the floor and drops the minor lines, so a battle that
//     ends mid-burst lands on its final line in a few hundred ms instead of
//     narrating a dead battle for four seconds. `reset()` is the harder stop
//     for unmount. Neither leaves a timer behind — the owner schedules exactly
//     one timeout at `nextDueAt()`, so there is nothing to leak.
//
//  4. SURVIVE A REJOIN. `battle:rejoin` REBUILDS `room.narration` from the
//     server's whole side-filtered log, so 200 lines can replace 40 in one
//     commit. Animating that would replay the entire battle. `observe` tells
//     an APPEND from a REBUILD by object identity — the append path keeps the
//     previous lines' object references (`[...room.narration, ...decoded]`)
//     while the rebuild allocates fresh ones — and adopts a rebuild silently:
//     the last line goes straight into the box with `animate: false`, no
//     effects, no queue. Identity search rather than a length compare, because
//     `narration` is `slice(-300)`-trimmed and a length compare would
//     mis-classify every append after line 300 as a rebuild.
//
// No React in here on purpose. This is the part that has to be RIGHT, and the
// only way to know a pacer is right is to drive it with a virtual clock and
// assert the invariants, which tests/pvpNarrationPacer.test.ts does.

import type { NarrationLine } from "../state/pvpBattleView";

/** Shortest a beat may ever be shown. Below this, text is unreadable. */
export const MIN_HOLD_MS = 110;

/**
 * How far behind the board the box is allowed to be, in ms of pending playout.
 *
 * 2.4s is one comfortable read plus change. Larger and the box is narrating a
 * turn the board has visibly moved past; smaller and an ordinary two-move turn
 * (which is ~6 lines) gets compressed even when nothing is wrong.
 */
export const LAG_BUDGET_MS = 2400;

/**
 * Hard ceiling on queued beats. MAX_QUEUE * MIN_HOLD_MS = 2200ms, deliberately
 * UNDER LAG_BUDGET_MS: that is what makes `backlogMs() <= LAG_BUDGET_MS` an
 * invariant rather than a target, because the floor-length playout of a full
 * queue still fits the budget.
 */
export const MAX_QUEUE = 20;

/**
 * How much lateness a beat may be credited with when catching up.
 *
 * FOUND IN A LIVE BATTLE, and it is the difference between a message box and no
 * message box. Beats advance from when the previous one was DUE rather than from
 * when the timer fired, so ordinary jitter cannot accumulate into drift and a
 * throttled tab can roll through the beats it already owes. But an IDLE pacer's
 * due time recedes into the past — and most of a battle is idle, because you
 * spend half of every turn waiting for the opponent. After 42 seconds of "What
 * will Espeon do?", the next burst's first beat was dated from 42 seconds ago,
 * its whole hold had "already elapsed", and the catch-up loop drained the entire
 * turn in one synchronous tick: the box jumped straight from "Turn 1" to the
 * last damage line and the move, its super-effective tag and its animation were
 * never committed to the DOM at all. Measured exactly that, on the arena.
 *
 * So lateness is credited only while it is plausibly JITTER. Deliberately small:
 * a visible tab's timers land within tens of milliseconds, so 350ms covers every
 * real slip while being far too little to swallow a whole beat. An earlier
 * 2200ms value was measured doing exactly that on the live arena — a background
 * tab's 1-second timer granularity fell inside the credit, so two beats were
 * consumed in one tick and only the second reached the DOM. Genuine catch-up is
 * not this mechanism's job; STALE_AFTER_MS below owns it.
 */
export const CATCHUP_CREDIT_MS = 350;

/**
 * When a QUEUED line is old enough that showing it would be a lie about the
 * board, and it gets skipped rather than narrated.
 *
 * The clamp above answers "was the timer late?"; this answers the different and
 * more important question "is this line still worth saying?". They are not the
 * same case: a tab hidden for a minute has a queue whose lines were pushed a
 * minute ago (stale — drain straight to the newest), while a battle that sat
 * idle for a minute and then received a turn has a queue of BRAND NEW lines
 * that must be paced normally. Distinguishing them by tick lateness alone gets
 * one of the two wrong; distinguishing them by the line's own age gets both
 * right.
 *
 * Twice the budget, not the budget itself: a normal full-budget drain pops its
 * last line at ~LAG_BUDGET_MS of age, and that line is not stale — it is simply
 * the end of a burst that was paced exactly as intended.
 */
export const STALE_AFTER_MS = LAG_BUDGET_MS * 2;

/** An initial batch bigger than this is a rejoin/replay, not a first turn. A
 *  real opening chunk is ~4-8 lines (team preview is silent, then two
 *  switch-ins and `|turn|1`); a rejoined battle replays dozens. */
export const SEED_BURST = 24;

/** Even a prefix-matching append this large is a replay in disguise (a
 *  reconnect that re-sent the log as one chunk), and must not animate. */
export const HARD_SEED_BURST = 60;

/** Per-kind reading time at rest. Tuned to the beat of the games: the move
 *  itself and a KO are the loud events, HP/stat bookkeeping is glue. */
const HOLD_BY_KIND: Record<NarrationLine["kind"], number> = {
  move: 900,
  faint: 1100,
  win: 1400,
  tie: 1400,
  switch: 800,
  cant: 850,
  miss: 800,
  fail: 750,
  turn: 260,
  damage: 520,
  heal: 560,
  status: 700,
  cure: 620,
  boost: 620,
  unboost: 620,
  weather: 620,
  hazard: 620,
  field: 620,
  ability: 620,
  item: 620,
  volatile: 620,
  info: 520,
  error: 900,
};

/**
 * Lines dropped FIRST when the queue cannot fit its budget.
 *
 * Chosen by what the player can recover from elsewhere on screen: an HP change
 * is already on the bar, a stat change is already a chip on the card, an item
 * or ability trigger is in the rail transcript. A move, a KO, a switch, a
 * "can't move", a miss and the verdict are never dropped — those are the
 * lines that explain what happened, and "your turn did nothing and nothing
 * said why" is the exact complaint the decoder was written to fix.
 */
export const MINOR_KINDS: ReadonlySet<NarrationLine["kind"]> = new Set<NarrationLine["kind"]>([
  "damage", "heal", "boost", "unboost", "volatile", "item", "ability", "info", "field",
]);

export function holdForKind(kind: NarrationLine["kind"]): number {
  return HOLD_BY_KIND[kind] ?? 520;
}

/**
 * Fit a queue's reading times into a time budget.
 *
 * A flat `budget / raw` scale is NOT enough, and the first version of this was
 * wrong for exactly that reason: scaling every hold by the same factor and then
 * clamping each one up to MIN_HOLD_MS pushes the total back OVER the budget,
 * because every clamped beat silently buys back time the scale had given away.
 * Measured on the real 13-line burst it overshot to 2454ms against a 2400ms
 * budget — small, but it means the bound is not a bound.
 *
 * So the short beats are taken out of the calculation instead. Each pass floors
 * whatever falls under MIN_HOLD_MS, subtracts those fixed costs from the budget
 * and re-solves the scale over what is left. The scale is monotonically
 * decreasing (proof: removing a floored beat removes proportionally more
 * budget than raw time), so the floored set only ever grows and the loop
 * converges — at which point the total is EXACTLY the budget. The final guard
 * catches non-convergence by falling back to all-floor, which fits by
 * construction because MAX_QUEUE * MIN_HOLD_MS < LAG_BUDGET_MS.
 */
export function paceHolds(raws: readonly number[], budget: number): number[] {
  const n = raws.length;
  if (n === 0) return [];
  const allFloor = () => raws.map(() => MIN_HOLD_MS);
  if (n * MIN_HOLD_MS >= budget) return allFloor();

  let rawTotal = 0;
  for (const h of raws) rawTotal += h;
  if (rawTotal <= budget) return raws.slice();

  let scale = budget / rawTotal;
  for (let iter = 0; iter < 12; iter++) {
    let floored = 0;
    let flexRaw = 0;
    for (const h of raws) {
      if (h * scale < MIN_HOLD_MS) floored += 1;
      else flexRaw += h;
    }
    if (floored === 0) break;
    const rest = budget - floored * MIN_HOLD_MS;
    if (rest <= 0 || flexRaw <= 0) return allFloor();
    const next = rest / flexRaw;
    if (Math.abs(next - scale) < 1e-9) { scale = next; break; }
    scale = next;
  }

  const out = raws.map((h) => Math.max(MIN_HOLD_MS, h * scale));
  let total = 0;
  for (const h of out) total += h;
  // Belt and braces: the loop above is proven to converge, but the bound is a
  // contract, not an aspiration, so an unconverged edge falls back rather than
  // shipping a queue that outlives its budget.
  return total <= budget + 1e-6 ? out : allFloor();
}

export interface Beat {
  /** Monotonic id. Doubles as the React key that restarts an effect's
   *  keyframes, so two identical moves in a row still both animate. */
  seq: number;
  line: NarrationLine;
  /** False for a beat adopted from a replay/rejoin — the box shows the text
   *  but no effect fires and no shake happens. */
  animate: boolean;
}

interface QueuedBeat { line: NarrationLine; holdMs: number; queuedAt: number }

export class NarrationPacer {
  private queue: QueuedBeat[] = [];
  private cur: Beat | null = null;
  private curUntil = 0;
  private curAnimate = true;
  private seqCounter = 0;
  private hurrying = false;

  /** Identity of the last line we have already consumed or queued. The whole
   *  append-vs-rebuild discrimination hangs off this one object reference. */
  private lastSeen: NarrationLine | null = null;
  private started = false;

  /** The beat currently in the box, or null before the first line. */
  get current(): Beat | null {
    return this.cur;
  }

  /** How many lines are still waiting. */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * Playout time still owed for the QUEUE.
   *
   * This is the "how stale can the box be" number, and the invariant is that it
   * never exceeds LAG_BUDGET_MS. Holds are computed ONCE when lines are queued
   * rather than re-derived per beat, which is the other half of that bound:
   * re-deriving them meant each pop saw a shorter queue, relaxed the pacing, and
   * the total playout of a burst crept back up to 5.4s — the box would still
   * have been narrating a two-turn-old board, just gradually.
   */
  backlogMs(): number {
    let total = 0;
    for (const b of this.queue) total += b.holdMs;
    return total;
  }

  /** When `tick` next needs to run, or null when there is nothing to do.
   *  The owner schedules exactly ONE timeout off this — no polling loop, so
   *  an idle battle costs zero timers and a background tab cannot pile up. */
  nextDueAt(): number | null {
    if (this.queue.length === 0) return null;
    if (!this.cur) return 0;
    return this.curUntil;
  }

  /**
   * Fold the room's narration array in.
   *
   * Safe to call on every render: it is a no-op when nothing was appended.
   */
  observe(lines: NarrationLine[], nowMs: number): void {
    if (lines.length === 0) {
      // A fresh room (battle:start resets narration to []). Forget the old
      // battle so its last line cannot be mistaken for a prefix of this one.
      if (this.started) this.reset();
      return;
    }

    let delta: NarrationLine[];
    let replay: boolean;

    if (!this.started || this.lastSeen == null) {
      delta = lines;
      // A rejoin into a room we have never rendered arrives all at once.
      replay = lines.length > SEED_BURST;
      this.started = true;
    } else {
      const at = lines.lastIndexOf(this.lastSeen);
      if (at < 0) {
        // Our anchor is gone: the array was REBUILT, not appended to. That is
        // battle:rejoin (fresh objects from a fresh applyChunk) — or a >300
        // line trim, which is the same situation for our purposes.
        delta = lines;
        replay = true;
      } else {
        delta = lines.slice(at + 1);
        replay = delta.length > HARD_SEED_BURST;
      }
    }

    this.lastSeen = lines[lines.length - 1] ?? null;
    if (delta.length === 0) return;

    if (replay) {
      this.queue = [];
      this.adopt(delta[delta.length - 1], nowMs, false, MIN_HOLD_MS);
      return;
    }

    for (const line of delta) {
      this.queue.push({ line, holdMs: holdForKind(line.kind), queuedAt: nowMs });
    }
    this.trim();
    this.repace();
    // First line of a battle goes in immediately rather than after a tick, so
    // the box is never blank while a chunk is already in hand.
    if (!this.cur) this.tick(nowMs);
  }

  /**
   * Advance the clock. Returns true when the visible beat changed, so the
   * owner can skip a re-render when nothing did.
   */
  tick(nowMs: number): boolean {
    let changed = false;
    // A loop, not an if: a heavily compressed queue can owe several beats by
    // the time a timer actually fires (browsers clamp a background tab's
    // setTimeout to ~1s, and an alt-tabbed player mid-battle is a real state),
    // and stepping one beat per tick there would stall the box behind the board
    // indefinitely instead of catching up.
    for (let guard = 0; guard < MAX_QUEUE + 2; guard++) {
      if (this.cur && nowMs < this.curUntil) break;
      const next = this.queue.shift();
      if (!next) break;
      // A line this old is describing a board the player has already watched
      // move on. Skip straight past it to something current rather than
      // narrating history — this is the case of a tab that was hidden (or a
      // machine that was asleep) while the battle carried on.
      if (nowMs - next.queuedAt >= STALE_AFTER_MS && this.queue.length > 0) continue;
      this.adopt(next.line, nowMs, true, next.holdMs);
      changed = true;
    }
    return changed;
  }

  /**
   * The battle is over (or the player is leaving): stop savouring it.
   *
   * Collapses every remaining hold to the floor and drops the minor lines, so
   * the tail plays out in a few hundred ms and the box lands on the verdict.
   * Deliberately NOT a jump straight to the last line: the KO and the win are
   * the two lines the player most wants to see, and skipping them to show the
   * winner is how the old inline result bar felt abrupt.
   */
  hurry(nowMs: number): boolean {
    if (this.hurrying) return false;
    this.hurrying = true;
    this.queue = this.queue
      .filter((b) => !MINOR_KINDS.has(b.line.kind))
      .map((b) => ({ ...b, holdMs: MIN_HOLD_MS }));
    // Cut the current beat short too, so the hurry is felt immediately.
    if (this.cur) this.curUntil = Math.min(this.curUntil, nowMs + MIN_HOLD_MS);
    return true;
  }

  /** Hard stop: no current beat, no queue, no anchor. For unmount and for a
   *  room swap (rematch), where carrying anything over would narrate the
   *  previous battle into the new one. */
  reset(): void {
    this.queue = [];
    this.cur = null;
    this.curUntil = 0;
    this.curAnimate = true;
    this.hurrying = false;
    this.lastSeen = null;
    this.started = false;
  }

  // ── internals ─────────────────────────────────────────────────────

  private adopt(line: NarrationLine, nowMs: number, animate: boolean, holdMs: number): void {
    this.seqCounter += 1;
    this.curAnimate = animate;
    this.cur = { seq: this.seqCounter, line, animate };
    // Advance from when this beat was DUE, not from when the timer happened to
    // fire. Two things fall out of that: ordinary timer jitter stops
    // accumulating into drift, and a late fire (a throttled background tab)
    // rolls straight through the beats it already owes instead of restarting the
    // clock on each one and never catching up.
    //
    // CATCHUP_CREDIT_MS is what keeps that from eating an idle gap — see the
    // note on the constant. Without the clamp, a pacer that had been quiet for
    // 42 seconds treated every new beat as 42 seconds overdue and drained a
    // whole turn inside one tick, so the box skipped every line of it.
    const late = this.curUntil > 0 && this.curUntil <= nowMs
      && nowMs - this.curUntil <= CATCHUP_CREDIT_MS;
    const base = late ? this.curUntil : nowMs;
    this.curUntil = base + holdMs;
  }

  /** Recompute every queued hold so the whole backlog fits LAG_BUDGET_MS.
   *  Called after any change to the queue's contents, and never during a pop —
   *  a per-pop recomputation is what let a burst's total playout drift past the
   *  budget as the queue drained. */
  private repace(): void {
    if (this.queue.length === 0) return;
    if (this.hurrying) {
      for (const b of this.queue) b.holdMs = MIN_HOLD_MS;
      return;
    }
    const paced = paceHolds(this.queue.map((b) => holdForKind(b.line.kind)), LAG_BUDGET_MS);
    for (let i = 0; i < this.queue.length; i++) this.queue[i].holdMs = paced[i];
  }

  /** Enforce MAX_QUEUE, sacrificing the OLDEST minor lines first and only
   *  then the oldest lines at all. Dropping from the front rather than
   *  refusing the new lines is deliberate: the newest lines describe the board
   *  the player is looking at, and those are the ones that must survive. */
  private trim(): void {
    if (this.queue.length <= MAX_QUEUE) return;
    let over = this.queue.length - MAX_QUEUE;
    const kept: QueuedBeat[] = [];
    for (const b of this.queue) {
      if (over > 0 && MINOR_KINDS.has(b.line.kind)) { over -= 1; continue; }
      kept.push(b);
    }
    this.queue = over > 0 ? kept.slice(over) : kept;
  }

  /** Exposed for the owner's render: whether the visible beat may animate. */
  get currentAnimates(): boolean {
    return this.curAnimate;
  }
}
