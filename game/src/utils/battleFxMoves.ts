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

import { FxActor } from "./battleFx";
import { canonicalMoveId } from "./moves";
import { moves as movesTable } from "../data/moves";

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
