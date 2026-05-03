import { useRef } from "react";
import { useGame } from "../state/GameContext";
import { moves as movesTable } from "../data/moves";
import { openManageMoves } from "./ManageMovesModal";
import { ControlsPopover } from "./ControlsPopover";
import { openCatchSettings } from "./CatchSettingsModal";
import { IconHospital } from "./Icon";
import { animatePop } from "../utils/animate";
import type { PokemonType } from "../types";

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

const TYPE_COLOR: Record<PokemonType, string> = {
  Normal:   "#a8a878",
  Fire:     "#f08030",
  Water:    "#6890f0",
  Electric: "#f8d030",
  Grass:    "#78c850",
  Ice:      "#98d8d8",
  Fighting: "#c03028",
  Poison:   "#a040a0",
  Ground:   "#e0c068",
  Flying:   "#a890f0",
  Psychic:  "#f85888",
  Bug:      "#a8b820",
  Rock:     "#b8a038",
  Ghost:    "#705898",
  Dragon:   "#7038f8",
  Dark:     "#705848",
  Steel:    "#b8b8d0",
  Fairy:    "#ee99ac",
};

const CATEGORY_ICON: Record<string, string> = {
  physical: "✴",
  special:  "◎",
  status:   "☯",
};

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
export function MovesToolbar() {
  const { state, dispatch } = useGame();
  const player = state.playerPokemon;
  const activeIdx = state.activePlayerPokemonIndex;
  const healBtnRef = useRef<HTMLButtonElement | null>(null);

  // Heal is allowed any time you have a party — even mid-battle. The only
  // gate is "already healing" so we don't double-fire the animation.
  const healDisabled = state.phase === "healing" || !player;

  return (
    <div className="moves-toolbar" role="toolbar" aria-label="Game controls">
      <div className="moves-toolbar-group speed-segment" role="group" aria-label="Game speed">
        {[1, 2, 5].map((s) => (
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
      <div className="moves-toolbar-group">
        <button
          ref={healBtnRef}
          className="toolbar-btn heal-quick-btn"
          disabled={healDisabled}
          onClick={() => {
            if (healBtnRef.current) animatePop(healBtnRef.current, 1.15);
            dispatch({ type: "START_HEALING" });
          }}
          title={healDisabled ? "Cannot heal right now" : "Heal your party"}
        >
          <IconHospital size={13} />
          <span>Heal</span>
        </button>
        <button
          className="toolbar-btn manage-moves-btn"
          disabled={!player}
          onClick={() => openManageMoves({ type: "party", index: activeIdx })}
          title="Manage moves"
        >
          Manage
        </button>
        <button
          className="toolbar-btn"
          onClick={() => openCatchSettings(state.currentLocation)}
          title="Catch settings for the current area"
        >
          Catch
        </button>
        <ControlsPopover />
      </div>
    </div>
  );
}

// 2x2 moves grid. In manual mode each slot is clickable to fire EXECUTE_TURN;
// otherwise the slot opens Manage Moves. The toolbar above is rendered as a
// separate bar (see MovesToolbar) so this card is purely the moveset.
export function MovesPanel() {
  const { state, dispatch } = useGame();
  const player = state.playerPokemon;
  const slots = [...(player?.moves ?? [])];
  while (slots.length < 4) slots.push(null as unknown as (typeof slots)[number]);

  const activeIdx = state.activePlayerPokemonIndex;
  const pickable = canPickMove(state);

  const onSlotClick = (moveId: string | null, hasPP: boolean) => {
    if (pickable && moveId && hasPP) {
      dispatch({ type: "EXECUTE_TURN", payload: { playerMoveId: moveId } });
    } else if (player) {
      openManageMoves({ type: "party", index: activeIdx });
    }
  };

  return (
    <div className={`moves-panel ${pickable ? "pickable" : ""}`}>
      {slots.map((m, i) => {
        if (!m) return <div key={i} className="move-slot empty" />;
        const def = movesTable[m.id];
        if (!def) return <div key={i} className="move-slot empty" />;
        const color = TYPE_COLOR[def.type] ?? "#888";
        const icon = CATEGORY_ICON[def.category] ?? "✴";
        const hasPP = m.pp > 0;
        const disabled = pickable && !hasPP;
        return (
          <button
            type="button"
            key={i}
            className={`move-slot ${disabled ? "no-pp" : ""} ${pickable ? "is-pickable" : ""}`}
            style={{ background: color }}
            disabled={disabled}
            onClick={() => onSlotClick(m.id, hasPP)}
            title={moveTooltip(def, m, pickable, hasPP)}
          >
            <div className="move-slot-name">
              <span className="move-cat">{icon}</span> {def.name}
            </div>
            <div className="move-slot-stats">
              <span>Pow {def.power || "—"}</span>
              <span>{def.type}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
