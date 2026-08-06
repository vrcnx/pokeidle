import { useEffect, useMemo, useRef } from "react";
import { useGame } from "../state/GameContext";
import { IconPlus } from "./Icon";
import { itemSpriteUrl } from "../utils/sprites";
import { PokemonSprite } from "./Sprite";
import { pokemonTable } from "../data/pokemon";
import { itemsCatalog } from "../data/itemsCatalog";
import { itemSpriteSlug, getItemInfo } from "../utils/items";
import { expForLevel } from "../utils/stats";
import { openPokemonDetail } from "./PokemonDetailModal";
import { openHub } from "./HubModal";
import { ContextPanel, UnlockHint } from "./ContextPanel";
import { RouteMasteryCard } from "./RouteMasteryCard";
import { animatePop } from "../utils/animate";
import { openContextMenu } from "./ContextMenu";
import { evolutions } from "../data/evolutions";
import { displayName } from "../utils/pokemon";
import { duplicateIdSet, releaseBlockedReason } from "../utils/releaseConfirm";
import { decideRelease } from "../utils/releaseAtClick";
import { pushToast } from "./Toast";
import {
  evolutionLocked,
  levelEvolutionBranches,
  levelEvolutionFor,
  levelEvolutionTargets,
} from "../utils/evolution";
import { useDragAndDrop } from "../hooks/useDrag";
import { InventoryRibbon } from "./InventoryRibbon";
import { PvpRail } from "./PvpArena";
import { useIsPvpBattle } from "../state/pvp";
import type { MutableRefObject } from "react";
import type { Pokemon, GameState, StatusCondition } from "../types";
import { useT } from "../i18n/useT";

// The stone evolution this Pokémon could take right now — the stone to
// spend and the species it becomes — or null if there isn't one. Split
// out of canEvolveNow so the party row's context menu can offer the
// evolution as an action instead of re-deriving which trigger matched.
function readyStoneEvolution(
  p: Pokemon,
  inventory: GameState["inventory"],
): { item: string; into: string } | null {
  for (const t of evolutions[p.speciesKey] ?? []) {
    // Stone-style item evolution (use from bag). Exclude trade+item
    // triggers — those only fire during a trade, not by using the
    // catalyst item out of your inventory.
    if (!("item" in t) || "trade" in t) continue;
    if ((inventory[t.item] ?? 0) <= 0) continue;
    // USE_STONE refuses to spend a stone on a species that isn't in the
    // dex yet, so don't advertise one either.
    if (!pokemonTable[t.into]) continue;
    return { item: t.item, into: t.into };
  }
  return null;
}

// The level-up evolution this Pokémon has already earned, or null.
// Level evolutions now fire on their own (hooks/useAutoEvolve, gated on
// state.autoEvolve and on the mon's own `noEvolve` lock), so in the default
// configuration this is normally true for less than a tick. The menu entry
// still matters, and is the only way to act on one, when the global toggle is
// off or this particular Pokémon is locked.
//
// levelEvolutionFor does the branch selection (and the "target exists in
// pokemonTable" guard this used to do inline), so a species with a stat
// split offers the one branch this individual actually qualifies for
// rather than whichever trigger happens to be listed first.
function readyLevelEvolution(p: Pokemon): { into: string } | null {
  const t = levelEvolutionFor(p);
  return t ? { into: t.into } : null;
}

// Returns true when this party member can evolve right now AND is waiting on
// the player to do something about it — either a stone it owns, or a level
// evolution that automation will not take (locked mon, or the global toggle
// off). Trade-only evolutions are excluded (those fire from the trade flow).
// Used to paint a glow on ready party rows so the player knows to act.
//
// A locked mon deliberately does NOT glow: the lock means "leave this one
// alone", and a row pulsing forever at a player who already answered the
// question is nagging, not information. The lock badge says what is going on
// instead, and the menu still offers the manual Evolve.
//
// Shares readyLevelEvolution's predicate rather than re-testing the raw
// level, so the glow and the context-menu entry can never disagree — the
// old inline test lit the row for targets the menu then refused to offer.
function canEvolveNow(p: Pokemon, inventory: GameState["inventory"], autoEvolve: boolean): boolean {
  if (readyLevelEvolution(p) !== null && !autoEvolve && !evolutionLocked(p)) return true;
  return readyStoneEvolution(p, inventory) !== null;
}

