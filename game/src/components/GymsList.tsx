import { useGame } from "../state/GameContext";
import { regions, regionForLocation, DEFAULT_REGION } from "../data/regions";
import { regionBadgeCount, regionEliteFourCount } from "../utils/unlocks";
import { routes } from "../data/routes";
import { TrainerSprite } from "./Sprite";
import { buildTeam } from "../utils/trainerFactory";
import type { BossBattle } from "../types";
import { useT } from "../i18n/useT";

// Gyms tab — shows badges, all gym leaders (with Challenge buttons for any
// unlocked + undefeated), and a League block to launch the E4 → Champion
// gauntlet once all badges for THIS region are earned.
//
// Region-scoped, not global: gymLeaders/eliteFour/champion come from
// whichever region the player is currently standing in, derived below.
// Before Johto existed this was a flat import of Kanto's own arrays with
// the same effect; keeping it flat once a second region registers would
// silently double Kanto's own 8-badge Elite Four gate to 16 for every
// existing player. defeatedChampions (not the global championDefeated
// boolean) answers "have I beaten THIS region's champion" — see its
// definition in types/index.ts for why the boolean alone can't.

export function GymsList() {
  const { state, dispatch } = useGame();
  const t = useT();
  const activeRegionId = regionForLocation(state.currentLocation) ?? DEFAULT_REGION;
  const region = regions[activeRegionId] ?? regions[DEFAULT_REGION];
  const gymLeaders = region.gymLeaders;
  const eliteFour = region.eliteFour;
  const champion = region.champion!;
  const championBeaten = state.defeatedChampions.includes(champion.id);
  const inBattle =
    state.phase === "battle" ||
    state.phase === "trainerBattle" ||
    state.phase === "bossBattle";

  function challengeGym(g: typeof gymLeaders[number]) {
    if (inBattle) return;
    if (state.defeatedGyms.includes(g.id)) return;
    if (!state.unlockedLocations.includes(g.locationKey)) return;
    const { team } = buildTeam(g.team, `gym_${g.id}_${Date.now()}`);
    dispatch({
      type: "START_BOSS_BATTLE",
      payload: {
        bossId: g.id,
        bossType: "gym",
        trainerName: g.name,
        trainerClass: "gym",
        trainerTeam: team,
        spriteKey: g.spriteKey,
      },
    });
  }

  function challengeE4Member(m: typeof eliteFour[number]) {
    if (inBattle) return;
    if (!allBadges) return;
    if (state.defeatedEliteFour.includes(m.id)) return;
    const { team } = buildTeam(m.team, `e4_${m.id}_${Date.now()}`);
    dispatch({
      type: "START_BOSS_BATTLE",
      payload: {
        bossId: m.id,
        bossType: "e4",
        trainerName: m.name,
        trainerClass: "e4",
        trainerTeam: team,
        spriteKey: m.spriteKey,
      },
    });
  }

  function challengeChampion() {
    if (inBattle) return;
    if (!allBadges || !allE4) return;
    if (championBeaten) return;
    const { team } = buildTeam(champion.team, `champion_${champion.id}_${Date.now()}`);
    dispatch({
      type: "START_BOSS_BATTLE",
      payload: {
        bossId: champion.id,
        bossType: "champion",
        trainerName: champion.name,
        trainerClass: "champion",
        trainerTeam: team,
        spriteKey: champion.spriteKey,
      },
    });
  }

  function beginGauntlet() {
    if (inBattle) return;
    if (regionBadgeCount(state, region) < gymLeaders.length) return;
    const queue: BossBattle[] = [];
    for (const m of eliteFour) {
      if (state.defeatedEliteFour.includes(m.id)) continue;
      const { team } = buildTeam(m.team, `e4_${m.id}_${Date.now()}`);
      queue.push({
        bossId: m.id,
        bossType: "e4",
        trainerName: m.name,
        trainerClass: "e4",
        trainerTeam: team,
        currentTrainerPokemonIndex: 0,
        spriteKey: m.spriteKey,
      });
    }
    if (!championBeaten) {
      const { team } = buildTeam(champion.team, `champion_${champion.id}_${Date.now()}`);
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

  const allBadges = regionBadgeCount(state, region) >= gymLeaders.length;
  const allE4 = regionEliteFourCount(state, region) >= eliteFour.length;
  // What — if anything — is the player currently fighting in the boss slot?
  const activeBoss = state.bossBattle ?? null;
  const inGauntlet =
    activeBoss?.bossType === "e4" || activeBoss?.bossType === "champion";

  return (
    <div className="gyms-list">
      <div className="badges-row">
        {gymLeaders.map((g) => (
          <span
            key={g.id}
            className={`badge ${state.defeatedGyms.includes(g.id) ? "earned" : ""}`}
            style={{
              background: state.defeatedGyms.includes(g.id) ? g.badgeColor : "#3a3027",
            }}
            title={state.defeatedGyms.includes(g.id) ? g.badgeName : t("Locked")}
          />
        ))}
      </div>

      <h4>{t("Gym Leaders")}</h4>
      <ul className="gym-list">
        {gymLeaders.map((g) => {
          const beaten = state.defeatedGyms.includes(g.id);
          const unlocked = state.unlockedLocations.includes(g.locationKey);
          return (
            <li key={g.id} className={`${beaten ? "beaten" : unlocked ? "" : "locked"}`}>
              {unlocked ? (
                <TrainerSprite
                  spriteKey={g.spriteKey}
                  alt={g.name}
                  width={28}
                  height={28}
                  style={{ imageRendering: "pixelated" }}
                />
              ) : (
                <span className="gym-mystery">???</span>
              )}
              <div>
                <strong>{unlocked ? g.name : "???"}</strong>
                <small className="dim">
                  {unlocked
                    ? `${routes[g.locationKey]?.name ?? g.locationKey}`
                    : t("Locked")}
                </small>
              </div>
              {beaten ? (
                <span className="check">✓</span>
              ) : unlocked ? (
                <button
                  className="gym-challenge"
                  disabled={inBattle}
                  onClick={() => challengeGym(g)}
                >
                  {activeBoss?.bossType === "gym" && activeBoss.bossId === g.id
                    ? t("Fighting…")
                    : t("Fight")}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>

      <h4>{t("Elite Four & Champion")}</h4>
      <p className="dim small" style={{ margin: "0 0 4px" }}>
        {allBadges
          ? t("Fight any Elite Four member directly, or run the full Gauntlet for one continuous run.")
          : `Earn all ${gymLeaders.length} badges to enter (${regionBadgeCount(state, region)}/${gymLeaders.length}).`}
      </p>
      <ul className="gym-list">
        {eliteFour.map((m) => {
          const beaten = state.defeatedEliteFour.includes(m.id);
          return (
            <li key={m.id} className={`${beaten ? "beaten" : allBadges ? "" : "locked"}`}>
              {allBadges ? (
                <TrainerSprite
                  spriteKey={m.spriteKey}
                  alt={m.name}
                  width={28}
                  height={28}
                  style={{ imageRendering: "pixelated" }}
                />
              ) : (
                <span className="gym-mystery">???</span>
              )}
              <div>
                <strong>{allBadges ? m.name : "???"}</strong>
                <small className="dim">{m.title}</small>
              </div>
              {beaten ? (
                <span className="check">✓</span>
              ) : allBadges ? (
                <button
                  className="gym-challenge"
                  disabled={inBattle}
                  onClick={() => challengeE4Member(m)}
                >
                  {activeBoss?.bossType === "e4" && activeBoss.bossId === m.id
                    ? t("Fighting…")
                    : t("Fight")}
                </button>
              ) : null}
            </li>
          );
        })}
        <li className={championBeaten ? "beaten" : (allE4 ? "" : "locked")}>
          {allE4 ? (
            <TrainerSprite
              spriteKey={champion.spriteKey}
              alt={champion.name}
              width={28}
              height={28}
              style={{ imageRendering: "pixelated" }}
            />
          ) : (
            <span className="gym-mystery">???</span>
          )}
          <div>
            <strong>{allE4 ? champion.name : "???"}</strong>
            <small className="dim">{champion.title}</small>
          </div>
          {championBeaten ? (
            <span className="check">✓</span>
          ) : allE4 ? (
            <button
              className="gym-challenge"
              disabled={inBattle}
              onClick={challengeChampion}
            >
              {activeBoss?.bossType === "champion" ? t("Fighting…") : t("Fight")}
            </button>
          ) : null}
        </li>
      </ul>
      <button
        className="gauntlet-btn"
        disabled={
          !allBadges || inBattle || (allE4 && championBeaten)
        }
        onClick={beginGauntlet}
      >
        {inGauntlet
          ? t("In Gauntlet…")
          : championBeaten && allE4
          ? t("Already conquered")
          : t("Begin Gauntlet")}
      </button>
    </div>
  );
}
