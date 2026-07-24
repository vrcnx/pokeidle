// Server-side save validation. Blocks the obvious cheats — illegal levels,
// negative money, oversized parties, HP exceeding maxHP — by rejecting
// saves that violate the bounds before they're persisted. Tightened to
// also reject inflated stats: IVs > 31, EV totals > 510, stat values
// beyond the theoretical Lv100 max, etc. The full list of valid
// species/moves lives in the game frontend; here we keep validation
// generic and fast (bounds checks, not deep schema mirrors).
//
// This is a defence-in-depth layer, not a hermetic seal — a determined
// cheater can still send a save where every value is "within bounds"
// but artificially inflated. Pair this with the version-monotonic check
// (saves can only move forward, not backward) and the per-account
// account-level recomputation on the server to make manipulation
// pointless for things like leaderboards.

const MAX_LEVEL = 100;
const MAX_PARTY = 6;
// 600 was the original cap, but veteran auto-catch accounts blew past
// it within weeks — once a player crossed 600 box mons every save
// POST started 400-ing, and once the trade flow's liveSnapshot got
// dropped by the same validator, ownership verification fell back to
// a now-stale DB save and trades cancelled with "Cannot be verified
// as the owner of the offered Pokémon". Bumping to 9999 (≈ 16
// traditional Pokémon PC boxes) covers any realistic account.
export const MAX_BOX = 9999;
const MAX_INVENTORY_STACK = 999_999;
const MAX_MONEY = 999_999_999;
const MAX_IV = 31;
const MAX_EV_PER_STAT = 252;
const MAX_EV_TOTAL = 510;
// Theoretical Lv 100 stat ceiling: 2*255 + 31 + 252/4 = 614 → final
// non-HP stat ≈ 614*100/100 + 5 → ~619 × 1.1 nature ≈ 681. Round up to
// give wiggle room for rounding / future species rebalances.
const MAX_HP_STAT = 999;
const MAX_OTHER_STAT = 800;
// Per-move PP cap. Real moves go up to 64 with PP-Up; double that as a
// safety margin since some moves use larger maxPp internally.
const MAX_PP = 128;
const MAX_NICKNAME = 32;
const MOVE_KEY_RE = /^[a-zA-Z0-9_-]{1,40}$/;
const SPECIES_KEY_RE = /^[a-zA-Z0-9_-]{1,40}$/;
const ITEM_KEY_RE = /^[a-zA-Z0-9_-]{1,40}$/;
const ID_KEY_RE = /^[a-zA-Z0-9_-]{1,40}$/;

interface PokemonShape {
  id?: unknown;
  level?: unknown;
  maxHp?: unknown;
  currentHp?: unknown;
  speciesKey?: unknown;
  totalExp?: unknown;
  attack?: unknown;
  defense?: unknown;
  spAttack?: unknown;
  spDefense?: unknown;
  speed?: unknown;
  ivs?: unknown;
  evs?: unknown;
  moves?: unknown;
  nickname?: unknown;
  heldItem?: unknown;
  isShiny?: unknown;
  nature?: unknown;
  ability?: unknown;
}

function validateStatBounds(name: string, val: unknown, max: number, where: string): string | null {
  if (typeof val !== "number" || !Number.isFinite(val) || val < 0 || val > max) {
    return `${where}: ${name} must be 0..${max}`;
  }
  return null;
}