// 3-letter abbreviations for the major status conditions, used by
// the party-row badge. Mirrors the in-battle HP-card abbreviations
// for consistency (PAR/SLP/BRN/FRZ/PSN/TOX) so a player learns one
// vocabulary across both surfaces.
const STATUS_ABBREV: Record<StatusCondition, string> = {
  paralyzed: "PAR",
  asleep: "SLP",
  burned: "BRN",
  frozen: "FRZ",
  poisoned: "PSN",
  badlyPoisoned: "TOX",
};
function statusBadgeClass(s: StatusCondition): string {
  // Class names match the in-battle HP-card status-badge styles in
  // app.css so we don't duplicate colour rules — see hp-status-badge
  // *.par/*.slp/*.brn/etc.
  switch (s) {
    case "paralyzed":     return "par";
    case "asleep":        return "slp";
    case "burned":        return "brn";
    case "frozen":        return "frz";
    case "poisoned":      return "psn";
    case "badlyPoisoned": return "tox";
  }
}

// RIGHT rail (Twitch-stream layout): control panel. Order top→bottom:
//   1. UnlockHint (Next Goal — what you are working towards, over the six
//      Pokémon you are working towards it with)
//   2. Party list (the player's team)
//   3. ContextPanel (status hints + battle log)
//   4. InventoryRibbon — MOBILE ONLY. Desktop shows a trainer card in the
//      left rail; mobile has no left rail, so the strip is still its Lv/$/
//      badges readout.
// Drag a party row onto another to swap slots; drag a box Pokémon onto a
// party slot to move/swap. The drag system is pointer-events-based so it
// works on touch.
export function PartyColumn({ showProfileStrip = true, wide = false }: { showProfileStrip?: boolean; wide?: boolean }) {
  const { state } = useGame();
  const t = useT();
  const pvpBattle = useIsPvpBattle();
  // The live state, for a row's frozen menu closures to read at CLICK time.
  // Held HERE and not in the row, because the row is keyed by pokemon id: the
  // exact mutation this guards against (the subject leaving the party) unmounts
  // the row, freezing its own ref at the last state in which the mon was still
  // there — which is precisely the answer that must not be trusted. This
  // component outlives every row in it.
  const liveRef = useRef(state);
  useEffect(() => { liveRef.current = state; });
  // During a PvP battle this whole rail becomes the PvP control panel:
  // match header + turn clock, both teams, and the battle log. The idle
  // verbs (Mart / Bag / PC / Dex, Heal, party switching) are deliberately
  // gone — none of them mean anything in a PvP turn, and leaving the PC
  // reachable would let a player deposit their active Pokémon mid-battle.
  if (pvpBattle) return <PvpRail />;
  return (
    <div className="party-column control-column">
      {/* NEXT GOAL, top-right. It moved off the left rail to sit above the
          party — the thing you are working towards, over the six Pokémon
          you are working towards it with. */}
      <UnlockHint />
      <RouteMasteryCard />
      <section className="ctx-section party-card">
        {/* Heal moved here from the moves toolbar at the bottom of the centre
            column (br_27cfd612ddd30485fc). It is a PARTY action — it restores
            HP and PP for these six rows — and it was sitting in a row of
            battle controls next to speed and Manage Moves, three panels away
            from the thing it acts on. Top-right of the party header is where
            the player looks for it. */}
        <div className="party-card-head">
          <h4>{t("Party")}</h4>
          {/* Where you go to change WHO is in the party, next to the button
              that changes what state they are in. The PC has always been the
              answer and there was never a route to it from the party itself:
              you had to know the PC also managed the party, and go looking.
              It lands on the PC with the party column beside the box, which
              is the surface this button is promising. */}
          <button
            type="button"
            className="party-manage-btn"
            onClick={() => openHub("pc")}
            title={t("Open the PC to swap Pokémon in and out")}
          >
            {t("Manage")}
          </button>
          <PartyHealButton />
        </div>
        {/* role="group", because every row inside is role="button" (see
            PartyRow) and a <ul> whose children are not listitems announces as
            an empty list. A named group of buttons is what this actually is. */}
        <ul className="party-list" role="group" aria-label={t("Party")}>
          {state.party.map((p, idx) => (
            <PartyRow key={p.id} pokemon={p} index={idx} live={liveRef} />
          ))}
        </ul>
      </section>

      {/* Wide moves the wild-Pokémon panel into the centre, under the moves. */}
      {!wide && <ContextPanel />}
      {/* The Next Goal card is at the TOP of this rail now, so the copy that
          used to sit down here is gone — leaving it would have rendered two
          of them on mobile, where `showProfileStrip` is true.
          The profile strip stays for mobile only: the desktop rails show a
          trainer card instead, and mobile has no left rail to put one in. */}
      {showProfileStrip && <InventoryRibbon />}
    </div>
  );
}

