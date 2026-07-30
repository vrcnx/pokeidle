// Rematch plumbing: "battle again" without asking the player to re-pick the
// team they just fought with.
//
// A rematch needs two things the finished room does not hand over directly.
//
// 1. THE TEAM AS REAL POKÉMON. The room only holds the SIMULATOR's view of it
//    — `request.side.pokemon[]`, whose entries are `{ ident: "p1: Espeon",
//    details: "Espeon, L50, F" }`. `startBotBattle` / `joinRandomQueue` /
//    `sendBattleInvite` all want `Pokemon[]` from the save. So the roster is
//    resolved BACK against the player's own party and box.
//
//    Matching is on species plus the displayed name, NOT on level: the
//    random50 format caps the team at Lv 50 server-side, so a Lv 78 Snorlax
//    arrives in `details` as "Snorlax, L50" and a level compare would reject
//    every rated team. Each save Pokémon is consumed at most once, so a party
//    with three Rattata resolves to three different Rattata rather than the
//    same one three times.
//
//    Returns null rather than a partial team when anything fails to resolve
//    (a mon released between battles, a nickname changed mid-match). The caller
//    falls back to the team builder, which is the same flow the battle hub
//    uses — an extra tap, never a wrong team.
//
// 2. WHICH AI IT WAS. A practice room's `opponent.id` is `bot:<battleId>`,
//    which carries no trainer identity, and `opponent.username` is the seat
//    LABEL ("Bug Catcher AI"). The server's roster derives that label from the
//    trainer id (`{ id: "bugcatcher", label: "Bug Catcher AI" }`), so the id is
//    recoverable locally with the same id normalisation the rest of the stack
//    uses — no extra round trip. A miss is harmless: `battle:bot` treats an
//    unknown `trainer` as "no preference" and picks its own recommendation, so
//    the worst case is a fair practice battle against someone else rather than
//    a failure.

import type { Pokemon } from "../types";

/** Trainer-seat label → the server's trainer id, or null when the label is
 *  not an AI seat's. Every AI label ends in " AI" (a space is impossible in a
 *  real username, which is what makes this unambiguous). */
export function botTrainerIdFromLabel(label: string): string | null {
  const m = /^(.*)\sAI$/.exec(label.trim());
  if (!m) return null;
  const id = m[1].toLowerCase().replace(/[^a-z0-9]/g, "");
  return id ? id : null;
}

/** The bits of a `request.side.pokemon` entry this needs. */
export interface RosterEntry {
  ident: string;
  details: string;
}

/** "p1: Espeon" → "Espeon". The nickname when one is set, else the species. */
function identName(ident: string): string {
  const i = ident.indexOf(":");
  return (i >= 0 ? ident.slice(i + 1) : ident).trim();
}

/** "Espeon, L50, F" → "espeon". Same strip as `parseDetails`, so Mr. Mime,
 *  Nidoran-F and Farfetch'd all land on the key the sprite loader uses. */
function detailsSpeciesKey(details: string): string {
  return (details.split(",")[0] ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function displayNameOf(p: Pokemon): string {
  return p.nickname && p.nickname.trim() ? p.nickname : p.name;
}

/**
 * Resolve the simulator's roster back to the player's own Pokémon, in the
 * order the battle used them.
 *
 * `pool` should be party THEN box, so a Pokémon that is in both lists (it
 * cannot be, but the ordering also decides which duplicate is picked first)
 * resolves to the party copy.
 */
export function resolveRematchTeam(
  roster: readonly RosterEntry[],
  pool: readonly Pokemon[],
): Pokemon[] | null {
  if (roster.length === 0) return null;
  const used = new Set<string>();
  const out: Pokemon[] = [];
  for (const entry of roster) {
    const key = detailsSpeciesKey(entry.details);
    const name = identName(entry.ident);
    const hit =
      // Species AND displayed name: the strongest signal available, and the
      // one that keeps two same-species mons apart when one is nicknamed.
      pool.find((p) => !used.has(p.id) && p.speciesKey === key && displayNameOf(p) === name)
      // Species alone, for a mon renamed since the battle started.
      ?? pool.find((p) => !used.has(p.id) && p.speciesKey === key);
    if (!hit) return null;
    used.add(hit.id);
    out.push(hit);
  }
  return out;
}

/** Formats a friend rematch may be sent in. `battle:invite` whitelists exactly
 *  these two server-side (tournament rooms are spawned by the bracket runner,
 *  never by a player), so anything else has to fall back rather than be
 *  refused with "bad target". */
export function rematchFormatFor(format: string): "random50" | "anything-goes" {
  return format === "random50" ? "random50" : "anything-goes";
}
