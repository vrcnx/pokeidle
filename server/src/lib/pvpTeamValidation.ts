// PvP team intake validation.
//
// Why this file exists: the three PvP team intake sites (battle:invite,
// battle:queue, battle:respond) each did nothing but
//
//     if (!Array.isArray(team) || team.length < 1 || team.length > 6)
//
// and then `team as never`. No stat bounds, no ownership check, no
// cross-reference against the player's save. The trade path has enforced
// zod bounds since it shipped (TradeOfferSchema in socket.ts) and
// replaces the offer with the SERVER-canonical mon at lock time; PvP
// never got either half. So a crafted socket payload could enter the
// rated queue with six Pokémon the sender never caught, at 31 IVs and
// arbitrary EVs, and `endBattle` would rate the result into PlayerRating
// unconditionally for random50.
//
// Scope of what was actually forgeable, measured rather than assumed:
//   - level     : NOT forgeable past 50 in the rated queue. applyLevelCap
//                 (pvp.ts) clamps every mon to levelCapForFormat, and
//                 random50 returns 50. Friend invites (anything-goes)
//                 have no cap, but they are not rated.
//   - species   : forgeable. Any Showdown-known species, owned or not.
//   - ivs/evs   : forgeable. pokemonToShowdownSet defaults absent IVs to
//                 31, so simply OMITTING ivs yields a perfect spread.
//                 EVs had no 252-per-stat and no 510-total ceiling.
//   - moves     : forgeable within the species' legality — the simulator
//                 does not enforce learnsets in Custom Game.
//   - ability   : forgeable, and unknown ids are cleared by
//                 adaptTeamForSimulator rather than refused.
//
// Two halves with deliberately different risk postures:
//
//   validatePvpTeam()   — ENFORCED now. Pure shape/bounds checking that
//                         mirrors TradeOfferSchema and saveValidation.ts.
//                         A legitimate client cannot fail it: the client
//                         already guarantees these bounds, and the same
//                         bounds have gated every trade for months. A
//                         team that fails is corrupt or crafted.
//
//   auditTeamOwnership() — SHADOW ONLY. Resolving each mon by id against
//                         the DB save is the check that actually stops
//                         species forgery, and it is also the one that
//                         can produce a false positive: saveData lags
//                         live client state by the autosave debounce
//                         (~1.5s) plus an HTTP roundtrip, which is the
//                         documented cause of the Haunter→Gastly trade
//                         bug. A mon caught seconds ago is legitimately
//                         absent from the DB. So this logs divergence and
//                         lets the battle proceed. Flip ENFORCE_OWNERSHIP
//                         once the logs are quiet — see the constant.
//
// Ordering note: validatePvpTeam is synchronous and runs on the socket
// thread before the room is built. auditTeamOwnership does DB I/O and is
// deliberately fire-and-forget — it must never delay a queue join or add
// a failure mode to matchmaking while it is only observing.

import { z } from "zod";
import { prisma } from "../db.js";
import { recordError } from "./errorReporting.js";

/**
 * Flip to true only after the pvp_team_unowned error rows have been
 * quiet for a sustained window. Enforcing while the shadow log is still
 * firing would reject legitimately-caught Pokémon and block queue joins,
 * which is a worse bug than the one being fixed.
 */
const ENFORCE_OWNERSHIP = false;

/** Showdown/game id shape — matches MoveSchema in socket.ts. */
const ID_RE = /^[a-zA-Z0-9_-]{1,40}$/;

const StatBlock = z.record(z.string(), z.number().int().min(0).max(31));
const EvBlock = z.record(z.string(), z.number().int().min(0).max(252));

const PvpMonSchema = z.object({
  // `id` is what ownership resolution keys on. The client sends whole
  // game Pokemon objects, so it is always present for a real team; a
  // payload without it cannot be checked at all and is refused.
  id: z.string().regex(ID_RE),
  speciesKey: z.string().regex(ID_RE),
  name: z.string().max(40).optional(),
  nickname: z.string().max(32).nullable().optional(),
  level: z.number().int().min(1).max(100),
  isShiny: z.boolean().optional(),
  heldItem: z.string().regex(ID_RE).nullable().optional(),
  nature: z.string().max(20).nullable().optional(),
  ability: z.string().max(40).nullable().optional(),
  // Stat ceilings mirror TradeOfferSchema, which mirrors saveValidation.
  currentHp: z.number().min(0).max(999).optional(),
  maxHp: z.number().min(1).max(999).optional(),
  attack: z.number().min(0).max(800).optional(),
  defense: z.number().min(0).max(800).optional(),
  spAttack: z.number().min(0).max(800).optional(),
  spDefense: z.number().min(0).max(800).optional(),
  speed: z.number().min(0).max(800).optional(),
  ivs: StatBlock.optional(),
  evs: EvBlock.optional(),
  moves: z.array(z.object({ id: z.string().regex(ID_RE) }).passthrough()).max(4).optional(),
  // Passthrough for the rest of the client's bookkeeping (status,
  // sleepTurns, statStages, totalExp, …). pokemonToShowdownSet reads a
  // fixed field list, so extra keys are inert — but strict() would
  // reject every real team, since the client sends the whole object.
}).passthrough();

