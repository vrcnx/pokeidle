/**
 * Move animations, ported from smogon/pokemon-showdown-client (MIT),
 * `battle-animations-moves.ts` / `BattleOtherAnims`.
 *
 *   https://github.com/smogon/pokemon-showdown-client — MIT License
 *
 * ── WHAT THIS FIXES ──────────────────────────────────────────────────────
 * 81 of our 173 moves are physical, and every one of them played the same
 * thing: two slashes and a ring, on the DEFENDER, for 350ms. The attacker
 * never moved. So Tackle, Body Slam, Dragon Claw and Bite were one animation
 * in four tints, and no physical move read as a Pokémon hitting another
 * Pokémon — because nothing on screen ever travelled between them.
 *
 * A contact move IS the attacker throwing itself at the defender. That is
 * what `contactattack` is, and it needs no artwork at all — it is pure
 * motion of the two sprites already on screen, which is why it is the first
 * thing ported.
 */

import { FxActor, FxScene } from "./battleFx";
import { canonicalMoveId } from "./moves";
import { moves as movesTable } from "../data/moves";
import { MOVE_ANIMS } from "../data/moveAnims";
import type { PokemonType } from "../types";

/**
 * Physical moves that do NOT make contact, and so must not lunge.
 *
 * Contact is a real flag in the games; our move table does not carry it (the
 * @pkmn backfill copied stats only), so it is listed here rather than
 * guessed from category. The DEFAULT is contact, which is correct — most
 * physical moves are — so a physical move missing from this list gets the
 * right animation, and only the handful that throw something get it wrong.
 */
const NON_CONTACT_PHYSICAL: ReadonlySet<string> = new Set(
  [
    // Ground erupts under them; the attacker stays put.
    "earthquake", "magnitude", "fissure", "bulldoze",
    // Thrown or fired.
    "rockthrow", "rockslide", "rocktomb", "stoneedge", "rockblast", "smackdown",
    "boneclub", "bonemerang", "boneRush", "eggbomb", "barrage", "bulletseed",
    "pinmissile", "spikecannon", "icicleSpear", "gunkshot", "seedbomb",
    "magnetbomb", "sandTomb", "iceShard", "poisonjab",
    // Not a physical strike in any sense.
    "selfdestruct", "explosion", "spikes", "toxicspikes", "stealthrock",
  ].map(canonicalMoveId),
);

/** Should this move move the attacker's sprite into the defender? */
export function isContactMove(moveId: string): boolean {
  const id = canonicalMoveId(moveId);
  const m = movesTable[id];
  if (!m || m.category !== "physical") return false;
  return !NON_CONTACT_PHYSICAL.has(id);
}

/**
 * BattleOtherAnims.contactattack — ported verbatim.
 *
 * The attacker arcs up and over to just in front of the defender (400ms,
 * ballistic), snaps down onto it (100ms, linear — the actual hit), then arcs
 * home (500ms). The defender waits out the approach, is knocked backwards on
 * impact, and swings back to its feet.
 *
 * The 450ms defender delay is what syncs the recoil to the contact frame, and
 * it is the reason this reads as a hit rather than as two sprites moving
 * near each other. Left exactly as written.
 */
/**
 * ── THE ONE NUMBER THAT IS NOT SHOWDOWN'S ────────────────────────────────
 * Their apex is `defender.y + 80`. Ported literally it throws our attacker
 * clean off the top of the arena, and the reason is a layout difference, not
 * a porting mistake: a Showdown sprite is ~27% of the stage height, ours is
 * 58%. The same arc that arches a small sprite over a small opponent
 * launches a sprite twice the relative size out of frame — measured at the
 * apex, 85% of the player's Pokémon was above the top edge.
 *
 * Lowered until the whole sprite stays in the arena at the peak. Everything
 * else — the durations, the easings, the 450ms sync — is untouched, because
 * none of it depends on our slot sizes.
 */
const CONTACT_ARC = 26;

export function contactAttack(attacker: FxActor, defender: FxActor): void {
  attacker.anim(
    { x: defender.x, y: defender.y + CONTACT_ARC, z: defender.behind(-30), time: 400 },
    "ballistic",
  );
  attacker.anim({ x: defender.x, y: defender.y + 5, z: defender.z, time: 100 });
  attacker.anim({ time: 500 }, "ballistic2Back");

  defender.delay(450);
  defender.anim({ z: defender.behind(20), time: 100 }, "swing");
  defender.anim({ time: 300 }, "swing");
}

