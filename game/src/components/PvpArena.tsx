// The PvP arena: a battle that takes over the layout in place.
//
// LAYOUT DECISION (and why it matters more than it looks)
//
// The arena does NOT take the whole screen. The centre column keeps the
// same slot the idle battle scene occupies, the left chat rail stays, and
// only the RIGHT rail converts to PvP panels. That was the owner's call and
// it removes an entire class of bug: a full-screen takeover would unmount
// GameShell, and GameShell's subtree contains the only components that can
// clear a terminal `state.phase` — EvolutionModal, HealOverlay,
// WhiteoutOverlay and RegionStarterSelect. Unmounting mid-phase leaves
// `phase: "evolution"` set with no mounted resolver, and useBattleLoop
// early-returns on that phase PERMANENTLY, so the idle game would be dead
// until a page reload. Keeping the shell mounted means that can't happen,
// and no risky hoist is needed.
//
// Everything here renders off `room.view` — the decoded battle state from
// state/pvpBattleView.ts — not off a re-walk of the log. The old UI derived
// the foe's Pokémon by scanning the whole log on every render and only
// understood four line types, so a foe's status never cleared and boosts
// never showed at all.
//
// VISUAL LANGUAGE: the fighter cards deliberately emit the SAME class names
// as the idle game's HpCard (.hp-card, .hp-card-row, .hp-card-bar,
// .hp-status-badge, .type-badge) and the same .trainer-tag / .trainer-ball
// markup as a trainer battle. That is why the arena looks native without
// duplicating a single style rule — the cascade already knows how to draw
// all of it. New PvP-only chrome lives in pvpArena.css under `pvp2-`.

import { useEffect, useRef, useState } from "react";
import {
  usePvpState,
  chooseBattleAction,
  cancelBattle,
  clearBattleRoom,
  type BattleRoom,
} from "../state/pvp";
import type { ActiveMon, BenchMon, NarrationLine, SideView } from "../state/pvpBattleView";
import { PokemonSprite } from "./Sprite";
import { pokemonTable } from "../data/pokemon";
import { moves as movesTable } from "../data/moves";
import { itemSpriteUrl } from "../utils/sprites";
import { typeEffectiveness } from "../utils/typing";
import { TYPE_COLOR } from "../utils/moveEffects";
import { openPublicTrainerCard } from "./TrainerCardModal";
import type { PokemonType } from "../types";
import { useT } from "../i18n/useT";
import "../pvpArena.css";

/** Indigo Plateau: the League arena. Neutral ground, already shipped, and
 *  it reads as "competitive" rather than "a route you grind". */
const ARENA_BG = "/backgrounds/indigoPlat.webp";
const ARENA_BG_FALLBACK = "/backgrounds/champion_blue.webp";

// ─── Shared bits ────────────────────────────────────────────────────

interface ActiveMove {
  move: string; id: string; pp: number; maxpp: number;
  target: string; disabled?: boolean;
}
interface SidePokemon {
  ident: string; details: string; condition: string; active: boolean;
  stats: Record<string, number>; moves: string[]; ability: string; item: string;
}
interface ActiveSlot {
  moves: ActiveMove[]; forceSwitch?: boolean; trapped?: boolean;
}

const STAT_SHORT: Record<string, string> = {
  atk: "Atk", def: "Def", spa: "SpA", spd: "SpD",
  spe: "Spe", accuracy: "Acc", evasion: "Eva",
};

/** Volatiles worth surfacing on the card. The protocol emits dozens; most
 *  are engine bookkeeping the player has no decision to make about. */
const VOLATILE_LABEL: Record<string, string> = {
  confusion: "CNF", substitute: "SUB", leechseed: "SEED", taunt: "TAUNT",
  encore: "ENCORE", torment: "TORMENT", disable: "DISABLE",
  yawn: "DROWSY", curse: "CURSE", nightmare: "NIGHTMARE",
  perish3: "PERISH 3", perish2: "PERISH 2", perish1: "PERISH 1",
  attract: "ATTRACT", foresight: "IDENTIFIED", aquaring: "AQUA RING",
  ingrain: "INGRAIN", magnetrise: "LEVITATING",
};

