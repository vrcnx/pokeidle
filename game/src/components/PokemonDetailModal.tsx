import { useEffect, useMemo, useState } from "react";
import type { Pokemon, EvolutionTrigger, PokemonType } from "../types";
import { useGame } from "../state/GameContext";
import { pokemonTable } from "../data/pokemon";
import { moves as movesTable } from "../data/moves";
import { evolutions } from "../data/evolutions";
import { evolutionStones } from "../data/evolutionStones";
import {
  describeStatCondition,
  evolutionLocked,
  levelEvolutionBranches,
  levelEvolutionTargets,
  statConditionMet,
} from "../utils/evolution";
import { findNature } from "../data/natures";
import { abilityInfo } from "../data/abilities";
import { itemsCatalog } from "../data/itemsCatalog";
import { itemSpriteUrl } from "../utils/sprites";
import { PokemonSprite } from "./Sprite";
import { expForLevel } from "../utils/stats";
import { displayName } from "../utils/pokemon";
import { resolveAnchoredIndex } from "../utils/pokemonAnchor";
import { duplicateIdSet, releaseBlockedReason, releaseConfirmMessage } from "../utils/releaseConfirm";
import { NICKNAME_MAX_LENGTH, normalizeNickname } from "../utils/nickname";
import { useModalEnter } from "../utils/animate";
import { openManageMoves } from "./ManageMovesModal";
import { useDragAndDrop } from "../hooks/useDrag";
import { useT } from "../i18n/useT";
import { IconEdit } from "./Icon";
import { genderSymbol } from "../data/gender";
import { openHeldItemPicker } from "./UseItemModal";
import "./releaseControls.css";

// Stat keys for Silver Bottle Cap hyper-training buttons.
const HYPER_STATS: { key: "hp" | "attack" | "defense" | "spAttack" | "spDefense" | "speed"; label: string }[] = [
  { key: "hp", label: "HP" },
  { key: "attack", label: "Attack" },
  { key: "defense", label: "Defense" },
  { key: "spAttack", label: "Sp. Atk" },
  { key: "spDefense", label: "Sp. Def" },
  { key: "speed", label: "Speed" },
];

// Held item row + assignment popover. Lets the player give/take a held
// item from the open Pokémon. The picker filters the player's inventory
// to held-category items with implemented effects.
function HeldItemRow({ pokemon }: { pokemon: Pokemon }) {
  const t = useT();
  const heldId = pokemon.heldItem;
  const heldDef = heldId ? itemsCatalog[heldId] : null;

  // One button, opening a real dialog. What was here was a picker that
  // expanded INSIDE this sheet, pushing the stats down, with no description
  // and no count — and when the bag held none of them, a full-width bar
  // reading "No held items in bag." where the control used to be. That was
  // the only route to a held item, so an empty bag left the player looking
  // at an error message with nothing to do about it.
  return (
    <div className="detail-held">
      <span className="dim">{t("Held:")}</span>{" "}
      {heldDef ? (
        <>
          <img
            className="detail-held-icon"
            src={itemSpriteUrl(heldDef.id, heldDef.spriteOverride)}
            alt=""
            width={20}
            height={20}
            style={{ imageRendering: "pixelated" }}
          />
          <span className="detail-held-name" title={heldDef.description}>
            {heldDef.name}
          </span>
          <button className="detail-held-btn" onClick={() => openHeldItemPicker(pokemon.id)}>
            {t("Change")}
          </button>
        </>
      ) : (
        <button className="detail-held-btn" onClick={() => openHeldItemPicker(pokemon.id)}>
          {t("Give item…")}
        </button>
      )}
    </div>
  );
}

// Type colors — kept in sync with MovesPanel so move tiles look uniform.
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

// Tiny event-bus so any component can open the detail modal. View-state
// only, kept out of the global reducer.
//
// `pokemonId` is the anchor and `index` is only a hint. The modal used to hold
// an index alone, and it re-read `state.box[index]` on every render — so an
// auction settling or a cloud reconcile landing while the sheet was OPEN slid a
// different Pokémon into the slot and silently re-aimed the header, the sprite,
// the stats and every button in the footer at it, including Release. See
// resolveAnchoredIndex. Optional so an index-only caller is unchanged.
type Source =
  | { type: "party"; index: number; pokemonId?: string }
  | { type: "box"; index: number; pokemonId?: string };
let _selected: Source | null = null;
const _listeners = new Set<(s: Source | null) => void>();

// ── Who draws the sheet ─────────────────────────────────────────────
// Normally the global mount in GameShell does. But when the hub's PC
// section is open, the sheet belongs INSIDE that dialog — a full-screen
// overlay on top of the PC is a second window covering the thing you were
// looking at, when what a player wants is to look at one Pokémon without
// losing the box and the party around it.
//
// So the PC mounts its own copy with `inline`, and that copy CLAIMS the
// sheet: while a claim is live, the global mount renders nothing. A count
// rather than a boolean, so a mount/unmount pair that overlaps during a
// section change cannot leave the flag stuck on and the sheet unreachable
// from everywhere else in the game.
let _hosts = 0;
const _hostListeners = new Set<(n: number) => void>();
function publishHosts() { for (const fn of _hostListeners) fn(_hosts); }
function useHosted(): boolean {
  const [n, set] = useState(_hosts);
  useEffect(() => {
    _hostListeners.add(set);
    set(_hosts);
    return () => { _hostListeners.delete(set); };
  }, []);
  return n > 0;
}

export function openPokemonDetail(s: Source) {
  _selected = s;
  _listeners.forEach((l) => l(s));
}
export function closePokemonDetail() {
  _selected = null;
  _listeners.forEach((l) => l(null));
}
function useSelected(): Source | null {
  const [s, setS] = useState<Source | null>(_selected);
  useEffect(() => {
    _listeners.add(setS);
    return () => { _listeners.delete(setS); };
  }, []);
  return s;
}

/**
 * @param inline Draw the sheet in place, inside whatever container mounts
 *   it, instead of as a full-screen overlay. Used by the hub's PC section.
 */