/**
 * A shorter, flatter version for priority moves.
 *
 * Quick Attack and Extreme Speed are the same shape at half the duration —
 * the whole point of them is that they are fast, and a move whose flavour is
 * speed playing the standard one-second arc contradicts its own text.
 */
export function quickContactAttack(attacker: FxActor, defender: FxActor): void {
  attacker.anim(
    { x: defender.x, y: defender.y + CONTACT_ARC / 2, z: defender.behind(-30), time: 200 },
    "ballistic",
  );
  attacker.anim({ x: defender.x, y: defender.y + 5, z: defender.z, time: 60 });
  attacker.anim({ time: 300 }, "ballistic2Back");

  defender.delay(230);
  defender.anim({ z: defender.behind(15), time: 80 }, "swing");
  defender.anim({ time: 220 }, "swing");
}

const QUICK_MOVES: ReadonlySet<string> = new Set(
  ["quickAttack", "extremeSpeed", "aquaJet", "machPunch", "bulletPunch", "iceShard", "shadowSneak", "vacuumWave"]
    .map(canonicalMoveId),
);

/**
 * Build the actor motion for a move, or return false if it has none yet.
 *
 * Returning false rather than falling back to something generic is
 * deliberate: the existing CSS effect layer still plays for every move, so a
 * move with no ported motion looks exactly like it does today rather than
 * looking wrong. That is what makes this portable one move at a time.
 */
export function buildMoveMotion(
  moveId: string,
  attacker: FxActor,
  defender: FxActor,
): boolean {
  const id = canonicalMoveId(moveId);
  if (!isContactMove(id)) return false;
  if (QUICK_MOVES.has(id)) {
    quickContactAttack(attacker, defender);
  } else {
    contactAttack(attacker, defender);
  }
  return true;
}

// ── PROJECTILES ───────────────────────────────────────────────────────────
//
// The shape almost every special move shares: something leaves the attacker,
// crosses the field, and lands. Showdown writes each move as its own script;
// what is ported here is that common spine, parameterised by the sprite,
// because it is what turns 40-odd special moves from "a tinted flash on the
// target" into something that visibly travels.
//
// Sprites are named from FX_SPRITES (see public/fx/PROVENANCE.md). A name we
// did not vendor is skipped by showEffect rather than drawn broken, which is
// how the moves whose art is GPL keep their existing CSS effect.

/** Which vendored sprite reads as this type's projectile.
 *  Exported so a test can check every name against what we actually shipped —
 *  a typo here is a move that silently loses its effect. */
export const TYPE_SPRITE: Partial<Record<PokemonType, string>> = {
  Fire: "fireball",
  Water: "waterwisp",
  Grass: "energyball",
  Electric: "electroball",
  Psychic: "mistball",
  Ghost: "shadowball",
  Dark: "blackwisp",
  Poison: "poisonwisp",
  Ground: "mudwisp",
  Ice: "iceball",
  Dragon: "flareball",
  Steel: "greenmetal1",
  Rock: "rock3",
  Bug: "leaf2",
  Flying: "feather",
  Normal: "wisp",
  Fighting: "fist",
  // Fairy is Gen 6 and this game caps at Gen 5, so it looked like it could be
  // skipped — but the @pkmn backfill brought Disarming Voice in with it, and
  // a type with exactly one special move is precisely the one nobody would
  // notice was missing an effect. Found by the coverage test, not by eye.
  Fairy: "moon",
};

/**
 * A stream of projectiles, staggered so it reads as a jet rather than a
 * single blob — the Flamethrower/Hydro Pump/Thunderbolt shape.
 *
 * The stagger is the whole effect. Three sprites launched together look like
 * one badly-drawn sprite; the same three at 100ms apart read as a continuous
 * stream, which is why every one of Showdown's beam moves is built this way.
 */
function projectileStream(
  scene: FxScene,
  attacker: FxActor,
  defender: FxActor,
  sprite: string,
  count = 5,
): void {
  for (let i = 0; i < count; i++) {
    const t = i * 100;
    scene.showEffect(
      sprite,
      { x: attacker.x, y: attacker.y, z: attacker.z, scale: 0.4, opacity: 0.7, time: t },
      { x: defender.x, y: defender.y, z: defender.z, scale: 1, opacity: 0.4, time: t + 400 },
      "decel",
      "explode",
    );
  }
  scene.showEffect(
    "impact",
    { x: defender.x, y: defender.y, z: defender.z, scale: 0.4, opacity: 0.6, time: 460 },
    { scale: 1.1, opacity: 0, time: 760 },
    "linear",
  );
}

