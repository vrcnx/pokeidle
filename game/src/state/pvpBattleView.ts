// Complete Showdown-protocol → battle-state reducer.
//
// WHY THIS EXISTS
//
// The simulator is Showdown's real Gen 5 engine, so every mechanic
// already resolves correctly on the server. What was missing was the
// client's ability to SEE it. The old decoder handled 11 protocol tags
// and `LogLine` rendered anything it didn't recognise as literally
// nothing, so a PvP battle silently dropped:
//
//   |-cant|       — paralysis / sleep / freeze / flinch. The single
//                   worst omission: your turn visibly did nothing and no
//                   line explained why. That alone reads as "PvP is
//                   broken", and it is the most common thing that
//                   happens in a real battle after "a move hit".
//   |-supereffective| / |-resisted| / |-immune|
//                 — type effectiveness, i.e. the core of the game.
//   |-boost| / |-unboost|
//                 — Swords Dance appeared to do nothing at all.
//   |-weather|, |-sidestart|, |-fieldstart|, |-start|, |-activate|,
//   |-crit|, |-miss|, |-item|, |-ability|, |-curestatus|, |-prepare|…
//
// It ALSO tracked foe state by re-walking the whole log on every render
// and only understood damage/heal/status/faint, so a foe's status never
// cleared, boosts never showed, and HP drifted out of sync.
//
// DESIGN
//
// One pure reducer, `applyLine(view, line, mySide) -> view`, plus an
// initial state. Pure because it is the part that has to be RIGHT: it can
// then be driven by a real @pkmn/sim battle in a test and asserted
// exactly, which is the only way to know a protocol decoder is correct.
// No React, no sockets, no imports from the game state.
//
// PROTOCOL NOTES that shaped this file (all verified against @pkmn/sim
// output, not from memory):
//
//  * Modifier lines follow their move and refer to it implicitly:
//    |move|…  then |-supereffective|…  |-crit|…  |-damage|…
//    So effectiveness/crit must ATTACH to the move's narration rather
//    than become their own log lines, or the log reads like a stack
//    dump. `pendingMove` does that attaching.
//  * HP: I expected the foe's to arrive as a percentage (`48/100`) and
//    only your own as absolute. Capturing a real battle disproved that —
//    in gen5customgame the player stream reports EXACT HP for both sides
//    ("|switch|p2a: Charizard|Charizard, L50, F|154/154"). So the parser
//    treats a fraction as exact wherever it appears, and does not
//    special-case the seat. Worth re-checking if the format ever changes,
//    since a format that hides foe HP sends `100/100` and a naive reader
//    would report a full-health foe forever.
//  * |raw| carries HTML and |debug| carries engine internals ("rain water
//    boost"). Both appear in ordinary battles and both must be silenced,
//    or they reach the player as log lines.
//  * `[from]` / `[of]` suffixes carry the CAUSE (Leftovers, Spikes,
//    Sandstorm, an ability). Without reading them, "Your Snorlax: 88/100"
//    is unattributable and looks like a bug.
//  * Boosts are cumulative per stat and reset on switch-out. Volatiles
//    (confusion, Substitute, Leech Seed, Taunt) live on the ACTIVE mon
//    and also clear on switch. Getting the clearing wrong is how a
//    tracker ends up claiming a fresh Pokémon is confused.
//  * p1 is always side "a" and p2 side "b" — set by the server when it
//    creates the streams.

export type BoostStat = "atk" | "def" | "spa" | "spd" | "spe" | "accuracy" | "evasion";
export type StatusCode = "brn" | "psn" | "tox" | "par" | "slp" | "frz";

export interface ActiveMon {
  /** Raw protocol ident, e.g. "p1a: Pikachu". */
  ident: string;
  /** Display name (nickname if set, else species). */
  name: string;
  speciesKey: string;
  level: number;
  gender: "M" | "F" | "";
  shiny: boolean;
  hp: number;
  maxHp: number;
  hpPct: number;
  /** False for the foe, whose HP the protocol only reveals as a %. */
  hpKnownExact: boolean;
  status: StatusCode | null;
  fainted: boolean;
  boosts: Partial<Record<BoostStat, number>>;
  /** confusion, substitute, leechseed, taunt, encore, … */
  volatiles: string[];
  /** Set while a two-turn move is charging (Fly, Dig, Solar Beam). */
  charging: string | null;
}

export interface BenchMon {
  ident: string;
  name: string;
  speciesKey: string;
  level: number;
  hpPct: number;
  status: StatusCode | null;
  fainted: boolean;
  active: boolean;
  /** Only known for your own side. */
  revealed: boolean;
}

/**
 * One roster entry as Team Preview reveals it.
 *
 * This is a DIFFERENT shape from BenchMon on purpose, and the difference is the
 * whole information-security story of the phase: there is no ident (the
 * protocol does not send a nickname at preview — measured: a Pokémon nicknamed
 * "SECRETNAME" arrives as `|poke|p1|Pikachu, L50, F|`), no HP, no status, no
 * moves, no item and no ability. Reusing BenchMon would have meant inventing
 * `hpPct: 100` and an `ident` for something the server never said, and a lie in
 * the model is how a lie reaches the screen.
 *
 * `slot` is the 1-based position in the side's own `|poke|` order, which is
 * exactly the number the `team N` choice takes.
 */