function validatePokemon(p: PokemonShape, where: string): string | null {
  if (!p || typeof p !== "object") return `${where}: must be object`;

  // Identity
  if (typeof p.speciesKey !== "string" || !SPECIES_KEY_RE.test(p.speciesKey))
    return `${where}: bad speciesKey`;
  if (p.id !== undefined && (typeof p.id !== "string" || !ID_KEY_RE.test(p.id)))
    return `${where}: bad id`;

  // Level + EXP
  if (typeof p.level !== "number" || !Number.isInteger(p.level) || p.level < 1 || p.level > MAX_LEVEL)
    return `${where}: level must be 1..${MAX_LEVEL}`;
  // totalExp is a pure tracking number — it grants no stat and level is
  // validated separately (1..MAX_LEVEL), so a huge value is harmless, not a
  // cheat. The old 2,000,000 cap rejected legit saves: a level-100 Pokémon
  // keeps accumulating exp past its level requirement, so a long-grinding
  // mon's totalExp climbs above 2M and bricked the whole save's cloud backup
  // ("not backing up"). Keep only a sane anti-garbage ceiling.
  if (typeof p.totalExp !== "number" || !Number.isFinite(p.totalExp) || p.totalExp < 0 || p.totalExp > 1_000_000_000)
    return `${where}: bad totalExp`;

  // HP
  if (typeof p.maxHp !== "number" || p.maxHp < 1 || p.maxHp > MAX_HP_STAT)
    return `${where}: maxHp out of range`;
  if (typeof p.currentHp !== "number" || p.currentHp < 0 || p.currentHp > p.maxHp)
    return `${where}: currentHp out of range`;

  // Other stats
  for (const k of ["attack", "defense", "spAttack", "spDefense", "speed"] as const) {
    const err = validateStatBounds(k, p[k], MAX_OTHER_STAT, where);
    if (err) return err;
  }

  // IVs (0-31 each, six stats expected)
  if (p.ivs !== undefined) {
    if (!p.ivs || typeof p.ivs !== "object" || Array.isArray(p.ivs))
      return `${where}: ivs must be object`;
    for (const k of ["hp", "attack", "defense", "spAttack", "spDefense", "speed"] as const) {
      const v = (p.ivs as Record<string, unknown>)[k];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_IV)
        return `${where}: ivs.${k} must be 0..${MAX_IV}`;
    }
  }

  // EVs (0-252 each, total ≤ 510)
  if (p.evs !== undefined) {
    if (!p.evs || typeof p.evs !== "object" || Array.isArray(p.evs))
      return `${where}: evs must be object`;
    let total = 0;
    for (const k of ["hp", "attack", "defense", "spAttack", "spDefense", "speed"] as const) {
      const v = (p.evs as Record<string, unknown>)[k];
      if (v === undefined || v === null) continue; // partial EV maps are fine
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_EV_PER_STAT)
        return `${where}: evs.${k} must be 0..${MAX_EV_PER_STAT}`;
      total += v;
    }
    if (total > MAX_EV_TOTAL) return `${where}: evs total > ${MAX_EV_TOTAL}`;
  }

  // Moves: max 4, each move id is a slug, pp/maxPp non-negative
  if (p.moves !== undefined) {
    if (!Array.isArray(p.moves)) return `${where}: moves must be array`;
    if (p.moves.length > 4) return `${where}: moves > 4`;
    for (let i = 0; i < p.moves.length; i++) {
      const m = p.moves[i];
      if (!m || typeof m !== "object") return `${where}: moves[${i}] must be object`;
      if (typeof (m as any).id !== "string" || !MOVE_KEY_RE.test((m as any).id))
        return `${where}: moves[${i}].id`;
      if (typeof (m as any).maxPp !== "number" || (m as any).maxPp < 0 || (m as any).maxPp > MAX_PP)
        return `${where}: moves[${i}].maxPp`;
      if (typeof (m as any).pp !== "number" || (m as any).pp < 0 || (m as any).pp > (m as any).maxPp)
        return `${where}: moves[${i}].pp`;
    }
  }

  // Strings / flags
  if (p.nickname !== undefined && (typeof p.nickname !== "string" || p.nickname.length > MAX_NICKNAME))
    return `${where}: nickname too long`;
  if (p.heldItem !== undefined && p.heldItem !== null) {
    if (typeof p.heldItem !== "string" || !ITEM_KEY_RE.test(p.heldItem))
      return `${where}: bad heldItem`;
  }
  if (p.nature !== undefined && (typeof p.nature !== "string" || p.nature.length > 20))
    return `${where}: bad nature`;
  if (p.ability !== undefined && p.ability !== null) {
    if (typeof p.ability !== "string" || p.ability.length > 40)
      return `${where}: bad ability`;
  }
  if (p.isShiny !== undefined && typeof p.isShiny !== "boolean")
    return `${where}: isShiny must be boolean`;

  return null;
}