/** A single heavy orb — Shadow Ball, Energy Ball, Sludge Bomb. */
function projectileOrb(
  scene: FxScene,
  attacker: FxActor,
  defender: FxActor,
  sprite: string,
): void {
  scene.showEffect(
    sprite,
    { x: attacker.x, y: attacker.y, z: attacker.z, scale: 0.2, opacity: 0.4 },
    { x: attacker.x, y: attacker.y, z: attacker.z, scale: 0.6, opacity: 1, time: 300 },
    "linear",
  );
  scene.showEffect(
    sprite,
    { x: attacker.x, y: attacker.y, z: attacker.z, scale: 0.6, opacity: 1, time: 300 },
    { x: defender.x, y: defender.y, z: defender.z, scale: 0.9, opacity: 0.6, time: 600 },
    "ballistic2",
    "explode",
  );
  scene.showEffect(
    "impact",
    { x: defender.x, y: defender.y, z: defender.z, scale: 0.5, opacity: 0.7, time: 590 },
    { scale: 1.2, opacity: 0, time: 850 },
    "linear",
  );
}

/** A ring on the target that does not travel — status moves and self-buffs. */
function auraOn(scene: FxScene, target: FxActor, sprite: string): void {
  for (let i = 0; i < 3; i++) {
    scene.showEffect(
      sprite,
      { x: target.x, y: target.y, z: target.z, scale: 0.2, opacity: 0.6, time: i * 120 },
      { x: target.x, y: target.y, z: target.z, scale: 1.4, opacity: 0, time: i * 120 + 500 },
      "linear",
    );
  }
}

/**
 * Build the whole animation for a move: actor motion AND effect sprites.
 *
 * Returns whether anything was queued. False means the move keeps only its
 * existing CSS effect, unchanged — which is what makes this portable a move
 * at a time instead of as one 900-move landing.
 */
export function buildMoveFx(
  moveId: string,
  scene: FxScene,
  attacker: FxActor,
  defender: FxActor,
): boolean {
  const id = canonicalMoveId(moveId);
  const move = movesTable[id];
  if (!move) return false;

  // ── THE REAL ANIMATION, IF WE HAVE ONE ──────────────────────────────
  // 163 of our 173 moves have Showdown's actual choreography ported into
  // data/moveAnims.ts. Everything below this line is the fallback for the
  // remaining handful, and for anything added later before it is ported.
  const ported = MOVE_ANIMS[id];
  if (ported) {
    ported(scene, attacker, defender);
    return true;
  }

  if (move.category === "physical") {
    return buildMoveMotion(id, attacker, defender);
  }

  const sprite = TYPE_SPRITE[move.type];
  if (!sprite) return false;

  if (move.category === "status") {
    // A status move aims at whoever it affects. Self-targeted buffs glowing
    // on the opponent is the single most confusing thing a battle UI can do
    // — it reads as the wrong Pokémon getting stronger.
    // `target` only exists on the effect variants that HAVE one (statChange,
    // status); recoil and friends do not carry it. Read defensively rather
    // than narrowing every variant — a status move with no target field is
    // aimed at the opponent, which is the right default.
    const eff = move.effect as { target?: string } | undefined;
    const self = eff?.target === "self";
    auraOn(scene, self ? attacker : defender, sprite);
    return true;
  }

  // Special. A beam-ish move streams; everything else throws one orb.
  if (BEAM_MOVES.has(id)) projectileStream(scene, attacker, defender, sprite);
  else projectileOrb(scene, attacker, defender, sprite);
  return true;
}

/** Moves whose flavour is a sustained jet rather than a thrown object.
 *  Exported for the same reason as TYPE_SPRITE: these ids are hand-written,
 *  and a misspelt one is a beam move that quietly throws a ball instead. */
export const BEAM_MOVES: ReadonlySet<string> = new Set(
  [
    "flamethrower", "fireBlast", "hydroPump", "waterGun", "bubbleBeam", "surf",
    "thunderbolt", "thunder", "thunderShock", "iceBeam", "blizzard", "powderSnow",
    "psybeam", "aurorabeam", "signalBeam", "flashCannon", "dragonBreath",
    "hyperBeam", "solarBeam", "chargeBeam", "ember", "waterPulse",
  ].map(canonicalMoveId),
);