/**
 * Gen-5 EV budget. The game's own catch/EV-training paths cannot exceed
 * this, so a team that does was not produced by playing.
 */
const MAX_TOTAL_EVS = 510;

export type PvpTeamMon = z.infer<typeof PvpMonSchema>;

export type PvpTeamResult =
  | { ok: true; team: PvpTeamMon[] }
  | { ok: false; error: string };

/**
 * Enforced shape + bounds check for an incoming PvP team. Returns a
 * discriminated result rather than throwing so the socket handler can
 * ack a reason.
 */
export function validatePvpTeam(team: unknown): PvpTeamResult {
  if (!Array.isArray(team) || team.length < 1 || team.length > 6) {
    return { ok: false, error: "team must be 1..6 mons" };
  }
  const out: PvpTeamMon[] = [];
  for (let i = 0; i < team.length; i++) {
    const parsed = PvpMonSchema.safeParse(team[i]);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const where = first?.path?.join(".") || "?";
      return { ok: false, error: `team[${i}].${where}: ${first?.message ?? "invalid"}` };
    }
    const mon = parsed.data;
    // Per-stat ceilings are handled by EvBlock; the total is a separate
    // rule the record schema cannot express.
    if (mon.evs) {
      let total = 0;
      for (const v of Object.values(mon.evs)) total += v;
      if (total > MAX_TOTAL_EVS) {
        return { ok: false, error: `team[${i}].evs: total ${total} exceeds ${MAX_TOTAL_EVS}` };
      }
    }
    out.push(mon);
  }
  // Duplicate ids would let one Pokémon fill six slots.
  const ids = new Set<string>();
  for (const m of out) {
    if (ids.has(m.id)) return { ok: false, error: "team has duplicate Pokémon" };
    ids.add(m.id);
  }
  return { ok: true, team: out };
}

/**
 * Resolve every team member against the sender's stored save and report
 * anything that isn't there.
 *
 * Shadow mode by default: returns the list of unowned ids for the caller
 * to log, and never blocks. With ENFORCE_OWNERSHIP on, the caller should
 * refuse the join when this is non-empty.
 *
 * Deliberately tolerant of a missing/malformed save: an unreadable save
 * is not evidence of forgery, and treating it as such would lock a
 * player with a fresh account out of PvP entirely.
 */
export async function auditTeamOwnership(
  userId: string,
  team: PvpTeamMon[],
  context: { format: string; via: string; username?: string },
): Promise<{ unowned: string[]; checked: boolean }> {
  let row: { saveData: string | null } | null = null;
  try {
    row = await prisma.user.findUnique({
      where: { id: userId },
      select: { saveData: true },
    });
  } catch {
    return { unowned: [], checked: false };
  }
  if (!row?.saveData) return { unowned: [], checked: false };

  let owned: Set<string>;
  try {
    const save = JSON.parse(row.saveData) as { party?: unknown; box?: unknown };
    owned = new Set<string>();
    for (const list of [save.party, save.box]) {
      if (!Array.isArray(list)) continue;
      for (const m of list) {
        const id = (m as { id?: unknown } | null)?.id;
        if (typeof id === "string") owned.add(id);
      }
    }
  } catch {
    return { unowned: [], checked: false };
  }
  // An empty owned-set means the save has no party AND no box, which is
  // indistinguishable from "we failed to read it". Don't accuse.
  if (owned.size === 0) return { unowned: [], checked: false };

  const unowned = team.filter((m) => !owned.has(m.id)).map((m) => m.id);
  if (unowned.length > 0) {
    void recordError({
      kind: "server",
      message: "pvp_team_unowned",
      source: "pvp.teamIntake",
      meta: {
        userId,
        username: context.username ?? null,
        via: context.via,
        format: context.format,
        enforced: ENFORCE_OWNERSHIP,
        unownedCount: unowned.length,
        teamSize: team.length,
        // Species rather than raw ids: the useful signal is "which mons
        // did this player claim", and ids alone are opaque in triage.
        unowned: team
          .filter((m) => unowned.includes(m.id))
          .map((m) => ({ id: m.id, species: m.speciesKey, level: m.level })),
      },
    });
  }
  return { unowned, checked: true };
}

export { ENFORCE_OWNERSHIP };
