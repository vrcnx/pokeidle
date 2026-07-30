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
//
// ─── WHAT THE 2026-07 PASS ADDED, AND WHY EACH PIECE IS REUSE ─────────
//
// A live battle had three holes the owner reported: no battle message box, no
// move effects at all, and an action area whose "Switch Pokémon" ghost button
// and greyed "Forfeit" were orphans floating at opposite edges under the move
// grid. A fourth was that a finished battle dead-ended on "Back to the game".
//
//  1. MESSAGE BOX — `.scene-status`, the idle game's OWN battle-text box,
//     verbatim. It is `position: absolute; bottom: 0; left/right: 0;
//     z-index: 40` in app.css and `.pvp2-scene` is `position: relative`, so
//     mounting it here needs no new rule and comes out pixel-identical to the
//     idle battle's. Fed by a PACER (utils/pvpNarrationPacer.ts), because PvP
//     narration arrives in bursts of a dozen lines per socket message and a box
//     that renders the latest line would flicker through all of them in one
//     frame. See that file for the four properties the queue has to hold.
//
//  2. MOVE EFFECTS — the idle game's `.move-anim` system, driven from PvP
//     narration by utils/pvpMoveEffects.ts. Every particle, beam, impact and
//     aura rule in app.css is globally scoped, and `.pvp2-scene` is locked to
//     the same 16/9 ratio as `.battle-scene` while the arena's sprites already
//     use the real `.player-slot` / `.enemy-slot` classes — so the baked slot
//     anchors and the baked beam angle land correctly with NO app.css change.
//     `.damage-flash` and `.effectiveness-flash` are reused the same way. Only
//     the Earthquake shake needed a rule, because app.css scopes its trigger to
//     `.battle-scene:has(…) .scene-content`; the PvP sibling of that one
//     selector lives in pvpArena.css and the `@keyframes` it references is
//     app.css's, shared.
//
//  3. ACTION AREA — one `.pvp2-console` panel holding the moves AND the bench
//     side by side, with forfeit as a small muted control in the console's own
//     header. The bench reuses `.pvp2-switch-grid` / `.pvp2-switch-card`, which
//     already existed for the forced-switch-after-faint case and is now
//     promoted to a permanent surface; the forced case keeps its own louder
//     treatment so it still reads as forced.
//
//  4. THE LOOP — PvpResultDialog, a real post-battle dialog with rematch and a
//     path back to the hub. See that file for the loop's design.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  usePvpState,
  chooseBattleAction,
  cancelBattle,
  clearBattleRoom,
  isBotBattle,
  type BattleRoom,
} from "../state/pvp";
import type { ActiveMon, BenchMon, NarrationLine, SideView } from "../state/pvpBattleView";
import { PokemonSprite } from "./Sprite";
import { pokemonTable } from "../data/pokemon";
import { moves as movesTable } from "../data/moves";
import { itemSpriteUrl } from "../utils/sprites";
import { typeEffectiveness } from "../utils/typing";
import { TYPE_COLOR } from "../utils/moveEffects";
import { useDamageFlash } from "../hooks/useDamageFlash";
import { effectForNarration, bannerForNarration, type PvpMoveEffect } from "../utils/pvpMoveEffects";
import { displayNarration } from "../utils/pvpNarrationText";
import { NarrationPacer } from "../utils/pvpNarrationPacer";
import { MoveEffectVisual } from "./MoveEffectVisual";
import { PvpResultDialog } from "./PvpResultDialog";
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
  const you = room.view.you;
  const foe = room.view.foe;

  const myActive = (room.request?.active?.[0] ?? null) as ActiveSlot | null;
  const mySidePoke = (room.request?.side?.pokemon ?? []) as SidePokemon[];
  const isWaiting = !!room.request?.wait;
  const forceSwitch = room.request?.forceSwitch?.some(Boolean) ?? !!myActive?.forceSwitch;
  const trapped = !!myActive?.trapped;
  const over = !!room.result || room.voided;
  const onChoose = (choice: string) => chooseBattleAction(room.battleId, choice);

  const stage = usePvpNarrationStage(room);

  return (
    <div className="pvp2-center">
      <div className="pvp2-scene">
        {/* Everything that should rattle on an Earthquake-class move goes
            inside `.scene-content` — app.css's own wrapper, reused verbatim
            (`position: absolute; inset: 0`, so the scene's geometry is
            unchanged). The message box is deliberately OUTSIDE it: the idle
            game shakes its typewriter along with the scene, but this is a
            timed competitive battle and text you cannot read during the one
            second you most need it is a worse trade here. */}
        <div className="scene-content">
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

          {/* The four fighters' pieces are laid out EXACTLY as the idle battle
              scene lays out its own: enemy card + trainer tag top-left, enemy
              sprite top-right, your back sprite bottom-left, your card
              bottom-right. That is not decoration — `.enemy-card-stack` and
              `.player-card` are `position: absolute` in app.css, so they need
              a full-bleed containing block. Nesting them inside a positioned
              per-side wrapper (which is what this used to be) made that wrapper
              the containing block instead: it shrink-wrapped to the only
              in-flow child it had left, the sprite, and both cards then sized
              to min-content and hung ~50-70px outside the frame, where
              `overflow: hidden` cut them in half — the "RAI Lv.100" and the
              sliced "304/ 304" in the bug report — while covering the sprites
              they sat on top of. `.scene-content` is `inset: 0` so it is that
              same full-bleed box. */}
          <div className="enemy-card-stack">
            {foe.active
              ? <PvpFighterCard mon={foe.active} className="enemy-card" />
              : <div className="pvp2-slot-empty dim small">{t("Waiting for opponent…")}</div>}
            <div className="trainer-tag">
              <OpponentName room={room} />
              <TeamBalls side={foe} />
            </div>
          </div>
          {foe.active && (
            <PvpSprite key={`foe-${foe.active.ident}-${foe.active.speciesKey}`} mon={foe.active} facing="foe" />
          )}

          {you.active
            ? (
              <>
                <PvpSprite key={`you-${you.active.ident}-${you.active.speciesKey}`} mon={you.active} facing="you" />
                <PvpFighterCard mon={you.active} className="player-card" />
              </>
            )
            : <div className="pvp2-slot-empty player-card dim small">{t("Sending out…")}</div>}

          {room.view.turn > 0 && (
            <div className="pvp2-turn-chip">{t("Turn")} {room.view.turn}</div>
          )}

          {/* Floating "-42" / "+18" over the slot whose HP moved, and the
              super-effective / critical banner. Both reuse app.css's
              `.damage-flash` and `.effectiveness-flash`, which are generic
              absolutely-positioned rules — no new CSS, and identical to what
              the idle battle shows. */}
          {foe.active && <PvpHpFloat mon={foe.active} side="enemy" />}
          {you.active && <PvpHpFloat mon={you.active} side="player" />}

          {stage.effect && (
            <MoveEffectVisual
              archetype={stage.effect.archetype}
              target={stage.effect.target}
              shake={stage.effect.shake}
              typeColor={stage.effect.typeColor}
              animKey={stage.seq}
            />
          )}
          {stage.banner && (
            <div
              key={`banner-${stage.seq}`}
              className={`effectiveness-flash effectiveness-${stage.banner.kind}`}
              aria-hidden
            >
              {t(stage.banner.text)}
            </div>
          )}
        </div>

        {/* ── The battle message box ── */}
        <PvpMessageBox
          line={stage.line}
          text={stage.text}
          fallback={messagePrompt(room, { isWaiting, forceSwitch, over }, t)}
        />
      </div>

      {/* ── Action area ── */}
      {over ? (
        <PvpResultDialog room={room} />
      ) : (
        <PvpConsole
          room={room}
          active={myActive}
          pokemon={mySidePoke}
          bench={you.bench}
          isWaiting={isWaiting}
          forceSwitch={forceSwitch}
          trapped={trapped}
          foeTypes={foe.active ? (pokemonTable[foe.active.speciesKey]?.types ?? []) : []}
          onMove={(i) => onChoose(`move ${i + 1}`)}
          onSwitch={(slot) => onChoose(`switch ${slot + 1}`)}
        />
      )}
    </div>
  );
}