export interface PreviewMon {
  slot: number;
  speciesKey: string;
  level: number;
  gender: "M" | "F" | "";
}

export interface SideView {
  /** Trainer name as the protocol announced it. */
  player: string;
  teamSize: number;
  active: ActiveMon | null;
  bench: BenchMon[];
  /** The Team Preview roster, from `|poke|`. Empty except during the phase and
   *  after it — the lines arrive once and are never re-sent, so this is kept
   *  rather than cleared at `|start`: it is the only record of the opponent's
   *  FULL team, and the rail's "+2 not yet revealed" count reads better against
   *  a roster than against a number. */
  preview: PreviewMon[];
  hazards: { spikes: number; toxicspikes: number; stealthrock: boolean; stickyweb: boolean };
  screens: Record<string, number | true>;
}

export interface BattleView {
  turn: number;
  weather: { id: string; label: string } | null;
  field: string[];
  you: SideView;
  foe: SideView;
  /** True between `|teampreview` and `|start` — i.e. exactly while the
   *  simulator is waiting for both sides' team orders.
   *
   *  Derived from the SHARED protocol rather than from `request.teamPreview`,
   *  deliberately. The request is the authority on "may I still choose", which
   *  goes false for me the instant I lock in while the phase carries on; this
   *  flag is the authority on "what is on screen", which must stay true while I
   *  wait for the opponent. The picker needs both and they are not the same
   *  question. */
  teamPreview: boolean;
  /** Terminal state, mirrored from |win| / |tie|. */
  ended: { winner: string | null; tie: boolean } | null;
}

export interface NarrationLine {
  /** Stable-ish key for React; the index is appended by the caller. */
  kind:
    | "turn" | "move" | "switch" | "faint" | "damage" | "heal" | "status"
    | "cure" | "boost" | "unboost" | "weather" | "hazard" | "field"
    | "ability" | "item" | "volatile" | "cant" | "miss" | "fail"
    | "win" | "tie" | "info" | "error";
  text: string;
  /** Which side the line is about, when it is about one. */
  side?: "a" | "b";
  /** Effectiveness/crit annotations attached to a move line. */
  tags?: string[];
}

// ── Static protocol vocabulary ──────────────────────────────────────

const STATUS_LABEL: Record<StatusCode, string> = {
  brn: "burned", psn: "poisoned", tox: "badly poisoned",
  par: "paralyzed", slp: "asleep", frz: "frozen",
};

const BOOST_LABEL: Record<BoostStat, string> = {
  atk: "Attack", def: "Defense", spa: "Sp. Atk", spd: "Sp. Def",
  spe: "Speed", accuracy: "accuracy", evasion: "evasiveness",
};

const WEATHER_LABEL: Record<string, string> = {
  RainDance: "Rain", SunnyDay: "Harsh sunlight", Sandstorm: "Sandstorm",
  Hail: "Hail", none: "",
};

/** |-sidestart| condition → our hazard/screen key. */
const SIDE_CONDITION: Record<string, string> = {
  "move: Spikes": "spikes",
  "move: Toxic Spikes": "toxicspikes",
  "move: Stealth Rock": "stealthrock",
  "move: Sticky Web": "stickyweb",
  "move: Reflect": "reflect",
  "move: Light Screen": "lightscreen",
  "move: Safeguard": "safeguard",
  "move: Mist": "mist",
  "move: Tailwind": "tailwind",
  "move: Lucky Chant": "luckychant",
};

const SIDE_LABEL: Record<string, string> = {
  spikes: "Spikes", toxicspikes: "Toxic Spikes", stealthrock: "Stealth Rock",
  stickyweb: "Sticky Web", reflect: "Reflect", lightscreen: "Light Screen",
  safeguard: "Safeguard", mist: "Mist", tailwind: "Tailwind",
  luckychant: "Lucky Chant",
};

/** Reasons |-cant| can fire, in Showdown's own vocabulary. */
const CANT_REASON: Record<string, string> = {
  par: "is paralyzed! It can't move",
  slp: "is fast asleep",
  frz: "is frozen solid",
  flinch: "flinched and couldn't move",
  recharge: "must recharge",
  truant: "is loafing around",
  "move: Taunt": "can't use that move after the taunt",
  "move: Imprison": "can't use the sealed move",
  "move: Gravity": "can't use that move under gravity",
  "move: Heal Block": "can't heal",
  nopp: "has no PP left for that move",
};

// ── Construction ────────────────────────────────────────────────────

function emptySide(player: string): SideView {
  return {
    player,
    teamSize: 0,
    active: null,
    bench: [],
    preview: [],
    hazards: { spikes: 0, toxicspikes: 0, stealthrock: false, stickyweb: false },
    screens: {},
  };
}

export function initialBattleView(youName = "You", foeName = "Opponent"): BattleView {
  return {
    turn: 0,
    weather: null,
    field: [],
    you: emptySide(youName),
    foe: emptySide(foeName),
    teamPreview: false,
    ended: null,
  };
}

// ── Parsing helpers ─────────────────────────────────────────────────

/** "p1a: Pikachu" → side "a"; "p2b: Foo" → "b". */
function sideOf(token: string | undefined): "a" | "b" | null {
  if (!token) return null;
  if (token.startsWith("p1")) return "a";
  if (token.startsWith("p2")) return "b";
  return null;
}