export function PokemonDetailModal({ inline = false }: { inline?: boolean } = {}) {
  const { state, dispatch } = useGame();
  const selected = useSelected();
  const hosted = useHosted();

  // An inline mount claims the sheet for as long as it exists — not only
  // while something is selected, or the global overlay would flash up for
  // the frame between a click and this component's effect running.
  useEffect(() => {
    if (!inline) return;
    _hosts++; publishHosts();
    return () => {
      _hosts--; publishHosts();
      // Close the sheet as the host goes away. Without this, switching from
      // the PC to any other hub section unmounted the inline copy, released
      // the claim, and the GLOBAL mount immediately rendered the same
      // selection as a full-screen overlay — so the sheet you were reading
      // inside the PC reappeared on top of the section you had just opened,
      // and would not go away.
      //
      // Closing is the honest behaviour and not just the fix that works:
      // this sheet is a child action of the PC pane, and leaving the pane is
      // leaving the thing it was showing you.
      closePokemonDetail();
    };
  }, [inline]);

  // Escape closes the modal — matches the rest of the modal surfaces
  // (PvP hub, replay, etc.). The hook always runs (no early return)
  // so React doesn't error out on the conditional.
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePokemonDetail();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  // The list this sheet is a view of. Computed before the early return so the
  // duplicate-id scan below is a hook that always runs; with no selection it
  // reads the box and nothing uses the answer.
  const list = selected?.type === "party" ? state.party : state.box;
  // Ids sharing a slot in `list`. Blocks Release rather than letting the
  // reducer's first-match re-anchor destroy a bystander — see duplicateIdSet.
  const duplicateIds = useMemo(() => duplicateIdSet(list), [list]);

  if (!selected) return null;
  // ANCHORED, not indexed. `index` is where the subject is right now; if it
  // left the list the sheet renders nothing rather than re-aiming at whoever
  // took the slot. Every index-addressed dispatch below uses this, not the
  // frozen `selected.index`.
  const index = resolveAnchoredIndex(list, selected);
  const p: Pokemon | undefined = index < 0 ? undefined : list[index];
  if (!p) return null;

  const sp = pokemonTable[p.speciesKey];
  const baseExp = expForLevel(p.level, sp.growthRate);
  const nextExp = expForLevel(p.level + 1, sp.growthRate);
  const expIntoLevel = p.totalExp - baseExp;
  const expSpan = Math.max(1, nextExp - baseExp);
  const expPct = Math.max(0, Math.min(100, (expIntoLevel / expSpan) * 100));

  const isActive =
    selected.type === "party" && state.activePlayerPokemonIndex === index;
  // Evolution is the one phase where we lock the modal — the animation is
  // already running and stacking another evolve dispatch breaks the queue.
  // Other phases (battle, healing, idle) all permit menu actions; the
  // reducer bails out of any active battle automatically.
  const blocking = state.phase === "evolution" || state.phase === "starterSelect" || state.phase === "regionStarterSelect";
  const inBattle = blocking;

  // Hyper Training (Bottle Caps). Gold perfects every IV; Silver maxes one
  // stat. Applied Pokémon-first from here — the modal already knows the exact
  // party/box slot, and Silver's stat pick is natural next to the stat list.
  const goldCaps = state.inventory.goldbottlecap ?? 0;
  const silverCaps = state.inventory.silverbottlecap ?? 0;
  const ivs = p.ivs ?? { hp: 0, attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0 };
  const perfectIVs =
    ivs.hp >= 31 && ivs.attack >= 31 && ivs.defense >= 31 &&
    ivs.spAttack >= 31 && ivs.spDefense >= 31 && ivs.speed >= 31;
  // EV berries: one per stat, each -10 EVs. Only offered for stats the mon
  // actually HAS EVs in, so the row can't be a dead end.
  const EV_BERRIES: { id: string; stat: keyof typeof ivs; label: string }[] = [
    { id: "pomegberry", stat: "hp", label: "HP" },
    { id: "kelpsyberry", stat: "attack", label: "Attack" },
    { id: "qualotberry", stat: "defense", label: "Defense" },
    { id: "hondewberry", stat: "spAttack", label: "Sp. Atk" },
    { id: "grepaberry", stat: "spDefense", label: "Sp. Def" },
    { id: "tamatoberry", stat: "speed", label: "Speed" },
  ];
  const monEvs = p.evs ?? { hp: 0, attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0 };
  function useEvBerry(itemId: string) {
    dispatch({ type: "USE_EV_BERRY", payload: { itemId, source: selected!.type, index } });
  }

  function hyperTrain(kind: "gold" | "silver", stat?: keyof typeof ivs) {
    dispatch({
      type: "USE_BOTTLE_CAP",
      payload: {
        itemId: kind === "gold" ? "goldbottlecap" : "silverbottlecap",
        source: selected!.type,
        index,
        stat,
      },
    });
    closePokemonDetail();
  }

  // All evolution paths for this species, with eligibility flag. We show
  // every possible evolution (greyed out when not eligible) so the player
  // knows what to aim for.
  type EvoOption = { trigger: EvolutionTrigger; reason: string; eligible: boolean };
  const allEvolutions: EvoOption[] = [];
  for (const t of evolutions[p.speciesKey] ?? []) {
    if ("level" in t) {
      // A branching line (Tyrogue) lists every sibling here. Show the live
      // stat comparison on each one — that is the whole difference between
      // "this Pokémon becomes a Hitmonchan" and an unexplained grey button —
      // and only mark the branch this individual qualifies for as eligible.
      const levelOk = p.level >= t.level;
      const statOk = statConditionMet(p, t.when);
      const eligible = levelOk && statOk;
      const condition = t.when ? describeStatCondition(p, t.when) : null;
      let reason: string;
      if (!levelOk) {
        reason = condition ? `Reach Lv ${t.level} · ${condition}` : `Reach Lv ${t.level}`;
      } else if (condition) {
        reason = eligible ? `Level ${t.level} · ${condition}` : `Needs ${condition}`;
      } else {
        reason = `Level ${t.level} reached`;
      }
      allEvolutions.push({ trigger: t, reason, eligible });
    } else if ("trade" in t) {
      // Trade evolutions: eligible automatically after a peer-to-peer
      // trade OR by using a Link Cable bought at Celadon Dept. Store.
      // For trade+item variants the catalyst (Metal Coat, etc.) must
      // be HELD by the Pokémon — the Link Cable consumes it on use,
      // matching the live trade flow.
      const requiredItem = "item" in t ? (t as any).item as string : null;
      const requiredItemName = requiredItem
        ? (itemsCatalog[requiredItem]?.name ?? requiredItem)
        : null;
      const haveCable = (state.inventory.linkcable ?? 0) > 0;
      const haveCatalyst = !requiredItem || p.heldItem === requiredItem;
      const eligible = haveCable && haveCatalyst;
      let reason: string;
      if (eligible) {
        reason = requiredItemName
          ? `Use Link Cable (consumes ${requiredItemName})`
          : "Use Link Cable";
      } else if (!haveCable && !haveCatalyst) {
        reason = `Trade or use a Link Cable while holding ${requiredItemName}`;
      } else if (!haveCable) {
        reason = "Trade or use a Link Cable";
      } else {
        // Have cable, missing the held catalyst.
        reason = `Equip ${requiredItemName} to use Link Cable`;
      }
      allEvolutions.push({ trigger: t, reason, eligible });
    } else if ("item" in t) {
      const owned = state.inventory[t.item] ?? 0;
      const eligible = owned > 0;
      const itemName = evolutionStones[t.item]?.name ?? t.item;
      allEvolutions.push({
        trigger: t,
        reason: eligible ? `Use ${itemName}` : `Needs ${itemName}`,
        eligible,
      });
    }
  }
  const isPartySelection = selected.type === "party";

  // Why RELEASE_POKEMON would refuse this one, if it would. The modal used to
  // offer Release unconditionally: on an auction-listed Pokémon it asked "this
  // cannot be undone", took the confirmation, and then nothing happened,
  // because the reducer refuses a listed mon. Same for the last party member
  // and the last HEALTHY party member. Confirming a permanent deletion and
  // watching nothing happen is its own kind of broken.
  const releaseBlocked = releaseBlockedReason(p, selected.type, {
    listedPokemonIds: state.listedPokemonIds ?? [],
    party: state.party,
    duplicateIds,
  });

  // The evolve lock is only meaningful for a species that has a LEVEL
  // evolution — it gates automatic evolving, and nothing is ever automated for
  // a stone or a Link Cable. Offering it on a Pidgeot would be a switch that
  // does nothing.
  const hasLevelEvolution = levelEvolutionTargets(p.speciesKey).length > 0;
  const evolveLocked = evolutionLocked(p);
  // Empty except for a species whose level evolution genuinely splits.
  const branches = levelEvolutionBranches(p);

  function evolveTo(trigger: EvolutionTrigger) {
    if (!selected || !isPartySelection) return;
    // Trade evolutions go through USE_LINK_CABLE — the reducer handles
    // consuming the cable, stripping the held catalyst (for trade+item
    // variants), and starting the evolution flow atomically.
    if ("trade" in trigger) {
      dispatch({ type: "USE_LINK_CABLE", payload: { partyIndex: index } });
      closePokemonDetail();
      return;
    }
    // Stone-style item evolution goes through USE_STONE — the reducer
    // validates the match, consumes exactly one stone, and starts the
    // evolution atomically (no free-evolve if the stone count is 0), the
    // same path the Bag's item-first flow uses.
    if ("item" in trigger) {
      dispatch({ type: "USE_STONE", payload: { itemId: trigger.item, partyIndex: index } });
      closePokemonDetail();
      return;
    }
    dispatch({
      type: "START_EVOLUTION",
      payload: { partyIndex: index, toSpeciesKey: trigger.into },
    });
    closePokemonDetail();
  }

  // The global mount stands down while an inline host is up. Placed with the
  // other early returns rather than at the top of the function so every hook
  // above still runs unconditionally.
  if (!inline && hosted) return null;

  // ONE dialog, two frames. Built here and wrapped below, rather than
  // written out twice: this call passes thirty props and half of them are
  // closures over `index`, so a second copy would be a second set of them
  // to keep in step.
  const sheet = (
    <PokemonDetailDialog
        pokemon={p}
        species={sp}
        isActive={isActive}
        inBattle={inBattle}
        isPartySelection={isPartySelection}
        allEvolutions={allEvolutions}
        evolveTo={evolveTo}
        hasLevelEvolution={hasLevelEvolution}
        evolveLocked={evolveLocked}
        autoEvolve={state.autoEvolve}
        branches={branches}
        onToggleEvolveLock={() =>
          dispatch({
            type: "SET_EVOLVE_LOCK",
            payload: { pokemonId: p.id, locked: !evolveLocked },
          })
        }
        // The RESOLVED position, not the frozen one the sheet was opened with.
        // The dialog reads `.type`, and hands `.index` to openManageMoves.
        selected={{ type: selected.type, index }}
        evBerries={EV_BERRIES.map((b) => ({ ...b, owned: state.inventory[b.id] ?? 0, ev: (monEvs as unknown as Record<string, number>)[b.stat] ?? 0 }))}
        useEvBerry={useEvBerry}
        goldCaps={goldCaps}
        silverCaps={silverCaps}
        perfectIVs={perfectIVs}
        hyperTrain={hyperTrain}
        partySize={state.party.length}
        party={state.party}
        expIntoLevel={expIntoLevel}
        expSpan={expSpan}
        expPct={expPct}
        // Reordering the four moves in place — see DetailMoveRow.
        onReorderMoves={(moveIds: string[]) =>
          dispatch({ type: "SET_MOVES", payload: { pokemonId: p.id, moveIds } })
        }
        onSwitch={() => {
          dispatch({
            type: "SWITCH_PLAYER_POKEMON",
            payload: { partyIndex: index },
          });
          closePokemonDetail();
        }}
        onPartyToBox={() => {
          dispatch({ type: "PARTY_TO_BOX", payload: { partyIndex: index } });
          closePokemonDetail();
        }}
        onBoxToParty={() => {
          dispatch({ type: "BOX_TO_PARTY", payload: { boxIndex: index } });
          closePokemonDetail();
        }}
        onSwapWithParty={(partyIndex: number) => {
          dispatch({
            type: "SWAP_PARTY_BOX",
            payload: { partyIndex, boxIndex: index },
          });
          closePokemonDetail();
        }}
        releaseBlocked={releaseBlocked}
        skipReleaseConfirm={state.skipReleaseConfirm}
        onRelease={(pokemonId: string) => {
          // The inline strip above the footer IS the confirmation on this
          // surface, and it is unconditional — so the modal now asks in
          // strictly MORE cases than the window.confirm it replaces did. A
          // shiny still always asks; with "skip confirmation" on, everything
          // else asks too, just in the short form. needsReleaseConfirm still
          // governs the two context menus and still decides the wording (see
          // releaseConfirmMessage). Nothing about it was loosened.
          //
          // Both guards re-checked HERE, at the moment of the dispatch: an
          // auction settling or a cloud reconcile can land between arming the
          // strip and pressing it.
          if (releaseBlocked) return;
          if (pokemonId !== p.id) return;
          // `selected` lives in a module-level store and outlives any number
          // of box mutations; `p.id` is what the player is actually looking
          // at. See the reducer case.
          dispatch({
            type: "RELEASE_POKEMON",
            payload: { source: selected.type, index, pokemonId },
          });
          closePokemonDetail();
        }}
      />
  );

  // Inline: no overlay and no click-to-close backdrop. This panel sits
  // inside a dialog that already has both, and a second scrim over the
  // first would dim the PC twice.
  if (inline) {
    return <div className="hub-detail" role="region" aria-label="Pokémon">{sheet}</div>;
  }

  return (
    // pokemon-detail-overlay carries a z-index above the other modal
    // overlays. Every .modal-overlay in the app sits at z-index 100, so which
    // one wins is decided by DOM order — and this sheet is mounted BEFORE the
    // hub in GameShell, which meant opening a Pokemon's details from the hub's
    // PC pane drew the sheet underneath the hub. It is not a peer of the
    // surface that opened it; it is a child action of one, so it belongs on
    // top of whatever that was. See releaseControls.css for the value and why
    // it stops short of the context menu.
    <div className="modal-overlay pokemon-detail-overlay" onClick={closePokemonDetail}>
      {sheet}
    </div>
  );
}