// ─── The narration stage: message box + effects, paced ───────────────

interface NarrationStage {
  /** The beat currently in the box, or null before the first line. */
  line: NarrationLine | null;
  /** Its display text, with the decoder's third-person `|win|` phrasing
   *  corrected for the local player. */
  text: string | null;
  /** Bumped per beat, so an effect's keyframes restart for a repeated move. */
  seq: number;
  effect: PvpMoveEffect | null;
  banner: { kind: "crit" | "se" | "nve"; text: string } | null;
}

/**
 * Drive one `NarrationPacer` off the room and publish the visible beat.
 *
 * The pacer is the whole answer to the burst problem and its invariants are
 * documented in utils/pvpNarrationPacer.ts. This hook is only the wiring, and
 * it is deliberately thin:
 *
 *  * ONE timer, scheduled at `nextDueAt()`, re-armed after each beat. No
 *    polling interval, so a battle sitting on "waiting for opponent" costs
 *    nothing and a backgrounded tab cannot accumulate work. `tick` steps as
 *    many beats as the elapsed time owes, so a throttled timer (browsers clamp
 *    background `setTimeout` to ~1s) catches up in one call instead of falling
 *    a beat further behind on every fire.
 *  * A re-render is requested only when the visible beat actually CHANGED.
 *  * The pacer is reset when `battleId` changes, which is what stops a rematch
 *    inheriting the previous battle's last line, and hurried when the battle
 *    ends so a burst that lands with the KO drains in a few hundred ms instead
 *    of narrating a finished battle.
 *
 * Nothing here touches `room.request`, so a drain can never gate the move
 * picker: the tiles render from the request and stay live throughout.
 */
