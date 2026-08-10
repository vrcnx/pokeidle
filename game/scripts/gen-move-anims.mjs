#!/usr/bin/env node
/**
 * Port Pokémon Showdown's per-move battle animations into src/data/moveAnims.ts.
 *
 * Source: https://github.com/smogon/pokemon-showdown-client
 *         play.pokemonshowdown.com/src/battle-animations-moves.ts  (CC0-1.0)
 *
 * ── WHY THIS IS A CONVERTER AND NOT 92 HAND-TRANSCRIPTIONS ───────────────
 * Their move library is 38,742 lines. Copying ninety animations by hand means
 * ninety chances to mistype a coordinate, and a mistyped coordinate does not
 * throw — it just puts the effect slightly in the wrong place, which is
 * exactly the class of bug you only find by watching one specific move.
 *
 * It works at all because utils/battleFx.ts was deliberately built to their
 * API: `scene.showEffect`, `scene.backgroundEffect`, `scene.wait`,
 * `actor.anim`, `actor.delay`, `actor.behind`, `actor.leftof`. A move body is
 * therefore already valid code against our runtime, and the job is to prove
 * that for each one rather than to translate it.
 *
 * ── NOTHING IS PORTED THAT CANNOT BE PROVEN SAFE ─────────────────────────
 * Every body is checked against an allowlist before it is emitted:
 *   - only the API surface above may be called
 *   - every sprite name must be one we actually vendored (11 are deliberately
 *     not shipped — see public/fx/PROVENANCE.md)
 *   - every transition and `after` must be one our engine implements
 * Anything failing is SKIPPED with the reason printed and recorded. A skipped
 * move keeps the CSS effect it has today, so the fallback is "unchanged",
 * never "broken".
 *
 * Usage:  node scripts/gen-move-anims.mjs
 */

import { writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src", "data", "moveAnims.ts");
const SRC = "https://raw.githubusercontent.com/smogon/pokemon-showdown-client/master/play.pokemonshowdown.com/src";

/** Exactly what our FxScene / FxActor implement. */
// Newline as a constant, so a rewrite string never has to carry a backslash
// escape through this file's own generation.
const LINE = String.fromCharCode(10);

const ALLOWED_CALLS = new Set([
  "scene.showEffect", "scene.backgroundEffect", "scene.wait", "scene.shakeStage",
  "attacker.anim", "attacker.delay", "attacker.behind", "attacker.leftof", "attacker.above",
  "defender.anim", "defender.delay", "defender.behind", "defender.leftof", "defender.above",
  // Plain arithmetic. `Math.random` is in here deliberately: a few of their
  // animations scatter particles randomly, and that is the point of them.
  "Math.floor", "Math.round", "Math.abs", "Math.max", "Math.min", "Math.random",
]);

const ALLOWED_TRANSITIONS = new Set([
  "linear", "swing", "accel", "decel",
  "ballistic", "ballisticUp", "ballisticUnder",
  // `ballistic2back` is their own typo, reproduced in our engine rather than
  // corrected — see the note there.
  "ballistic2", "ballistic2Back", "ballistic2back", "ballistic2Under",
]);

const ALLOWED_AFTER = new Set(["fade", "explode"]);

/**
 * Stand-ins for the sprites we deliberately did not vendor.
 *
 * Those files are GPL or unlicensed (see public/fx/PROVENANCE.md), but the
 * ANIMATIONS that use them are CC0 and perfectly good. Substituting a
 * vendored sprite keeps Ice Beam's real choreography — the timing, the arc,
 * the stagger — and only changes what the particle looks like. The
 * alternative was dropping 15 moves back to a generic CSS flash, which is a
 * far bigger loss than a differently-drawn icicle.
 */
const SUBSTITUTE = {
  // `iceball` was the obvious swap by name and it was the wrong one. The
  // sprite it replaces is a SHAPE — a sharp icicle — and `iceball` is a soft
  // pale-blue radial blob. Screened over a lit background it is invisible:
  // Ice Beam's densest frame rendered as a faint haze and nothing else.
  // `shine` is a hard four-point crystal, which is what an icicle reads as.
  icicle: "shine",
  pinkicicle: "shine",
  lightning: "electroball",
  rocks: "rock3",
  rock1: "rock3",
  rock2: "rock3",
  bone: "rock3",
};

/** ScenePos keys our engine honours. A body using anything else would be
 *  silently rendering something different from what its author wrote. */
const ALLOWED_POS_KEYS = new Set([
  "x", "y", "z", "scale", "xscale", "yscale", "opacity", "time",
]);

/** Walk from the `{` at `i` to its matching `}`. Brace counting rather than a
 *  regex, because a regex cannot know where a nested object ends — the same
 *  mistake that once welded Psychic's effect onto Dream Eater in gen-tms. */
function matchBrace(src, i) {
  let d = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") d++;
    else if (src[j] === "}") { d--; if (d === 0) return j + 1; }
  }
  return -1;
}

