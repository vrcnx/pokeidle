// Single-elimination bracket runner.
//
// The bracket is stored on Tournament.bracket as a JSON tree. Each
// round is an array of slot pairs; each slot is one of:
//   - { kind: "player", userId, username, seed? }  — concrete player
//   - { kind: "bye" }                              — auto-advance (odd round)
//   - { kind: "winnerOf", matchId }                — placeholder filled in
//                                                    by advanceBracket()
//   - { kind: "tbd" }                              — not yet seeded (rare,
//                                                    only between rounds)
//
// A "match" within a round has slot a + slot b + an optional battleId
// (the PvpMatch.id once the match has actually been kicked off) and a
// winnerId once it's resolved. byes auto-resolve immediately.
//
// Generation:
//   - Take all entries (filter out eliminated, but at generate-time
//     none should be eliminated yet — the route errors if status !== "open")
//   - Order by `seed` (1 = best). server/src/routes/admin.ts assigns
//     seeds from PlayerRating (ELO) at generate time; unseeded entries
//     sort last, tie-broken by userId so generation is deterministic.
//   - Pad to next power of two with byes.
//   - Build round 1 using the STANDARD bracket slot order so the top
//     seeds are spread across the tree (see seedOrder()).
//   - Subsequent rounds are placeholders (winnerOf) until advance.
//
// Advancement:
//   - Caller builds a matchId → result map (from completed PvpMatch
//     rows, from a walkover, or from an admin override) and hands it
//     to advanceBracket().
//   - Winners are copied into the match, losers are returned so the
//     caller can flag TournamentEntry.eliminated, and winnerOf
//     placeholders in later rounds resolve to concrete players.
//   - If the last round now has exactly one match with a winner,
//     the caller marks the tournament completed.
//
// Idempotency: re-running generate on an already-generated bracket is
// refused by the route (409). Re-running advance on a fully-resolved
// round is a no-op — advanceBracket only ever writes into matches that
// have no winner yet.

export type BracketSlot =
  | { kind: "player"; userId: string; username: string; seed?: number | null }
  | { kind: "bye" }
  | { kind: "winnerOf"; matchId: string }
  | { kind: "tbd" };

/** How a match was decided. Recorded so the bracket UI (and the
 *  post-mortem) can tell a real 6-on-6 from a no-show walkover. */
export type WinBy = "battle" | "bye" | "walkover" | "forfeit" | "admin";

export interface BracketMatch {
  /** Stable id within the bracket — we generate as `r<round>.m<index>`
   *  so advanceBracket() can wire winnerOf placeholders deterministically. */
  id: string;
  a: BracketSlot;
  b: BracketSlot;
  /** PvpMatch.id once started. Null until started. */
  battleId?: string | null;
  /** Resolved winner userId. null until decided.
   *  byes auto-resolve at generation time. */
  winnerId?: string | null;
  /** How `winnerId` was arrived at. */
  winBy?: WinBy | null;
  /** Epoch ms by which this match must be resolved. Stamped by the
   *  runner when the match's round becomes current; once it passes, a
   *  no-show is decided rather than left to rot. Null = not yet armed. */
  deadlineAt?: number | null;
  /** How many battles have been spawned and died on this match
   *  (double timeout, cancellation, engine refusal). The runner stops
   *  retrying and decides the match another way after
   *  MAX_BATTLE_ATTEMPTS. */
  attempts?: number;
  /** Epoch ms before which the runner will not respawn a battle for
   *  this match. Set when a battle is reaped, so a pairing that fails
   *  instantly (engine refusal, a client that connects and vanishes)
   *  cannot burn every attempt inside one minute and be left waiting on
   *  the round deadline with nobody having had a real chance to play. */
  retryAfter?: number | null;
  /** Epoch ms the current battle was spawned. Used to notice a battle
   *  that never ends — the last way a bracket could sit still. */
  battleStartedAt?: number | null;
  /** Free-form runner/operator note, e.g. "no-show: neither player
   *  online at the deadline — advanced higher seed". */
  note?: string | null;
}

export interface BracketRound {
  index: number;
  matches: BracketMatch[];
}

export interface Bracket {
  rounds: BracketRound[];
}

export interface EntryInput {
  userId: string;
  username: string;
  seed?: number | null;
}

/** Sentinel written when two byes somehow face each other. Never a real
 *  userId; championOf() refuses to hand it back as a champion. */