/** The manual Heal, at the top-right of the Party card (br_27cfd612ddd30485fc).
 *
 *  Dispatches START_HEALING, not HEAL_PARTY: that is the animated route the
 *  moves toolbar used, and it plays the Centre sequence before COMPLETE_HEALING
 *  actually restores the party. Disabled only while a heal is already running,
 *  so it stays usable mid-battle as the panic button it has always been. */
/** Heal / retreat. Exported for the PC's party column, which is a second
 *  place a player manages the team and would otherwise have to leave the
 *  dialog to heal it. */
export function PartyHealButton() {
  const { state, dispatch } = useGame();
  const t = useT();
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const disabled = state.phase === "healing" || !state.playerPokemon;
  // Nothing to restore — every member is at full HP with full PP. Kept as a
  // hint rather than a disable: a player who clicks it should learn why it did
  // nothing, and `disabled` here would also swallow the mid-battle retreat use.
  const alreadyFull = state.party.every(
    (p) => p.currentHp >= p.maxHp && p.moves.every((m) => m.pp >= m.maxPp),
  );
  return (
    <button
      ref={btnRef}
      type="button"
      className={`party-heal-btn${alreadyFull ? " full" : ""}`}
      disabled={disabled}
      onClick={() => {
        if (btnRef.current) animatePop(btnRef.current, 1.15);
        dispatch({ type: "START_HEALING" });
      }}
      title={
        disabled
          ? t("Cannot heal right now")
          : alreadyFull
            ? t("Your party is already at full health.")
            : t("Fully heal your party. Retreats from any active battle or raid.")
      }
    >
      <IconPlus size={13} strokeWidth={2.5} />
      <span>{t("Heal")}</span>
    </button>
  );
}

/**
 * One party member.
 *
 * Exported because the PC's third column renders the same rows. Two party
 * lists that looked alike and behaved differently would be worse than one
 * shared row — the drag rules, the context menu, the release guards and the
 * keyboard route all live in here, and a second copy would drift from this
 * one on the first change to any of them.
 */