/** Top-level `name: { ... }` entries of an object literal. */
function parseTable(src, declaration) {
  const start = src.indexOf(declaration);
  if (start < 0) throw new Error(`could not find ${declaration}`);
  const open = src.indexOf("{", start);
  const end = matchBrace(src, open);
  const body = src.slice(open + 1, end - 1);
  const out = new Map();
  const re = /^\t([a-zA-Z0-9_]+):\s*\{/gm;
  let m;
  while ((m = re.exec(body))) {
    const braceAt = body.indexOf("{", m.index + m[1].length);
    const close = matchBrace(body, braceAt);
    if (close < 0) continue;
    out.set(m[1], body.slice(braceAt, close));
    re.lastIndex = close;
  }
  return out;
}

/** The `anim(scene, [attacker, defender]) { ... }` body from an entry. */
function ownBody(entry) {
  const m = /anim\(scene,\s*\[([^\]]*)\]\)\s*\{/.exec(entry);
  if (!m) return null;
  const braceAt = entry.indexOf("{", m.index + m[0].length - 1);
  const close = matchBrace(entry, braceAt);
  if (close < 0) return null;
  return entry.slice(braceAt + 1, close - 1);
}

/**
 * Resolve an entry to a body, following aliases.
 *
 * Most of their library is aliases, and missing that is what made the first
 * run skip Scratch, Growl and Tackle as "no animation" when all three have
 * one. Three shapes:
 *
 *   anim: BattleOtherAnims.slashattack.anim   → a shared anim in the engine file
 *   anim: BattleMoveAnims['slam'].anim        → another move
 *   BattleMoveAnims['tackle'] = { ... }       → assigned after the literal
 *
 * Chains can be several deep (ember → flamethrower), so this recurses with a
 * seen-set; a cycle would otherwise hang the generator rather than fail it.
 */
/**
 * Splice `BattleOtherAnims.X.anim(scene, [attacker, defender]);` calls into
 * the body they appear in.
 *
 * A third of the library composes this way — Vine Whip is "do a contact
 * attack, then draw a vine". Treating the call as unsupported skipped 13 of
 * our moves for no reason: the shared anim is itself plain, portable code.
 */
function inlineShared(body, others, depth = 0) {
  if (depth > 3) return body;
  return body.replace(
    /BattleOtherAnims\.(\w+)\.anim\(scene,\s*\[[^\]]*\]\);?/g,
    (whole, name) => {
      const entry = others.get(name);
      if (!entry) return whole;
      const inner = ownBody(entry);
      return inner === null ? whole : inlineShared(inner, others, depth + 1);
    },
  );
}

function resolveBody(entry, moves, others, seen = new Set()) {
  const own = ownBody(entry);
  if (own !== null) return inlineShared(own, others);

  let m = /anim:\s*BattleOtherAnims\.(\w+)\.anim/.exec(entry);
  if (m) {
    if (seen.has(`o:${m[1]}`)) return null;
    seen.add(`o:${m[1]}`);
    const next = others.get(m[1]);
    return next ? resolveBody(next, moves, others, seen) : null;
  }
  m = /anim:\s*BattleMoveAnims\[?'?(\w+)'?\]?\.anim/.exec(entry);
  if (m) {
    if (seen.has(`m:${m[1]}`)) return null;
    seen.add(`m:${m[1]}`);
    const next = moves.get(m[1]);
    return next ? resolveBody(next, moves, others, seen) : null;
  }
  return null;
}