function nameOf(token: string | undefined): string {
  if (!token) return "";
  const i = token.indexOf(":");
  return i >= 0 ? token.slice(i + 1).trim() : token;
}

/**
 * "Pikachu, L50, M, shiny" → parts. Species must survive Mr. Mime,
 * Nidoran-F, Porygon-Z and Farfetch'd, so the key strips to alphanum —
 * matching `toShowdownId` on the server and the sprite loader's slugs.
 */
export function parseDetails(details: string): {
  speciesKey: string; level: number; gender: "M" | "F" | ""; shiny: boolean;
} {
  const segs = details.split(",").map((s) => s.trim());
  const speciesKey = (segs[0] ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  let level = 100;
  let gender: "M" | "F" | "" = "";
  let shiny = false;
  for (const s of segs.slice(1)) {
    if (/^L\d+$/i.test(s)) level = parseInt(s.slice(1), 10);
    else if (s === "M" || s === "F") gender = s;
    else if (s === "shiny") shiny = true;
  }
  return { speciesKey, level, gender, shiny };
}

/** "191/258 brn" | "48/100" | "0 fnt" → structured condition. */
export function parseCondition(cond: string): {
  hp: number; maxHp: number; hpPct: number; status: StatusCode | null; fainted: boolean;
} {
  const fainted = /\bfnt\b/.test(cond);
  let status: StatusCode | null = null;
  for (const s of ["brn", "psn", "tox", "par", "slp", "frz"] as StatusCode[]) {
    if (new RegExp(`\\b${s}\\b`).test(cond)) { status = s; break; }
  }
  const m = cond.match(/(\d+)\s*\/\s*(\d+)/);
  if (fainted) return { hp: 0, maxHp: m ? parseInt(m[2], 10) : 100, hpPct: 0, status: null, fainted: true };
  if (!m) return { hp: 100, maxHp: 100, hpPct: 100, status, fainted: false };
  const hp = parseInt(m[1], 10);
  const maxHp = parseInt(m[2], 10);
  return { hp, maxHp, hpPct: maxHp > 0 ? (hp / maxHp) * 100 : 0, status, fainted: false };
}

/** Pull `[from] item: Leftovers` / `[of] p2a: Foo` style suffixes. */
function kwargs(parts: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of parts) {
    const m = p.match(/^\[([a-z]+)\]\s*(.*)$/i);
    if (m) out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}

/** "item: Leftovers" / "move: Spikes" / "ability: Intimidate" → tail. */
function stripEffectPrefix(s: string): string {
  return s.replace(/^(item|move|ability):\s*/i, "").trim();
}

// ── The reducer ─────────────────────────────────────────────────────

export interface ApplyResult {
  view: BattleView;
  /** Narration produced by this line, if any. */
  lines: NarrationLine[];
}

/**
 * Fold one protocol line into the view. `mySide` is which seat the
 * viewer occupies, so narration can say "Your" vs the opponent's name
 * and the right SideView gets mutated. Spectators pass "a" and get
 * absolute framing via `neutral`.
 *
 * `pendingMove` is carried on the view-adjacent scratch object rather
 * than the view itself because it is presentation state, not battle
 * state, and must not survive a re-render of a completed battle.
 */
export function applyLine(
  view: BattleView,
  line: string,
  mySide: "a" | "b",
  scratch: { pendingMove: NarrationLine | null },
  neutral = false,
): ApplyResult {
  if (!line.startsWith("|")) {
    return { view, lines: line.trim() ? [{ kind: "info", text: line.trim() }] : [] };
  }
  const parts = line.split("|");
  const tag = parts[1] ?? "";
  const kw = kwargs(parts);

  // Which SideView a protocol side maps to, from the viewer's seat.
  const viewSideKey = (s: "a" | "b" | null): "you" | "foe" | null =>
    s === null ? null : s === mySide ? "you" : "foe";

  const posessive = (s: "a" | "b" | null): string => {
    if (s === null) return "";
    if (neutral) return `${(s === mySide ? view.you : view.foe).player}'s`;
    return s === mySide ? "Your" : "Foe's";
  };

  // Clone lazily — most lines touch one side.
  const next: BattleView = { ...view, you: { ...view.you }, foe: { ...view.foe } };
  const out: NarrationLine[] = [];

  /** Mutate the active mon on a given protocol side. */
  const withActive = (s: "a" | "b" | null, fn: (m: ActiveMon) => ActiveMon): void => {
    const key = viewSideKey(s);
    if (!key) return;
    const cur = next[key].active;
    if (!cur) return;
    next[key] = { ...next[key], active: fn({ ...cur }) };
  };

  /** Mirror an HP/status change onto the bench entry too. */
  const syncBench = (s: "a" | "b" | null): void => {
    const key = viewSideKey(s);
    if (!key) return;
    const act = next[key].active;
    if (!act) return;
    next[key] = {
      ...next[key],
      bench: next[key].bench.map((b) =>
        b.ident === act.ident
          ? { ...b, hpPct: act.hpPct, status: act.status, fainted: act.fainted, active: true }
          : { ...b, active: false },
      ),
    };
  };

  /** Flush a held move line once its modifiers have been attached. */
  const flushMove = (): void => {
    if (scratch.pendingMove) { out.push(scratch.pendingMove); scratch.pendingMove = null; }
  };

  switch (tag) {
    // ── Framing ────────────────────────────────────────────────────
    case "player": {
      // |player|p1|Alice|avatar|rating
      const s = parts[2] === "p1" ? "a" : parts[2] === "p2" ? "b" : null;
      const key = viewSideKey(s);
      if (key && parts[3]) next[key] = { ...next[key], player: parts[3] };
      return { view: next, lines: [...out, ] };
    }
    case "teamsize": {
      const s = parts[2] === "p1" ? "a" : parts[2] === "p2" ? "b" : null;
      const key = viewSideKey(s);
      if (key) next[key] = { ...next[key], teamSize: parseInt(parts[3] ?? "0", 10) || 0 };
      return { view: next, lines: [...out, ] };
    }
    case "turn": {
      flushMove();
      next.turn = parseInt(parts[2] ?? "0", 10) || 0;
      return { view: next, lines: [...out, { kind: "turn", text: `Turn ${next.turn}` }] };
    }

    // ── Team Preview ───────────────────────────────────────────────
    // Three tags that used to be in the deliberately-silent list below, back
    // when the format removed the phase with `!Team Preview` and they could
    // therefore never arrive. The phase is on now, and these three lines are
    // the ENTIRE channel through which one side learns anything about the
    // other's team — so they are decoded into state, and still produce no
    // narration: "Pikachu" appearing in the message box six times before the
    // battle starts is not a battle log, it is noise.
    case "clearpoke":
      // Sent once, immediately before the `|poke|` block. Resets rather than
      // appends so a rejoin replay of the whole delivered log rebuilds exactly
      // one roster per side instead of two.
      next.you = { ...next.you, preview: [] };
      next.foe = { ...next.foe, preview: [] };
      return { view: next, lines: [...out, ] };
    case "poke": {
      // |poke|p1|Pikachu, L50, F|      ← the fourth field is the held-item
      // flag, and the SERVER strips it before this ever arrives (see
      // server/src/lib/pvpTeamPreview.ts). It is not read here either way:
      // decoding it would put a real competitive signal one `git revert` away
      // from the screen.
      const s = parts[2] === "p1" ? "a" : parts[2] === "p2" ? "b" : null;
      const key = viewSideKey(s);
      if (!key) return { view: next, lines: [...out, ] };
      const d = parseDetails(parts[3] ?? "");
      const preview = [
        ...next[key].preview,
        { slot: next[key].preview.length + 1, speciesKey: d.speciesKey, level: d.level, gender: d.gender },
      ];
      // `|teamsize|` does NOT arrive until both sides have locked in, so
      // without this the preview screen could not say how many the foe has
      // even though it is listing them. Counting the roster is the same fact.
      next[key] = { ...next[key], preview, teamSize: Math.max(next[key].teamSize, preview.length) };
      return { view: next, lines: [...out, ] };
    }
    case "teampreview":
      next.teamPreview = true;
      return { view: next, lines: [...out, ] };
    case "start":
      // The phase is over the instant the battle proper begins. This tag was
      // silent before and stays silent — `|start` is immediately followed by
      // the two `|switch|` lines that DO narrate — but it now carries the one
      // piece of state that tells the arena to put the picker away.
      next.teamPreview = false;
      return { view: next, lines: [...out, ] };
    case "win": {
      flushMove();
      next.ended = { winner: parts[2] ?? null, tie: false };
      return { view: next, lines: [...out, { kind: "win", text: `${parts[2] ?? "Someone"} wins!` }] };
    }
    case "tie": {
      flushMove();
      next.ended = { winner: null, tie: true };
      return { view: next, lines: [...out, { kind: "tie", text: "The battle ended in a tie." }] };
    }
    case "error":
      return { view: next, lines: [...out, { kind: "error", text: parts.slice(2).join(" | ") }] };
    case "-message":
    case "message":
      return { view: next, lines: [...out, { kind: "info", text: parts.slice(2).join(" ") }] };

    // ── Switching ──────────────────────────────────────────────────
    case "switch":
    case "drag":
    case "replace": {
      flushMove();
      const s = sideOf(parts[2]);
      const key = viewSideKey(s);
      if (!key) return { view: next, lines: [...out, ] };
      const d = parseDetails(parts[3] ?? "");
      const c = parseCondition(parts[4] ?? "100/100");
      const mon: ActiveMon = {
        ident: parts[2] ?? "",
        name: nameOf(parts[2]),
        speciesKey: d.speciesKey,
        level: d.level,
        gender: d.gender,
        shiny: d.shiny,
        hp: c.hp, maxHp: c.maxHp, hpPct: c.hpPct,
        // Verified against real stream output rather than assumed: this
        // format (gen5customgame) reports EXACT HP for both sides on a
        // player stream — the foe's Charizard arrives as "116/154", not
        // as a percentage. So exactness is a property of whether we
        // parsed a real fraction, not of which seat we occupy.
        hpKnownExact: /\d+\s*\/\s*\d+/.test(parts[4] ?? ""),
        status: c.status,
        fainted: c.fainted,
        // Boosts and volatiles do NOT survive a switch. Starting from a
        // clean mon here is what stops a fresh Pokémon inheriting the
        // previous one's confusion or +2 Attack.
        boosts: {},
        volatiles: [],
        charging: null,
      };
      const existing = next[key].bench.find((b) => b.ident === mon.ident);
      const bench: BenchMon[] = existing
        ? next[key].bench.map((b) =>
            b.ident === mon.ident
              ? { ...b, active: true, hpPct: c.hpPct, status: c.status, fainted: c.fainted, revealed: true }
              : { ...b, active: false })
        : [
            ...next[key].bench.map((b) => ({ ...b, active: false })),
            {
              ident: mon.ident, name: mon.name, speciesKey: mon.speciesKey,
              level: mon.level, hpPct: c.hpPct, status: c.status,
              fainted: c.fainted, active: true, revealed: true,
            },
          ];
      next[key] = { ...next[key], active: mon, bench };
      const verb = tag === "drag" ? "was dragged out" : "sent out";
      return {
        view: next,
        lines: [{
          kind: "switch", side: s ?? undefined,
          text: neutral
            ? `${next[key].player} ${verb} ${mon.name}!`
            : `${posessive(s)} ${mon.name} ${s === mySide ? "is on the field" : "came out"}!`,
        }],
      };
    }
    case "detailschange":
    case "-formechange": {
      const s = sideOf(parts[2]);
      const d = parseDetails(parts[3] ?? "");
      withActive(s, (m) => ({ ...m, speciesKey: d.speciesKey || m.speciesKey }));
      return {
        view: next, lines: [...out, {
          kind: "info", side: s ?? undefined,
          text: `${posessive(s)} ${nameOf(parts[2])} transformed!`,
        }],
      };
    }

    // ── Moves and their modifiers ──────────────────────────────────
    case "move": {
      flushMove();
      const s = sideOf(parts[2]);
      const mon = nameOf(parts[2]);
      const move = parts[3] ?? "";
      // Held so |-crit| / |-supereffective| / |-miss| can attach.
      scratch.pendingMove = {
        kind: "move", side: s ?? undefined,
        text: `${posessive(s)} ${mon} used ${move}!`,
        tags: [],
      };
      withActive(s, (m) => ({ ...m, charging: null }));
      return { view: next, lines: [...out, ] };
    }
    case "-crit":
      if (scratch.pendingMove) scratch.pendingMove.tags?.push("Critical hit!");
      return { view: next, lines: [...out, ] };
    case "-supereffective":
      if (scratch.pendingMove) scratch.pendingMove.tags?.push("Super effective!");
      return { view: next, lines: [...out, ] };
    case "-resisted":
      if (scratch.pendingMove) scratch.pendingMove.tags?.push("Not very effective…");
      return { view: next, lines: [...out, ] };
    case "-immune": {
      const s = sideOf(parts[2]);
      flushMove();
      return {
        view: next, lines: [...out, {
          kind: "fail", side: s ?? undefined,
          text: `It doesn't affect ${posessive(s).replace(/'s$/, "")} ${nameOf(parts[2])}…`,
        }],
      };
    }
    case "-miss": {
      // |-miss|p1a: Attacker|p2a: Target
      const attacker = sideOf(parts[2]);
      flushMove();
      return {
        view: next, lines: [...out, {
          kind: "miss", side: attacker ?? undefined,
          text: `${posessive(attacker)} ${nameOf(parts[2])} missed!`,
        }],
      };
    }
    case "-notarget":
      flushMove();
      return { view: next, lines: [...out, { kind: "fail", text: "But there was no target…" }] };
    case "-fail": {
      const s = sideOf(parts[2]);
      flushMove();
      return {
        view: next, lines: [...out, {
          kind: "fail", side: s ?? undefined,
          text: `But it failed!`,
        }],
      };
    }
    case "-hitcount": {
      flushMove();
      const n = parts[3] ?? "?";
      return { view: next, lines: [...out, { kind: "info", text: `Hit ${n} time${n === "1" ? "" : "s"}!` }] };
    }
    case "-prepare": {
      // Two-turn move charging (Fly, Dig, Solar Beam).
      const s = sideOf(parts[2]);
      const move = parts[3] ?? "";
      withActive(s, (m) => ({ ...m, charging: move }));
      flushMove();
      return {
        view: next, lines: [...out, {
          kind: "info", side: s ?? undefined,
          text: `${posessive(s)} ${nameOf(parts[2])} is charging ${move}…`,
        }],
      };
    }
    case "-singleturn": {
      const s = sideOf(parts[2]);
      const what = stripEffectPrefix(parts[3] ?? "");
      flushMove();
      return {
        view: next, lines: [...out, {
          kind: "info", side: s ?? undefined,
          text: `${posessive(s)} ${nameOf(parts[2])} braced itself (${what}).`,
        }],
      };
    }

    // ── The one that mattered most ─────────────────────────────────
    case "cant": {
      // |cant|p1a: Pikachu|par   — the reason a turn did nothing.
      flushMove();
      const s = sideOf(parts[2]);
      const why = parts[3] ?? "";
      const reason = CANT_REASON[why] ?? CANT_REASON[stripEffectPrefix(why)] ?? "couldn't move";
      return {
        view: next, lines: [...out, {
          kind: "cant", side: s ?? undefined,
          text: `${posessive(s)} ${nameOf(parts[2])} ${reason}!`,
        }],
      };
    }

    // ── HP ─────────────────────────────────────────────────────────
    case "-damage":
    case "-heal":
    case "-sethp": {
      flushMove();
      const s = sideOf(parts[2]);
      const c = parseCondition(parts[3] ?? "");
      let delta = 0;
      const key = viewSideKey(s);
      if (key && next[key].active) delta = c.hpPct - next[key].active!.hpPct;
      withActive(s, (m) => ({
        ...m,
        hp: c.hp, maxHp: c.maxHp, hpPct: c.hpPct,
        // The condition field is authoritative and always carries the
        // CURRENT status ("132/155 par"), so read it straight rather
        // than falling back to the tracked value — `?? m.status` would
        // make a cured status impossible to clear from a damage line.
        status: c.fainted ? null : c.status,
        fainted: c.fainted,
      }));
      syncBench(s);
      // The cause matters: unattributed HP loss looks like a bug.
      const from = kw.from ? stripEffectPrefix(kw.from) : "";
      const pct = Math.abs(Math.round(delta));
      const who = `${posessive(s)} ${nameOf(parts[2])}`;
      if (tag === "-heal") {
        return {
          view: next, lines: [...out, {
            kind: "heal", side: s ?? undefined,
            text: from ? `${who} restored HP with ${from}.` : `${who} restored ${pct}% HP.`,
          }],
        };
      }
      if (tag === "-sethp") {
        return { view: next, lines: [...out, { kind: "damage", side: s ?? undefined, text: `${who}'s HP was set.` }] };
      }
      // ── A LETHAL HIT SAYS NOTHING HERE ───────────────────────────
      // `|faint|` always follows, and "Foe's Pidgey lost 100% HP." directly
      // above "Foe's Pidgey fainted!" is the same event reported twice, the
      // first time in a register no Pokémon game has ever used. The faint
      // line is the better of the two, so this one steps aside.
      //
      // Attributed damage still speaks — "was hurt by Spikes" then "fainted"
      // reads correctly, because the first line carries the CAUSE and the
      // second carries the outcome.
      if (c.fainted && !from) {
        return { view: next, lines: out };
      }
      // Rounding, not a no-op: sub-1% chip damage is real and the bar moves.
      // "lost 0% HP" reads as a bug in a way "a little HP" does not.
      const amount = pct > 0 ? `${pct}% HP` : "a little HP";
      return {
        view: next, lines: [...out, {
          kind: "damage", side: s ?? undefined,
          text: from ? `${who} was hurt by ${from}.` : `${who} lost ${amount}.`,
        }],
      };
    }
    case "faint": {
      flushMove();
      const s = sideOf(parts[2]);
      withActive(s, (m) => ({ ...m, fainted: true, hp: 0, hpPct: 0, status: null }));
      syncBench(s);
      return {
        view: next, lines: [...out, {
          kind: "faint", side: s ?? undefined,
          text: `${posessive(s)} ${nameOf(parts[2])} fainted!`,
        }],
      };
    }

    // ── Status ─────────────────────────────────────────────────────
    case "-status": {
      flushMove();
      const s = sideOf(parts[2]);
      const st = (parts[3] ?? "") as StatusCode;
      withActive(s, (m) => ({ ...m, status: st }));
      syncBench(s);
      const from = kw.from ? ` (${stripEffectPrefix(kw.from)})` : "";
      return {
        view: next, lines: [...out, {
          kind: "status", side: s ?? undefined,
          text: `${posessive(s)} ${nameOf(parts[2])} was ${STATUS_LABEL[st] ?? st}!${from}`,
        }],
      };
    }
    case "-curestatus": {
      flushMove();
      const s = sideOf(parts[2]);
      const st = (parts[3] ?? "") as StatusCode;
      withActive(s, (m) => ({ ...m, status: m.status === st ? null : m.status }));
      syncBench(s);
      return {
        view: next, lines: [...out, {
          kind: "cure", side: s ?? undefined,
          text: `${posessive(s)} ${nameOf(parts[2])} is no longer ${STATUS_LABEL[st] ?? st}.`,
        }],
      };
    }
    case "-cureteam":
      flushMove();
      return { view: next, lines: [...out, { kind: "cure", text: "The whole team was cured!" }] };

    // ── Stat stages ────────────────────────────────────────────────
    case "-boost":
    case "-unboost": {
      flushMove();
      const s = sideOf(parts[2]);
      const stat = (parts[3] ?? "") as BoostStat;
      const amt = parseInt(parts[4] ?? "1", 10) || 1;
      const signed = tag === "-boost" ? amt : -amt;
      withActive(s, (m) => {
        const cur = m.boosts[stat] ?? 0;
        // Gen-5 stages clamp at ±6.
        const nv = Math.max(-6, Math.min(6, cur + signed));
        return { ...m, boosts: { ...m.boosts, [stat]: nv } };
      });
      const word = amt >= 3 ? "drastically" : amt === 2 ? "sharply" : "";
      const dir = tag === "-boost" ? "rose" : "fell";
      return {
        view: next, lines: [...out, {
          kind: tag === "-boost" ? "boost" : "unboost", side: s ?? undefined,
          text: `${posessive(s)} ${nameOf(parts[2])}'s ${BOOST_LABEL[stat] ?? stat} ${word ? word + " " : ""}${dir}!`,
        }],
      };
    }
    case "-setboost": {
      flushMove();
      const s = sideOf(parts[2]);
      const stat = (parts[3] ?? "") as BoostStat;
      const amt = parseInt(parts[4] ?? "0", 10) || 0;
      withActive(s, (m) => ({ ...m, boosts: { ...m.boosts, [stat]: amt } }));
      return { view: next, lines: [...out, { kind: "boost", side: s ?? undefined, text: `${posessive(s)} ${nameOf(parts[2])}'s ${BOOST_LABEL[stat] ?? stat} was set.` }] };
    }
    case "-clearboost":
    case "-clearnegativeboost": {
      flushMove();
      const s = sideOf(parts[2]);
      withActive(s, (m) => ({
        ...m,
        boosts: tag === "-clearboost"
          ? {}
          : Object.fromEntries(Object.entries(m.boosts).filter(([, v]) => (v ?? 0) > 0)),
      }));
      return { view: next, lines: [...out, { kind: "info", side: s ?? undefined, text: `${posessive(s)} ${nameOf(parts[2])}'s stat changes were cleared.` }] };
    }
    case "-clearallboost":
      flushMove();
      next.you = { ...next.you, active: next.you.active ? { ...next.you.active, boosts: {} } : null };
      next.foe = { ...next.foe, active: next.foe.active ? { ...next.foe.active, boosts: {} } : null };
      return { view: next, lines: [...out, { kind: "info", text: "All stat changes were eliminated!" }] };
    case "-copyboost":
    case "-swapboost":
    case "-invertboost":
      flushMove();
      return { view: next, lines: [...out, { kind: "info", text: "Stat changes were shuffled." }] };

    // ── Volatiles ──────────────────────────────────────────────────
    case "-start": {
      flushMove();
      const s = sideOf(parts[2]);
      const raw = parts[3] ?? "";
      const vol = stripEffectPrefix(raw).toLowerCase().replace(/[^a-z0-9]/g, "");
      withActive(s, (m) => ({
        ...m,
        volatiles: m.volatiles.includes(vol) ? m.volatiles : [...m.volatiles, vol],
      }));
      return {
        view: next, lines: [...out, {
          kind: "volatile", side: s ?? undefined,
          text: `${posessive(s)} ${nameOf(parts[2])}: ${stripEffectPrefix(raw)} started.`,
        }],
      };
    }
    case "-end": {
      flushMove();
      const s = sideOf(parts[2]);
      const raw = parts[3] ?? "";
      const vol = stripEffectPrefix(raw).toLowerCase().replace(/[^a-z0-9]/g, "");
      withActive(s, (m) => ({ ...m, volatiles: m.volatiles.filter((v) => v !== vol) }));
      return {
        view: next, lines: [...out, {
          kind: "volatile", side: s ?? undefined,
          text: `${posessive(s)} ${nameOf(parts[2])}: ${stripEffectPrefix(raw)} ended.`,
        }],
      };
    }
    case "-activate": {
      flushMove();
      const s = sideOf(parts[2]);
      const what = stripEffectPrefix(parts[3] ?? "");
      return {
        view: next, lines: [...out, {
          kind: "volatile", side: s ?? undefined,
          text: `${posessive(s)} ${nameOf(parts[2])}: ${what}!`,
        }],
      };
    }

    // ── Abilities and items ────────────────────────────────────────
    case "-ability": {
      flushMove();
      const s = sideOf(parts[2]);
      return {
        view: next, lines: [...out, {
          kind: "ability", side: s ?? undefined,
          text: `${posessive(s)} ${nameOf(parts[2])}'s ${parts[3] ?? "ability"} activated!`,
        }],
      };
    }
    case "-endability":
      flushMove();
      return { view: next, lines: [...out, { kind: "ability", text: `${nameOf(parts[2])}'s ability was suppressed.` }] };
    case "-item": {
      flushMove();
      const s = sideOf(parts[2]);
      return {
        view: next, lines: [...out, {
          kind: "item", side: s ?? undefined,
          text: `${posessive(s)} ${nameOf(parts[2])} has ${parts[3] ?? "an item"}.`,
        }],
      };
    }
    case "-enditem": {
      flushMove();
      const s = sideOf(parts[2]);
      return {
        view: next, lines: [...out, {
          kind: "item", side: s ?? undefined,
          text: `${posessive(s)} ${nameOf(parts[2])} used its ${parts[3] ?? "item"}!`,
        }],
      };
    }

    // ── Weather / field / side conditions ──────────────────────────
    case "-weather": {
      flushMove();
      const id = parts[2] ?? "none";
      if (id === "none") {
        next.weather = null;
        return { view: next, lines: [...out, { kind: "weather", text: "The weather cleared up." }] };
      }
      const label = WEATHER_LABEL[id] ?? id;
      const upkeep = "upkeep" in kw;
      next.weather = { id, label };
      // An upkeep tick every turn would flood the log; track it, don't
      // narrate it.
      if (upkeep) return { view: next, lines: [...out, ] };
      return { view: next, lines: [...out, { kind: "weather", text: `${label} kicked up!` }] };
    }
    case "-fieldstart": {
      flushMove();
      const id = stripEffectPrefix(parts[2] ?? "");
      if (!next.field.includes(id)) next.field = [...next.field, id];
      return { view: next, lines: [...out, { kind: "field", text: `${id} took effect!` }] };
    }
    case "-fieldend": {
      flushMove();
      const id = stripEffectPrefix(parts[2] ?? "");
      next.field = next.field.filter((f) => f !== id);
      return { view: next, lines: [...out, { kind: "field", text: `${id} wore off.` }] };
    }
    case "-sidestart": {
      flushMove();
      // |-sidestart|p1: Alice|move: Spikes
      const s = parts[2]?.startsWith("p1") ? "a" : parts[2]?.startsWith("p2") ? "b" : null;
      const key = viewSideKey(s);
      const cond = SIDE_CONDITION[parts[3] ?? ""] ?? stripEffectPrefix(parts[3] ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (key) {
        const sv = { ...next[key] };
        if (cond === "spikes" || cond === "toxicspikes") {
          sv.hazards = { ...sv.hazards, [cond]: Math.min(3, sv.hazards[cond] + 1) };
        } else if (cond === "stealthrock" || cond === "stickyweb") {
          sv.hazards = { ...sv.hazards, [cond]: true };
        } else {
          sv.screens = { ...sv.screens, [cond]: true };
        }
        next[key] = sv;
      }
      return {
        view: next, lines: [...out, {
          kind: "hazard", side: s ?? undefined,
          text: `${SIDE_LABEL[cond] ?? cond} was set on ${neutral ? `${key ? next[key].player : "a"}'s` : (s === mySide ? "your" : "the foe's")} side!`,
        }],
      };
    }
    case "-sideend": {
      flushMove();
      const s = parts[2]?.startsWith("p1") ? "a" : parts[2]?.startsWith("p2") ? "b" : null;
      const key = viewSideKey(s);
      const cond = SIDE_CONDITION[parts[3] ?? ""] ?? stripEffectPrefix(parts[3] ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (key) {
        const sv = { ...next[key] };
        if (cond === "spikes" || cond === "toxicspikes") sv.hazards = { ...sv.hazards, [cond]: 0 };
        else if (cond === "stealthrock" || cond === "stickyweb") sv.hazards = { ...sv.hazards, [cond]: false };
        else { const sc = { ...sv.screens }; delete sc[cond]; sv.screens = sc; }
        next[key] = sv;
      }
      return {
        view: next, lines: [...out, {
          kind: "hazard", side: s ?? undefined,
          text: `${SIDE_LABEL[cond] ?? cond} faded.`,
        }],
      };
    }

    // ── Deliberately silent ────────────────────────────────────────
    // These are real protocol lines that carry no player-facing meaning
    // (or would flood the log). Listed explicitly rather than caught by
    // `default` so an unrecognised tag stays distinguishable from an
    // intentionally-ignored one.
    case "":
    case "t:":
    case "upkeep":
    case "gen":
    case "tier":
    case "rule":
    case "gametype":
    // |raw| carries HTML (the custom-rule infobox is emitted in EVERY
    // battle's preamble) and |debug| carries engine internals like
    // "rain water boost". Both were found by capturing a real battle,
    // and both would otherwise fall through to `default` and be printed
    // to the player as log lines.
    case "raw":
    case "html":
    case "uhtml":
    case "debug":
    // `|start` is NOT here any more — it moved up to the Team Preview block,
    // where it still emits no narration but now clears `teamPreview`.
    case "done":
    case "request":
    case "inactive":
    case "inactiveoff":
    case "-anim":
    case "-nothing":
    case "-ohko":
    case "-combine":
    case "-waiting":
    case "-block":
    case "-fieldactivate":
    case "-mustrecharge":
    case "-transform":
    case "-zpower":
    case "-zbroken":
    case "-terastallize":
    case "seed":
    case "split":
      return { view: next, lines: [...out, ] };

    default:
      // Unknown tag: keep it, but out of the way. A silent drop is how
      // the old decoder hid |cant| for months.
      return { view: next, lines: [...out, { kind: "info", text: parts.slice(1).join(" ").trim() }] };
  }
}

/**
 * Fold a whole chunk. Returns the new view plus the narration produced,
 * carrying `scratch` across lines so move modifiers attach correctly
 * even when a chunk boundary splits them.
 */
export function applyChunk(
  view: BattleView,
  chunk: string,
  mySide: "a" | "b",
  scratch: { pendingMove: NarrationLine | null },
  neutral = false,
): ApplyResult {
  let v = view;
  const lines: NarrationLine[] = [];
  for (const raw of chunk.split("\n")) {
    if (!raw) continue;
    const r = applyLine(v, raw, mySide, scratch, neutral);
    v = r.view;
    lines.push(...r.lines);
  }
  return { view: v, lines };
}

/**
 * Flush any move line still held for modifier attachment. Call when a
 * chunk is known to be the last of a turn (or the battle ended), so the
 * final move isn't swallowed.
 */
export function flushPending(scratch: { pendingMove: NarrationLine | null }): NarrationLine[] {
  if (!scratch.pendingMove) return [];
  const l = scratch.pendingMove;
  scratch.pendingMove = null;
  return [l];
}