function usePvpNarrationStage(room: BattleRoom): NarrationStage {
  const pacerRef = useRef<NarrationPacer | null>(null);
  if (!pacerRef.current) pacerRef.current = new NarrationPacer();
  const pacer = pacerRef.current;

  const battleRef = useRef(room.battleId);
  if (battleRef.current !== room.battleId) {
    battleRef.current = room.battleId;
    pacer.reset();
  }

  const [, bump] = useState(0);
  const timerRef = useRef<number | null>(null);
  const ended = !!room.result || room.voided;

  useEffect(() => {
    const rerender = () => bump((n) => n + 1);

    const schedule = () => {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const due = pacer.nextDueAt();
      if (due == null) return;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        if (pacer.tick(Date.now())) rerender();
        schedule();
      }, Math.max(0, due - Date.now()));
    };

    const before = pacer.current?.seq ?? 0;
    pacer.observe(room.narration, Date.now());
    if (ended) pacer.hurry(Date.now());
    if ((pacer.current?.seq ?? 0) !== before) rerender();
    schedule();

    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [room.narration, ended, pacer]);

  const beat = pacer.current;
  const seq = beat?.seq ?? 0;
  const line = beat?.line ?? null;

  // Recomputed only when the beat changes — `effectForNarration` does a dex
  // lookup, and a re-render caused by anything else must not repeat it.
  const derived = useMemo(() => {
    if (!beat || !beat.line) return { effect: null, banner: null, text: null };
    return {
      effect: beat.animate ? effectForNarration(beat.line, room.side) : null,
      banner: beat.animate ? bannerForNarration(beat.line) : null,
      text: displayNarration(beat.line, room.view),
    };
    // room.view is intentionally read fresh but not depended on: the only part
    // used is the two trainer names, which are fixed for the battle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq, room.side]);

  return { line, text: derived.text, seq, effect: derived.effect, banner: derived.banner };
}

/**
 * The classic Pokémon message box.
 *
 * `.scene-status` is the idle game's own class — same parchment-dark bar, same
 * pixel font, same z-index above the sprites and the particle layer — so this
 * matches the idle battle exactly rather than approximating it. `.pvp2-msg`
 * adds only the second row for the effectiveness/crit tags the decoder attaches
 * to a move line, and a minimum height so the bar never changes size between a
 * one-line and a two-line beat.
 *
 * `aria-live="polite"` rather than "assertive": a screen reader should hear the
 * battle, but never at the cost of interrupting the player mid-choice.
 */
function PvpMessageBox({
  line, text, fallback,
}: {
  line: NarrationLine | null;
  text: string | null;
  fallback: string;
}) {
  const t = useT();
  const showing = text ?? fallback;
  const tags = line?.tags ?? [];
  return (
    <div
      className={`scene-status pvp2-msg${line ? ` kind-${line.kind}` : " is-prompt"}`}
      aria-live="polite"
      aria-atomic="true"
    >
      <span className="pvp2-msg-text">{showing}</span>
      {tags.length > 0 && (
        <span className="pvp2-msg-tags">
          {tags.map((tg) => (
            <em
              key={tg}
              className={tg.startsWith("Super") ? "great" : tg.startsWith("Critical") ? "crit" : "weak"}
            >
              {t(tg)}
            </em>
          ))}
        </span>
      )}
    </div>
  );
}

/**
 * What the box says when the queue is empty — which is most of a battle, since
 * the player spends it waiting for their own decision or the opponent's.
 *
 * Deliberately the same vocabulary the idle game's `statusLine` uses, including
 * "What will <name> do?", so the two battle systems read as one game.
 */
function messagePrompt(
  room: BattleRoom,
  s: { isWaiting: boolean; forceSwitch: boolean; over: boolean },
  t: (k: string) => string,
): string {
  if (room.voided) return t("The battle was voided by a server restart.");
  if (s.over) return t("The battle is over.");
  if (room.opponentAway) return t("Waiting for your opponent to reconnect…");
  if (s.forceSwitch) return t("Choose your next Pokémon!");
  if (s.isWaiting) return t("Waiting for the opponent's move…");
  const mine = room.view.you.active;
  if (mine && room.request?.active?.[0]) return `${t("What will")} ${mine.name} ${t("do?")}`;
  return t("Getting the battle ready…");
}

/**
 * Floating HP delta over a slot, reusing app.css's `.damage-flash`.
 *
 * Watches the DECODED hp rather than a log line, exactly as the idle game's
 * DamageFlash watches `currentHp` — so passive damage (Leftovers, Toxic,
 * Sandstorm, Stealth Rock on entry) floats too, without needing a narration
 * line to exist for it. Keyed on the mon's ident so a switch-in never reads as
 * a 300-point hit.
 *
 * When the format hides exact HP the delta is shown as a percentage instead of
 * inventing a number: `hpKnownExact` is false precisely when the protocol gave
 * us `48/100`, and printing "-52" there would be a lie about a 52-HP hit.
 */
function PvpHpFloat({ mon, side }: { mon: ActiveMon; side: "player" | "enemy" }) {
  const exact = mon.hpKnownExact;
  const value = exact ? mon.hp : Math.round(mon.hpPct);
  const prev = useRef<{ ident: string | null; value: number | null }>({ ident: null, value: null });
  const [pop, setPop] = useState<{ key: number; delta: number } | null>(null);

  useEffect(() => {
    const last = prev.current;
    prev.current = { ident: mon.ident, value };
    if (last.ident !== mon.ident) return;
    if (last.value == null) return;
    const delta = value - last.value;
    if (delta === 0) return;
    setPop({ key: Date.now() + (side === "player" ? 0 : 1), delta });
    // 1400ms matches the `damageFlashRise` keyframes' own duration in app.css,
    // so the element is removed exactly as its animation ends.
    const id = window.setTimeout(() => setPop(null), 1400);
    return () => window.clearTimeout(id);
  }, [mon.ident, value, side]);

  if (!pop) return null;
  const heal = pop.delta > 0;
  return (
    <div className={`damage-flash side-${side} ${heal ? "heal" : "hit"}`} aria-hidden>
      {heal ? "+" : ""}{pop.delta}{exact ? "" : "%"}
    </div>
  );
}

/**
 * The foe's name plate.
 *
 * Two things change for an AI practice battle, and neither is decoration:
 *
 *  1. The name stops being a button. openPublicTrainerCard fetches
 *     GET /api/profile/<name>, which 404s for a seat that has no account — so
 *     the link is a dead end that looks like a real player's profile.
 *  2. A permanent AI chip sits next to it. The label already ends in " AI"
 *     (and a space is impossible in a real username, so it cannot be
 *     impersonating anyone), but the chip is what makes it unmissable at a
 *     glance in the middle of a battle rather than something you have to read.
 */
function OpponentName({ room }: { room: BattleRoom }) {
  const t = useT();
  if (isBotBattle(room)) {
    return (
      <span className="pvp2-foe-name">
        <strong>{room.opponent.username}</strong>
        <span className="pvp2-ai-chip" title={t("A computer opponent — this battle is not rated.")}>
          {t("AI")}
        </span>
      </span>
    );
  }
  return (
    <button
      type="button"
      className="pvp2-name-link"
      onClick={() => openPublicTrainerCard(room.opponent.username)}
      title={t("View trainer card")}
    >
      <strong>{room.opponent.username}</strong>
    </button>
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

/**
 * One fighter's sprite, in the idle battle scene's own slot.
 *
 * `.sprite-slot` + `.player-slot` / `.enemy-slot` and `.player-sprite` /
 * `.enemy-sprite` are app.css classes, reused wholesale rather than
 * reimplemented: they carry the slot geometry (percentages of the arena, so
 * the sprite scales with it instead of being pinned to a 96px box), the
 * intrinsic-size scaling that keeps every species' relative size honest, the
 * floor shadow, the pokéball-pop entrance and the faint drop. The `pvp2-`
 * classes are identity hooks with no layout of their own.
 *
 * `bump-0` / `bump-1` is the idle game's own hit recoil, driven by the same
 * `useDamageFlash` hook BattleScene uses — so a PvP Pokémon flinches when it
 * is hit exactly as an idle one does, with no new animation.
 *
 * The call sites key this on the Pokémon's ident, which is what replays the
 * entrance animation on a switch-in the same way the idle scene does.
 */
function PvpSprite({ mon, facing }: { mon: ActiveMon; facing: "you" | "foe" }) {
  const mine = facing === "you";
  const bump = useDamageFlash(mon.ident, mon.hpKnownExact ? mon.hp : Math.round(mon.hpPct));
  return (
    <div
      className={[
        "sprite-slot",
        mine ? "player-slot" : "enemy-slot",
        "pvp2-sprite",
        `pvp2-sprite-${facing}`,
        bump > 0 ? `bump-${bump % 2}` : "",
        mon.fainted ? "fainted" : "",
      ].filter(Boolean).join(" ")}
      data-status={mon.status ?? undefined}
    >
      {/* Your own Pokémon shows its BACK sprite, exactly as in the idle
          battle scene — a PvP battle that renders both sides front-on reads
          as a menu, not a battle. PokemonSprite owns the failure policy:
          animated GIF → cache-busting retry → static PNG → its retry → a
          visible placeholder, so a species with no animated sprite degrades
          instead of leaving an empty arena. */}
      <PokemonSprite
        className={mine ? "player-sprite" : "enemy-sprite"}
        speciesKey={mon.speciesKey}
        isShiny={mon.shiny}
        isBack={mine}
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

// ─── The console: one control surface ───────────────────────────────

/**
 * Moves, bench and forfeit as ONE panel.
 *
 * WHAT WAS WRONG. "Switch Pokémon" was a 104×26 ghost button pinned to the
 * LEFT edge under the move grid and "Forfeit" was a 55×26 button at the RIGHT
 * edge at 11px / rgb(156,156,156) / opacity 0.65 — measured on a live battle.
 * Neither had any visual relationship to the 2×2 grid they belonged with, the
 * grid itself soaked all 564px of the column's vertical slack, and the two
 * orphans left a band of dead space beneath it. Worse than the geometry: your
 * team was HIDDEN behind a toggle, so a switch — which in a competitive battle
 * is as much an attacking decision as a move is — cost two clicks and made the
 * moves disappear while you thought about it.
 *
 * WHAT THIS IS. A titled panel whose body is the moves grid and the bench, side
 * by side (a real simulator puts your team beside your moves, and this arena's
 * own rail already proves the bench reads fine as a narrow column). Both
 * columns stretch, so the panel has no slack to leave anywhere and there is no
 * layout jump between fighting, waiting and switching — the surface is the same
 * size in all three, only its contents change.
 *
 * FORFEIT lives in the console's header, small and muted with a flag glyph, at
 * the opposite end of the panel from every attack and outside the body that
 * contains them. It keeps its confirmation, which becomes a full-width
 * `role="alertdialog"` bar across the header rather than an inline span — an
 * accidental forfeit in a rated match is unrecoverable, so the confirm step has
 * to be louder than the trigger, not quieter. It is in the CENTRE column and
 * not the rail on purpose: the rail is a third dashboard track that a narrow
 * layout can push off-screen, and on MobileShell it only appears under the
 * "party" tab — a rail-only forfeit would be a control the player has to go
 * looking for in a battle with a turn clock.
 *
 * The forced-switch case keeps its own treatment (`forced`), where the bench
 * takes the whole body as large cards and the header says so in warning colour
 * — it must still read as forced, not as a bench that happens to be open.
 */
function PvpConsole({
  room, active, pokemon, bench, isWaiting, forceSwitch, trapped, foeTypes, onMove, onSwitch,
}: {
  room: BattleRoom;
  active: ActiveSlot | null;
  pokemon: SidePokemon[];
  bench: BenchMon[];
  isWaiting: boolean;
  forceSwitch: boolean;
  trapped: boolean;
  foeTypes: PokemonType[];
  onMove: (i: number) => void;
  onSwitch: (slot: number) => void;
}) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);

  const mode = forceSwitch ? "forced" : isWaiting ? "waiting" : active ? "fight" : "loading";
  const switchDisabledReason =
    forceSwitch ? null
      : trapped ? t("You can't switch out right now.")
      : isWaiting ? t("Waiting for the opponent…")
      : null;

  return (
    <section className={`pvp2-console mode-${mode}`} aria-label={t("Battle actions")}>
      <header className="pvp2-console-head">
        {confirming ? (
          <div className="pvp2-forfeit-confirm" role="alertdialog" aria-label={t("Confirm forfeit")}>
            <strong>{t("Forfeit? Your opponent gets the win.")}</strong>
            <button
              className="g-btn-ghost g-btn-small"
              autoFocus
              onClick={() => setConfirming(false)}
            >{t("Keep fighting")}</button>
            <button
              className="g-btn-danger-ghost g-btn-small"
              onClick={() => { setConfirming(false); cancelBattle(room.battleId); }}
            >{t("Yes, forfeit")}</button>
          </div>
        ) : (
          <>
            <h4 className="pvp2-console-title">
              {mode === "forced" ? t("Choose your next Pokémon")
                : mode === "waiting" ? t("Opponent is choosing")
                : t("Your move")}
            </h4>
            <button
              type="button"
              className="pvp2-forfeit-btn"
              onClick={() => setConfirming(true)}
              title={t("Give up this battle — your opponent gets the win")}
            >
              <span aria-hidden>⚐</span> {t("Forfeit")}
            </button>
          </>
        )}
      </header>

      {room.opponentAway && <AwayBanner away={room.opponentAway} />}

      <div className="pvp2-console-body">
        {/* The moves column exists in EVERY mode, which is what stops the
            console resizing between fighting, waiting and switching — a surface
            that reflows mid-turn in a battle with a turn clock is a way to
            mis-click. In a forced switch it carries the notice instead; the
            first attempt gave the whole body to the bench and measured 430px of
            dead space under three cards. */}
        <div className="pvp2-console-moves">
          {mode === "fight" && active ? (
            <MoveGrid active={active} foeTypes={foeTypes} onMove={onMove} />
          ) : mode === "forced" ? (
            <p className="pvp2-forced-notice" role="status">
              <strong>{t("Your Pokémon fainted.")}</strong>
              <span>{t("You must send out a replacement before the battle can go on.")}</span>
            </p>
          ) : (
            <p className="pvp2-waiting dim">
              {mode === "waiting"
                ? t("Waiting for opponent's choice…")
                : t("Getting the battle ready…")}
            </p>
          )}
        </div>

        <div className="pvp2-console-bench">
          <div className="pvp2-bench-head">
            <h5>{mode === "forced" ? t("Send out") : t("Switch")}</h5>
            {switchDisabledReason && <span className="dim small">{switchDisabledReason}</span>}
          </div>
          <SwitchGrid
            pokemon={pokemon}
            bench={bench}
            variant={mode === "forced" ? "wide" : "rail"}
            disabled={switchDisabledReason != null}
            onChoose={onSwitch}
          />
        </div>
      </div>
    </section>
  );
}

// ─── Move grid ──────────────────────────────────────────────────────

function MoveGrid({
  active, foeTypes, onMove,
}: {
  active: ActiveSlot;
  foeTypes: PokemonType[];
  onMove: (i: number) => void;
}) {
  const t = useT();
  return (
    /* Reuses the idle game's own `.moves-panel` / `.move-slot` markup,
       inline type colour and all, so a PvP move tile is visually the
       same object as an idle one. The old modal emitted
       `move-type-<type>` classes that do not exist anywhere in the
       stylesheet, which is why PvP moves rendered as grey boxes. */
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

// ─── Switch grid ────────────────────────────────────────────────────

/**
 * The bench, as switch targets.
 *
 * This is the arena's existing `.pvp2-switch-grid` / `.pvp2-switch-card` —
 * built for the forced-switch-after-faint case and now PROMOTED to a permanent
 * part of the console rather than duplicated. `variant` picks the shape: "rail"
 * is the narrow column that sits beside the moves, "wide" is the original
 * auto-fill grid, used when a faint hands the whole body over to it.
 *
 * Each card shows everything the rail's team panel shows — sprite, name, an HP
 * bar, status badge and the fainted state — because "switch to what?" is a
 * decision, and the previous toggle-then-choose flow made the player commit
 * before they could see the answer.
 */
function SwitchGrid({
  pokemon, bench, onChoose, variant, disabled,
}: {
  pokemon: SidePokemon[];
  bench: BenchMon[];
  onChoose: (slot: number) => void;
  variant: "rail" | "wide";
  disabled: boolean;
}) {
  const t = useT();
  if (pokemon.length === 0) {
    return <p className="dim small pvp2-bench-empty">{t("No bench Pokémon.")}</p>;
  }
  return (
    <div className={`pvp2-switch-grid as-${variant}`}>
      {pokemon.map((p, idx) => {
        const fainted = p.condition.includes("fnt");
        const speciesKey = (p.details.split(",")[0] ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
        const name = p.ident.includes(":") ? p.ident.slice(p.ident.indexOf(":") + 1).trim() : p.ident;
        const m = p.condition.match(/(\d+)\s*\/\s*(\d+)/);
        const pct = fainted ? 0 : m ? (parseInt(m[1], 10) / parseInt(m[2], 10)) * 100 : 100;
        const hpClass = pct > 50 ? "ok" : pct > 20 ? "warn" : "low";
        const status = bench.find((b) => b.ident === p.ident)?.status ?? null;
        const blocked = p.active || fainted || disabled;
        return (
          <button
            key={p.ident}
            type="button"
            className={`pvp2-switch-card ${p.active ? "active" : ""} ${fainted ? "fainted" : ""}`}
            disabled={blocked}
            onClick={() => onChoose(idx)}
            title={p.active ? t("Already out") : fainted ? t("Fainted") : `${t("Send out")} ${name}`}
          >
            {/* Wrapped rather than laid out directly: PokemonSprite renders an
                <img> normally but a `.sprite-missing` glyph when every source
                in its fallback chain fails, and the grid needs one stable child
                to place either way. */}
            <span className="pvp2-switch-pic">
              <PokemonSprite
                speciesKey={speciesKey}
                alt=""
                width={40}
                height={40}
                style={{ imageRendering: "pixelated" }}
              />
            </span>
            <span className="pvp2-switch-name">{name}</span>
            <span className={`pvp2-switch-hp ${hpClass}`}>
              <span style={{ width: `${pct}%` }} />
            </span>
            {(status || p.active || fainted) && (
              <span className="pvp2-switch-flags">
                {status && <span className={`hp-status-badge status-${status}`}>{status.toUpperCase()}</span>}
                {p.active && <span className="pvp2-switch-tag">{t("Out")}</span>}
                {fainted && <span className="pvp2-switch-tag">{t("KO")}</span>}
              </span>
            )}
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

// ─── Banners ────────────────────────────────────────────────────────

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

// ─── Right rail: the PvP control panel ──────────────────────────────

export function PvpRail() {
  const { room } = usePvpState();
  const t = useT();
  if (!room) return null;
  return (
    <div className="party-column control-column pvp2-rail">
      <header className="pvp2-rail-head">
        <span className="pvp2-rail-title">{t("PvP Battle")}</span>
        {/* "bot" needs its own branch, not the fallback. This chain ends in
            "Friendly", which for an unrated AI practice battle would be a lie
            about who you are fighting — and the one thing this feature must
            never do is let the player think an AI was a person. */}
        <span className="pvp2-rail-format">
          {room.format === "random50" ? t("Ranked · Lv 50")
            : room.format === "tournament" ? t("Tournament")
            : room.format === "bot" ? t("AI Practice · Not rated")
            : t("Friendly")}
        </span>
        {!room.result && room.turnDeadlineAt && <TurnTimer deadline={room.turnDeadlineAt} />}
      </header>

      <TeamPanel title={t("Your team")} side={room.view.you} own />
      <TeamPanel title={`${room.opponent.username}${t("'s team")}`} side={room.view.foe} />

      <section className="ctx-section pvp2-log-card">
        <h4>{t("Battle log")}</h4>
        <NarrationLog lines={room.narration} mySide={room.side} view={room.view} />
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

/** The full transcript. Unlike the message box this is NOT paced — a
 *  transcript's job is to be complete and scrollable, and pacing it would mean
 *  the player could not scroll back to a line the box had already passed.
 *  It does share the `|win|` phrasing fix, so the two never disagree. */
function NarrationLog({
  lines, mySide, view,
}: {
  lines: NarrationLine[];
  mySide: "a" | "b";
  view: Parameters<typeof displayNarration>[1];
}) {
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
          <span>{displayNarration(l, view)}</span>
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
