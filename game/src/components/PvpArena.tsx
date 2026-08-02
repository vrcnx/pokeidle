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
  lockTeamPreview,
  unlockTeamPreview,
  cancelBattle,
  clearBattleRoom,
  isBotBattle,
  type BattleRoom,
} from "../state/pvp";
import type { ActiveMon, BenchMon, NarrationLine, PreviewMon, SideView } from "../state/pvpBattleView";
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
import { NO_PVP, type PvpMobileView, type PvpNavSignals } from "../utils/pvpMobileNav";
import { MoveEffectVisual } from "./MoveEffectVisual";
import { PvpResultDialog } from "./PvpResultDialog";
import { openPublicTrainerCard } from "./TrainerCardModal";
import type { PokemonType } from "../types";
import { useT } from "../i18n/useT";
import "../pvpArena.css";

/**
 * The arenas a PvP match can be fought on.
 *
 * Every match used to happen at Indigo Plateau. It was the right ONE choice
 * — neutral ground, reads as competitive rather than as a route you grind —
 * but it is the same picture every time, and a ladder you climb for hours
 * looked like one long battle in one room.
 *
 * These are all League and landmark arenas that already ship with the game,
 * so this costs nothing to download. Deliberately not the ordinary route
 * backdrops: a ranked match should not look like a patch of grass.
 */
const ARENAS = [
  "/backgrounds/indigoPlat.webp",
  "/backgrounds/champion_blue.webp",
  "/backgrounds/champion_lanceJohto.webp",
  "/backgrounds/e4_lance.webp",
  "/backgrounds/e4_agatha.webp",
  "/backgrounds/e4_bruno.webp",
  "/backgrounds/e4_lorelei.webp",
  "/backgrounds/e4_karen.webp",
  "/backgrounds/e4_will.webp",
  "/backgrounds/dragonsDen.webp",
  "/backgrounds/bellTower.webp",
  "/backgrounds/ceruleanCave.webp",
];
/** Indigo Plateau stays the fallback: it is the one that has always been
 *  here, so a missing file lands somewhere known rather than on nothing. */
const ARENA_BG_FALLBACK = "/backgrounds/indigoPlat.webp";

/**
 * One arena per BATTLE, picked from the room id.
 *
 * Hashed rather than random: both players are running this component
 * separately, and `Math.random()` in each of them would put the two of them
 * in different rooms — which is the kind of thing nobody notices until
 * somebody posts a screenshot. The room id is the one value both sides
 * already agree on, so the same battle looks the same to both of them
 * without the server having to send anything new.
 */
function arenaFor(roomId: string | undefined): string {
  if (!roomId) return ARENA_BG_FALLBACK;
  let h = 0;
  for (let i = 0; i < roomId.length; i++) h = (h * 31 + roomId.charCodeAt(i)) | 0;
  return ARENAS[Math.abs(h) % ARENAS.length];
}

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

/**
 * Everything every action surface is derived from, in one place.
 *
 * This used to be six `const`s at the top of PvpBattleWindow, which was fine
 * while the arena had exactly one layout. It has two now — the desktop centre
 * column and the phone's four tabs — and `forceSwitch` in particular is a
 * two-source expression (`request.forceSwitch[]` OR `active[0].forceSwitch`,
 * because the simulator uses both spellings). A second hand-copied version of
 * that in the mobile shell is a second thing that can silently disagree with
 * the console about whether the player is allowed to pick a move.
 */
interface BattleControls {
  active: ActiveSlot | null;
  pokemon: SidePokemon[];
  isWaiting: boolean;
  forceSwitch: boolean;
  trapped: boolean;
  over: boolean;
  /** Team Preview owns the screen. TWO SOURCES, and they answer different
   *  questions — see canPickLead. This one is "is the phase on", read from the
   *  shared protocol (`|teampreview` … `|start`), so it stays true while I wait
   *  for the opponent after locking in. */
  previewing: boolean;
  /**
   * Do I still OWE a lead? This is the "you have a decision to make" signal —
   * the one the phone's always-visible status strip shows and the one the
   * picker arms its button on.
   *
   * It is NOT `request.teamPreview`, and that distinction was measured rather
   * than reasoned about: the simulator sends no acknowledgement when a side
   * answers Team Preview, so the request stays a preview request after this
   * player has locked in and keeps saying so until `|start`. Reading it alone
   * left the arena telling somebody who had already chosen to choose. The
   * client's own record of the lock (room.previewLead) is the missing half.
   */
  canPickLead: boolean;
}

