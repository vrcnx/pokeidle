import { useGame } from "../state/GameContext";
import { trainerSpriteUrl } from "../utils/sprites";

// Slides a trainer sprite in BEHIND the opponent Pokemon at the start of a
// trainer / boss battle (and on every trainer-send-next). The slide-in /
// hold / slide-out timing matches the pokeball-pop duration of the Pokemon
// sprite so the two read as one beat.
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

  return (
    <img
      key={`trainer-${enemy.id}`}
      className="trainer-behind"
      src={trainerSpriteUrl(battle.spriteKey)}
      alt={battle.trainerName}
      title={battle.trainerName}
      onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
    />
  );
}