export function PartyRow({
  pokemon: p,
  index: idx,
  live,
}: {
  pokemon: Pokemon;
  index: number;
  /** Owned by PartyColumn — see the comment there. */
  live?: MutableRefObject<GameState>;
}) {
  const { state, dispatch } = useGame();
  const t = useT();
  const sp = pokemonTable[p.speciesKey];
  const hpPct = (p.currentHp / p.maxHp) * 100;
  const hpClass = hpPct > 50 ? "ok" : hpPct > 20 ? "warn" : "low";
  const baseExp = expForLevel(p.level, sp.growthRate);
  const nextExp = expForLevel(p.level + 1, sp.growthRate);
  const expSpan = Math.max(1, nextExp - baseExp);
  const expIntoLevel = Math.max(0, p.totalExp - baseExp);
  const expRaw = (expIntoLevel / expSpan) * 100;
  const expPct = expRaw === 0 ? 0 : Math.max(2, Math.min(100, expRaw));
  const active = idx === state.activePlayerPokemonIndex;
  const stoneEvo = readyStoneEvolution(p, state.inventory);
  const levelEvo = readyLevelEvolution(p);
  const evoReady = canEvolveNow(p, state.inventory, state.autoEvolve);
  const locked = evolutionLocked(p);
  // Non-empty only for a species whose level evolution actually splits
  // (Tyrogue). Drives the "which branch, and why" hints below.
  const branches = levelEvolutionBranches(p);
  const onBranch = branches.find((b) => b.met);

  const ref = useDragAndDrop<HTMLLIElement>({
    source: {
      payload: () => ({ kind: "party", data: { index: idx, id: p.id } }),
    },
    target: {
      // Accept other party rows OR PC box cells. Reject self-drop.
      accept: (payload) => {
        if (payload.kind === "party") {
          const fromIdx = (payload.data as { index: number }).index;
          return fromIdx !== idx;
        }
        return payload.kind === "box";
      },
      onDrop: (payload) => {
        if (payload.kind === "party") {
          const fromIdx = (payload.data as { index: number }).index;
          if (fromIdx === idx) return;
          dispatch({ type: "SWAP_PARTY", payload: { a: fromIdx, b: idx } });
        } else if (payload.kind === "box") {
          const boxIdx = (payload.data as { index: number }).index;
          if (state.party[idx]) {
            dispatch({
              type: "SWAP_PARTY_BOX",
              payload: { partyIndex: idx, boxIndex: boxIdx },
            });
          } else {
            dispatch({ type: "BOX_TO_PARTY", payload: { boxIndex: boxIdx } });
          }
        }
        if (ref.current) requestAnimationFrame(() => animatePop(ref.current!, 1.06));
      },
    },
  });

  // Why RELEASE_POKEMON would refuse this row, if it would. `partySize <= 1`
  // was the only thing the menu checked, so the reducer's OTHER two guards —
  // an auction-listed mon, and the last HEALTHY member — were offered as live
  // actions that confirmed and then did nothing.
  // Ids sharing a slot in the party. RELEASE_POKEMON's id re-anchor resolves to
  // the FIRST match, so releasing the later of a duplicated pair destroys the
  // earlier one — blocked rather than risked. See duplicateIdSet.
  const duplicateIds = useMemo(() => duplicateIdSet(state.party), [state.party]);
  const releaseBlocked = releaseBlockedReason(p, "party", {
    listedPokemonIds: state.listedPokemonIds ?? [],
    party: state.party,
    duplicateIds,
  });


  // One menu, three ways in: right-click, the ContextMenu key / Shift+F10, and
  // (on touch) the detail modal that a tap now actually opens. Built once so
  // the keyboard route can never drift from the pointer one.
  const openRowMenu = (at: { clientX: number; clientY: number }) => {
    const isFront = idx === 0;
    const partySize = state.party.length;
    openContextMenu(at, [
      // Manual level evolution. Offered even when this mon is locked —
      // the lock stops AUTO-evolving, and a click here is the player
      // asking for this Pokémon by name, which outranks a standing
      // preference. The hint carries the branch comparison so a split
      // line (Tyrogue) says what it is about to become and why.
      ...(levelEvo
        ? [{
            label: t("Evolve"),
            hint: onBranch
              ? `${pokemonTable[levelEvo.into]?.name ?? levelEvo.into} · ${onBranch.requirement}`
              : pokemonTable[levelEvo.into]?.name,
            icon: (
              <PokemonSprite
                speciesKey={levelEvo.into}
                alt=""
                width={16}
                height={16}
                style={{ imageRendering: "pixelated" }}
              />
            ),
            onClick: () =>
              dispatch({
                type: "START_EVOLUTION",
                payload: { partyIndex: idx, toSpeciesKey: levelEvo.into },
              }),
          }]
        : []),
      // The branches this individual is NOT on, with what each would need.
      // Inert rows sitting directly under the Evolve entry they qualify —
      // they exist so a three-way split is legible at the surface where
      // the evolution is actually triggered, not only inside the detail
      // modal. Gated on `levelEvo` so they only ever annotate a pending
      // evolution, and empty for every non-branching line (all but one
      // species), so this adds no rows to anybody else's menu.
      ...(levelEvo
        ? branches
            .filter((b) => !b.met)
            .map((b) => ({
              label: `→ ${pokemonTable[b.into]?.name ?? b.into}`,
              hint: `${t("Needs")} ${b.requirement}`,
              disabled: true,
              onClick: () => {},
            }))
        : []),
      // A stone evolution costs an item, so it stays a separate entry
      // rather than being folded into the one above.
      ...(stoneEvo
        ? [{
            label: t("Evolve"),
            hint: getItemInfo(stoneEvo.item).name,
            icon: (
              <img
                src={itemSpriteUrl(stoneEvo.item, itemSpriteSlug(stoneEvo.item))}
                alt=""
                width={14}
                height={14}
                style={{ imageRendering: "pixelated" }}
              />
            ),
            onClick: () =>
              dispatch({
                type: "USE_STONE",
                payload: { itemId: stoneEvo.item, partyIndex: idx },
              }),
          }]
        : []),
      // The Everstone, directly under the evolution actions it governs.
      // Offered for every Pokémon that can evolve by level — including one
      // nowhere near the threshold, since deciding "not this one" BEFORE
      // it gets there is the whole point. Wording flips to the action the
      // entry performs so it can never be misread as a state label.
      ...(levelEvolutionTargets(p.speciesKey).length > 0
        ? [{
            label: locked ? t("Allow evolving") : t("Never evolve"),
            hint: locked ? t("Auto-evolve resumes") : t("Skips auto-evolve"),
            onClick: () =>
              dispatch({
                type: "SET_EVOLVE_LOCK",
                payload: { pokemonId: p.id, locked: !locked },
              }),
          }]
        : []),
      {
        label: t("View details"),
        // `pokemonId`, not just the frozen index: a menu that went stale used
        // to open the sheet on whoever had taken the slot.
        onClick: () => openPokemonDetail({ type: "party", index: idx, pokemonId: p.id }),
      },
      {
        label: t("Send out next"),
        disabled: isFront || p.currentHp <= 0,
        onClick: () =>
          dispatch({ type: "REORDER_PARTY", payload: { from: idx, to: 0 } }),
      },
      {
        label: t("Move to PC"),
        disabled: partySize <= 1,
        onClick: () =>
          dispatch({ type: "PARTY_TO_BOX", payload: { partyIndex: idx } }),
      },
      {
        label: t("Release"),
        danger: true,
        // Every reducer guard, not just the party-size one, and the hint
        // says WHICH — a greyed row with no reason reads as a bug.
        disabled: !!releaseBlocked,
        hint: releaseBlocked ? t(releaseBlocked) : undefined,
        onClick: () => {
          // Decided against the state as it is NOW. This menu froze `idx` and
          // every guard it checked when it opened; decideRelease looks the
          // subject up by id, re-runs those guards live, and only then asks —
          // so a menu left open while the mon was deposited or fainted no
          // longer takes a "yes" for a deletion the reducer then refuses.
          const d = decideRelease(p.id, "party", live?.current ?? state);
          if (d.act === "skip") { pushToast({ kind: "warn", text: t(d.note) }); return; }
          if (d.act !== "release") return;
          // See the reducer case: this menu froze `idx` when it opened, so
          // the id is what actually addresses the Pokémon.
          dispatch({
            type: "RELEASE_POKEMON",
            payload: { source: "party", index: idx, pokemonId: p.id },
          });
        },
      },
    ]);
  };

  return (
    <li
      ref={ref}
      className={[
        "party-row",
        active ? "active" : "",
        p.currentHp <= 0 ? "fainted" : "",
        evoReady ? "evo-ready" : "",
      ].filter(Boolean).join(" ")}
      // Keyboard and screen-reader reachability. The row was a bare <li> with
      // a click handler: no tabindex, no name, no role — so the detail modal,
      // the actions menu and therefore Release had NO keyboard route at all.
      //
      // role="button", not the implicit listitem. Focusable and named was not
      // enough: a screen reader announced "list item", which says nothing about
      // Enter opening the sheet where Release lives, so the destructive action
      // stayed undiscoverable for exactly the users who cannot see the row
      // highlight. The element itself is unchanged — it is still the <li> the
      // drag controller attaches to — and the parent <ul> becomes a named
      // group to match. aria-haspopup says what activating it does.
      role="button"
      aria-haspopup="dialog"
      tabIndex={0}
      // The name carries what the flattened row content no longer announces
      // individually, status included.
      aria-label={`${displayName(p)} · ${t("Lv")}${p.level} · ${p.currentHp}/${p.maxHp} ${t("HP")}${
        p.status ? ` · ${t(STATUS_ABBREV[p.status])}` : ""
      }${p.currentHp <= 0 ? ` · ${t("fainted")}` : ""}${active ? ` · ${t("active")}` : ""}`}
      onClick={() => {
        // The drag controller suppresses click propagation if a real
        // drag fired — so a click here means "tap, no drag", which
        // should open the detail modal.
        openPokemonDetail({ type: "party", index: idx, pokemonId: p.id });
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openPokemonDetail({ type: "party", index: idx, pokemonId: p.id });
          return;
        }
        // The keyboard's own context-menu gesture. Same menu, same items,
        // opened at the row so it appears where the focus already is.
        if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          openRowMenu({ clientX: r.left + 12, clientY: r.bottom - 8 });
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        openRowMenu(e);
      }}
      title={t("Tap for details · hold-and-drag to reorder · right-click (or the menu key) for actions")}
    >
      <div className="party-row-sprite">
        <PokemonSprite
          speciesKey={p.speciesKey}
          isShiny={p.isShiny}
          alt={displayName(p)}
          width={48}
          height={48}
          style={{ imageRendering: "pixelated" }}
          draggable={false}
        />
        {/* The lock has to be visible on the row itself: it is a silent,
            indefinite behaviour change, and a player who set it weeks ago (or
            on another device) needs to be able to see WHY this is the one
            party member that never evolves. Pinned to the sprite's top-left so
            it doesn't fight the held-item pip at the bottom-right, and outside
            the name grid so it can't disturb the name/type/level columns. */}
        {locked && (
          <span
            className="party-row-evolock"
            title={t("Never evolve — auto-evolve skips this Pokémon. Right-click the row to allow it again.")}
            aria-label={t("Never evolve")}
          >
            🚫
          </span>
        )}
        {p.heldItem && itemsCatalog[p.heldItem] && (
          <img
            className="held-item-badge"
            src={itemSpriteUrl(p.heldItem, itemSpriteSlug(p.heldItem))}
            alt=""
            title={itemsCatalog[p.heldItem]?.name ?? p.heldItem}
            width={20}
            height={20}
            draggable={false}
          />
        )}
      </div>
      <div className="party-row-info">
        <div className="party-row-name">
          <strong>{displayName(p)}{p.isShiny ? " ✨" : ""}</strong>
          <span className="party-row-types">
            {sp?.types.map((t) => (
              <span key={t} className={`party-type-chip type-${t.toLowerCase()}`}>{t}</span>
            ))}
          </span>
          <span className="party-row-level">{t("Lv")}{p.level}</span>
        </div>
        <div className="party-bar-wrap">
          <span className="party-bar-label">{t("HP")}</span>
          <div className={`party-bar hp ${hpClass}`}>
            <div className="party-bar-fill" style={{ width: `${hpPct}%` }} />
          </div>
          <span className="party-bar-num">{p.currentHp}/{p.maxHp}</span>
        </div>
        <div className="party-bar-wrap">
          <span className="party-bar-label">{t("EXP")}</span>
          <div className="party-bar exp">
            <div
              className="party-bar-fill"
              style={{ width: `${expPct}%` }}
              title={`${expIntoLevel} / ${expSpan} exp to next level`}
            />
          </div>
          {p.status && (
            <span
              className={`party-status-badge hp-status-badge ${statusBadgeClass(p.status)}`}
              title={p.status}
            >
              {STATUS_ABBREV[p.status]}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}