function battleControls(room: BattleRoom): BattleControls {
  const active = (room.request?.active?.[0] ?? null) as ActiveSlot | null;
  const over = !!room.result || room.voided;
  return {
    active,
    pokemon: (room.request?.side?.pokemon ?? []) as SidePokemon[],
    isWaiting: !!room.request?.wait,
    forceSwitch: room.request?.forceSwitch?.some(Boolean) ?? !!active?.forceSwitch,
    trapped: !!active?.trapped,
    over,
    // `!over` on both: a battle voided by a restart during Team Preview would
    // otherwise leave the picker up over a dead room, with a countdown running
    // toward an auto-lock nothing is going to perform.
    previewing: !over && room.view.teamPreview,
    canPickLead: !over && !!room.request?.teamPreview && room.previewLead == null,
  };
}

/** The three facts the phone's tab router navigates on, read through the same
 *  derivation the console uses. See utils/pvpMobileNav.ts for the rule. */
export function pvpBattleSignals(room: BattleRoom | null): PvpNavSignals {
  if (!room) return NO_PVP;
  const c = battleControls(room);
  return { battleId: room.battleId, forceSwitch: c.forceSwitch, over: c.over };
}

/** The format line, shared by the desktop rail head and the phone's status
 *  strip. "bot" needs its own branch, not the fallback: this chain ends in
 *  "Friendly", which for an unrated AI practice battle would be a lie about who
 *  you are fighting — and the one thing this feature must never do is let the
 *  player think an AI was a person. */
function formatLabel(room: BattleRoom, t: (k: string) => string): string {
  return room.format === "random50" ? t("Ranked · Lv 50")
    : room.format === "tournament" ? t("Tournament")
    : room.format === "bot" ? t("AI Practice · Not rated")
    : t("Friendly");
}

function PvpBattleWindow({ room }: { room: BattleRoom }) {
  const over = battleControls(room).over;
  return (
    <div className="pvp2-center">
      <PvpScene room={room} />

      {/* ── Action area ── */}
      {over ? <PvpResultDialog room={room} /> : <PvpConsoleFor room={room} />}
    </div>
  );
}

/**
 * The battle window itself — the 16/9 frame, its fighters and its message box.
 *
 * Split out of PvpBattleWindow when the phone layout landed. On a phone the
 * frame lives in the shell's arena row and the console lives in the tab body
 * below it, which are two different grid rows of `.mobile-shell` and therefore
 * cannot be one component. Nothing about the scene changed in the split; it is
 * the same markup, and both layouts render this exact component so the two can
 * not drift.
 */
function PvpScene({ room }: { room: BattleRoom }) {
  // Same arena for both players, different arena for the next battle — see
  // arenaFor. battleId is the value both sides already agree on.
  const arenaBg = arenaFor(room.battleId);
  const t = useT();
  const you = room.view.you;
  const foe = room.view.foe;
  const { isWaiting, forceSwitch, over, previewing } = battleControls(room);
  const stage = usePvpNarrationStage(room);

  return (
    <div className={`pvp2-scene${previewing ? " is-preview" : ""}`}>
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
          src={arenaBg}
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
            : previewing
              ? null
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
          : previewing
            ? null
            : <div className="pvp2-slot-empty player-card dim small">{t("Sending out…")}</div>}

        {/* THE PREVIEW STAGE, inside `.scene-content` and inside the same
            16/9 frame the battle uses — this is the arena's own window, not a
            modal over it. It replaces the two "Waiting for opponent…" /
            "Sending out…" placeholders above rather than sitting beside them:
            during Team Preview neither side HAS an active Pokémon yet, so those
            two strings are describing a state that is not the one the player is
            in. */}
        {previewing && <PvpPreviewStage room={room} />}

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
  );
}

