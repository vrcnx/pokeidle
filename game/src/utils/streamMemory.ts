// The stream director's notebook.
//
// The director LEARNS: which routes keep wiping it, which bosses have already
// beaten it, which shop items silently refuse to sell, which progression gate
// turned out to be a dead end. All of that used to live in React refs, which
// meant every frontend deploy — each of which force-reloads the streamed page
// — threw the lesson away and the account walked straight back into the fight
// that had just killed it, on camera, for another fifteen minutes.
//
// None of it is player progress, so it deliberately stays OUT of the save:
// putting scratch heuristics in `saveData` would round-trip them through the
// cloud, the validator and the admin tooling for no benefit. This is a local,
// disposable notebook that merely happens to survive a reload. If it is lost
// or corrupt the director just re-learns, which is cheap — so every read and
// write is best-effort and never throws.

const KEY = "pokemon-idle-stream-memory";
/** Bumped only when the shape changes incompatibly; a mismatch resets. */
const VERSION = 1;

export interface Strike {
  count: number;
  at: number;
}

export interface StreamMemory {
  v: number;
  /** locationId → whiteouts recorded there. */
  routeDanger: Record<string, Strike>;
  /** bossId → times that boss has beaten us. */
  bossLosses: Record<string, Strike>;
  /** itemId → epoch ms until which we stop trying to buy it. */
  unbuyable: Record<string, number>;
  /** locationId → epoch ms until which we stop treating it as the frontier. */
  frontierSkip: Record<string, number>;
}

function empty(): StreamMemory {
  return { v: VERSION, routeDanger: {}, bossLosses: {}, unbuyable: {}, frontierSkip: {} };
}

/** Defensive: anything we didn't write ourselves is treated as absent. */
function asStrikeMap(raw: unknown): Record<string, Strike> {
  const out: Record<string, Strike> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const s = v as Partial<Strike> | null;
    if (!s || typeof s.count !== "number" || typeof s.at !== "number") continue;
    if (!Number.isFinite(s.count) || !Number.isFinite(s.at)) continue;
    out[k] = { count: s.count, at: s.at };
  }
  return out;
}

function asStampMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

export function loadStreamMemory(): StreamMemory {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty();
    const parsed = JSON.parse(raw) as Partial<StreamMemory> | null;
    if (!parsed || parsed.v !== VERSION) return empty();
    return {
      v: VERSION,
      routeDanger: asStrikeMap(parsed.routeDanger),
      bossLosses: asStrikeMap(parsed.bossLosses),
      unbuyable: asStampMap(parsed.unbuyable),
      frontierSkip: asStampMap(parsed.frontierSkip),
    };
  } catch {
    return empty();
  }
}

export function persistStreamMemory(m: StreamMemory): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* quota / private mode — the director degrades to in-memory learning */
  }
}

// ---------------------------------------------------------------------------
// Strikes
// ---------------------------------------------------------------------------

/** Live strike count, ignoring (and pruning) anything that has aged out. */
export function strikeCount(map: Record<string, Strike>, key: string, ttlMs: number): number {
  const s = map[key];
  if (!s) return 0;
  if (Date.now() - s.at > ttlMs) {
    delete map[key];
    return 0;
  }
  return s.count;
}

/** Record another strike. Returns the new count. */
export function addStrike(map: Record<string, Strike>, key: string, ttlMs: number): number {
  const prev = strikeCount(map, key, ttlMs);
  const next = prev + 1;
  map[key] = { count: next, at: Date.now() };
  return next;
}

/** Drop expired entries. Returns true when anything was removed. */
export function pruneStrikes(map: Record<string, Strike>, ttlMs: number): boolean {
  const now = Date.now();
  let changed = false;
  for (const [k, s] of Object.entries(map)) {
    if (now - s.at > ttlMs) {
      delete map[k];
      changed = true;
    }
  }
  return changed;
}

/** Drop expired entries from an itemId/locationId → expiry-stamp map. */
export function pruneStamps(map: Record<string, number>): boolean {
  const now = Date.now();
  let changed = false;
  for (const [k, until] of Object.entries(map)) {
    if (until <= now) {
      delete map[k];
      changed = true;
    }
  }
  return changed;
}

export function markStamp(map: Record<string, number>, key: string, ttlMs: number): void {
  map[key] = Date.now() + ttlMs;
}

export function stampActive(map: Record<string, number>, key: string): boolean {
  const until = map[key];
  if (until == null) return false;
  if (until <= Date.now()) {
    delete map[key];
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Operator hold
// ---------------------------------------------------------------------------
//
// The admin's hand always outranks the autopilot. Without this the director
// would undo a manual `travel` on its very next tick, which from the
// dashboard reads as "the remote control is broken". Kept in module scope
// rather than localStorage on purpose: a reload ends the operator's session
// with the page they were steering, so the hold should not survive it.

let operatorAt = 0;

export function noteOperatorCommand(): void {
  operatorAt = Date.now();
}

/** Milliseconds of hands-off time left after the operator's last command. */
export function operatorHoldMsLeft(holdMs: number): number {
  if (operatorAt === 0) return 0;
  return Math.max(0, operatorAt + holdMs - Date.now());
}
