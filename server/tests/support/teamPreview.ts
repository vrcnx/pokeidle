// Answering Team Preview, for every test that drives a real battle.
//
// NOT a test file (vitest's include is `tests/**/*.test.ts`), and deliberately
// so: this is the one thing every battle driver in the suite gained on the day
// Team Preview was turned on, and thirteen hand-rolled copies of it is thirteen
// chances for one of them to answer the phase slightly differently from the
// client.
//
// ─── Why every driver needs this ──────────────────────────────────────
//
// With `!Team Preview` in the format string, the first |request| a side got was
// a move request and `applyChoice(room, "uA", "move 1")` immediately after
// startBattle was correct. It is not any more. The first request is
// `{"teamPreview":true}`, and a move choice against it comes back verbatim:
//
//     |error|[Invalid choice] Can't move: You need a teampreview response
//
// leaving the battle in the phase. Production resolves that after twenty
// seconds through the auto-lock in startBattle; a test with an eight-second
// budget just fails. So a driver has to answer the phase exactly as the client
// does — which is also the point: a suite that could not answer it would not be
// proving the phase is answerable.

import { applyChoice, type BattleRoom } from "../../src/pvp.js";

/** Is this side still owed a team order? Reads the parsed |request| the room
 *  already holds, which is the same object the client renders its picker from. */
export function awaitingPreview(side: { request: unknown }): boolean {
  const rq = side.request as { teamPreview?: unknown } | null;
  return !!rq && rq.teamPreview === true;
}

/**
 * Answer Team Preview for whichever of the two seats is still in it.
 *
 * `default` is the identity order — measured against the real simulator, and
 * the same string the server's own auto-lock writes — so a driver that calls
 * this gets exactly the lead its fixture declared in slot 1, which is what
 * every fixture in the suite was written against.
 *
 * Idempotent and safe to call at any point: a side that has already answered
 * (or a battle past the phase) has no preview request, so nothing is written.
 * Returns the ids it answered for, so a test can assert the phase was really
 * there rather than silently passing on a battle that never had one.
 */
export function answerTeamPreview(
  room: BattleRoom,
  ids: { a: string; b: string } = { a: room.a.userId, b: room.b.userId },
): string[] {
  const answered: string[] = [];
  // The AI seat answers through its own brain (RandomPlayerAI.chooseTeamPreview
  // returns `default`), so it is skipped here — writing for it would race the
  // brain and land a second choice for a side that had already locked.
  if (room.a.isBot !== true && awaitingPreview(room.a)) {
    if (applyChoice(room, ids.a, "default").ok) answered.push(ids.a);
  }
  if (room.b.isBot !== true && awaitingPreview(room.b)) {
    if (applyChoice(room, ids.b, "default").ok) answered.push(ids.b);
  }
  return answered;
}

/**
 * Poll until the battle leaves Team Preview, answering it on the way.
 *
 * The request does not arrive synchronously with `>start` — the player streams
 * are async iterators, so the first chunk lands a tick or two later — which is
 * why a single `answerTeamPreview` immediately after startBattle would be a
 * race. Every caller has some `await settle(…)` already; this replaces the
 * guesswork with a condition.
 */
export async function passTeamPreview(
  room: BattleRoom,
  opts: {
    ids?: { a: string; b: string };
    /**
     * How to let time pass between polls.
     *
     * Defaults to a real 15 ms sleep. A test running on FAKE timers must pass
     * its own (`() => vi.advanceTimersByTimeAsync(20)`), because a real
     * setTimeout inside a fake-timer region never resolves and the poll loop
     * hangs until vitest's own 15-second timeout — which is how this helper's
     * first version turned six passing tests into six timeouts.
     *
     * Deadline counting uses ATTEMPTS rather than Date.now() for the same
     * reason: `vi.setSystemTime` pins the clock, so a wall-clock budget in a
     * fake-timer test is either instantly expired or never expires.
     */
    settle?: () => Promise<void>;
    attempts?: number;
  } = {},
): Promise<void> {
  const settle = opts.settle ?? (() => new Promise<void>((r) => setTimeout(r, 15)));
  const attempts = opts.attempts ?? 200;
  for (let i = 0; i < attempts; i++) {
    if (room.status !== "active") return;
    answerTeamPreview(room, opts.ids);
    // The exit condition is that BOTH sides hold a request and NEITHER of them
    // is a preview request — i.e. the simulator has replaced the preview
    // request with the turn-1 move request on both streams. "No preview
    // request" alone is not enough: it is also true for the split second before
    // the first request of any kind arrives.
    if (room.a.request && room.b.request && !awaitingPreview(room.a) && !awaitingPreview(room.b)) return;
    await settle();
  }
}

/** `passTeamPreview` for a test running on vitest's fake timers. `advance` is
 *  the caller's own `vi.advanceTimersByTimeAsync`, passed in rather than
 *  imported so this module stays a plain helper with no vitest dependency of
 *  its own. */
export async function passTeamPreviewFake(
  room: BattleRoom,
  advance: (ms: number) => Promise<unknown>,
  ids?: { a: string; b: string },
): Promise<void> {
  await passTeamPreview(room, {
    ids,
    attempts: 40,
    settle: async () => { await advance(20); },
  });
}
