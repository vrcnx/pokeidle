import { useGame } from "../state/GameContext";
import { TrainerSprite } from "./Sprite";

// Slides a trainer sprite in BEHIND the opponent Pokemon at the start of a
// trainer / boss battle (and on every trainer-send-next). The slide-in /
// hold / slide-out timing matches the pokeball-pop duration of the Pokemon
// sprite so the two read as one beat.
//
// The beat is SPEED-SCALED. Its duration and the Pokemon's entrance delay come
// from --trainer-intro-dur / --trainer-intro-delay, published on .battle-scene
// by BattleScene from utils/battleTiming.ts, which also gives useBattleLoop the
// matching settle window. Nothing here has a timing of its own — the animation
// used to be a flat 1500ms and was the one thing ×5 speed didn't touch
// (br_7362030de4444c8da8).
//
// We use the enemy Pokemon's id as the React key — when a new opponent
// appears (trainer's first mon, send-next, etc.) the element re-mounts and
// the CSS animation re-fires. Outside trainer/boss battles this renders
// nothing.
export function TrainerIntro() {
  const { state } = useGame();
  const battle = state.trainerBattle ?? state.bossBattle;
  const enemy = state.enemyPokemon;
  if (!battle || !enemy) return null;

  // `missing="hidden"`: this sprite is purely decorative — the same trainer
  // is already named and pictured on the context panel, and this copy slides
  // across half the arena. A placeholder box here would be louder than the
  // thing it stands in for, so this is the ONE sprite allowed to end up
  // hidden, and only after Sprite's retry chain has been exhausted. A
  // transient failure still self-heals.
  return (
    <TrainerSprite
      key={`trainer-${enemy.id}`}
      className="trainer-behind"
      spriteKey={battle.spriteKey}
      alt={battle.trainerName}
      title={battle.trainerName}
      missing="hidden"
    />
  );
}
