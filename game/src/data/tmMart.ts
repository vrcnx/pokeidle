// The TM Mart — a rotating shop, and the only counter that sells machines.
//
// ── WHY IT ROTATES ────────────────────────────────────────────────────────
// A permanent TM shelf makes every TM a question of money and nothing else:
// you look up the one you want, you buy it, and the route that hides it stops
// mattering the moment your wallet is big enough. Rotation changes the
// question from "can I afford it" to "is it up today", which is a question
// money cannot answer.
//
// So the shop can eventually offer almost anything — but never the thing you
// came in for. Routes stay the reliable way to get a specific machine; this
// is the shortcut you take when the shortcut happens to be pointing your way.
//
// ── WHAT IS NEVER SOLD ────────────────────────────────────────────────────
// HMs and the five heaviest TMs (Hyper Beam, Giga Impact, Solar Beam,
// Overheat, Explosion). Those are raid prizes, and a prize you can wait out
// at a shop counter is not a prize. See data/machineSources.ts.
//
// ── WHY IT IS COMPUTED, NOT STORED ────────────────────────────────────────
// The stock is a pure function of the UTC day, so every player sees the same
// six machines on the same day with no server call, no table, and nothing to
// keep in sync. That is what makes it shareable — "Ice Beam is up today" is
// a true statement about everyone's game, not just the speaker's.

import { machineList, type MachineDef } from "./tms";
import { machineSource } from "./machineSources";

/** How many machines are on the counter at once. */
export const TM_MART_SLOTS = 6;

/**
 * What the shop is allowed to stock: every TM that isn't a raid prize.
 *
 * Sorted by id so the pool itself never depends on array order elsewhere —
 * the rotation has to be reproducible from the date alone, and a pool that
 * quietly reorders would silently change history.
 */
export const TM_MART_POOL: MachineDef[] = machineList
  .filter((m) => m.kind === "tm" && machineSource[m.id] !== "raid")
  .sort((a, b) => a.id.localeCompare(b.id));

/**
 * Route machines cost DOUBLE at the counter.
 *
 * The route that hides a machine has to stay the better deal or the drops
 * stop meaning anything. Paying twice for it is the price of not walking —
 * and it is still a real option for a player with money and no patience.
 * The setup machines, which have no route, are sold at their face price.
 */
export function tmMartPrice(m: MachineDef): number {
  const base = m.price ?? 0;
  return machineSource[m.id] === "route" ? base * 2 : base;
}

/** UTC day index. The day is the rotation, everywhere on earth at once. */
export function rotationDay(now: number = Date.now()): number {
  return Math.floor(now / 86_400_000);
}

/** When the current stock is replaced, as epoch ms. */
export function nextRotationAt(now: number = Date.now()): number {
  return (rotationDay(now) + 1) * 86_400_000;
}

/**
 * A small, fast, well-distributed integer hash.
 *
 * `Math.random()` cannot be used here for the obvious reason and one less
 * obvious one: this module is imported by the reducer's test suite, where an
 * extra draw from the shared random stream shifts every seeded fixture after
 * it. The rotation is derived arithmetic, so it draws nothing.
 */
function hash(n: number): number {
  let h = n | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = h ^ (h >>> 16);
  return h >>> 0;
}

/**
 * How many days it takes to see the whole pool once. 48 machines, 6 a day.
 */
export const TM_MART_CYCLE_DAYS = Math.ceil(TM_MART_POOL.length / TM_MART_SLOTS);

/**
 * The machines on sale on a given day.
 *
 * ── DEALT, NOT DRAWN ──────────────────────────────────────────────────────
 * The obvious implementation is an independent random draw each day. It was
 * written that way first and measured, and the tail is the problem: over a
 * simulated year every machine did come around, but a specific one could be
 * 28 days out. A player who wants Ice Beam and is told "maybe next month" has
 * been given a slot machine, not a shop.
 *
 * So the pool is SHUFFLED ONCE PER CYCLE and dealt out six a day, like hands
 * from a deck. Every machine is guaranteed to appear exactly once every eight
 * days — you can always be told how long the wait is, and it is never long —
 * while the day it lands on is still unpredictable enough that you cannot
 * simply buy what you came for. Rotation without the lottery.
 */
export function tmMartStock(day: number = rotationDay()): MachineDef[] {
  const cycle = Math.floor(day / TM_MART_CYCLE_DAYS);
  const dayInCycle = ((day % TM_MART_CYCLE_DAYS) + TM_MART_CYCLE_DAYS) % TM_MART_CYCLE_DAYS;

  // Fisher–Yates seeded by the CYCLE, so the deck is the same all week.
  const deck = [...TM_MART_POOL];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = hash(cycle * 7919 + i) % (i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck.slice(dayInCycle * TM_MART_SLOTS, dayInCycle * TM_MART_SLOTS + TM_MART_SLOTS);
}

/**
 * Days until this machine is next on the counter, or null if it isn't within
 * the horizon.
 *
 * This exists so the shop can answer the question it otherwise creates. A
 * rotating shop that only shows today is a shop you have to keep checking;
 * one that can say "Earthquake, 4 days" is one you can plan around, and
 * planning is the difference between a mechanic and a chore.
 *
 * Because the pool is dealt rather than drawn, this always finds an answer
 * within two cycles for anything the shop stocks at all — the horizon is a
 * guard against being asked about an HM or a raid prize, which never appear.
 */
export function daysUntilStocked(machineId: string, from: number = rotationDay(), horizon = TM_MART_CYCLE_DAYS * 2): number | null {
  for (let d = 0; d <= horizon; d++) {
    if (tmMartStock(from + d).some((m) => m.id === machineId)) return d;
  }
  return null;
}