// Inner dialog renders inside the .g-modal shell. Split from the parent
// so `useModalEnter` only runs when the dialog is actually mounted.
function PokemonDetailDialog({
  pokemon: p,
  species: sp,
  isActive,
  inBattle,
  isPartySelection,
  allEvolutions,
  evolveTo,
  hasLevelEvolution,
  evolveLocked,
  autoEvolve,
  branches,
  onToggleEvolveLock,
  selected,
  evBerries,
  useEvBerry,
  goldCaps,
  silverCaps,
  perfectIVs,
  hyperTrain,
  partySize,
  party,
  expIntoLevel,
  expSpan,
  expPct,
  onSwitch,
  onReorderMoves,
  onPartyToBox,
  onBoxToParty,
  onSwapWithParty,
  onRelease,
  releaseBlocked,
  skipReleaseConfirm,
}: any) {
  const dialogRef = useModalEnter(".g-profile-hero, .g-card");
  const t = useT();
  // Release is two deliberate presses, always. This modal is where a player
  // who tapped a Pokémon expecting to act on it lands — which is exactly why
  // it is the discoverable place to put Release, and exactly why a single tap
  // on a button sitting next to "Close" must not be able to destroy anything.
  //
  // Armed by POKÉMON ID, not by a boolean: the modal addresses its subject by
  // index, so an auction settling or a cloud reconcile can slide a different
  // Pokémon into the slot while the strip is open. Binding to the id makes the
  // strip disappear by itself if that happens, instead of re-aiming.
  const [armedId, setArmedId] = useState<string | null>(null);
  const armed = armedId !== null && armedId === p.id;
  useEffect(() => { setArmedId(null); }, [p.id]);
  // Box → Party swap picker. Opens an inline list of party slots so the
  // player can pick which mon to swap out without leaving the detail
  // sheet. Especially useful on mobile where drag-and-drop swaps are
  // awkward and PARTY-IS-FULL would otherwise block "→ Party" outright.
  const [swapPicking, setSwapPicking] = useState(false);
  return (
    <div
      ref={dialogRef}
      className="g-modal pokemon-detail-v2"
      onClick={(e) => e.stopPropagation()}
      role="dialog"
      aria-label={displayName(p)}
    >
      {/* A TITLE, not the rename control.
          It used to be <NicknameField/> — the Pokemon's name and level, which
          you renamed by clicking, with nothing saying so. Two problems in one
          element: the name and level are already on the line directly below,
          so the header was repeating them, and the only affordance the rename
          had was knowing it was there. Player report: found it in the patch
          notes, then had to guess which of the two names was the button.
          The rename lives beside the name in the hero now, as a button. */}
      <header className="g-modal-head">
        <h2>{t("Pokémon")}</h2>
        <button className="g-modal-close" onClick={closePokemonDetail} aria-label={t("Close")}>×</button>
      </header>

      <div className="g-modal-body">
        <section className="g-profile-hero">
          <PokemonSprite
            className="g-pokemon-sprite-hero"
            speciesKey={p.speciesKey}
            isShiny={p.isShiny}
            alt={displayName(p)}
            width={64}
            height={64}
            style={{ imageRendering: "pixelated" }}
          />
          <div className="g-profile-info">
            {/* Name over species — the layout was always built for a nickname
                (that is what the second, dimmer line is for), but the first
                line read `p.name`, which IS the species name. Unnamed mons
                printed "Bulbasaur / Bulbasaur" and renamed ones hid the
                nickname the player had just typed one header above. */}
            <div className="g-profile-name">
              <NicknameField pokemon={p} />
              <span className="g-profile-species">{sp.name}</span>
            </div>
            <div className="dex-species-types">
              {sp.types.map((t: PokemonType) => (
                <span key={t} className="dex-species-type" style={{ background: TYPE_COLOR[t] }}>{t}</span>
              ))}
            </div>
          </div>
          <div className="g-profile-stats">
            <div className="g-stat-pill"><strong>{p.level}</strong><span>{t("Level")}</span></div>
            <div className="g-stat-pill"><strong>{p.currentHp}/{p.maxHp}</strong><span>{t("HP")}</span></div>
            <div className="g-stat-pill"><strong>{Math.round(expPct)}%</strong><span>{t("EXP")}</span></div>
          </div>
        </section>

        <section className="g-card g-card-full pokemon-meta-card">
          <div className="pokemon-meta-row">
            {p.nature && (
              <div className="pokemon-meta-item">
                <span className="dim">{t("Nature")}</span>
                <strong>{p.nature}</strong>
              </div>
            )}
            {p.ability && abilityInfo[p.ability] && (
              <div className="pokemon-meta-item" title={abilityInfo[p.ability].description}>
                <span className="dim">{t("Ability")}</span>
                <strong>{abilityInfo[p.ability].name}</strong>
              </div>
            )}
            <div className="pokemon-meta-item pokemon-meta-held">
              <HeldItemRow pokemon={p} />
            </div>
          </div>
          <div className="pokemon-exp-row">
            <span className="dim small">{t("EXP to next")}</span>
            <div className="exp-bar">
              <div className="exp-fill" style={{ width: `${expPct}%` }} />
            </div>
            <small className="dim">{expIntoLevel} / {expSpan}</small>
          </div>
        </section>

        {allEvolutions.length > 0 && (
          /* Hoisted above the stats grid and given the same blue treatment as
             a ready-to-evolve party row. Evolving is the most consequential
             thing you can do from this screen and it used to sit last, below
             stats and the whole move list. */
          <section className={`g-card g-card-full detail-evo-card${allEvolutions.some((e: any) => e.eligible) ? " ready" : ""}`}>
            <h3>
              {t("Evolution")}
              {allEvolutions.some((e: any) => e.eligible) && (
                <span className="detail-evo-ready-pill">{t("Ready")}</span>
              )}
            </h3>
            <ul className="detail-evos">
              {allEvolutions.map((e: any) => {
                const target = pokemonTable[e.trigger.into];
                return (
                  <li key={e.trigger.into} className={e.eligible ? "" : "evo-locked"}>
                    <PokemonSprite
                      speciesKey={e.trigger.into}
                      isShiny={p.isShiny}
                      alt={target?.name ?? e.trigger.into}
                      width={40}
                      height={40}
                      style={{
                        imageRendering: "pixelated",
                        filter: e.eligible ? "none" : "grayscale(1) brightness(0.6)",
                      }}
                    />
                    <div>
                      <strong>→ {target?.name ?? e.trigger.into}</strong>
                      <small className="dim">{e.reason}</small>
                    </div>
                    <button
                      disabled={!isPartySelection || inBattle || !e.eligible}
                      title={
                        !e.eligible ? e.reason :
                        !isPartySelection ? t("Move to party first") :
                        undefined
                      }
                      onClick={() => e.eligible && evolveTo(e.trigger)}
                    >
                      {t("Evolve")}
                    </button>
                  </li>
                );
              })}
            </ul>
            {!isPartySelection && allEvolutions.some((e: any) => e.eligible) && (
              <p className="g-help">{t("Move this Pokémon to your party to evolve it.")}</p>
            )}

            {/* A split line decides itself from the live stats at the instant
                it evolves — and with auto-evolve on, that instant is the
                moment the level threshold is crossed. Say so here, next to the
                comparison, so the outcome never reads as a coin flip. EV
                berries and EV training are the levers that move it. */}
            {branches.length > 0 && (
              <p className="g-help">
                {autoEvolve && !evolveLocked
                  ? t("This line splits. The branch is decided by this Pokémon's own stats at the moment it evolves — which, with auto-evolve on, is as soon as it reaches the level. Train or lower the stats above to change which one it takes, or set “Never evolve” below to hold it here.")
                  : t("This line splits. The branch is decided by this Pokémon's own stats at the moment it evolves. Train or lower the stats above to change which one it takes.")}
              </p>
            )}

            {/* Per-Pokémon opt-out — this game's Everstone. Only shown for a
                species that can actually evolve by level, since that is the
                only path anything is automated on. */}
            {hasLevelEvolution && (
              <div className="detail-evolock">
                <div className="detail-evolock-text">
                  <strong>{t("Never evolve")}</strong>
                  <small className="dim">
                    {evolveLocked
                      ? t("Auto-evolve skips this Pokémon. You can still evolve it yourself with the button above.")
                      : autoEvolve
                        ? t("Off — this Pokémon evolves on its own when it reaches the level.")
                        : t("Off — but auto-evolve is turned off in Settings, so nothing evolves on its own.")}
                  </small>
                </div>
                <button
                  className={evolveLocked ? "g-btn-primary g-btn-small" : "g-btn-ghost g-btn-small"}
                  aria-pressed={evolveLocked}
                  onClick={onToggleEvolveLock}
                >
                  {evolveLocked ? t("Allow evolving") : t("Never evolve")}
                </button>
              </div>
            )}
          </section>
        )}

        <div className="g-grid">
          {/* LEFT COLUMN as a real stack.
              Grid placement was tried first and could not work: the meta
              card above is full-width and occupies row 1, so pinning the EV
              radar to `grid-row: 1` collided with it and the rule never
              applied. A nested stack does not care what the grid is doing —
              Stats keeps its own height and Moves sits directly beneath it,
              which is the whole ask. */}
          <div className="detail-col">
          <section className="g-card">
            <h3>{t("Stats")}</h3>
            <ul className="detail-stats">
              <StatRow label={t("HP")} value={p.maxHp} pokemon={p} stat="hp" />
              <StatRow label={t("Attack")} value={p.attack} pokemon={p} stat="attack" />
              <StatRow label={t("Defense")} value={p.defense} pokemon={p} stat="defense" />
              <StatRow label={t("Sp. Atk")} value={p.spAttack} pokemon={p} stat="spAttack" />
              <StatRow label={t("Sp. Def")} value={p.spDefense} pokemon={p} stat="spDefense" />
              <StatRow label={t("Speed")} value={p.speed} pokemon={p} stat="speed" />
            </ul>
          </section>
          <section className="g-card detail-moves-card">
            <div className="detail-moves-header">
              <h3>{t("Moves")}</h3>
              {selected.type === "party" && !inBattle && (
                <button
                  className="g-btn-ghost g-btn-small"
                  // Does NOT close this sheet any more. It used to, so adding a
                  // move dropped you back to the game and you had to find the
                  // Pokemon again to see the result. The manager stacks above
                  // instead, and closing it returns you here.
                  onClick={() => openManageMoves({ type: "party", index: selected.index })}
                  title={t("Open the move manager for this Pokémon")}
                >
                  {t("Manage moves")}
                </button>
              )}
            </div>
            {/* Reorderable in place. This list was read-only, so changing the
                order of the four moves you are already looking at meant closing
                this sheet, opening the move manager, dragging there, and coming
                back. Adding a move still opens the manager — that needs the
                whole learnable pool, which does not belong in a summary — but
                ORDER is a property of these four, and it belongs here.

                Party only: a boxed Pokemon has no active move order to change,
                and neither has one mid-battle. */}
            <ul className="detail-moves">
              {p.moves.map((m: any, i: number) => {
                const def = movesTable[m.id];
                const color = def ? TYPE_COLOR[def.type] : "#666";
                const icon = def ? CATEGORY_ICON[def.category] ?? "✴" : "✴";
                return (
                  <DetailMoveRow
                    key={m.id}
                    moveId={m.id}
                    index={i}
                    draggable={selected.type === "party" && !inBattle}
                    tint={color}
                    onSwap={(from, to) => {
                      if (from === to) return;
                      const ids = p.moves.map((x: any) => x.id);
                      [ids[from], ids[to]] = [ids[to], ids[from]];
                      onReorderMoves(ids);
                    }}
                  >
                    <strong>
                      <span style={{ marginRight: 4, opacity: 0.85 }}>{icon}</span>
                      {def?.name ?? m.id}
                    </strong>
                    <small>
                      Pwr {def?.power || "—"} · Acc {def?.accuracy}% · {def?.type ?? "—"}
                    </small>
                  </DetailMoveRow>
                );
              })}
            </ul>
          </section>
          </div>

          <section className="g-card ev-training-card">
            <h3>{t("EV training")}</h3>
            {/* The radar alone showed a number with no story attached, and the
                only EV CONTROL in this modal is the berry row below, which
                subtracts. Players reasonably concluded EVs never rise (three
                separate reports). They always did — every defeat and every
                catch trains the active Pokémon. Saying so here is the other
                half of the battle-log line: the log proves it moves, this
                explains where it comes from and why it eventually stops. */}
            <p className="dim small" style={{ margin: "0 0 8px" }}>
              {t("EVs rise every time this Pokémon defeats or catches another — how much, and in which stat, depends on the species beaten. Caps: 252 per stat, 510 in total.")}
            </p>
            <EvRadar evs={p.evs ?? { hp: 0, attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0 }} ivs={p.ivs} />
          </section>
        </div>

        {evBerries.some((b: any) => b.owned > 0 && b.ev > 0) && (
          <section className="g-card g-card-full">
            <h3>{t("Lower EVs")}</h3>
            <p className="dim small" style={{ margin: "0 0 6px" }}>
              {t("Each berry removes 10 EVs from one stat.")}
            </p>
            <div className="hyper-train-stats">
              {evBerries.filter((b: any) => b.owned > 0 && b.ev > 0).map((b: any) => (
                <button
                  key={b.id}
                  className="g-btn-ghost g-btn-small"
                  disabled={inBattle}
                  onClick={() => useEvBerry(b.id)}
                >
                  {t(b.label)} <span className="dim">{b.ev} EV · ×{b.owned}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {(goldCaps > 0 || silverCaps > 0) && (
          <section className="g-card g-card-full hyper-train-card">
            <h3>{t("Hyper Training")}</h3>
            {perfectIVs ? (
              <p className="dim small">{t("This Pokémon already has perfect IVs.")} 🎉</p>
            ) : (
              <>
                {goldCaps > 0 && (
                  <button
                    className="g-btn-primary g-btn-small hyper-train-gold"
                    disabled={inBattle}
                    onClick={() => hyperTrain("gold")}
                  >
                    ⭐ {t("Perfect all IVs")}{" "}
                    <span className="dim">— {t("Gold Bottle Cap")} ×{goldCaps}</span>
                  </button>
                )}
                {silverCaps > 0 && (
                  <div className="hyper-train-silver">
                    <p className="dim small">
                      {t("Silver Bottle Cap")} ×{silverCaps} — {t("max a single stat")}:
                    </p>
                    <div className="hyper-train-stats">
                      {HYPER_STATS.map(({ key, label }) => {
                        const iv = (p.ivs?.[key] as number) ?? 0;
                        const maxed = iv >= 31;
                        return (
                          <button
                            key={key}
                            className="g-btn-ghost g-btn-small"
                            disabled={inBattle || maxed}
                            title={maxed ? t("Already maxed") : ""}
                            onClick={() => hyperTrain("silver", key)}
                          >
                            {t(label)} <span className="dim">{iv}/31</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        )}



      </div>

      {swapPicking && (
        <div className="swap-picker-overlay">
          <div className="swap-picker">
            <header className="swap-picker-head">
              <strong>Swap {displayName(p)} with…</strong>
              <button className="g-modal-close" onClick={() => setSwapPicking(false)} aria-label={t("Cancel")}>×</button>
            </header>
            <ul className="swap-picker-list">
              {(party as Pokemon[]).map((m, i) => (
                <li key={m.id}>
                  <button
                    type="button"
                    className="swap-picker-row"
                    onClick={() => { setSwapPicking(false); onSwapWithParty(i); }}
                  >
                    <PokemonSprite
                      speciesKey={m.speciesKey}
                      isShiny={m.isShiny}
                      alt=""
                      width={32}
                      height={32}
                      style={{ imageRendering: "pixelated" }}
                    />
                    <div className="swap-picker-meta">
                      <strong>{m.nickname || m.name}</strong>
                      <small className="dim">Lv {m.level} · {m.currentHp}/{m.maxHp} HP</small>
                    </div>
                    <span className="swap-picker-arrow">⇄</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* Sibling of the footer, never a child: at <=480px app.css turns
          .g-modal-foot into a two-column grid and this strip would land in a
          cell. Above the footer it is also just the right shape. */}
      {/* aria-describedby, not just the group label: focus lands on Keep the
          moment this opens, and a screen reader announces the focused button
          plus the group's NAME — it does not read arbitrary sibling text.
          Without it the whole warning (the "cannot be undone" sentence, and
          the shiny exception under it) was on screen and silent, so the one
          surface that exists to make an irreversible action deliberate
          announced only "Confirm release, Keep button". */}
      {armed && !releaseBlocked && (
        <div
          className="rel-confirm"
          role="group"
          aria-label={t("Confirm release")}
          aria-describedby="rel-confirm-text"
        >
          <p className="rel-confirm-text" id="rel-confirm-text">
            {releaseConfirmMessage(p, skipReleaseConfirm)}
            {p.isShiny && (
              <span className="rel-confirm-why">
                {t("Shiny Pokémon always ask, even with confirmations turned off.")}
              </span>
            )}
          </p>
          <div className="rel-confirm-actions">
            {/* Keep takes focus, so a stray Enter or a mis-hit keeps the
                Pokémon. The destructive button is never the default. */}
            <button
              type="button"
              className="rel-confirm-keep"
              autoFocus
              onClick={() => setArmedId(null)}
            >
              {t("Keep")}
            </button>
            {/* Named apart from the footer button that armed it. Both read
                "Release" from their text, and two identically-named buttons in
                one dialog is ambiguous for a screen reader and unusable for
                voice control ("click Release" — which one?). */}
            <button
              type="button"
              className="rel-confirm-go"
              aria-label={`${t("Release")} ${displayName(p)} — ${t("this cannot be undone")}`}
              onClick={() => { setArmedId(null); onRelease(p.id); }}
            >
              {t("Release")}
            </button>
          </div>
        </div>
      )}
      {releaseBlocked && (
        <p className="rel-blocked-note">{t(releaseBlocked)}</p>
      )}

      <footer className="g-modal-foot">
        <button
          type="button"
          className="g-btn-danger-ghost"
          disabled={!!releaseBlocked}
          aria-expanded={armed}
          title={releaseBlocked ? t(releaseBlocked) : t("Release this Pokémon permanently")}
          onClick={() => setArmedId(armed ? null : p.id)}
        >
          {t("Release")}
        </button>
        <span style={{ flex: 1 }} />
        {selected.type === "party" && !isActive && p.currentHp > 0 && !inBattle && (
          <button className="g-btn-ghost g-btn-small" onClick={onSwitch}>{t("Make active")}</button>
        )}
        {selected.type === "party" && partySize > 1 && !inBattle && (
          <button className="g-btn-ghost g-btn-small" onClick={onPartyToBox}>{t("→ Box")}</button>
        )}
        {selected.type === "box" && partySize < 6 && !inBattle && (
          <button className="g-btn-ghost g-btn-small" onClick={onBoxToParty}>{t("→ Party")}</button>
        )}
        {selected.type === "box" && partySize > 0 && !inBattle && (
          <button className="g-btn-ghost g-btn-small" onClick={() => setSwapPicking(true)}>
            {t("Swap with party")}
          </button>
        )}
        <button className="g-btn-primary" onClick={closePokemonDetail}>{t("Close")}</button>
      </footer>
    </div>
  );
}

function statShort(k: keyof import("../types").Stats): string {
  return ({
    hp: "HP", attack: "Atk", defense: "Def",
    spAttack: "SpA", spDefense: "SpD", speed: "Spd",
  } as const)[k];
}

// One row in the Stats list. Shows a +/- arrow when the Pokemon's nature
// boosts or hinders this stat.
function StatRow({
  label, value, pokemon, stat,
}: {
  label: string;
  value: number;
  pokemon: Pokemon;
  stat: keyof import("../types").Stats;
}) {
  const nature = pokemon.nature ? findNature(pokemon.nature) : undefined;
  const boost =
    nature && nature.plus !== nature.minus
      ? nature.plus === stat ? "up" : nature.minus === stat ? "down" : null
      : null;
  return (
    <li className={boost ? `nature-${boost}` : ""}>
      <span>
        {label}
        {boost === "up" && <span className="nature-arrow up"> ▲</span>}
        {boost === "down" && <span className="nature-arrow down"> ▼</span>}
      </span>
      <span>{value}</span>
    </li>
  );
}

// Inline rename input. Submits on blur or Enter.
function NicknameField({ pokemon }: { pokemon: Pokemon }) {
  const { dispatch } = useGame();
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(pokemon.nickname ?? "");
  // Set when the shared rule refuses the draft. Kept in the field rather than
  // read back off state, because a REFUSAL leaves the mon's nickname exactly
  // as it was — there is nothing in state to observe, which is why a rejected
  // rename used to look like a rename that silently did nothing.
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(pokemon.nickname ?? "");
    setError(null);
  }, [pokemon.id, pokemon.nickname]);

  function commit() {
    // Ask the same function the reducer will ask. On refusal, stay in edit
    // mode with the text still there so the player can fix it, instead of
    // dropping their typing and closing.
    const result = normalizeNickname(draft);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    dispatch({
      type: "SET_NICKNAME",
      payload: { pokemonId: pokemon.id, nickname: draft },
    });
    setError(null);
    setEditing(false);
  }

  if (editing) {
    return (
      <span className="nickname-edit">
        <input
          autoFocus
          className="nickname-input"
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setError(null); }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") { setError(null); setEditing(false); }
          }}
          placeholder={pokemon.name}
          maxLength={NICKNAME_MAX_LENGTH}
          aria-label={t("Nickname")}
          aria-invalid={error ? true : undefined}
        />
        {/* Reuses the shared .g-error chip rather than inventing a class, so
            the refusal looks like every other refusal in the app. */}
        {error && (
          <small className="g-error" style={{ display: "block", marginTop: 6 }}>
            {t(error)}
          </small>
        )}
      </span>
    );
  }
  return (
    <span className="nickname-row">
      {displayName(pokemon)}{pokemon.isShiny ? " ✨" : ""}
      {/* Genderless species show nothing at all rather than a dash: an
          absent symbol reads as "not applicable", a placeholder reads as
          "missing". Pokemon caught before the field existed also show
          nothing, which is the honest answer — we never rolled one. */}
      {genderSymbol(pokemon.gender) && (
        <span
          className={`mon-gender is-${pokemon.gender === "M" ? "male" : "female"}`}
          title={pokemon.gender === "M" ? "Male" : "Female"}
        >
          {genderSymbol(pokemon.gender)}
        </span>
      )}
      {/* A REAL BUTTON, beside the name. The whole feature was previously
          reachable only by clicking a heading that gave no sign it was
          interactive — discoverable if you already knew, invisible if you
          did not. A pencil with a label says what it does before you press
          it, which is the entire ask. */}
      <button
        type="button"
        className="nickname-btn"
        onClick={() => setEditing(true)}
        title={pokemon.nickname ? t("Rename") : t("Give this Pokémon a nickname")}
      >
        <IconEdit size={12} />
        <span>{pokemon.nickname ? t("Rename") : t("Nickname")}</span>
      </button>
    </span>
  );
}

// ── EV / IV radar ──────────────────────────────────────────────────
// Hexagonal stat radar: outer hexagon = max EVs (252), inner filled
// polygon = current EVs, with IV pips alongside each stat label.
// Rendered as inline SVG (~200 lines of pure geometry — no chart lib
// needed, dashboard-style). EV cap is enforced server-side; this just
// visualises the current state.
function EvRadar({
  evs,
  ivs,
}: {
  evs: { hp: number; attack: number; defense: number; spAttack: number; spDefense: number; speed: number };
  ivs: { hp: number; attack: number; defense: number; spAttack: number; spDefense: number; speed: number };
}) {
  const t = useT();
  // Six-stat vertices. Order matches the canonical Showdown radar:
  // HP (top), Atk, Def, SpA, SpD, Spe. We rotate so HP is at the top.
  const STAT_LABELS: Array<{ key: keyof typeof evs; short: string; full: string }> = [
    { key: "hp",        short: t("HP"),  full: "HP" },
    { key: "attack",    short: t("Atk"), full: "Attack" },
    { key: "defense",   short: t("Def"), full: "Defense" },
    { key: "spAttack",  short: t("SpA"), full: "Sp. Atk" },
    { key: "spDefense", short: t("SpD"), full: "Sp. Def" },
    { key: "speed",     short: t("Spe"), full: "Speed" },
  ];
  const N = STAT_LABELS.length;
  const SIZE = 220;
  const CX = SIZE / 2;
  const CY = SIZE / 2;
  const R = SIZE / 2 - 28;  // leave margin for outer labels
  const MAX_EV = 252;

  // Vertex angle for each stat. Start at -90° (top) and go clockwise.
  const angle = (i: number) => (-Math.PI / 2) + (i * 2 * Math.PI) / N;
  const vertex = (i: number, r: number) => ({
    x: CX + Math.cos(angle(i)) * r,
    y: CY + Math.sin(angle(i)) * r,
  });

  // Background hex grid: 25%, 50%, 75%, 100% of full radius.
  const gridLevels = [0.25, 0.5, 0.75, 1.0];

  // Filled polygon for current EV values.
  const evPoly = STAT_LABELS.map((s, i) => {
    const ratio = Math.min(1, (evs[s.key] ?? 0) / MAX_EV);
    const v = vertex(i, R * ratio);
    return `${v.x.toFixed(1)},${v.y.toFixed(1)}`;
  }).join(" ");

  // Total EV count — capped at 510 in-game.
  const evTotal = STAT_LABELS.reduce((sum, s) => sum + (evs[s.key] ?? 0), 0);
  const ivTotal = STAT_LABELS.reduce((sum, s) => sum + (ivs[s.key] ?? 0), 0);

  // Label positions sit slightly outside each vertex so they don't
  // clip the polygon. Anchor based on whether the vertex is above /
  // below / on the centre horizontal so labels read correctly.
  const labelPos = (i: number): { x: number; y: number; anchor: "middle" | "start" | "end" } => {
    const v = vertex(i, R + 14);
    const a = angle(i);
    const cosA = Math.cos(a);
    const anchor: "middle" | "start" | "end" =
      Math.abs(cosA) < 0.2 ? "middle" : cosA > 0 ? "start" : "end";
    return { x: v.x, y: v.y, anchor };
  };

  return (
    <div className="ev-radar-wrap">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="ev-radar" aria-label={t("EV radar")}>
        {/* Background hex grid rings */}
        {gridLevels.map((lvl, ringIdx) => {
          const points = STAT_LABELS.map((_, i) => {
            const v = vertex(i, R * lvl);
            return `${v.x.toFixed(1)},${v.y.toFixed(1)}`;
          }).join(" ");
          return (
            <polygon
              key={ringIdx}
              points={points}
              fill="none"
              stroke="rgba(255,255,255,0.08)"
              strokeWidth={1}
            />
          );
        })}

        {/* Spokes from centre to each vertex */}
        {STAT_LABELS.map((_, i) => {
          const v = vertex(i, R);
          return (
            <line
              key={i}
              x1={CX} y1={CY}
              x2={v.x} y2={v.y}
              stroke="rgba(255,255,255,0.06)"
              strokeWidth={1}
            />
          );
        })}

        {/* Filled EV polygon */}
        <polygon
          points={evPoly}
          fill="rgba(96, 165, 250, 0.30)"
          stroke="#60a5fa"
          strokeWidth={1.5}
          strokeLinejoin="round"
        />

        {/* EV vertex dots */}
        {STAT_LABELS.map((s, i) => {
          const ratio = Math.min(1, (evs[s.key] ?? 0) / MAX_EV);
          const v = vertex(i, R * ratio);
          return <circle key={s.key} cx={v.x} cy={v.y} r={2.5} fill="#60a5fa" />;
        })}

        {/* Stat labels */}
        {STAT_LABELS.map((s, i) => {
          const pos = labelPos(i);
          return (
            <g key={s.key}>
              <text
                x={pos.x}
                y={pos.y - 2}
                textAnchor={pos.anchor}
                className="ev-radar-label"
              >
                {s.short}
              </text>
              <text
                x={pos.x}
                y={pos.y + 9}
                textAnchor={pos.anchor}
                className="ev-radar-value"
              >
                {evs[s.key] ?? 0}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="ev-radar-totals">
        <div>
          <span>{t("EV total")}</span>
          <strong>{evTotal} <span className="dim">{t("/ 510")}</span></strong>
        </div>
        <div>
          <span>{t("IV total")}</span>
          <strong>{ivTotal} <span className="dim">{t("/ 186")}</span></strong>
        </div>
      </div>

      <ul className="ev-radar-iv-list">
        {STAT_LABELS.map((s) => (
          <li key={s.key}>
            <span className="ev-radar-iv-label">{s.short}</span>
            <span className="ev-radar-iv-pips">
              {Array.from({ length: 31 }, (_, i) => (
                <span
                  key={i}
                  className={`ev-radar-iv-pip ${i < (ivs[s.key] ?? 0) ? "filled" : ""}`}
                />
              ))}
            </span>
            <span className="ev-radar-iv-num">{ivs[s.key] ?? 0}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One move in the detail sheet, draggable onto another to swap them.
 *
 * Addressed by INDEX here rather than by id, deliberately and unlike the
 * move manager: this list is exactly four rows rendered from the Pokemon's
 * own `moves` array, it is not filtered or windowed, and both ends of the
 * swap are resolved in the same render. The manager needs ids because its
 * pool is filtered and its draft mutates under the drag.
 */
function DetailMoveRow({
  moveId, index, tint, draggable, onSwap, children,
}: {
  moveId: string;
  index: number;
  tint: string;
  draggable: boolean;
  onSwap: (from: number, to: number) => void;
  children: React.ReactNode;
}) {
  const ref = useDragAndDrop<HTMLLIElement>({
    enabled: draggable,
    source: { payload: () => ({ kind: "detailMove", data: { index, moveId } }) },
    target: {
      accept: (p) => p.kind === "detailMove",
      onDrop: (p) => onSwap((p.data as { index: number }).index, index),
    },
  });
  return (
    <li
      ref={ref}
      style={{ background: tint }}
      className={draggable ? "is-draggable" : undefined}
      title={draggable ? "Drag to reorder" : undefined}
    >
      {children}
    </li>
  );
}