export const DOUBLE_BYE = "__double_bye__";

/** How many dead battles a single bracket match tolerates before the
 *  runner stops retrying and decides it another way. */
export const MAX_BATTLE_ATTEMPTS = 2;

// ─── Generation ─────────────────────────────────────────────────────

/** Build a fresh bracket from a list of entries. Throws on <2 entries. */
export function generateBracket(entries: EntryInput[]): Bracket {
  if (entries.length < 2) {
    throw new Error("at least 2 entries required to generate a bracket");
  }
  // Order: explicit seed first (lower seed = better), then by userId for
  // tie-break determinism. Callers that care about seeding (the admin
  // generate-bracket route) assign `seed` from ELO before calling.
  const seeded = [...entries].sort((a, b) => {
    if (a.seed != null && b.seed != null && a.seed !== b.seed) return a.seed - b.seed;
    if (a.seed != null && b.seed == null) return -1;
    if (a.seed == null && b.seed != null) return 1;
    return a.userId.localeCompare(b.userId);
  });

  // Pad to the next power of two with byes so single-elim works cleanly.
  // Byes take the WORST seed positions, so the top seeds get them.
  const target = nextPow2(seeded.length);
  const padded: (EntryInput | null)[] = [...seeded];
  while (padded.length < target) padded.push(null);

  // Round 1 uses the standard bracket slot order (1,8,4,5,2,7,3,6 for
  // an 8-draw), which is what actually guarantees #1 and #2 cannot meet
  // before the final, #1–#4 cannot meet before the semis, and so on.
  //
  // The previous implementation paired (i, N-1-i) straight down the
  // seed list — 1v8, 2v7, 3v6, 4v5 — and then fed ADJACENT round-1
  // matches into round 2, which put #1 against #2 in the semi-final of
  // every 8-player draw. The header comment claimed the opposite.
  const order = seedOrder(target); // 1-based seed numbers, bracket order
  const round1: BracketMatch[] = [];
  for (let i = 0; i < target / 2; i++) {
    const seedA = order[i * 2];
    const seedB = order[i * 2 + 1];
    const a = padded[seedA - 1] ?? null;
    const b = padded[seedB - 1] ?? null;
    const slotA = toSlot(a, seedA);
    const slotB = toSlot(b, seedB);
    // Auto-resolve a bye immediately: if one slot is a bye, the
    // non-bye player is the winner and gets a free advance.
    const winnerId = slotA.kind === "bye" && slotB.kind === "player" ? slotB.userId
      : slotB.kind === "bye" && slotA.kind === "player" ? slotA.userId
      : null;
    round1.push({
      id: `r0.m${i}`,
      a: slotA,
      b: slotB,
      battleId: null,
      winnerId,
      winBy: winnerId ? "bye" : null,
      deadlineAt: null,
      attempts: 0,
      retryAfter: null,
      battleStartedAt: null,
      note: null,
    });
    // (round-1 entry; later rounds are built as placeholders below)
  }

  // Subsequent rounds are placeholder shells until advanceBracket()
  // resolves real winners into them. Each match's a / b are
  // winnerOf-pointers into the previous round's matches.
  const rounds: BracketRound[] = [{ index: 0, matches: round1 }];
  let prev = round1;
  let roundIdx = 1;
  while (prev.length > 1) {
    const matches: BracketMatch[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      matches.push({
        id: `r${roundIdx}.m${i / 2}`,
        a: { kind: "winnerOf", matchId: prev[i].id },
        b: { kind: "winnerOf", matchId: prev[i + 1].id },
        battleId: null,
        winnerId: null,
        winBy: null,
        deadlineAt: null,
        attempts: 0,
        note: null,
      });
    }
    rounds.push({ index: roundIdx, matches });
    prev = matches;
    roundIdx += 1;
  }

  // After auto-resolving byes in round 1, propagate any auto-wins
  // forward by one round so the bracket UI doesn't show winnerOf
  // pointing at a slot that's already been decided.
  propagateResolved(rounds);

  return { rounds };
}

function toSlot(e: EntryInput | null, seedNumber: number): BracketSlot {
  return e
    ? { kind: "player", userId: e.userId, username: e.username, seed: e.seed ?? seedNumber }
    : { kind: "bye" };
}

