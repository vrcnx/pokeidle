import { useEffect } from "react";
import { useGame } from "../state/GameContext";
import { useAuth } from "../auth/AuthContext";
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
// 5x is no longer offered to players — 1x and 2x only. It stays available to
// admins and to the 24-7 stream, which is an operator-run showcase and needs
// to cover ground on camera.
//
// This is a UI gate, not a security boundary, and it is not pretending to be
// one: SET_SPEED is a client reducer and the save is client-authoritative, so
// anyone determined can still write speed:5 into their own blob. That is
// fine. The point is that the game no longer OFFERS it, not that it is
// cryptographically forbidden.
//
// Migration matters here more than the gate does: 850 of 2,327 accounts
// (36.5%) were sitting on 5x when this shipped. Hiding the button alone would
// have left every one of them stuck at a speed the UI could no longer show or
// change — the segment would render 1x/2x with neither marked active, and
// clicking either would feel like a downgrade with no explanation. So a
// non-admin found above 2x is moved to 2x once, and told why in the battle
// log rather than silently.
const PLAYER_SPEEDS = [1, 2];
const ADMIN_SPEEDS = [1, 2, 5];
const MAX_PLAYER_SPEED = 2;

export function MovesToolbar() {
  const { state, dispatch } = useGame();
  const { me } = useAuth();
  const t = useT();
  const player = state.playerPokemon;
  const activeIdx = state.activePlayerPokemonIndex;
  const canFastForward = !!me?.isAdmin || !!me?.isStream;
  const speedChoices = canFastForward ? ADMIN_SPEEDS : PLAYER_SPEEDS;

  // Pull a player down off a speed that no longer exists for them. Keyed on
  // the resolved flag rather than firing before the profile has loaded —
  // `me` is null while auth is still resolving, and clamping then would
  // briefly demote an admin on every refresh.
  useEffect(() => {
    if (!me) return;
    if (canFastForward) return;
    if (state.speed <= MAX_PLAYER_SPEED) return;
    dispatch({ type: "SET_SPEED", payload: { speed: MAX_PLAYER_SPEED } });
  }, [me, canFastForward, state.speed, dispatch]);

  return (
    <div className="moves-toolbar" role="toolbar" aria-label={t("Game controls")}>
      <div className="moves-toolbar-group speed-segment" role="group" aria-label={t("Game speed")}>
        {speedChoices.map((s) => (
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
    <div className={`moves-panel ${pickable ? "pickable" : ""}`}>
      {slots.map((m, i) => {
        if (!m) return <div key={i} className="move-slot empty" />;
        const def = movesTable[m.id];
        if (!def) return <div key={i} className="move-slot empty" />;
        const color = TYPE_COLOR[def.type] ?? "#888";
        const icon = CATEGORY_ICON[def.category] ?? "✴";
        const hasPP = m.pp > 0;
        const ppLow = hasPP && m.pp <= Math.max(1, Math.ceil(m.maxPp * 0.25));
        const disabled = pickable && !hasPP;
        // Effectiveness badge — only meaningful for damaging moves
        // when the enemy is on-screen. Status moves and "no enemy"
        // skip the chip so we don't mislead.
        const showEff = def.category !== "status" && enemyTypes.length > 0;
        const effMult = showEff ? typeEffectiveness(def.type, enemyTypes) : 1;
        const effClass = !showEff ? ""
          : effMult === 0 ? "eff-immune"
          : effMult >= 2 ? "eff-super"
          : effMult <= 0.5 ? "eff-resist"
          : "eff-neutral";
        const effLabel =
          effMult === 0 ? t("Immune")
          : effMult >= 4 ? "4×"
          : effMult >= 2 ? "2×"
          : effMult === 0.25 ? "¼×"
          : effMult <= 0.5 ? "½×"
          : "";
        return (
          <button
            type="button"
            key={i}
            className={`move-slot ${disabled ? "no-pp" : ""} ${pickable ? "is-pickable" : ""} ${effClass}`}
            style={{ background: color }}
            disabled={disabled}
            onClick={() => onSlotClick(m.id, hasPP)}
            title={moveTooltip(def, m, pickable, hasPP)}
          >
            <div className="move-slot-name">
              <span className="move-cat">{icon}</span> {def.name}
              {showEff && effLabel && (
                <span className="move-eff-chip" aria-label={`${effMult}× damage vs opponent`}>
                  {effLabel}
                </span>
              )}
            </div>
            <div className="move-slot-stats">
              <span>{t("Pow")} {def.power || "—"}</span>
              <span>{def.type}</span>
              <span className={`move-pp ${ppLow ? "low" : ""} ${!hasPP ? "out" : ""}`}>
                {t("PP")} {m.pp}/{m.maxPp}
              </span>
            </div>
          </button>
        );
      })}
      {pickable && outOfPP && (
        <button
          type="button"
          className="move-slot struggle-slot is-pickable"
          onClick={() =>
            dispatch({ type: "EXECUTE_TURN", payload: { playerMoveId: STRUGGLE_ID } })
          }
          title={t("No moves left — Struggle hits weakly and hurts you too")}
        >
          <div className="move-slot-name">
            <span className="move-cat">✴</span> {t("Struggle")}
          </div>
          <div className="move-slot-stats">
            <span>{t("Out of PP — heal to restore it")}</span>
          </div>
        </button>
      )}
    </div>
  );
}
