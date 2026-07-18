import { useEffect, useState } from "react";
import { useGame } from "../state/GameContext";
import { raidLegendaries, RAID_COOLDOWN_MS } from "../data/raidLegendaries";
import { pokemonTable } from "../data/pokemon";
import { pokemonSpriteUrl } from "../utils/sprites";
import { useT } from "../i18n/useT";

export function RaidPanel() {
  const { state, dispatch } = useGame();
  const [now, setNow] = useState(() => Date.now());
  const t = useT();

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!state.championDefeated) {
    return (
      <div className="raid-panel">
        <h2>{t("Raid Island")}</h2>
        <p className="dim">{t("Defeat the Champion to unlock legendary raids.")}</p>
      </div>
    );
  }

  const cooldownRemaining = state.raidCooldownEnd
    ? Math.max(0, state.raidCooldownEnd - now)
    : 0;

  function startRaid(speciesKey: string, level: number) {
    if (cooldownRemaining > 0 || state.inRaid) return;
    dispatch({ type: "START_RAID", payload: { speciesKey, level } });
  }

  return (
    <div className="raid-panel">
      <h2>{t("🏝️ Raid Island")}</h2>
      <p className="dim">
        {t("Battle a legendary at full power. Win and you can try to catch it.")}
        {RAID_COOLDOWN_MS / 60000}{t("-minute cooldown between raids.")}
      </p>
      {state.inRaid && state.raidLegendary ? (
        <p>
          <strong>{t("In raid:")}</strong>{" "}
          {pokemonTable[state.raidLegendary.speciesKey]?.name} L{state.raidLevel}
        </p>
      ) : cooldownRemaining > 0 ? (
        <p>{t("Cooldown: ")}{Math.ceil(cooldownRemaining / 1000)}s</p>
      ) : null}
      <div className="raid-grid">
        {raidLegendaries.map((l) => {
          const sp = pokemonTable[l.speciesKey];
          return (
            <button
              key={l.speciesKey}
              className="raid-card"
              disabled={cooldownRemaining > 0 || state.inRaid}
              onClick={() => startRaid(l.speciesKey, l.level)}
            >
              <img
                src={pokemonSpriteUrl(l.speciesKey)}
                alt={sp?.name}
                width={96}
                height={96}
                style={{ imageRendering: "pixelated" }}
              />
              <strong>{sp?.name ?? l.speciesKey}</strong>
              <small>{t("Level ")}{l.level}</small>
              <small className="dim">{sp?.types.join(" / ")}</small>
            </button>
          );
        })}
      </div>
      {state.inRaid && (
        <button
          onClick={() => {
            if (confirm(t("Flee the raid?"))) dispatch({ type: "END_RAID" });
          }}
        >
          {t("Flee")}
        </button>
      )}
    </div>
  );
}
