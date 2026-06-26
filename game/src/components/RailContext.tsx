import { useEffect, useState } from "react";
import { useGame } from "../state/GameContext";
import { routes } from "../data/routes";
import { encounters } from "../data/encounters";
import { pokemonTable } from "../data/pokemon";
import { getUIPhase } from "../utils/uiPhase";
import { getGymLeaderForLocation } from "../utils/trainerFactory";
import { pokemonSpriteUrl } from "../utils/sprites";
import {
  RAID_COOLDOWN_MS,
  raidTiersOrdered,
  isTierUnlocked,
} from "../data/raidLegendaries";
import { ContextPanel } from "./ContextPanel";
import { IconClose, IconPin } from "./Icon";

// Compact contextual strip for the right rail. Shows ONLY the
// always-relevant info per phase — encounter sprites on a route,
// a single action CTA when there's something to do (gym, league,
// raid). The full deep-dive UI (raid tier picker, league card,
// gym leader card) opens in a focused modal via the CTA so it's
// not screaming for attention permanently in the rail.
export function RailContext() {
  const { state } = useGame();
  const [modalOpen, setModalOpen] = useState(false);
  const phase = getUIPhase(state);
  const here = routes[state.currentLocation];

  // Auto-close the modal whenever the phase changes — moving to a
  // different location or starting a battle shouldn't leave a stale
  // modal hanging.
  useEffect(() => {
    setModalOpen(false);
  }, [state.currentLocation, state.phase]);

  return (
    <>
      <div className="rail-ctx">
        <div className="rail-ctx-loc">
          <IconPin size={11} strokeWidth={1.8} />
          <span className="rail-ctx-loc-name">{here?.name ?? "Unknown"}</span>
          {here?.type && (
            <span className="rail-ctx-loc-type">{here.type}</span>
          )}
        </div>

        {phase === "idle-route"  && <RouteRail />}
        {phase === "idle-town"   && <TownRail onOpenModal={() => setModalOpen(true)} />}
        {phase === "idle-raid"   && <RaidRail onOpenModal={() => setModalOpen(true)} />}
        {phase === "battle-wild" && <WildBattleRail />}
        {phase === "battle-trainer" && <TrainerBattleRail onOpenModal={() => setModalOpen(true)} />}
        {phase === "battle-boss"    && <BossBattleRail onOpenModal={() => setModalOpen(true)} />}
        {phase === "meta"           && <MetaRail />}
      </div>

      {modalOpen && (
        <LocationActionModal
          title={modalTitle(state, phase, here)}
          onClose={() => setModalOpen(false)}
        />
      )}
    </>
  );
}

// Wild-encounter strip — small clickable sprite cells. Caught
// species render in colour, seen render in greyscale, unseen render
// black silhouettes. Click any sprite to open the full ContextPanel
// modal where the player can pin / pick / configure catch settings.
function RouteRail() {
  const { state } = useGame();
  const enc = encounters[state.currentLocation]?.encounters ?? [];
  if (enc.length === 0) {
    return <p className="rail-ctx-empty dim small">No wild Pokémon here.</p>;
  }
  const total = enc.reduce((s, e) => s + e.weight, 0);
  return (
    <div className="rail-ctx-section">
      <header className="rail-ctx-section-head">
        <span>Wild Pokémon</span>
        <small>{enc.length} species</small>
      </header>
      <div className="rail-ctx-encounters">
        {enc.slice(0, 12).map((e) => {
          const seen = state.pokedexSeen.includes(e.speciesKey);
          const caught = state.pokedexCaught.includes(e.speciesKey);
          const sp = pokemonTable[e.speciesKey];
          const ratePct = total > 0 ? (e.weight / total) * 100 : 0;
          const filter = caught
            ? "none"
            : seen
              ? "grayscale(1) brightness(0.85)"
              : "brightness(0)";
          return (
            <span
              key={e.speciesKey}
              className={`rail-ctx-enc ${caught ? "caught" : seen ? "seen" : "unknown"}`}
              title={seen ? `${sp.name} · ${ratePct.toFixed(1)}%` : "???"}
            >
              <img
                src={pokemonSpriteUrl(e.speciesKey)}
                alt={seen ? sp.name : "???"}
                style={{ filter, imageRendering: "pixelated" }}
                width={28}
                height={28}
                draggable={false}
              />
            </span>
          );
        })}
      </div>
    </div>
  );
}

// Town strip — exposes the gym fight or the league entrance via a
// single CTA. Everything else (gym leader's full team, league card)
// lives behind the modal so it doesn't permanently fill the rail.
function TownRail({ onOpenModal }: { onOpenModal: () => void }) {
  const { state } = useGame();
  const here = state.currentLocation;
  if (here === "indigoPlat") {
    return (
      <button className="rail-ctx-cta" onClick={onOpenModal}>
        <span>▶ Enter the League</span>
      </button>
    );
  }
  const leader = getGymLeaderForLocation(here);
  if (leader) {
    const defeated = state.defeatedGyms.includes(leader.id);
    return (
      <button className="rail-ctx-cta" onClick={onOpenModal}>
        <span>▶ {defeated ? "Rematch" : "Challenge"} {leader.name}</span>
      </button>
    );
  }
  return <p className="rail-ctx-empty dim small">Nothing to do here right now.</p>;
}