// ─── Centre column: the battle window ───────────────────────────────

export function PvpCenter() {
  const { room } = usePvpState();
  if (!room) return null;
  return <PvpBattleWindow room={room} />;
}

function PvpBattleWindow({ room }: { room: BattleRoom }) {
  const t = useT();
  const [confirmingForfeit, setConfirmingForfeit] = useState(false);
  const you = room.view.you;
  const foe = room.view.foe;

  const myActive = (room.request?.active?.[0] ?? null) as ActiveSlot | null;
  const mySidePoke = (room.request?.side?.pokemon ?? []) as SidePokemon[];
  const isWaiting = !!room.request?.wait;
  const forceSwitch = room.request?.forceSwitch?.some(Boolean) ?? !!myActive?.forceSwitch;
  const trapped = !!myActive?.trapped;
  const onChoose = (choice: string) => chooseBattleAction(room.battleId, choice);

  return (
    <div className="pvp2-center">
      <div className="pvp2-scene">
        <img
          className="battle-bg"
          src={ARENA_BG}
          alt=""
          aria-hidden
          draggable={false}
          onError={(e) => {
            const el = e.target as HTMLImageElement;
            const abs = window.location.origin + ARENA_BG_FALLBACK;
            if (el.src !== abs) el.src = ARENA_BG_FALLBACK;
          }}
        />

        {/* Field conditions sit above the arena so weather and hazards are
            readable at a glance — they change how a turn should be played
            and were previously invisible entirely. */}
        <FieldStrip room={room} />

        {/* Foe — top right, mirroring the idle scene's enemy slot. */}
        <div className="pvp2-slot pvp2-slot-foe">
          <div className="enemy-card-stack">
            {foe.active
              ? <PvpFighterCard mon={foe.active} className="enemy-card" />
              : <div className="pvp2-slot-empty dim small">{t("Waiting for opponent…")}</div>}
            <div className="trainer-tag">
              <button
                type="button"
                className="pvp2-name-link"
                onClick={() => openPublicTrainerCard(room.opponent.username)}
                title={t("View trainer card")}
              >
                <strong>{room.opponent.username}</strong>
              </button>
              <TeamBalls side={foe} />
            </div>
          </div>
          {foe.active && <PvpSprite mon={foe.active} facing="foe" />}
        </div>

        {/* You — bottom left. */}
        <div className="pvp2-slot pvp2-slot-you">
          {you.active && <PvpSprite mon={you.active} facing="you" />}
          <div className="pvp2-you-card">
            {you.active
              ? <PvpFighterCard mon={you.active} className="player-card" />
              : <div className="pvp2-slot-empty dim small">{t("Sending out…")}</div>}
          </div>
        </div>

        {room.view.turn > 0 && (
          <div className="pvp2-turn-chip">{t("Turn")} {room.view.turn}</div>
        )}
      </div>

      {/* ── Action bar ── */}
      {room.voided ? (
        <VoidedNotice />
      ) : room.result ? (
        <ResultBar room={room} />
      ) : (
        <section className="pvp2-actions">
          {room.opponentAway && <AwayBanner away={room.opponentAway} />}

          {isWaiting && (
            <p className="pvp2-waiting dim">{t("Waiting for opponent's choice…")}</p>
          )}

          {!isWaiting && forceSwitch && (
            <>
              <h4 className="pvp2-action-title">{t("Choose your next Pokémon")}</h4>
              <SwitchRow
                pokemon={mySidePoke}
                bench={you.bench}
                onChoose={(slot) => onChoose(`switch ${slot + 1}`)}
              />
            </>
          )}

          {!isWaiting && !forceSwitch && myActive && (
            <MoveGrid
              active={myActive}
              pokemon={mySidePoke}
              bench={you.bench}
              trapped={trapped}
              foeTypes={foe.active ? (pokemonTable[foe.active.speciesKey]?.types ?? []) : []}
              onMove={(i) => onChoose(`move ${i + 1}`)}
              onSwitch={(slot) => onChoose(`switch ${slot + 1}`)}
            />
          )}

          {!isWaiting && !forceSwitch && !myActive && (
            <p className="pvp2-waiting dim">{t("Getting the battle ready…")}</p>
          )}

          <div className="pvp2-forfeit-row">
            {confirmingForfeit ? (
              <div className="pvp2-forfeit-confirm" role="alertdialog">
                <span>{t("Forfeit? Your opponent gets the win.")}</span>
                <button
                  className="g-btn-ghost g-btn-small"
                  onClick={() => setConfirmingForfeit(false)}
                >{t("Keep fighting")}</button>
                <button
                  className="g-btn-danger-ghost g-btn-small"
                  onClick={() => { setConfirmingForfeit(false); cancelBattle(room.battleId); }}
                >{t("Yes, forfeit")}</button>
              </div>
            ) : (
              <button
                className="g-btn-ghost g-btn-small pvp2-forfeit-btn"
                onClick={() => setConfirmingForfeit(true)}
              >{t("Forfeit")}</button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

// ─── Fighter card — same classes as the idle HpCard ─────────────────

function PvpFighterCard({ mon, className }: { mon: ActiveMon; className: string }) {
  const t = useT();
  const types = pokemonTable[mon.speciesKey]?.types ?? [];
  const hpClass = mon.hpPct > 50 ? "ok" : mon.hpPct > 20 ? "warn" : "low";
  const boosts = Object.entries(mon.boosts).filter(([, v]) => (v ?? 0) !== 0);
  const vols = mon.volatiles.filter((v) => VOLATILE_LABEL[v]);
  return (
    <div className={`hp-card ${className} ${mon.fainted ? "pvp2-fainted" : ""}`}>
      <div className="hp-card-name">
        <strong>{mon.name.toUpperCase()}{mon.shiny ? " ✨" : ""}</strong>
        <span>{t("Lv.")}{mon.level}</span>
      </div>
      {types.length > 0 && (
        <div className="hp-card-meta">
          <span className="hp-card-types">
            {types.map((ty) => (
              <span key={ty} className={`type-badge type-${ty.toLowerCase()}`}>{ty}</span>
            ))}
          </span>
        </div>
      )}
      <div className="hp-card-row">
        <span className="hp-card-label">{t("HP")}</span>
        <div className={`hp-card-bar ${hpClass}`}>
          <div className="hp-card-fill" style={{ width: `${Math.max(0, Math.min(100, mon.hpPct))}%` }} />
        </div>
        {mon.status && (
          <span className={`hp-status-badge status-${statusClass(mon.status)}`}>
            {mon.status.toUpperCase()}
          </span>
        )}
      </div>
      {(boosts.length > 0 || vols.length > 0) && (
        <div className="pvp2-stage-row">
          {boosts.map(([stat, v]) => (
            <span key={stat} className={`pvp2-stage ${(v ?? 0) > 0 ? "up" : "down"}`}>
              {STAT_SHORT[stat] ?? stat} {(v ?? 0) > 0 ? "+" : ""}{v}
            </span>
          ))}
          {vols.map((v) => (
            <span key={v} className="hp-status-badge status-confused">{VOLATILE_LABEL[v]}</span>
          ))}
        </div>
      )}
      {mon.charging && (
        <div className="pvp2-charging small">{t("Charging")} {mon.charging}…</div>
      )}
      {mon.hpKnownExact && (
        <div className="hp-card-numbers">{mon.hp}/ {mon.maxHp}</div>
      )}
    </div>
  );
}

/** Map a protocol status code onto the idle game's badge class names, which
 *  are keyed by the game's own vocabulary (par/slp/brn/frz/psn/tox). They
 *  happen to match one-for-one, so the badge colours come free. */
function statusClass(s: string): string {
  return s;
}

function PvpSprite({ mon, facing }: { mon: ActiveMon; facing: "you" | "foe" }) {
  return (
    <div className={`pvp2-sprite pvp2-sprite-${facing} ${mon.fainted ? "fainted" : ""}`}>
      {/* Your own Pokémon shows its BACK sprite, exactly as in the idle
          battle scene — a PvP battle that renders both sides front-on reads
          as a menu, not a battle. */}
      <PokemonSprite
        speciesKey={mon.speciesKey}
        isShiny={mon.shiny}
        isBack={facing === "you"}
        alt={mon.name}
        style={{ imageRendering: "pixelated" }}
      />
    </div>
  );
}

/** Poké Ball row showing how much of a side is still standing. Reuses the
 *  trainer-battle markup, so it matches the gym/E4 treatment exactly.
 *  For the foe this only counts what the protocol has REVEALED — we do not
 *  know their unsent Pokémon, and inventing six balls would be a lie. */
function TeamBalls({ side }: { side: SideView }) {
  const t = useT();
  const known = side.bench.length;
  const total = Math.max(known, side.teamSize || known);
  const fainted = side.bench.filter((b) => b.fainted).length;
  return (
    <span className="trainer-tag-balls">
      {Array.from({ length: total }, (_, i) => {
        const spent = i < fainted;
        const unknown = i >= known;
        return (
          <img
            key={i}
            src={itemSpriteUrl("pokeball")}
            alt={spent ? t("fainted") : t("ready")}
            title={unknown ? t("Not yet revealed") : spent ? t("fainted") : t("ready")}
            className={`trainer-ball ${spent ? "spent" : ""} ${unknown ? "pvp2-ball-unknown" : ""}`}
            width={12}
            height={12}
            draggable={false}
          />
        );
      })}
    </span>
  );
}

// ─── Move grid ──────────────────────────────────────────────────────

function MoveGrid({
  active, pokemon, bench, trapped, foeTypes, onMove, onSwitch,
}: {
  active: ActiveSlot;
  pokemon: SidePokemon[];
  bench: BenchMon[];
  trapped: boolean;
  foeTypes: PokemonType[];
  onMove: (i: number) => void;
  onSwitch: (slot: number) => void;
}) {
  const t = useT();
  const [showSwitch, setShowSwitch] = useState(false);
  const switchable = pokemon.some((p, i) => !p.active && !p.condition.includes("fnt") && i >= 0);
  return (
    <>
      {/* Reuses the idle game's own `.moves-panel` / `.move-slot` markup,
          inline type colour and all, so a PvP move tile is visually the
          same object as an idle one. The old modal emitted
          `move-type-<type>` classes that do not exist anywhere in the
          stylesheet, which is why PvP moves rendered as grey boxes. */}
      <div className="moves-panel pickable pvp2-moves">
        {active.moves.map((m, i) => {
          const def = movesTable[m.id];
          const out = !!m.disabled || m.pp <= 0;
          const ppLow = m.pp > 0 && m.pp <= Math.max(1, Math.ceil(m.maxpp * 0.25));
          const eff = def ? effectivenessChip(def.type, def.category, foeTypes) : null;
          const color = def ? (TYPE_COLOR[def.type] ?? "#888") : "#888";
          return (
            <button
              type="button"
              key={`${m.id}-${i}`}
              className={`move-slot is-pickable ${out ? "no-pp" : ""} ${eff?.cls ?? ""}`}
              style={{ background: color }}
              disabled={out}
              onClick={() => onMove(i)}
              title={
                m.pp <= 0 ? t("No PP left")
                  : m.disabled ? t("This move is disabled")
                  : (def?.name ?? m.move)
              }
            >
              <div className="move-slot-name">
                {def?.name ?? m.move}
                {eff && <span className="move-eff-chip">{eff.label}</span>}
              </div>
              <div className="move-slot-stats">
                <span>{t("Pow")} {def?.power || "—"}</span>
                <span>{def?.type ?? "?"}</span>
                <span className={`move-pp ${ppLow ? "low" : ""} ${m.pp <= 0 ? "out" : ""}`}>
                  {t("PP")} {m.pp}/{m.maxpp}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      <div className="pvp2-switch-row">
        {trapped ? (
          <span className="dim small">{t("You can't switch out right now.")}</span>
        ) : switchable ? (
          <button
            className="g-btn-ghost g-btn-small"
            onClick={() => setShowSwitch((v) => !v)}
          >
            {showSwitch ? t("Hide team") : t("Switch Pokémon")}
          </button>
        ) : null}
      </div>

      {showSwitch && !trapped && (
        <SwitchRow pokemon={pokemon} bench={bench} onChoose={(slot) => { setShowSwitch(false); onSwitch(slot); }} />
      )}
    </>
  );
}

/**
 * Effectiveness chip for a move against the defender's actual typing.
 *
 * Deliberately delegates to the game's own `typeEffectiveness` and its
 * `data/typeChart` rather than carrying a chart here. A second copy would
 * be free to drift, and "PvP disagrees with the idle game about whether
 * Electric hits Ground" is a bug report nobody would be able to explain.
 * Status moves get no chip — a 2× badge on Thunder Wave is a lie.
 */
function effectivenessChip(
  moveType: PokemonType,
  category: string | undefined,
  defTypes: PokemonType[],
): { label: string; cls: string } | null {
  if (category === "status" || defTypes.length === 0) return null;
  const mult = typeEffectiveness(moveType, defTypes);
  const cls = mult === 0 ? "eff-immune"
    : mult >= 2 ? "eff-super"
    : mult <= 0.5 ? "eff-resist"
    : "eff-neutral";
  const label = mult === 0 ? "Immune"
    : mult >= 4 ? "4×"
    : mult >= 2 ? "2×"
    : mult === 0.25 ? "¼×"
    : mult <= 0.5 ? "½×"
    : "";
  return label ? { label, cls } : null;
}

// ─── Switch row ─────────────────────────────────────────────────────

function SwitchRow({
  pokemon, bench, onChoose,
}: {
  pokemon: SidePokemon[];
  bench: BenchMon[];
  onChoose: (slot: number) => void;
}) {
  const t = useT();
  return (
    <div className="pvp2-switch-grid">
      {pokemon.map((p, idx) => {
        const fainted = p.condition.includes("fnt");
        const speciesKey = (p.details.split(",")[0] ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
        const name = p.ident.includes(":") ? p.ident.slice(p.ident.indexOf(":") + 1).trim() : p.ident;
        const m = p.condition.match(/(\d+)\s*\/\s*(\d+)/);
        const pct = fainted ? 0 : m ? (parseInt(m[1], 10) / parseInt(m[2], 10)) * 100 : 100;
        const hpClass = pct > 50 ? "ok" : pct > 20 ? "warn" : "low";
        const status = bench.find((b) => b.ident === p.ident)?.status ?? null;
        return (
          <button
            key={p.ident}
            className={`pvp2-switch-card ${p.active ? "active" : ""} ${fainted ? "fainted" : ""}`}
            disabled={p.active || fainted}
            onClick={() => onChoose(idx)}
            title={p.active ? t("Already out") : fainted ? t("Fainted") : `${t("Send out")} ${name}`}
          >
            <PokemonSprite
              speciesKey={speciesKey}
              alt=""
              width={40}
              height={40}
              style={{ imageRendering: "pixelated" }}
            />
            <span className="pvp2-switch-name">{name}</span>
            <span className={`pvp2-switch-hp ${hpClass}`}>
              <span style={{ width: `${pct}%` }} />
            </span>
            {status && <span className={`hp-status-badge status-${status}`}>{status.toUpperCase()}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ─── Field conditions ───────────────────────────────────────────────

function FieldStrip({ room }: { room: BattleRoom }) {
  const t = useT();
  const v = room.view;
  const chips: { key: string; label: string; cls: string }[] = [];
  if (v.weather) chips.push({ key: "w", label: v.weather.label, cls: "weather" });
  for (const f of v.field) chips.push({ key: `f-${f}`, label: f, cls: "field" });
  pushHazards(chips, v.you, t("Yours"), "you");
  pushHazards(chips, v.foe, t("Foe"), "foe");
  if (chips.length === 0) return null;
  return (
    <div className="pvp2-field-strip">
      {chips.map((c) => (
        <span key={c.key} className={`pvp2-field-chip ${c.cls}`}>{c.label}</span>
      ))}
    </div>
  );
}

function pushHazards(
  out: { key: string; label: string; cls: string }[],
  side: SideView,
  who: string,
  tag: string,
) {
  const h = side.hazards;
  if (h.spikes > 0) out.push({ key: `${tag}-sp`, label: `${who}: Spikes ×${h.spikes}`, cls: "hazard" });
  if (h.toxicspikes > 0) out.push({ key: `${tag}-tsp`, label: `${who}: T-Spikes ×${h.toxicspikes}`, cls: "hazard" });
  if (h.stealthrock) out.push({ key: `${tag}-sr`, label: `${who}: Stealth Rock`, cls: "hazard" });
  if (h.stickyweb) out.push({ key: `${tag}-sw`, label: `${who}: Sticky Web`, cls: "hazard" });
  for (const s of Object.keys(side.screens)) {
    out.push({ key: `${tag}-${s}`, label: `${who}: ${s}`, cls: "screen" });
  }
}

// ─── Banners and results ────────────────────────────────────────────

function AwayBanner({ away }: { away: { username: string; graceEndsAt: number } }) {
  const t = useT();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  const left = Math.max(0, Math.ceil((away.graceEndsAt - now) / 1000));
  return (
    <div className="pvp2-away-banner" role="status">
      <strong>{away.username}</strong>{" "}
      {t("lost connection")} — {left}s {t("to reconnect")}
    </div>
  );
}

function VoidedNotice() {
  const t = useT();
  return (
    <div className="pvp2-voided" role="status">
      <strong>{t("Battle ended by a server restart.")}</strong>
      <span className="dim small">{t("It was not rated — your ranking is unchanged.")}</span>
      <button className="g-btn-primary g-btn-small" onClick={() => clearBattleRoom()}>
        {t("Back to the game")}
      </button>
    </div>
  );
}

function ResultBar({ room }: { room: BattleRoom }) {
  const t = useT();
  // The server sends winnerId as a real userId. The client doesn't keep its
  // own id but does keep the opponent's, so "did I win?" is "the winner is
  // not the opponent". The old sentinel-based check could never match a real
  // id, which is why every winner once saw "You lose."
  const won = room.result?.winnerId != null && room.result.winnerId !== room.opponent.id;
  const cancelled = room.result?.winnerId == null;
  const delta = room.result?.ratingDelta ?? null;
  const myDelta = delta ? (won ? delta.aDelta : delta.bDelta) : null;
  const myRating = delta ? (won ? delta.aRating : delta.bRating) : null;
  return (
    <div className={`pvp2-result ${cancelled ? "draw" : won ? "win" : "loss"}`} role="status">
      <strong className="pvp2-result-verdict">
        {cancelled ? t("Battle cancelled") : won ? t("You win!") : t("You lose.")}
      </strong>
      {room.result?.reason === "forfeit" && <span className="dim small">({t("forfeit")})</span>}
      {room.result?.reason === "timeout" && <span className="dim small">({t("timeout")})</span>}
      {myDelta != null && (
        <span className={`pvp2-result-delta ${myDelta >= 0 ? "up" : "down"}`}>
          {myDelta >= 0 ? "+" : ""}{myDelta}
          <small className="dim"> → {myRating}</small>
        </span>
      )}
      {/* No auto-close. The old modal cleared itself after 4 seconds, which
          meant a player who looked away missed the result and the rating
          change entirely. Leaving is now their decision. */}
      <button className="g-btn-primary g-btn-small" onClick={() => clearBattleRoom()}>
        {t("Back to the game")}
      </button>
    </div>
  );
}

// ─── Right rail: the PvP control panel ──────────────────────────────

export function PvpRail() {
  const { room } = usePvpState();
  const t = useT();
  if (!room) return null;
  return (
    <div className="party-column control-column pvp2-rail">
      <header className="pvp2-rail-head">
        <span className="pvp2-rail-title">{t("PvP Battle")}</span>
        <span className="pvp2-rail-format">
          {room.format === "random50" ? t("Ranked · Lv 50")
            : room.format === "tournament" ? t("Tournament")
            : t("Friendly")}
        </span>
        {!room.result && room.turnDeadlineAt && <TurnTimer deadline={room.turnDeadlineAt} />}
      </header>

      <TeamPanel title={t("Your team")} side={room.view.you} own />
      <TeamPanel title={`${room.opponent.username}${t("'s team")}`} side={room.view.foe} />

      <section className="ctx-section pvp2-log-card">
        <h4>{t("Battle log")}</h4>
        <NarrationLog lines={room.narration} mySide={room.side} />
      </section>
    </div>
  );
}

function TeamPanel({ title, side, own = false }: { title: string; side: SideView; own?: boolean }) {
  const t = useT();
  const hidden = Math.max(0, (side.teamSize || 0) - side.bench.length);
  return (
    <section className="ctx-section pvp2-team-card">
      <h4>{title}</h4>
      {side.bench.length === 0 ? (
        <p className="dim small">{t("Nothing revealed yet.")}</p>
      ) : (
        <ul className="pvp2-team-list">
          {side.bench.map((b) => (
            <li
              key={b.ident}
              className={`pvp2-team-row ${b.active ? "active" : ""} ${b.fainted ? "fainted" : ""}`}
            >
              <PokemonSprite
                speciesKey={b.speciesKey}
                alt=""
                width={32}
                height={32}
                style={{ imageRendering: "pixelated" }}
              />
              <span className="pvp2-team-name">{b.name}</span>
              <span className="pvp2-team-lv dim">{t("Lv")}{b.level}</span>
              <span className={`pvp2-team-hp ${b.hpPct > 50 ? "ok" : b.hpPct > 20 ? "warn" : "low"}`}>
                <span style={{ width: `${Math.max(0, Math.min(100, b.hpPct))}%` }} />
              </span>
              {b.status && (
                <span className={`hp-status-badge status-${b.status}`}>{b.status.toUpperCase()}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {/* Be honest about what is unknown rather than padding the list. */}
      {!own && hidden > 0 && (
        <p className="dim small pvp2-team-hidden">
          +{hidden} {t("not yet revealed")}
        </p>
      )}
    </section>
  );
}

function NarrationLog({ lines, mySide }: { lines: NarrationLine[]; mySide: "a" | "b" }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const t = useT();
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines.length]);
  return (
    <div className="pvp2-log" ref={ref}>
      {lines.length === 0 && <div className="dim small">{t("Waiting for the first turn…")}</div>}
      {lines.map((l, i) => (
        <div
          key={i}
          className={`pvp2-log-line kind-${l.kind} ${l.side ? (l.side === mySide ? "mine" : "theirs") : ""}`}
        >
          <span>{l.text}</span>
          {l.tags && l.tags.length > 0 && (
            <span className="pvp2-log-tags">
              {l.tags.map((tg) => (
                <em key={tg} className={tg.startsWith("Super") ? "great" : tg.startsWith("Critical") ? "crit" : "weak"}>
                  {tg}
                </em>
              ))}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/** Per-turn countdown. The server owns enforcement — this never
 *  short-circuits a choice when it reaches zero. */
function TurnTimer({ deadline }: { deadline: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  const ms = Math.max(0, deadline - now);
  const secs = Math.ceil(ms / 1000);
  return (
    <span className={`pvp2-timer ${ms < 30_000 ? "urgent" : ""}`}>
      {Math.floor(secs / 60)}:{(secs % 60).toString().padStart(2, "0")}
    </span>
  );
}
