// Single-elimination bracket runner.
//
// The bracket is stored on Tournament.bracket as a JSON tree. Each
// round is an array of slot pairs; each slot is one of:
//   - { kind: "player", userId, username }       — concrete player
//   - { kind: "bye" }                              — auto-advance (odd round)
//   - { kind: "winnerOf", matchId }                — placeholder filled in
//                                                    by advanceRound()
//   - { kind: "tbd" }                              — not yet seeded (rare,
//                                                    only between rounds)
//
// A "match" within a round has slot a + slot b + an optional matchId
// (the PvpMatch.id once the match has actually been kicked off) and a
// winnerId once it's resolved. byes auto-resolve immediately.
//
// Generation:
//   - Take all entries (filter out eliminated, but at generate-time
//     none should be eliminated yet — we error if status !== "open")
//   - Optional shuffle so the seeding isn't just registration order.
//     If a deterministic seed is desired the admin can set entry.seed
//     and we sort by that instead.
//   - Pad to next power of two with byes.
//   - Build round 1 from pairs.
//   - Subsequent rounds are placeholders (winnerOf) until advance.
//
// Advancement:
//   - Read the latest tournament with bracket + entries.
//   - Find the latest "open" round (some match still missing a winner).
//   - For each match in that round: if its matchId points to a
//     completed PvpMatch, copy that winner into the match's winnerId
//     field and propagate the winnerOf placeholder in the next round
//     to a concrete player slot.
//   - Mark losers as eliminated.
//   - If the last round now has exactly one match with a winner,
//     mark the tournament completed and finishedAt.
//
// Idempotency: re-running generate on an already-generated bracket
// returns 409. Re-running advance on a fully-resolved round is a no-op.

export type BracketSlot =
  | { kind: "player"; userId: string; username: string }
  | { kind: "bye" }
  | { kind: "winnerOf"; matchId: string }
  | { kind: "tbd" };

export interface BracketMatch {
  /** Stable id within the bracket — we generate as `round-i.match-j`
   *  so advanceRound() can wire winnerOf placeholders deterministically. */
  id: string;
  a: BracketSlot;
  b: BracketSlot;
  /** PvpMatch.id once started. Null until started. */
  battleId?: string | null;
  /** Resolved winner userId. null until decided.
   *  byes auto-resolve at generation time. */
  winnerId?: string | null;
}

export interface BracketRound {
  index: number;
  matches: BracketMatch[];
}

export interface Bracket {
  rounds: BracketRound[];
}

interface EntryInput {
  userId: string;
  username: string;
  seed?: number | null;
}