// Raid strip — single button that opens the full tier picker in a
// modal. Cooldown info shows inline as a thin strip below the CTA
// so the player still sees timing info at a glance.
function RaidRail({ onOpenModal }: { onOpenModal: () => void }) {
  const { state } = useGame();

  // Live cooldown ticker so the timer counts down in the rail.
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Use the player's most-relevant tier for the cooldown — pick the
  // first unlocked tier that has a remaining cooldown, falling back
  // to "no cooldown" if none.
  const firstUnlocked = raidTiersOrdered.find((t) => isTierUnlocked(t, state)) ?? raidTiersOrdered[0];
  const tierCooldown = state.raidCooldowns?.[firstUnlocked.id] ?? 0;
  const legacyCooldown = state.raidCooldownEnd ?? 0;
  const cooldown = state.raidCooldowns ? tierCooldown : legacyCooldown;
  const cdLeft = Math.max(0, cooldown - Date.now());
  const onCooldown = cdLeft > 0;

  return (
    <>
      <button
        className="rail-ctx-cta"
        onClick={onOpenModal}
        disabled={state.inRaid}
      >
        <span>▶ {state.inRaid ? "Raiding…" : "Open Raid Den"}</span>
      </button>
      {onCooldown && (
        <p className="rail-ctx-empty dim small" style={{ margin: "6px 0 0" }}>
          On cooldown · {formatCooldown(cdLeft)} until next raid
        </p>
      )}
      <p className="rail-ctx-empty dim small" style={{ margin: "4px 0 0", fontSize: 10 }}>
        Pick a tier and lineup inside.
      </p>
    </>
  );
}

// Mid-battle strips — minimal "what's happening right now" lines.
// Trainer / boss fights also expose an "expand" button so the
// player can look up the trainer's full team and gauntlet progress
// without leaving the battle.
function WildBattleRail() {
  const { state } = useGame();
  const enemy = state.enemyPokemon;
  if (!enemy) return null;
  return (
    <p className="rail-ctx-line">
      <span className="rail-ctx-dot" data-kind="wild" /> Wild <strong>{enemy.name}</strong> · Lv {enemy.level}
    </p>
  );
}

function TrainerBattleRail({ onOpenModal }: { onOpenModal: () => void }) {
  const { state } = useGame();
  const t = state.trainerBattle;
  if (!t) return null;
  return (
    <>
      <p className="rail-ctx-line">
        <span className="rail-ctx-dot" data-kind="trainer" />
        Trainer <strong>{t.trainerName}</strong>
      </p>
      <button className="rail-ctx-cta-soft" onClick={onOpenModal}>
        Show team ({t.currentTrainerPokemonIndex}/{t.trainerTeam.length})
      </button>
    </>
  );
}

function BossBattleRail({ onOpenModal }: { onOpenModal: () => void }) {
  const { state } = useGame();
  const b = state.bossBattle;
  if (!b) return null;
  const queueLeft = state.bossQueue.length;
  return (
    <>
      <p className="rail-ctx-line">
        <span className="rail-ctx-dot" data-kind="boss" />
        {b.bossType === "champion" ? "Champion" : b.bossType === "e4" ? "Elite Four" : "Gym Leader"}
        {" "}<strong>{b.trainerName}</strong>
      </p>
      <button className="rail-ctx-cta-soft" onClick={onOpenModal}>
        Show {queueLeft > 0 ? `gauntlet (${queueLeft} left)` : "team"}
      </button>
    </>
  );
}

function MetaRail() {
  const { state } = useGame();
  const label =
    state.phase === "healing" ? "Healing your party…"
    : state.phase === "evolution" ? "A Pokémon is evolving…"
    : state.phase === "starterSelect" ? "Pick your starter."
    : "—";
  return <p className="rail-ctx-line dim">{label}</p>;
}

function modalTitle(
  state: ReturnType<typeof useGame>["state"],
  phase: ReturnType<typeof getUIPhase>,
  here: { name?: string } | undefined
): string {
  if (phase === "idle-raid") return "Legendary Raids";
  if (phase === "idle-town" && state.currentLocation === "indigoPlat") return "Pokémon League";
  if (phase === "idle-town") {
    const leader = getGymLeaderForLocation(state.currentLocation);
    return leader ? `${leader.name}'s Gym` : (here?.name ?? "Town");
  }
  if (phase === "battle-trainer") return state.trainerBattle?.trainerName ?? "Trainer Battle";
  if (phase === "battle-boss")    return state.bossBattle?.trainerName ?? "Boss Battle";
  return here?.name ?? "Details";
}

function formatCooldown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Modal that hosts the existing ContextPanel — gives the player the
// full deep-dive UI (raid tier picker, league card, gym roster,
// trainer's full team) on demand without keeping it permanently
// pinned to the rail.
function LocationActionModal({ title, onClose }: { title: string; onClose: () => void }) {
  // Close on ESC.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="loc-modal-scrim" onClick={onClose}>
      <div
        className="loc-modal-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <header className="loc-modal-head">
          <h3>{title}</h3>
          <button
            className="loc-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            <IconClose size={16} strokeWidth={1.8} />
          </button>
        </header>
        <div className="loc-modal-body">
          <ContextPanel />
        </div>
      </div>
    </div>
  );
}