/** The console with its props read off the room. One call site on desktop, one
 *  on the phone's battle tab — the derivation lives in `battleControls` so
 *  neither can invent its own. */
function PvpConsoleFor({ room }: { room: BattleRoom }) {
  const c = battleControls(room);
  const foe = room.view.foe;
  // ONE seam for both layouts. The desktop centre column and the phone's
  // battle tab both render this component and nothing else, so putting Team
  // Preview here is what makes it reachable on a phone without a second
  // implementation — and what stops the two from disagreeing about whether the
  // phase is still on.
  if (c.previewing) return <PvpTeamPreview room={room} canPick={c.canPickLead} />;
  return (
    <PvpConsole
      room={room}
      active={c.active}
      pokemon={c.pokemon}
      bench={room.view.you.bench}
      isWaiting={c.isWaiting}
      forceSwitch={c.forceSwitch}
      trapped={c.trapped}
      foeTypes={foe.active ? (pokemonTable[foe.active.speciesKey]?.types ?? []) : []}
      onMove={(i) => chooseBattleAction(room.battleId, `move ${i + 1}`)}
      onSwitch={(slot) => chooseBattleAction(room.battleId, `switch ${slot + 1}`)}
    />
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
  // Above forceSwitch/isWaiting on purpose. A preview request carries neither
  // `active` nor `forceSwitch`, and "Waiting for the opponent's move…" is a lie
  // during a phase where no move has been possible yet.
  //
  // `previewLead` and not `request.teamPreview`: the request stays a preview
  // request after this player answers (the simulator acknowledges nothing), so
  // reading it here left the box telling somebody who had already locked in to
  // choose. Measured in the browser.
  if (room.view.teamPreview) {
    return room.previewLead == null
      ? t("Team Preview — choose who leads.")
      : t("Locked in. Waiting for your opponent…");
  }
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

// ─── Team Preview ───────────────────────────────────────────────────
//
// The defining pre-battle ritual of competitive Pokémon, and the reason PvP
// was broken once: Custom Game ships Team Preview ON, the first |request| is
// `{"teamPreview":true}` with no active slot and no moves, and with nothing
// able to answer it every battle sat until the AFK watchdog forfeited it. The
// server side of the fix is in server/src/pvp.ts (a 20-second auto-lock armed
// inside startBattle, which every start path passes through). This is the other
// half — the thing that makes answering possible.
//
// ─── WHY PICKING A LEAD IS THE WHOLE DECISION ────────────────────────
//
// The protocol's `team <order>` takes a full permutation, and a first pass at
// this screen let you build one. It was removed, because in SINGLES the order
// beyond the lead decides NOTHING: every Pokémon after the first enters through
// a switch the player chooses explicitly at the time, either voluntarily or from
// the forced-switch grid after a faint. The tail of the permutation is
// unobservable. Shipping a six-slot reorder would have been twenty seconds of
// dragging to set a value the battle never reads — in front of the rarest event
// in the game, on a population of ~34 active players an hour, with a countdown
// running.
//
// So the picker is "tap the Pokémon you want to lead, then lock in", which maps
// one-to-one onto a choice string measured against the real simulator:
// `team 3` on a six-Pokémon team produces the final order [3,1,2,4,5,6] and
// leads slot 3. Nothing is derived, nothing is reordered client-side, and there
// is no local order model that could disagree with the server's.
//
// ─── WHAT IT MAY SHOW ────────────────────────────────────────────────
//
// The foe's roster is rendered from `view.foe.preview`, which the decoder
// builds from the shared `|poke|` lines and nothing else: SPECIES, LEVEL,
// GENDER. Not moves, not items, not abilities, not stats, not nicknames — the
// |request| payload that carries all of that is one-sided and the server strips
// the one extra bit `|poke|` used to carry (the held-item flag). See
// server/src/lib/pvpTeamPreview.ts for the measurement.
//
// The consequence for THIS file is a rule rather than a note: render only what
// is on `PreviewMon`. Do not reach into `pokemonTable` for anything but the
// display name and the sprite — a type badge would be fine (typing is public
// knowledge, given the species) but a base-stat or movepool readout would turn
// a species reveal into a build reveal for anyone who does not know the dex by
// heart, which is a competitive advantage handed to the client that happens to
// render more.

/**
 * The preview rosters, inside the arena's own 16/9 battle window.
 *
 * Deliberately NOT a modal, and deliberately inside `.scene-content`: the arena
 * is a battle window with a background, a message box and a field strip, and a
 * dialog floating over it would read as "the app interrupted you" rather than
 * "the battle has a phase". The two rows sit where the two fighters will be —
 * foe up top, yours at the bottom — so when the phase ends and the real sprites
 * come out, they come out where their team already was.
 */
function PvpPreviewStage({ room }: { room: BattleRoom }) {
  const t = useT();
  const foe = room.view.foe.preview;
  const you = room.view.you.preview;
  return (
    <div className="pvp2-preview-stage" aria-label={t("Team Preview")}>
      <PvpPreviewRow
        who={room.opponent.username}
        mons={foe}
        side="foe"
        empty={t("Waiting for the opponent's team…")}
      />
      <PvpPreviewRow who={t("Your team")} mons={you} side="you" empty={t("Loading your team…")} />
    </div>
  );
}

function PvpPreviewRow({
  who, mons, side, empty,
}: {
  who: string;
  mons: PreviewMon[];
  side: "you" | "foe";
  empty: string;
}) {
  const t = useT();
  return (
    <div className={`pvp2-preview-row is-${side}`}>
      <span className="pvp2-preview-who">{who}</span>
      {mons.length === 0 ? (
        <span className="pvp2-preview-empty dim small">{empty}</span>
      ) : (
        <ul className="pvp2-preview-list">
          {mons.map((m) => (
            <li key={m.slot} className="pvp2-preview-mon">
              <PokemonSprite
                speciesKey={m.speciesKey}
                alt=""
                width={40}
                height={40}
                style={{ imageRendering: "pixelated" }}
              />
              <span className="pvp2-preview-name">
                {pokemonTable[m.speciesKey]?.name ?? m.speciesKey}
              </span>
              <span className="pvp2-preview-lv dim">{t("Lv")}{m.level}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The picker, in the console's slot.
 *
 * It emits `.pvp2-console` and its header/body classes, so it inherits the
 * panel the moves and bench already live in — same size, same chrome, same
 * place on desktop and on the phone's battle tab. That matters beyond looks:
 * `.pvp2-console` is what gives the surface a fixed height, and a preview
 * screen that was a different size from the console it turns into would make
 * the whole layout jump at the exact moment turn 1 opens.
 *
 * ─── THE COUNTDOWN IS NOT DECORATION ─────────────────────────────────
 *
 * `room.turnDeadlineAt` carries the PREVIEW deadline during this phase and the
 * turn deadline afterwards (server-side, one function — see turnDeadlineFor in
 * server/src/pvp.ts), so the same `TurnTimer` the rail already renders is
 * counting down the real auto-lock. Telling the player it is going to lock, and
 * what it will lock, is the difference between a deadline and an ambush — and
 * the honest message is reassuring rather than threatening, because `default`
 * is the order they already built in the Team Builder.
 */
function PvpTeamPreview({ room, canPick }: { room: BattleRoom; canPick: boolean }) {
  const t = useT();
  const mons = room.view.you.preview;
  // SELECTION is local — a decision that has not been sent, which nothing
  // outside this panel needs, and which the remount on a new battle resets for
  // free. THE LOCK is not local: it lives on the room (state/pvp.ts's
  // previewLead) because the message box is a sibling component and, on a
  // phone, the status strip is on a DIFFERENT TAB. See that field's comment for
  // what was measured in the browser.
  const [lead, setLead] = useState<number | null>(null);
  const sent = room.previewLead;
  const locked = sent !== null;
  // The SERVER will still accept a change — a second `team` overwrites the
  // first until both sides have answered — so this is a separate question from
  // `canPick`, which goes false the moment we lock.
  const phaseOpen = !!room.request?.teamPreview && !room.result;

  const nameOfSlot = (slot: number | null) =>
    slot == null ? "" : (pokemonTable[mons.find((m) => m.slot === slot)?.speciesKey ?? ""]?.name ?? "");
  const chosenName = nameOfSlot(lead);
  const sentName = sent ? nameOfSlot(sent) : nameOfSlot(mons[0]?.slot ?? null);

  return (
    <section className={`pvp2-console mode-preview${locked ? " is-locked" : ""}`} aria-label={t("Team Preview")}>
      <header className="pvp2-console-head">
        <h4 className="pvp2-console-title">
          {canPick ? t("Choose your lead") : t("Locked in")}
        </h4>
        {!room.result && room.turnDeadlineAt && (
          <span className="pvp2-preview-clock">
            <span className="dim small">{t("Auto-locks in")}</span>
            <TurnTimer deadline={room.turnDeadlineAt} />
          </span>
        )}
      </header>

      <div className="pvp2-console-body is-preview">
        <div className="pvp2-preview-pick">
          {mons.length === 0 ? (
            <p className="pvp2-waiting dim">{t("Getting the battle ready…")}</p>
          ) : (
            <div className="pvp2-switch-grid as-wide pvp2-preview-grid">
              {mons.map((m) => {
                const picked = (sent ?? lead) === m.slot || (sent === 0 && m.slot === 1 && lead == null);
                return (
                  <button
                    key={m.slot}
                    type="button"
                    className={`pvp2-switch-card pvp2-preview-card ${picked ? "picked" : ""}`}
                    // Frozen once locked, and re-armed by "Change lead" rather
                    // than by tapping a card. Tapping only SELECTS — the send
                    // is the button — so leaving the cards live after a lock
                    // would let a stray tap silently disagree with the choice
                    // the server is holding.
                    disabled={!canPick}
                    aria-pressed={picked}
                    onClick={() => setLead(m.slot)}
                    title={`${t("Lead with")} ${pokemonTable[m.speciesKey]?.name ?? m.speciesKey}`}
                  >
                    <span className="pvp2-switch-pic">
                      <PokemonSprite
                        speciesKey={m.speciesKey}
                        alt=""
                        width={40}
                        height={40}
                        style={{ imageRendering: "pixelated" }}
                      />
                    </span>
                    <span className="pvp2-switch-name">
                      {pokemonTable[m.speciesKey]?.name ?? m.speciesKey}
                    </span>
                    <span className="pvp2-preview-slot dim small">
                      {t("Lv")}{m.level}
                    </span>
                    {picked && <span className="pvp2-switch-tag">{t("Lead")}</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="pvp2-preview-actions">
          {canPick ? (
            <>
              <button
                type="button"
                className="g-btn-primary pvp2-preview-lock"
                onClick={() => lockTeamPreview(room.battleId, lead)}
                disabled={mons.length === 0}
              >
                {lead == null
                  ? t("Lock in my order")
                  : `${t("Lead with")} ${chosenName}`}
              </button>
              <p className="dim small pvp2-preview-hint">
                {t("You only see each other's species. If the clock runs out, your current order is used.")}
              </p>
            </>
          ) : (
            <>
              <p className="pvp2-preview-locked" role="status">
                <strong>{t("Locked in.")}</strong>
                <span>{sentName ? `${t("Leading with")} ${sentName}.` : ""}</span>
                <span>{t("Waiting for your opponent…")}</span>
              </p>
              {/* Changing your mind is LEGAL until both sides have answered —
                  a second `team` choice overwrites the first, measured against
                  the real simulator — so the affordance exists rather than the
                  screen pretending the decision is final. It disappears the
                  moment the phase does, because this whole component unmounts
                  on |start. */}
              {phaseOpen && (
                <button
                  type="button"
                  className="g-btn-ghost g-btn-small pvp2-preview-change"
                  onClick={() => unlockTeamPreview(room.battleId)}
                >
                  {t("Change lead")}
                </button>
              )}
              <p className="dim small pvp2-preview-hint">
                {t("The battle starts the moment they choose.")}
              </p>
            </>
          )}
        </div>
      </div>
    </section>
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
        <span className="pvp2-rail-format">{formatLabel(room, t)}</span>
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
  // "Not yet revealed" counts species you have not SEEN. During Team Preview
  // you have seen all of them, so the count is zero however empty `bench` is —
  // it measured `teamSize - bench.length` and printed "+6 not yet revealed"
  // directly underneath a list of all six. Measured in the browser.
  const showingPreview = side.bench.length === 0 && side.preview.length > 0;
  const hidden = showingPreview ? 0 : Math.max(0, (side.teamSize || 0) - side.bench.length);
  return (
    <section className="ctx-section pvp2-team-card">
      <h4>{title}</h4>
      {showingPreview ? (
        // TEAM PREVIEW. `bench` only ever holds Pokémon that have actually
        // taken the field, so during the preview phase it is empty for both
        // sides and this panel used to say "Nothing revealed yet." over a
        // screen that was, at that moment, revealing exactly this. The roster
        // is shown WITHOUT hp bars or status badges — not for tidiness, but
        // because `PreviewMon` genuinely has neither and rendering a full green
        // bar would be inventing a fact the server never sent.
        <ul className="pvp2-team-list is-preview">
          {side.preview.map((p) => (
            <li key={p.slot} className="pvp2-team-row">
              <PokemonSprite
                speciesKey={p.speciesKey}
                alt=""
                width={32}
                height={32}
                style={{ imageRendering: "pixelated" }}
              />
              <span className="pvp2-team-name">
                {pokemonTable[p.speciesKey]?.name ?? p.speciesKey}
              </span>
              <span className="pvp2-team-lv dim">{t("Lv")}{p.level}</span>
            </li>
          ))}
        </ul>
      ) : side.bench.length === 0 ? (
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

// ─── The phone ───────────────────────────────────────────────────────
//
// THE GAP THIS CLOSES. At 390×760 with a live battle in the store, the arena
// did not mount AT ALL: `.pvp2-center` and `.pvp2-scene` were absent and the
// phone showed the frozen IDLE battle scene instead. MobileShell was
// byte-identical to the commit before the arena shipped, so it simply never
// routed to it. What a phone player actually had was the rail — and only under
// the "Party" tab, because PartyColumn swaps itself for PvpRail. So they could
// read the transcript and both teams, and could not pick a move, could not
// switch, could not forfeit, and never saw the result dialog.
//
// WHY THIS IS NOT THE DESKTOP LAYOUT SQUEEZED. Desktop is a centre column
// (scene + console) PLUS a right rail (timer, both teams, transcript). There is
// no second column at 374px, and stacking all five surfaces would be ~1,100px
// of scroll in front of a battle with a turn clock — the one situation where
// "scroll down to find your moves" is a lost match rather than an annoyance.
//
// SO THE PHONE SPLITS IT BY TIME INSTEAD OF BY SPACE:
//
//   ALWAYS ON SCREEN — the battle window (the same `PvpScene` desktop renders,
//   so the sprites, cards, field chips, move effects and the message box are
//   literally the same component) plus a status strip carrying the two facts a
//   player must never have to go looking for: the turn clock, and whether the
//   battle is waiting on THEM.
//
//   ONE TAB AT A TIME — the console (moves + bench + forfeit), the two teams,
//   the transcript, and chat. They take over the shell's bottom bar for the
//   duration of the battle, which is deliberate: the idle game is PARKED while
//   a room exists (App.tsx passes `useIsPvpBattle()` into `useBattleLoop`), so
//   the six idle tabs lead to a frozen game, and the bar is the most valuable
//   real estate on a phone. Chat keeps a slot because desktop keeps its chat
//   rail during a battle and "gg" is part of PvP.
//
// The tab is chosen by the player except at the three moments where the clock
// would punish that — see utils/pvpMobileNav.ts, which owns that rule and is
// tested.

/**
 * The always-visible half: the battle window plus the status strip.
 *
 * The strip is the mobile answer to a desktop fact — that the console, with its
 * "Your move" / "Opponent is choosing" / "Choose your next Pokémon" title, is
 * on screen at all times. On a phone it is one of four tabs, so the state it
 * announces is republished here where it cannot be tabbed away from, next to
 * the countdown that enforces it.
 */
export function PvpMobileStage() {
  const { room } = usePvpState();
  const t = useT();
  if (!room) return null;
  const c = battleControls(room);
  // Ordered by what BLOCKS the battle, not by what is interesting. Team Preview
  // splits in two because the phase outlives your answer to it: once you have
  // locked in, the same screen is a wait, and telling a player to pick a lead
  // they have already picked is how you get them tapping a dead surface with an
  // auto-lock counting down.
  const state = c.over ? { cls: "over", label: t("Battle over") }
    : room.opponentAway ? { cls: "away", label: t("Opponent away") }
    // Team Preview above forceSwitch/isWaiting: none of the labels below
    // describes a phase in which no move has been possible yet. This strip is
    // the phone's ALWAYS-VISIBLE row while the picker is one tab away, so it is
    // the only thing that can tell a player they still owe a decision.
    : c.previewing ? (c.canPickLead
        ? { cls: "act", label: t("Pick your lead") }
        : { cls: "wait", label: t("Locked in — waiting") })
    : c.forceSwitch ? { cls: "act", label: t("Send out a Pokémon") }
    : c.isWaiting ? { cls: "wait", label: t("Opponent choosing") }
    : c.active ? { cls: "act", label: t("Your turn") }
    : { cls: "wait", label: t("Getting ready…") };
  return (
    <div className="pvp2-m-stage">
      <PvpScene room={room} />
      <div className="pvp2-m-status">
        <span className="pvp2-m-format">{formatLabel(room, t)}</span>
        <span className={`pvp2-m-state is-${state.cls}`} role="status">{state.label}</span>
        {/* Same condition the rail uses: a finished battle's deadline is stale
            and a counter still ticking toward it would imply a forfeit that
            cannot happen. */}
        {!room.result && room.turnDeadlineAt && <TurnTimer deadline={room.turnDeadlineAt} />}
      </div>
    </div>
  );
}

/**
 * The tabbed half.
 *
 * Every branch renders a component the desktop layout already renders — the
 * console via `PvpConsoleFor`, the rail's `TeamPanel` twice, the rail's
 * `NarrationLog` — so there is no second implementation of any battle surface
 * to keep in step. Only the hosting boxes are new, and they exist to give the
 * phone's tab body the right scroll behaviour per view (see pvpArena.css:
 * the console tab must never scroll, the log tab scrolls INSIDE the log so its
 * heading stays put, the teams tab is free to grow).
 */
export function PvpMobilePanel({ view }: { view: Exclude<PvpMobileView, "chat"> }) {
  const { room } = usePvpState();
  const t = useT();
  if (!room) return null;

  if (view === "team") {
    return (
      <div className="pvp2-m-panel view-team">
        <TeamPanel title={t("Your team")} side={room.view.you} own />
        <TeamPanel title={`${room.opponent.username}${t("'s team")}`} side={room.view.foe} />
      </div>
    );
  }

  if (view === "log") {
    return (
      <div className="pvp2-m-panel view-log">
        <section className="ctx-section pvp2-log-card">
          <h4>{t("Battle log")}</h4>
          <NarrationLog lines={room.narration} mySide={room.side} view={room.view} />
        </section>
      </div>
    );
  }

  // The battle tab, and the same branch desktop takes: a finished battle
  // replaces the console with the result dialog, which renders its own summary
  // bar here AND a fixed overlay above everything. `nextPvpMobileView` forces
  // this tab the moment a result lands, so the dialog can never be mounted on a
  // tab the player is not looking at.
  const over = battleControls(room).over;
  return (
    <div className="pvp2-m-panel view-battle">
      {over ? <PvpResultDialog room={room} /> : <PvpConsoleFor room={room} />}
    </div>
  );
}
