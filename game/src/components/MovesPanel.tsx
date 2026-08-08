import { useGame } from "../state/GameContext";
import { moves as movesTable } from "../data/moves";
import { openManageMoves } from "./ManageMovesModal";
import { ControlsPopover } from "./ControlsPopover";
import { openCatchSettings } from "./CatchSettingsModal";
import { IconEdit, IconTarget } from "./Icon";
import { STRUGGLE_ID, isOutOfPP } from "../utils/battle";
import { typeEffectiveness } from "../utils/typing";
import { pokemonTable } from "../data/pokemon";
import type { PokemonType } from "../types";
import { useT } from "../i18n/useT";
import { MoveCard, effChip } from "./MoveCard";
import { moveDescriptions } from "../data/moveDescriptions";

// Manual-mode predicate. When the player needs to pick a move to advance the
// turn, every move slot becomes a clickable button. Anything else (recharge,
// locked-into-Outrage, mid-animation event drain, awaiting party switch) keeps
// the panel read-only and lets the simulation keep moving.
function canPickMove(state: ReturnType<typeof useGame>["state"]): boolean {
  if (state.battleMode !== "manual") return false;
  if (state.phase !== "battle" && state.phase !== "trainerBattle" && state.phase !== "bossBattle") return false;
  if (state.pendingEvents.length > 0) return false;
  if (state.awaitingSwitch) return false;
  if (!state.playerPokemon || !state.enemyPokemon) return false;
  if (state.playerVolatile?.mustRecharge) return false;
  if (state.playerVolatile?.lockedMove) return false;
  return true;
}

function moveTooltip(
  def: (typeof movesTable)[string],
  slot: { pp: number; maxPp: number },
  pickable: boolean,
  hasPP: boolean
): string {
  const head = pickable
    ? hasPP ? `Use ${def!.name}` : `${def!.name} — out of PP`
    : def!.name;
  const lines = [
    head,
    `${def!.type} · ${def!.category} · Acc ${def!.accuracy}%`,
  ];
  const eff = (def as any)!.effect;
  if (eff) {
    const pct = (c: number) => `${Math.round(c * 100)}%`;
    switch (eff.type) {
      case "inflictStatus":
        lines.push(`${pct(eff.chance)} ${eff.status} chance`);
        break;
      case "confuse":
        lines.push(`${pct(eff.chance)} confuse chance`);
        break;
      case "multiHit":
        lines.push(eff.minHits === eff.maxHits ? `Hits ${eff.minHits}×` : `Hits ${eff.minHits}–${eff.maxHits}×`);
        break;
      case "recoil":
        lines.push(`Recoil ${pct(eff.fraction)} of damage`);
        break;
      case "crashOnMiss":
        lines.push(`Crashes for ${pct(eff.fraction)} maxHP on miss`);
        break;
      case "recharge":
        lines.push(`Must recharge next turn`);
        break;
      case "selfDestruct":
        lines.push(`User faints`);
        break;
      case "multiTurnLock":
        lines.push(`Locked ${eff.minTurns}–${eff.maxTurns} turns; confuses self after`);
        break;
      case "statChange": {
        const target = eff.target === "self" ? "Self" : "Target";
        const changes = Object.entries(eff.changes).map(([k, v]) =>
          `${k} ${(v as number) > 0 ? "+" : ""}${v}`
        ).join(", ");
        lines.push(`${target}: ${changes}`);
        break;
      }
    }
  }
  if ((def as any)!.critRatio && (def as any)!.critRatio > 1) {
    lines.push(`High crit rate (1/${Math.round(16 / (def as any)!.critRatio)})`);
  }
  if ((def as any)!.isPunch) lines.push(`Punching move`);
  return lines.join("\n");
}

// Standalone toolbar bar that lives between the battle scene and the moves
// grid. Holds speed, heal, manage, and the More popover. Rendered separately
// from the moves card so it reads as a global controls strip.
//
// 5x is offered to EVERYONE. It was briefly admin-only, with non-admins above
// 2x clamped down on load; that is reverted. Players preferred 5x — 850 of
// 2,327 accounts (36.5%) were sitting on it when the gate shipped — so the
// speed segment is back to the full 1x / 2x / 5x for every account.
//
// No reverse migration is needed or wanted: the clamp moved those accounts to
// 2x and 2x is a legal speed. The button is simply on offer again, and anyone
// who wants 5x clicks it.
const SPEEDS = [1, 2, 5];