export function validateSave(save: unknown): { ok: true } | { ok: false; reason: string } {
  if (!save || typeof save !== "object") return { ok: false, reason: "save must be an object" };
  const s = save as Record<string, unknown>;

  // Money
  if (s.money !== undefined) {
    if (typeof s.money !== "number" || s.money < 0 || s.money > MAX_MONEY)
      return { ok: false, reason: "money out of range" };
  }

  // Party
  if (s.party !== undefined) {
    if (!Array.isArray(s.party)) return { ok: false, reason: "party must be array" };
    if (s.party.length > MAX_PARTY) return { ok: false, reason: `party > ${MAX_PARTY}` };
    for (let i = 0; i < s.party.length; i++) {
      const err = validatePokemon(s.party[i], `party[${i}]`);
      if (err) return { ok: false, reason: err };
    }
  }

  // Box
  if (s.box !== undefined) {
    if (!Array.isArray(s.box)) return { ok: false, reason: "box must be array" };
    if (s.box.length > MAX_BOX) return { ok: false, reason: `box > ${MAX_BOX}` };
    for (let i = 0; i < s.box.length; i++) {
      const err = validatePokemon(s.box[i], `box[${i}]`);
      if (err) return { ok: false, reason: err };
    }
  }

  // Active player Pokémon — must exist in the party.
  if (typeof s.activePlayerPokemonIndex === "number") {
    if (
      Array.isArray(s.party) &&
      (s.activePlayerPokemonIndex < 0 || s.activePlayerPokemonIndex >= s.party.length)
    ) {
      return { ok: false, reason: "activePlayerPokemonIndex out of range" };
    }
  }

  // Inventory: every entry must be a non-negative integer under the cap.
  if (s.inventory !== undefined) {
    if (!s.inventory || typeof s.inventory !== "object" || Array.isArray(s.inventory))
      return { ok: false, reason: "inventory must be an object" };
    for (const [k, v] of Object.entries(s.inventory as Record<string, unknown>)) {
      if (typeof v !== "number" || v < 0 || v > MAX_INVENTORY_STACK || !Number.isInteger(v))
        return { ok: false, reason: `inventory[${k}] out of range` };
    }
  }

  // Pokédex caught/seen lists must be string arrays.
  for (const key of ["pokedexCaught", "pokedexSeen", "shinyCaught", "shinySeen", "defeatedGyms", "claimedRegionStarters"]) {
    if (s[key] !== undefined) {
      if (!Array.isArray(s[key])) return { ok: false, reason: `${key} must be array` };
      for (const v of s[key] as unknown[]) {
        if (typeof v !== "string") return { ok: false, reason: `${key} entry must be string` };
      }
    }
  }

  return { ok: true };
}

// Clamp recoverable, harmless per-Pokémon inconsistencies IN PLACE before
// validation, so legitimate play doesn't brick the whole save's cloud backup.
// The prime offender: currentHp > maxHp (a transient after an evolution or an
// over-heal). Clamping HP DOWN can never be a cheat — battles already cap at
// maxHp — so it's always safe to fix rather than reject. Returns true if it
// changed anything (useful for logging), but callers can ignore that.
export function sanitizeSave(save: unknown): boolean {
  if (!save || typeof save !== "object") return false;
  let changed = false;
  const clampMon = (m: any) => {
    if (!m || typeof m !== "object") return;
    if (typeof m.maxHp === "number" && typeof m.currentHp === "number") {
      if (m.currentHp > m.maxHp) { m.currentHp = m.maxHp; changed = true; }
      else if (m.currentHp < 0) { m.currentHp = 0; changed = true; }
    }
  };
  const s = save as { party?: unknown; box?: unknown };
  if (Array.isArray(s.party)) s.party.forEach(clampMon);
  if (Array.isArray(s.box)) s.box.forEach(clampMon);
  return changed;
}