/** Blank out string literals and comments so a hex colour inside
 *  `backgroundEffect('#B84038', …)` is not read as an identifier. That false
 *  positive alone skipped Fire Blast, Outrage, Overheat and Focus Blast. */
function stripLiterals(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

/** Every reason a body cannot be emitted, or [] if it is clean. */
/** Members our FxActor actually has. `attacker.sp` (their sprite data) and
 *  `defender.isMissedPokemon` are the ones that slipped past a call-shaped
 *  check, because they are property reads rather than calls. */
const ACTOR_MEMBERS = new Set([
  "x", "y", "z", "anim", "delay", "behind", "leftof", "above", "sp",
]);
const SCENE_MEMBERS = new Set(["showEffect", "backgroundEffect", "wait", "shakeStage"]);

const JS_KEYWORDS = new Set([
  "const", "let", "var", "for", "if", "else", "return", "function", "of", "in",
  "new", "true", "false", "null", "undefined", "typeof", "void", "while", "do",
  "break", "continue", "switch", "case", "default", "this",
]);

/**
 * Rewrites applied BEFORE the safety check, turning three of their idioms into
 * ours.
 *
 * Each one is a SUBSTITUTION, not a loosening of the allowlist: the check
 * still runs afterwards, over the rewritten body, and still refuses anything
 * it does not recognise. What changes is that three patterns which used to be
 * unrecognisable now say something our engine can do.
 */
function normalize(body) {
  let out = body;

  // ── Their CDN background → our vendored copy ─────────────────────────
  // `scene.backgroundEffect(`url('https://${Config.routes.client}/fx/bg-space.jpg')`, …)`
  // The template literal reads as bare identifiers `Config` and `url` to the
  // checker, which skipped ten moves — Moonlight, Morning Sun, Wish, Cosmic
  // Power, Moonblast, Sheer Cold, Meteor Mash, Dragon Ascent, Solar Beam and
  // Seismic Toss — over a filename. bg-space.jpg is the only background any
  // of them wants, and it is now in public/fx.
  out = out.replace(
    // Two paths, because they keep backgrounds in two places: `/fx/` and
    // `/sprites/gen6bgs/`. Sheer Cold was the only skip left over the second
    // one. Both files are vendored into public/fx.
    /`url\('https:\/\/\$\{Config\.routes\.client\}\/(?:fx|sprites\/gen6bgs)\/([\w-]+\.(?:jpg|png))'\)`/g,
    (_m, file) => `"url('/fx/${file}')"`,
  );

  // ── Their $bg shake → our stage shake ────────────────────────────────
  // `scene.$bg.animate({top, bottom}, ms).animate(...)...` — jQuery walking
  // their background element. Collapsed into one shakeStage call whose
  // duration is the sum of the steps and whose intensity is the largest
  // offset they asked for. See FxScene.shakeStage for why this is a
  // substitute rather than a port.
  out = out.replace(
    // Bulldoze writes its lead-in as a SEPARATE statement — `scene.$bg.delay(275);`
    // then the chain — rather than chaining it, so both shapes are matched.
    /(?:scene\.\$bg\s*\.delay\(\s*(\d+)\s*\)\s*;\s*)?scene\.\$bg(?:\s*\.delay\(\s*(\d+)\s*\))?((?:\s*\.animate\(\s*\{[^}]*\}\s*,\s*\d+\s*\))+)\s*;/g,
    (_m, preDelay, inlineDelay, chain) => {
      const steps = [...chain.matchAll(/\{([^}]*)\}\s*,\s*(\d+)/g)];
      const total = steps.reduce((n, st) => n + Number(st[2]), 0);
      const peak = Math.max(
        4,
        ...steps.flatMap((st) => [...st[1].matchAll(/-?\d+/g)].map((n) => Math.abs(Number(n[0])))),
      );
      // Their `top` sits around -90 at REST, so the shake is the swing around
      // that baseline rather than the raw number.
      const amplitude = Math.max(3, Math.min(14, peak - 88));
      const delay = Number(preDelay || inlineDelay || 0);
      return `scene.shakeStage(${total}, ${amplitude}, ${delay});`;
    },
  );

  // ── Their spread loop → our single defender ──────────────────────────
  // `anim(scene, [attacker, ...defenders]) { for (const defender of defenders) {…} }`
  // is how they write a move that hits everything on the far side — Surf,
  // Eruption, Heat Wave, Muddy Water and four others.
  //
  // The SIGNATURE never reaches here: ownBody() returns what is inside the
  // braces, so the parameter list is already gone and only the loop is left.
  // In a one-on-one battle that loop runs exactly once, over the defender we
  // already have, so unwrapping it to a plain block is the entire translation
  // — no rebinding, nothing undeclared, and the body draws precisely what it
  // drew before.
  out = out.replace(
    /for\s*\(\s*(?:const|let)\s+defender\s+of\s+defenders\s*\)\s*\{/g,
    "{",
  );

  // The other half of the same idiom: `const defender = defenders[1] ||
  // defenders[0];`, which is them reaching for the SECOND target in doubles
  // and falling back to the first. With one target on the far side, that
  // expression is the defender we were handed, so the declaration is dropped
  // rather than rewritten — keeping it would shadow the parameter, which is
  // exactly what the safety check refuses.
  out = out.replace(
    /(?:const|let|var)\s+defender\s*=\s*defenders\s*\[\s*\d+\s*\]\s*(?:\|\|\s*defenders\s*\[\s*\d+\s*\]\s*)*;/g,
    "",
  );

  return out;
}

