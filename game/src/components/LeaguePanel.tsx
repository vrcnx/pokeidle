import { useGame } from "../state/GameContext";
import { eliteFour, champion } from "../data/eliteFour";
import { gymLeaders } from "../data/gymLeaders";
import { trainerSpriteUrl } from "../utils/sprites";
import { buildTeam } from "../utils/trainerFactory";
import type { BossBattle } from "../types";

// The Pokemon League: Indigo Plateau gauntlet of Elite Four + Champion.
// Unlocked after all 8 gym badges. Battles run as a queue with no healing
// between fights (the reducer's BOSS_BATTLE_END handles the chaining).
export function LeaguePanel() {
  const { state, dispatch } = useGame();
  const inBattle =
    state.phase === "battle" || state.phase === "trainerBattle" || state.phase === "bossBattle";

  const allBadges = state.defeatedGyms.length >= gymLeaders.length;
  const eliteCleared = state.defeatedEliteFour.length >= eliteFour.length;
  const championBeaten = state.championDefeated;

  function startGauntlet() {
    if (inBattle || !allBadges) return;
    // Build queued boss battles for the four E4 (skipping any already defeated)
    // followed by the Champion (if not yet beaten).
    const queue: BossBattle[] = [];
    for (const e4 of eliteFour) {
      if (state.defeatedEliteFour.includes(e4.id)) continue;
      const { team } = buildTeam(e4.team, `e4_${e4.id}`);
      queue.push({
        bossId: e4.id,
        bossType: "e4",
        trainerName: e4.name,
        trainerClass: "e4",
        trainerTeam: team,
        currentTrainerPokemonIndex: 0,
        spriteKey: e4.spriteKey,
      });
    }
    if (!state.championDefeated) {
      const { team } = buildTeam(champion.team, `champion_${champion.id}`);
      queue.push({
        bossId: champion.id,
        bossType: "champion",
        trainerName: champion.name,
        trainerClass: "champion",
        trainerTeam: team,
        currentTrainerPokemonIndex: 0,
        spriteKey: champion.spriteKey,
      });
    }
    if (queue.length === 0) return;
    // Dispatch the first one with the rest as bossQueue
    const [first, ...rest] = queue;
    dispatch({
      type: "START_BOSS_BATTLE",
      payload: {
        bossId: first.bossId,
        bossType: first.bossType,
        trainerName: first.trainerName,
        trainerClass: first.trainerClass,
        trainerTeam: first.trainerTeam,
        spriteKey: first.spriteKey,
        bossQueue: rest,
      },
    });
  }

  if (!allBadges) {
    return (
      <div className="league-panel">
        <h2>🏆 Pokémon League</h2>
        <p className="dim">
          Earn all 8 Gym Badges to challenge the Elite Four. ({state.defeatedGyms.length}/{gymLeaders.length} earned)
        </p>
      </div>
    );
  }

  return (
    <div className="league-panel">
      <h2>🏆 Pokémon League — Indigo Plateau</h2>
      <p className="dim">
        Battle the Elite Four and Champion in sequence with no healing between fights.
        Defeat all four E4 to unlock the Champion. Each E4 win earns no token; the
        Champion win earns 1 Victory Token and the title.
      </p>

      <h3>Elite Four</h3>
      <div className="trainers-grid">
        {eliteFour.map((m) => {
          const beaten = state.defeatedEliteFour.includes(m.id);
          return (
            <div key={m.id} className={`trainer-card ${beaten ? "defeated" : ""}`}>
              <img
                src={trainerSpriteUrl(m.spriteKey)}
                alt={m.name}
                width={56}
                height={56}
                style={{ imageRendering: "pixelated" }}
                onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
              />
              <div className="trainer-info">
                <strong>
                  {m.name} {beaten && "✓"}
                </strong>
                <small className="dim">
                  {m.team.map((t) => `${t.speciesKey} L${t.level}`).join(", ")}
                </small>
              </div>
            </div>
          );
        })}
      </div>

      <h3>Champion</h3>
      <div className={`trainer-card boss ${championBeaten ? "defeated" : ""}`}>
        <img
          src={trainerSpriteUrl(champion.spriteKey)}
          alt={champion.name}
          width={64}
          height={64}
          style={{ imageRendering: "pixelated" }}
          onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
        />
        <div>
          <strong>
            {champion.name} {championBeaten && "✓"}
          </strong>
          <div className="dim">{champion.title}</div>
          <div>
            {champion.team.map((t) => `${t.speciesKey} L${t.level}`).join(", ")}
          </div>
        </div>
      </div>

      <div className="league-actions">
        <button
          disabled={inBattle || (eliteCleared && championBeaten)}
          onClick={startGauntlet}
        >
          {eliteCleared && championBeaten
            ? "Already conquered"
            : eliteCleared
            ? "Challenge Champion"
            : "Begin Gauntlet"}
        </button>
        {eliteCleared && (
          <button
            onClick={() => {
              if (confirm("Reset Elite Four progress so you can re-challenge them?")) {
                dispatch({ type: "RESET_ELITE_FOUR" });
              }
            }}
          >
            Reset E4 progress
          </button>
        )}
      </div>
    </div>
  );
}