/** Standard single-elimination slot order for a power-of-two draw,
 *  as 1-based seed numbers.
 *
 *    size 2 → [1,2]
 *    size 4 → [1,4,2,3]
 *    size 8 → [1,8,4,5,2,7,3,6]
 *
 *  Consecutive pairs are the round-1 matchups; the recursion is what
 *  makes the top and bottom halves of the draw mirror each other, so
 *  the two best seeds can only meet in the final. */
export function seedOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    const next: number[] = [];
    for (const s of order) next.push(s, n + 1 - s);
    order = next;
  }
  return order;
}

// ─── Advancement ────────────────────────────────────────────────────

export type MatchResult = string | { winnerId: string; by?: WinBy; note?: string };

export interface AdvanceOutcome {
  bracket: Bracket;
  eliminatedUserIds: string[];
  complete: boolean;
  championId: string | null;
}

/** Apply newly-decided match results to the bracket. Returns the
 *  updated bracket + a list of userIds whose entry should be flagged
 *  eliminated. Idempotent: rerunning with no new results no-ops, and a
 *  result for an already-resolved match is ignored.
 *
 *  matchResults: map of bracket-match-id → winner userId (or a richer
 *  { winnerId, by, note } record). The caller builds this by joining
 *  the bracket's `battleId` field against the PvpMatch table, by
 *  deciding a walkover, or from an admin override. */
export function advanceBracket(
  bracket: Bracket,
  matchResults: Record<string, MatchResult | null>,
): AdvanceOutcome {
  const next = cloneBracket(bracket);
  const eliminated: Set<string> = new Set();

  // Apply incoming results to matches that don't already have a
  // winner. Skip ones already resolved — that's how byes propagate.
  for (const round of next.rounds) {
    for (const m of round.matches) {
      if (m.winnerId) continue;
      const raw = matchResults[m.id];
      if (raw == null) continue;
      const result = typeof raw === "string" ? { winnerId: raw } as { winnerId: string; by?: WinBy; note?: string } : raw;
      if (!result.winnerId) continue;
      // Refuse a winner who isn't actually in this match. Previously an
      // out-of-band id was accepted and then `m.a` was blamed as the
      // loser — eliminating a player who had in fact won.
      const aId = slotUserId(m.a);
      const bId = slotUserId(m.b);
      if (result.winnerId !== aId && result.winnerId !== bId) continue;
      m.winnerId = result.winnerId;
      m.winBy = result.by ?? "battle";
      if (result.note) m.note = result.note;
      const loserId = result.winnerId === aId ? bId : aId;
      if (loserId) eliminated.add(loserId);
    }
  }

  // Propagate resolved winners into the next round's winnerOf slots.
  propagateResolved(next.rounds);

  const championId = championOf(next);
  return {
    bracket: next,
    eliminatedUserIds: Array.from(eliminated),
    complete: championId != null,
    championId,
  };
}

/** The champion, or null if the final hasn't resolved. Refuses the
 *  DOUBLE_BYE sentinel — that is not a person and must never be
 *  written into Tournament.championId or handed a prize. */
export function championOf(bracket: Bracket): string | null {
  const last = bracket.rounds[bracket.rounds.length - 1];
  if (!last || last.matches.length !== 1) return null;
  const w = last.matches[0].winnerId;
  if (!w || w === DOUBLE_BYE) return null;
  return w;
}

// ─── Queries used by the runner + the UI ────────────────────────────

export function cloneBracket(bracket: Bracket): Bracket {
  return {
    rounds: bracket.rounds.map((r) => ({
      ...r,
      matches: r.matches.map((m) => ({ ...m, a: { ...m.a }, b: { ...m.b } })),
    })),
  };
}

export function findMatch(bracket: Bracket, matchId: string): BracketMatch | null {
  for (const r of bracket.rounds) {
    for (const m of r.matches) if (m.id === matchId) return m;
  }
  return null;
}

/** Index of the earliest round that still has an unresolved match, or
 *  -1 when every match in the bracket has a winner. This is "the round
 *  the tournament is currently on" — a round only opens once every
 *  match in the previous round has a winner, which is what makes a
 *  per-round deadline meaningful. */
export function currentRoundIndex(bracket: Bracket): number {
  for (const r of bracket.rounds) {
    if (r.matches.some((m) => !m.winnerId)) return r.index;
  }
  return -1;
}

/** Matches in the current round that are ready to be played: both
 *  slots are concrete players, nobody has won yet, and no battle is
 *  already in flight. */