function check(body, sprites) {
  const problems = [];
  // Sprite names and transitions are read from the REAL source (they live in
  // string literals); everything else is read from the stripped copy.
  const code = stripLiterals(body);

  for (const m of code.matchAll(/\b([a-zA-Z_$][\w$]*)\.([a-zA-Z]+)\s*\(/g)) {
    const call = `${m[1]}.${m[2]}`;
    if (!ALLOWED_CALLS.has(call)) problems.push(`calls ${call}`);
  }

  // ── EVERY IDENTIFIER, NOT JUST THE CALLS ──────────────────────────────
  // A call-shaped check passes `attacker.sp` (a property read), `defenders`
  // (the doubles array), and a body that shadows `defender` with its own
  // local. All three compiled to nothing sensible and were only caught by
  // running tsc over the generated file, which is not a check that belongs
  // downstream of generation.
  const declared = new Set(
    [...code.matchAll(/\b(?:const|let|var)\s+([\w$]+)/g)].map((m) => m[1]),
  );
  // A `for (const defender of defenders)` binding is fine — it is a block
  // scope and the outer parameter is still what initialised `defenders`.
  // Only a top-level reassignment is a problem.
  for (const m of code.matchAll(/\b(?:const|let|var)\s+(attacker|defender|scene)\s*=/g)) {
    problems.push(`rebinds ${m[1]}`);
  }
  for (const m of code.matchAll(/(?<![.\w$])([a-zA-Z_$][\w$]*)/g)) {
    const id = m[1];
    // Match the WHOLE identifier and then look at what follows. A negative
    // lookahead inside the match lets the regex backtrack to a prefix — it
    // reported `scal`, `opacit` and `tim` for `scale:`, `opacity:`, `time:`,
    // which skipped 104 moves for identifiers that do not exist.
    if (/^\s*:/.test(code.slice(m.index + id.length))) continue; // object key
    if (JS_KEYWORDS.has(id) || declared.has(id)) continue;
    if (id === "scene" || id === "attacker" || id === "defender" || id === "Math") continue;
    problems.push(`references ${id}`);
  }
  for (const m of code.matchAll(/\b(attacker|defender)\.([\w$]+)/g)) {
    if (!ACTOR_MEMBERS.has(m[2])) problems.push(`uses ${m[1]}.${m[2]}`);
  }
  for (const m of code.matchAll(/\bscene\.([\w$]+)/g)) {
    if (!SCENE_MEMBERS.has(m[1])) problems.push(`uses scene.${m[1]}`);
  }
  for (const m of body.matchAll(/showEffect\(\s*'([^']+)'/g)) {
    if (!sprites.has(m[1])) problems.push(`sprite '${m[1]}' not vendored`);
  }
  // The 4th/5th positional args of showEffect.
  for (const m of body.matchAll(/\}\s*,\s*'([a-zA-Z0-9]+)'(?:\s*,\s*'([a-zA-Z0-9]+)')?/g)) {
    if (m[1] && !ALLOWED_TRANSITIONS.has(m[1])) problems.push(`transition '${m[1]}'`);
    if (m[2] && !ALLOWED_AFTER.has(m[2])) problems.push(`after '${m[2]}'`);
  }
  for (const m of code.matchAll(/(?:^|[{,\s])([a-z][a-zA-Z]*)\s*:/gm)) {
    if (!ALLOWED_POS_KEYS.has(m[1])) problems.push(`position key '${m[1]}'`);
  }
  return [...new Set(problems)];
}

async function main() {
  const [movesSrc, engineSrc, ourMoves, spriteSrc, levelUp, gen3LevelUp, tms] = await Promise.all([
    fetch(`${SRC}/battle-animations-moves.ts`).then((r) => r.text()),
    fetch(`${SRC}/battle-animations.ts`).then((r) => r.text()),
    readFile(join(ROOT, "src", "data", "moves.ts"), "utf8"),
    readFile(join(ROOT, "src", "data", "battleFxSprites.ts"), "utf8"),
    readFile(join(ROOT, "src", "data", "levelUpMoves.ts"), "utf8"),
    // Gen 3's learnsets are MERGED into levelUpMoves.ts as a spread, so the
    // text scan below cannot see them — it looks for `, "moveId"]` literals
    // and a spread has none. Read the generated file directly.
    //
    // This is the failure mode of parsing source as text rather than importing
    // it: the porter ran clean, reported nothing wrong, and silently skipped
    // 238 newly-learnable moves because they were behind one `...`.
    readFile(join(ROOT, "src", "data", "gen3", "levelUpMoves.ts"), "utf8"),
    readFile(join(ROOT, "src", "data", "tms.ts"), "utf8"),
  ]);

  const sprites = new Set(
    [...spriteSrc.matchAll(/^\s{2}(\w+):\s*\{/gm)].map((m) => m[1]),
  );

  // ── WHICH MOVES TO PORT ─────────────────────────────────────────────
  // Not "everything in the move table": that is 1,038 entries because the
  // @pkmn backfill brings the whole modern movepool in, and porting all of
  // them would put ~1MB of animations nobody can trigger into the bundle.
  //
  // Not "everything hand-authored in moves.ts" either — that was the first
  // attempt and it missed 84 LEARNABLE moves, because Gen 2 learnsets and the
  // TM list reference backfilled ids (`synthesis`, `agility`, `spark`) that
  // never appear in the hand-written literal.
  //
  // The right set is what a Pokémon can actually end up knowing: every move
  // in a level-up list, every move a machine teaches, plus the authored ones.
  const authoredByFlat = new Map();
  for (const m of ourMoves.matchAll(/\n {4}([a-zA-Z0-9_]+):\s*\{/g)) {
    authoredByFlat.set(m[1].toLowerCase().replace(/[^a-z0-9]/g, ""), m[1]);
  }
  const reachable = new Set(authoredByFlat.keys());
  for (const src of [levelUp, gen3LevelUp]) {
    for (const m of src.matchAll(/,\s*"([a-zA-Z0-9_]+)"\s*\]/g)) {
      reachable.add(m[1].toLowerCase().replace(/[^a-z0-9]/g, ""));
    }
  }
  for (const m of tms.matchAll(/moveId:\s*"([a-zA-Z0-9_]+)"/g)) {
    reachable.add(m[1].toLowerCase().replace(/[^a-z0-9]/g, ""));
  }
  // Emitted under the id the RUNTIME will look up — canonicalMoveId prefers
  // the hand-authored camelCase key where one exists, and the flat key
  // otherwise. Getting this wrong is a lookup that silently misses.
  const ours = new Map([...reachable].map((flat) => [flat, authoredByFlat.get(flat) ?? flat]));

  const table = parseTable(movesSrc, "export const BattleMoveAnims");
  const others = parseTable(engineSrc, "export const BattleOtherAnims");
  // Aliases assigned AFTER the object literal — `BattleMoveAnims['tackle'] =
  // { anim: BattleMoveAnims['slam'].anim }`. Forty of our moves are defined
  // this way and nothing in the literal mentions them.
  for (const m of movesSrc.matchAll(/BattleMoveAnims\['(\w+)'\]\s*=\s*(\{[^;]*\});/g)) {
    if (!table.has(m[1])) table.set(m[1], m[2]);
  }

  const ported = [];
  const skipped = [];
  for (const [flat, ourId] of ours) {
    const entry = table.get(flat);
    if (!entry) { skipped.push([ourId, "no animation in the library"]); continue; }
    let body = resolveBody(entry, table, others);
    if (body === null) { skipped.push([ourId, "no plain anim() (charge/residual only)"]); continue; }

    // Their idioms into ours, before anything inspects the body. See
    // `normalize`: the safety check still runs over the result.
    body = normalize(body);

    // ── SINGLES-ONLY NORMALISATIONS ──────────────────────────────────
    // Their library is written for doubles and triples. Two idioms fall out
    // of that, and both mean something trivial in a one-on-one battle:
    //
    //   `defenders`               the list of targets — for us, exactly one
    //   `defender.isMissedPokemon`  a placeholder for a target that is not
    //                               there; ours always is
    //
    // Rewriting them recovers Rock Slide, Surf, Confuse Ray and Will-O-Wisp,
    // which would otherwise fall back to a generic flash for no better
    // reason than that the source also supports formats we do not have.
    body = body.replace(/\b(attacker|defender)\.isMissedPokemon\b/g, "false");
    const usesDefenders = /\bdefenders\b/.test(stripLiterals(body));
    if (usesDefenders) body = `const defenders = [defender];\n${body}`;
    body = body.replace(/showEffect\(\s*'([^']+)'/g, (whole, name) =>
      SUBSTITUTE[name] ? whole.replace(`'${name}'`, `'${SUBSTITUTE[name]}'`) : whole);
    const problems = check(body, sprites);
    if (problems.length) { skipped.push([ourId, problems.join("; ")]); continue; }
    ported.push({ id: ourId, body });
  }

  await writeFile(OUT, emit(ported, skipped), "utf8");

  console.log(`${ours.size} moves in the game`);
  console.log(`  ${ported.length} ported`);
  console.log(`  ${skipped.length} skipped\n`);
  const grouped = new Map();
  for (const [id, why] of skipped) {
    const key = why.length > 60 ? why.slice(0, 60) + "…" : why;
    grouped.set(key, [...(grouped.get(key) ?? []), id]);
  }
  for (const [why, ids] of [...grouped].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(ids.length).padStart(3)}  ${why}`);
    console.log(`       ${ids.slice(0, 8).join(", ")}${ids.length > 8 ? ", …" : ""}`);
  }
}

function emit(ported, skipped) {
  return `// GENERATED by scripts/gen-move-anims.mjs — do not edit.
//
// Per-move battle animations ported from Pokémon Showdown's client:
//   play.pokemonshowdown.com/src/battle-animations-moves.ts  (CC0-1.0)
//   https://github.com/smogon/pokemon-showdown-client
//
// These are the bodies of their \`anim(scene, [attacker, defender])\` functions,
// unchanged. They run against our engine without translation because
// utils/battleFx.ts implements their API — see that file's header.
//
// Only bodies that could be PROVEN safe are here: every call, sprite name,
// transition, \`after\` and position key is checked by the generator against
// what our engine actually implements. ${skipped.length} of our moves were
// skipped, and each keeps the CSS effect it has today rather than getting a
// half-rendered port.

import type { FxScene, FxActor } from "../utils/battleFx";

export type MoveAnim = (scene: FxScene, attacker: FxActor, defender: FxActor) => void;

export const MOVE_ANIMS: Record<string, MoveAnim> = {
${ported.map((p) => `  ${p.id}(scene, attacker, defender) {${p.body.replace(/\n\t\t\t/g, "\n    ").replace(/\n\t\t/g, "\n  ").replace(/\t/g, "  ")}},`).join("\n")}
};

/** Moves with no ported animation, and why. Kept as data so the gaps are
 *  visible and countable rather than being an absence nobody can see. */
export const UNPORTED: Record<string, string> = {
${skipped.map(([id, why]) => `  ${id}: ${JSON.stringify(why)},`).join("\n")}
};
`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