export function MovesToolbar() {
  const { state, dispatch } = useGame();
  const t = useT();
  const player = state.playerPokemon;
  const activeIdx = state.activePlayerPokemonIndex;

  return (
    <div className="moves-toolbar" role="toolbar" aria-label={t("Game controls")}>
      <div className="moves-toolbar-group speed-segment" role="group" aria-label={t("Game speed")}>
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            className={`speed-btn ${state.speed === s ? "active" : ""}`}
            onClick={() => dispatch({ type: "SET_SPEED", payload: { speed: s } })}
            aria-pressed={state.speed === s}
            title={`${s}× speed`}
          >
            {s}×
          </button>
        ))}
      </div>
      {/* Heal MOVED to the top-right of the Party card (br_27cfd612ddd30485fc).
          It acted on the party but lived in a row of battle controls between
          the speed segment and Manage Moves, in a different column from the six
          rows it heals. Deliberately not left here as a duplicate: two Heal
          buttons in one screen is how a player ends up unsure which one
          retreats from the battle. See PartyHealButton in PartyColumn.tsx. */}
      <div className="moves-toolbar-group">
        <button
          className="toolbar-btn manage-moves-btn"
          disabled={!player}
          onClick={() => openManageMoves({ type: "party", index: activeIdx })}
          title={t("Manage moves")}
        >
          <IconEdit size={13} />
          <span>{t("Manage")}</span>
        </button>
        <button
          className="toolbar-btn"
          onClick={() => openCatchSettings(state.currentLocation)}
          title={t("Catch settings for the current area")}
        >
          <IconTarget size={13} />
          <span>{t("Catch")}</span>
        </button>
        <ControlsPopover />
      </div>
    </div>
  );
}

// 2x2 moves grid. In manual mode each slot is clickable to fire EXECUTE_TURN;
// otherwise the slot opens Manage Moves. The toolbar above is rendered as a
// separate bar (see MovesToolbar) so this card is purely the moveset.
//
// Each tile shows: name, category icon (physical/special/status), power, type,
// PP / max PP, and — when there's an active enemy — a type-effectiveness
// badge ("2×", "½×", "Immune") computed against the opponent's typing.
export function MovesPanel() {
  const { state, dispatch } = useGame();
  const t = useT();
  const player = state.playerPokemon;
  const slots = [...(player?.moves ?? [])];
  while (slots.length < 4) slots.push(null as unknown as (typeof slots)[number]);

  const activeIdx = state.activePlayerPokemonIndex;
  const pickable = canPickMove(state);
  // Every slot empty means every slot is disabled — without an explicit
  // Struggle button there is nothing left to click and manual mode has no
  // way to advance the turn.
  const outOfPP = !!player && isOutOfPP(player.moves);

  // Defender type lookup — used for type-effectiveness preview on each
  // tile. Status moves don't deal type-affected damage so we skip the
  // badge for them. Pulled from the species table because the enemy
  // Pokemon shape only carries its species key.
  const enemyTypes: PokemonType[] = state.enemyPokemon
    ? (pokemonTable[state.enemyPokemon.speciesKey]?.types ?? []) as PokemonType[]
    : [];

  const onSlotClick = (moveId: string | null, hasPP: boolean) => {
    if (pickable && moveId && hasPP) {
      dispatch({ type: "EXECUTE_TURN", payload: { playerMoveId: moveId } });
    } else if (player) {
      openManageMoves({ type: "party", index: activeIdx });
    }
  };

  return (
    <div className={`moves-panel mv-grid ${pickable ? "pickable" : ""}`}>
      {slots.map((m, i) => {
        if (!m) return <div key={i} className="mv-card mv-card--empty" />;
        const def = movesTable[m.id];
        if (!def) return <div key={i} className="mv-card mv-card--empty" />;
        const hasPP = m.pp > 0;
        const disabled = pickable && !hasPP;
        // Effectiveness is only meaningful for damaging moves with an enemy
        // on screen. Status moves and "no enemy" skip it rather than claim a
        // neutral multiplier they do not have.
        const eff = effChip(def.type, def.category, enemyTypes);
        return (
          <MoveCard
            key={i}
            name={def.name}
            type={def.type}
            category={def.category}
            power={def.power}
            accuracy={def.accuracy}
            pp={m.pp}
            maxPp={m.maxPp}
            eff={eff}
            description={moveDescriptions[m.id]}
            disabled={disabled}
            pickable={pickable}
            title={moveTooltip(def, m, pickable, hasPP)}
            onClick={() => onSlotClick(m.id, hasPP)}
          />
        );
      })}
      {pickable && outOfPP && (
        <MoveCard
          name={t("Struggle")}
          type={null}
          category="physical"
          power={50}
          accuracy={100}
          pp={1}
          maxPp={1}
          eff={null}
          pickable
          struggle
          title={t("No moves left — Struggle hits weakly and hurts you too")}
          onClick={() =>
            dispatch({ type: "EXECUTE_TURN", payload: { playerMoveId: STRUGGLE_ID } })
          }
        />
      )}
    </div>
  );
}