export function playableMatches(bracket: Bracket): BracketMatch[] {
  const idx = currentRoundIndex(bracket);
  if (idx < 0) return [];
  const round = bracket.rounds.find((r) => r.index === idx);
  if (!round) return [];
  return round.matches.filter(
    (m) => !m.winnerId && !m.battleId && m.a.kind === "player" && m.b.kind === "player",
  );
}

/** Every unresolved match in the current round, playable or not. */
export function openMatches(bracket: Bracket): BracketMatch[] {
  const idx = currentRoundIndex(bracket);
  if (idx < 0) return [];
  return bracket.rounds.find((r) => r.index === idx)?.matches.filter((m) => !m.winnerId) ?? [];
}

export interface MatchSide { userId: string; username: string; seed: number }

/** The two concrete participants of a match, or null if either slot is
 *  still a placeholder / bye. */
export function participants(m: BracketMatch): { a: MatchSide; b: MatchSide } | null {
  if (m.a.kind !== "player" || m.b.kind !== "player") return null;
  return {
    a: { userId: m.a.userId, username: m.a.username, seed: m.a.seed ?? Number.MAX_SAFE_INTEGER },
    b: { userId: m.b.userId, username: m.b.username, seed: m.b.seed ?? Number.MAX_SAFE_INTEGER },
  };
}

/** Live list of players still in the draw. */
export function survivors(bracket: Bracket): string[] {
  const idx = currentRoundIndex(bracket);
  if (idx < 0) {
    const champ = championOf(bracket);
    return champ ? [champ] : [];
  }
  const round = bracket.rounds.find((r) => r.index === idx);
  const out = new Set<string>();
  for (const m of round?.matches ?? []) {
    if (m.winnerId) { out.add(m.winnerId); continue; }
    const aId = slotUserId(m.a); if (aId) out.add(aId);
    const bId = slotUserId(m.b); if (bId) out.add(bId);
  }
  return Array.from(out);
}

// ─── Helpers ────────────────────────────────────────────────────────
function slotUserId(s: BracketSlot): string | null {
  return s.kind === "player" ? s.userId : null;
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** Walk every round forward; replace winnerOf slots with concrete
 *  player slots whenever the referenced match has resolved. Loops
 *  until no more substitutions are possible (handles chained byes). */
function propagateResolved(rounds: BracketRound[]): void {
  // matchId → resolved player slot lookup, refreshed each pass.
  const lookup = (id: string): BracketSlot | null => {
    for (const r of rounds) {
      for (const m of r.matches) {
        if (m.id !== id) continue;
        if (!m.winnerId) return null;
        // Find the winner slot from m.a or m.b. Bye-winners come from
        // the surviving player slot.
        if (m.a.kind === "player" && m.a.userId === m.winnerId) return { ...m.a };
        if (m.b.kind === "player" && m.b.userId === m.winnerId) return { ...m.b };
        // Neither side is a concrete player but the match resolved —
        // only reachable via the double-bye sentinel. Carry it forward
        // as a bye so it can never masquerade as a player.
        if (m.winnerId === DOUBLE_BYE) return { kind: "bye" };
        return { kind: "player", userId: m.winnerId, username: "" };
      }
    }
    return null;
  };
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 64) {
    changed = false;
    for (const r of rounds) {
      for (const m of r.matches) {
        if (m.a.kind === "winnerOf") {
          const resolved = lookup(m.a.matchId);
          if (resolved) { m.a = resolved; changed = true; }
        }
        if (m.b.kind === "winnerOf") {
          const resolved = lookup(m.b.matchId);
          if (resolved) { m.b = resolved; changed = true; }
        }
        // Auto-resolve a match where one slot is a bye (chained byes).
        if (!m.winnerId) {
          if (m.a.kind === "bye" && m.b.kind === "player") {
            m.winnerId = m.b.userId;
            m.winBy = "bye";
            changed = true;
          } else if (m.b.kind === "bye" && m.a.kind === "player") {
            m.winnerId = m.a.userId;
            m.winBy = "bye";
            changed = true;
          } else if (m.a.kind === "bye" && m.b.kind === "bye") {
            // Double bye — unreachable with our padding (byes never
            // outnumber players), but be safe rather than infinite-loop.
            m.winnerId = DOUBLE_BYE;
            m.winBy = "bye";
            changed = true;
          }
        }
      }
    }
  }
}