/** Build a fresh bracket from a list of entries. Throws on <2 entries. */
export function generateBracket(entries: EntryInput[]): Bracket {
  if (entries.length < 2) {
    throw new Error("at least 2 entries required to generate a bracket");
  }
  // Order: explicit seed first (lower seed wins), then by username for
  // tie-break determinism. If no seeds are set anywhere we fall back
  // to a deterministic-but-shuffle-like order keyed off userId so
  // identical entries don't collide.
  const seeded = [...entries].sort((a, b) => {
    if (a.seed != null && b.seed != null && a.seed !== b.seed) return a.seed - b.seed;
    if (a.seed != null && b.seed == null) return -1;
    if (a.seed == null && b.seed != null) return 1;
    return a.userId.localeCompare(b.userId);
  });

  // Pad to the next power of two with byes so single-elim works
  // cleanly. Byes are inserted at the END of the seed list so the
  // top-seeded players get the byes (standard tournament practice).
  const target = nextPow2(seeded.length);
  const padded: (EntryInput | null)[] = [...seeded];
  while (padded.length < target) padded.push(null);

  // Round 1 — pair (1 vs N), (2 vs N-1), ... (this is "split" seeding,
  // common in real-world brackets so #1 doesn't meet #2 until the final).
  const round1: BracketMatch[] = [];
  for (let i = 0; i < target / 2; i++) {
    const a = padded[i];
    const b = padded[target - 1 - i];
    const slotA: BracketSlot = a
      ? { kind: "player", userId: a.userId, username: a.username }
      : { kind: "bye" };
    const slotB: BracketSlot = b
      ? { kind: "player", userId: b.userId, username: b.username }
      : { kind: "bye" };
    // Auto-resolve a bye immediately: if one slot is a bye, the
    // non-bye player is the winner and gets a free advance.
    const winnerId = slotA.kind === "bye" && slotB.kind === "player" ? slotB.userId
      : slotB.kind === "bye" && slotA.kind === "player" ? slotA.userId
      : null;
    round1.push({
      id: `r0.m${i}`,
      a: slotA,
      b: slotB,
      winnerId,
    });
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
        winnerId: null,
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

/** Apply newly-completed match results to the bracket. Returns the
 *  updated bracket + a list of winnerIds whose loser should be marked
 *  eliminated. Idempotent: rerunning with no new results no-ops.
 *
 *  matchResults: map of bracket-match-id → winner userId. Caller
 *  builds this by joining the bracket's `battleId` field against the
 *  PvpMatch table. */
export function advanceBracket(
  bracket: Bracket,
  matchResults: Record<string, string | null>,
): { bracket: Bracket; eliminatedUserIds: string[]; complete: boolean; championId: string | null } {
  const next: Bracket = {
    rounds: bracket.rounds.map((r) => ({
      ...r,
      matches: r.matches.map((m) => ({ ...m })),
    })),
  };
  const eliminated: Set<string> = new Set();

  // Apply incoming results to matches that don't already have a
  // winner. Skip ones already resolved — that's how byes propagate.
  for (const round of next.rounds) {
    for (const m of round.matches) {
      if (m.winnerId) continue;
      const result = matchResults[m.id];
      if (result == null) continue;
      m.winnerId = result;
      // Mark loser eliminated.
      const loserSlot = slotUserId(m.a) === result ? m.b : m.a;
      const loserId = slotUserId(loserSlot);
      if (loserId) eliminated.add(loserId);
    }
  }

  // Propagate resolved winners into the next round's winnerOf slots.
  propagateResolved(next.rounds);

  // Final check: if the last round has exactly one match with a
  // winner, the tournament is complete.
  const last = next.rounds[next.rounds.length - 1];
  const finalMatch = last?.matches.length === 1 ? last.matches[0] : null;
  const championId = finalMatch?.winnerId ?? null;

  return {
    bracket: next,
    eliminatedUserIds: Array.from(eliminated),
    complete: !!championId,
    championId,
  };
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
  // Build matchId → resolved player slot lookup, refreshed each pass.
  const lookup = (id: string): BracketSlot | null => {
    for (const r of rounds) {
      for (const m of r.matches) {
        if (m.id !== id) continue;
        if (!m.winnerId) return null;
        // Find the winner slot from m.a or m.b. Bye-winners come from
        // the surviving player slot.
        const slotA = m.a;
        const slotB = m.b;
        if (slotA.kind === "player" && slotA.userId === m.winnerId) return slotA;
        if (slotB.kind === "player" && slotB.userId === m.winnerId) return slotB;
        // If neither side is a concrete player but the match resolved
        // (should only happen for fully chained byes), we don't have
        // a username handy — fall back to a player slot with empty
        // username, which the UI will surface as "(unknown)".
        return { kind: "player", userId: m.winnerId, username: "" };
      }
    }
    return null;
  };
  let changed = true;
  while (changed) {
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
            changed = true;
          } else if (m.b.kind === "bye" && m.a.kind === "player") {
            m.winnerId = m.a.userId;
            changed = true;
          } else if (m.a.kind === "bye" && m.b.kind === "bye") {
            // Double bye — shouldn't happen with our padding, but be
            // safe rather than infinite-loop. Mark with a sentinel.
            m.winnerId = "__double_bye__";
            changed = true;
          }
        }
      }
    }
  }
}
