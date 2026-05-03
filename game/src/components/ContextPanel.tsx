import { useState, useEffect } from "react";
import { useGame } from "../state/GameContext";
import { routes } from "../data/routes";
import { encounters } from "../data/encounters";
import { pokemonTable } from "../data/pokemon";
import { pokemonSpriteUrl, trainerSpriteUrl, itemSpriteUrl } from "../utils/sprites";
import { rarityFromRate } from "../utils/rarity";
import { getGymLeaderForLocation, buildTeam } from "../utils/trainerFactory";
import { getUIPhase } from "../utils/uiPhase";
import { openCatchSettings } from "./CatchSettingsModal";
import { WildPokemonDetail } from "./WildPokemonDetail";
import {
  RAID_COOLDOWN_MS,
  raidTiersOrdered,
  isTierUnlocked,
  type RaidTier,
  type RaidTierId,
} from "../data/raidLegendaries";
import { IconHome, IconMountain, IconLeaf, IconIsland, IconInfo } from "./Icon";
import { eliteFour, champion } from "../data/eliteFour";
import { gymLeaders } from "../data/gymLeaders";
import { openRewardShop } from "./RewardShopPanel";
import type { BossBattle } from "../types";
import type { ReactNode } from "react";

// Adaptive right column. Replaces the old Location/Gyms tab switcher with
// a panel whose body is determined by getUIPhase. The header is always the
// same (location name + Gyms shortcut) so navigation feels stable; only
// the content below it reacts to whatever the player is doing.
export function ContextPanel() {
  const { state } = useGame();
  const phase = getUIPhase(state);
  const route = routes[state.currentLocation];

  return (
    <div className="context-panel">
      <div className="context-panel-body">
        {/* Wild battles use the same route rendering as idle so the panel
            doesn't flicker between encounters at higher speeds. Manual ball
            throws live in the moves-panel "⋯ → Catch" popover. */}
        {(phase === "battle-wild" || phase === "idle-route") && <IdleRoutePanel />}
        {phase === "battle-trainer" && <BattleTrainerPanel />}
        {phase === "battle-boss" && <BattleBossPanel />}
        {phase === "idle-town" && <IdleTownPanel />}
        {phase === "idle-raid" && <IdleRaidPanel />}
        {phase === "meta" && <MetaPanel />}
        {/* Goal path — always visible, regardless of phase. Sits at the
            bottom so it doesn't push down phase-specific content. */}
        <UnlockHint />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase-specific panels
// ---------------------------------------------------------------------------


function BattleTrainerPanel() {
  const { state, dispatch } = useGame();
  const t = state.trainerBattle;
  if (!t) return null;

  // Indigo Plateau: show the league card (E4 + Champion) as the
  // contextual sidebar even mid-trainer-fight, so players can punch
  // through to the gauntlet whenever.
  if (state.currentLocation === "indigoPlat") {
    return (
      <>
        <LeagueCard />
        <section className="ctx-section">
          <h4>Currently battling</h4>
          <p className="dim small" style={{ margin: 0 }}>
            <strong>{t.trainerName}</strong> ({t.trainerClass})
          </p>
          <TeamBalls
            total={t.trainerTeam.length}
            spent={t.currentTrainerPokemonIndex}
            label="Their team"
          />
        </section>
      </>
    );
  }

  // If the current location has a gym leader, surface them as the
  // contextual card instead of the random trainer the player happens
  // to be mid-battle with — that's what defines the town.
  const leader = getGymLeaderForLocation(state.currentLocation);
  if (leader) {
    const defeated = state.defeatedGyms.includes(leader.id);
    return (
      <section className="ctx-section">
        <h4>Gym Leader</h4>
        <div className="ctx-trainer-card">
          <img
            src={trainerSpriteUrl(leader.spriteKey)}
            alt={leader.name}
            width={48}
            height={48}
            style={{ imageRendering: "pixelated" }}
            onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
          />
          <div>
            <strong>{leader.name}</strong>
            <small className="dim">{leader.title}</small>
          </div>
          <button
            type="button"
            title={defeated
              ? "You've already beaten this gym — challenge again for the rematch"
              : "Bails out of any active battle, heals your party, and starts the gym fight"}
            onClick={() => {
              const { team } = buildTeam(leader.team, `gym_${leader.id}_${Date.now()}`);
              dispatch({
                type: "START_BOSS_BATTLE",
                payload: {
                  bossId: leader.id,
                  bossType: "gym",
                  trainerName: leader.name,
                  trainerClass: "gym",
                  trainerTeam: team,
                  spriteKey: leader.spriteKey,
                },
              });
            }}
          >
            {defeated ? "Rematch" : "Challenge"}
          </button>
        </div>
        <p className="dim small" style={{ margin: "6px 0 0" }}>
          Currently battling <strong>{t.trainerName}</strong> ({t.trainerClass}).
        </p>
        <TeamBalls
          total={t.trainerTeam.length}
          spent={t.currentTrainerPokemonIndex}
          label="Their team"
        />
      </section>
    );
  }

  // No gym in this location — fall back to the original trainer card.
  return (
    <section className="ctx-section">
      <h4>Trainer battle</h4>
      <div className="ctx-trainer-card">
        <img
          src={trainerSpriteUrl(t.spriteKey)}
          alt={t.trainerName}
          width={48}
          height={48}
          style={{ imageRendering: "pixelated" }}
          onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
        />
        <div>
          <strong>{t.trainerName}</strong>
          <small className="dim">{t.trainerClass}</small>
        </div>
      </div>
      <TeamBalls
        total={t.trainerTeam.length}
        spent={t.currentTrainerPokemonIndex}
        label="Their team"
      />
    </section>
  );
}

function BattleBossPanel() {
  const { state } = useGame();
  const b = state.bossBattle;
  if (!b) return null;
  const queueLeft = state.bossQueue.length;
  return (
    <section className="ctx-section">
      <h4>{b.bossType === "champion" ? "Champion" : b.bossType === "e4" ? "Elite Four" : "Gym Leader"}</h4>
      <div className="ctx-trainer-card">
        <img
          src={trainerSpriteUrl(b.spriteKey)}
          alt={b.trainerName}
          width={56}
          height={56}
          style={{ imageRendering: "pixelated" }}
          onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
        />
        <div>
          <strong>{b.trainerName}</strong>
          <small className="dim">{b.trainerClass}</small>
        </div>
      </div>
      <TeamBalls
        total={b.trainerTeam.length}
        spent={b.currentTrainerPokemonIndex}
        label="Their team"
      />
      {queueLeft > 0 && (
        <p className="dim small" style={{ margin: "6px 0 0" }}>
          {queueLeft} fight{queueLeft === 1 ? "" : "s"} left in this gauntlet.
        </p>
      )}
    </section>
  );
}

function IdleRoutePanel() {
  const { state } = useGame();
  const here = state.currentLocation;
  const enc = encounters[here]?.encounters ?? [];
  return (
    <>
      {enc.length > 0 && <WildPokemonSection routeKey={here} />}
    </>
  );
}

function IdleTownPanel() {
  const { state, dispatch } = useGame();
  const here = state.currentLocation;
  const route = routes[here];
  const leader = getGymLeaderForLocation(here);

  function challengeGym() {
    if (!leader) return;
    // No "already in battle" gate — START_BOSS_BATTLE bails from the
    // current encounter and heals the party before the boss fight.
    // No "already defeated" gate either — players can rematch any time.
    const { team } = buildTeam(leader.team, `gym_${leader.id}_${Date.now()}`);
    dispatch({
      type: "START_BOSS_BATTLE",
      payload: {
        bossId: leader.id,
        bossType: "gym",
        trainerName: leader.name,
        trainerClass: "gym",
        trainerTeam: team,
        spriteKey: leader.spriteKey,
      },
    });
  }

  return (
    <>
      {here === "indigoPlat" && <LeagueCard />}
      {leader && (
        <section className="ctx-section">
          <h4>Gym Leader</h4>
          <div className="ctx-trainer-card">
            <img
              src={trainerSpriteUrl(leader.spriteKey)}
              alt={leader.name}
              width={48}
              height={48}
              style={{ imageRendering: "pixelated" }}
              onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
            />
            <div>
              <strong>{leader.name}</strong>
              <small className="dim">{leader.title}</small>
            </div>
            <button
              type="button"
              onClick={challengeGym}
              title="Bails out of any active battle, heals your party, and starts the gym fight"
            >
              {state.defeatedGyms.includes(leader.id) ? "Rematch" : "Challenge"}
            </button>
          </div>
        </section>
      )}
    </>
  );
}

function IdleRaidPanel() {
  const { state, dispatch } = useGame();
  const route = routes[state.currentLocation];
  const cooldown = state.raidCooldownEnd ?? 0;
  const cdLeft = Math.max(0, cooldown - Date.now());
  const onCooldown = cdLeft > 0;
  const canRaid = !onCooldown && !state.inRaid;

  // Default the picker to the first unlocked tier the player has access
  // to. The user can click any unlocked tier card to switch.
  const firstUnlocked = raidTiersOrdered.find((t) => isTierUnlocked(t, state)) ?? raidTiersOrdered[0];
  const [selectedTier, setSelectedTier] = useState<RaidTierId>(firstUnlocked.id);
  const tier = raidTiersOrdered.find((t) => t.id === selectedTier) ?? firstUnlocked;
  const tierUnlocked = isTierUnlocked(tier, state);

  // Live ticker so the cooldown timer counts down in the UI.
  const [, force] = useState(0);
  useEffect(() => {
    if (!onCooldown) return;
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [onCooldown]);

  // Build the per-tier lineup from the tier's pool; sorted by weight
  // desc so the most-likely spawns are listed first.
  const lineup = Object.entries(tier.pool)
    .sort(([, a], [, b]) => b - a)
    .map(([speciesKey, weight]) => ({ speciesKey, weight }));

  // The descriptive raid blurb + cooldown rules live behind an info
   // icon in the title row instead of taking up two paragraphs of
   // vertical space — the player only needs the tier blurb when
   // deciding which tier to pick, and the +5-levels / cooldown rules
   // are static reference info.
  const tierInfo =
    `${tier.blurb}\n\nEach defeat summons the next at +5 levels. ` +
    `${RAID_COOLDOWN_MS / 60000}-minute cooldown after a wipe.`;

  return (
    <>
      <section className="ctx-section ctx-section-with-info">
        <h4 className="ctx-section-h4-with-info">
          Legendary Raids
          <button
            type="button"
            className="ctx-info-btn"
            title={tierInfo}
            aria-label="About Legendary Raids"
            onClick={(e) => {
              // Mobile / tap-to-expand: surface the tooltip text inline
              // because hover doesn't exist. Toggles the popover open
              // class on a sibling at the section level.
              e.preventDefault();
              const section = (e.currentTarget as HTMLElement).closest(".ctx-section");
              const el = section?.querySelector(".ctx-info-popover") as HTMLElement | null;
              if (el) el.classList.toggle("open");
            }}
          >
            <IconInfo size={15} strokeWidth={1.75} />
          </button>
        </h4>
        <span className="ctx-info-popover" role="tooltip">
          {tierInfo}
        </span>
        {onCooldown && (
          <div className="raid-cooldown-banner" role="status">
            <span className="raid-cooldown-icon" aria-hidden>⏱</span>
            <div className="raid-cooldown-text">
              <strong>On cooldown</strong>
              <span className="raid-cooldown-time">{formatCooldown(cdLeft)}</span>
            </div>
            <span className="raid-cooldown-help">until next raid</span>
          </div>
        )}

        {/* Card-grid picker — desktop / tablet. Hidden via CSS at
            phone breakpoints in favour of the dropdown below. */}
        <div className="raid-tier-picker">
          {raidTiersOrdered.map((t) => {
            const unlocked = isTierUnlocked(t, state);
            const active = t.id === selectedTier;
            return (
              <button
                key={t.id}
                type="button"
                className={`raid-tier-card ${active ? "active" : ""} ${unlocked ? "" : "locked"}`}
                disabled={!unlocked}
                onClick={() => setSelectedTier(t.id)}
                title={
                  unlocked
                    ? `${t.name} — Lv. ${t.startLevel}`
                    : tierUnlockHint(t)
                }
              >
                <span className="raid-tier-card-name">{t.name}</span>
                <span className="raid-tier-card-meta">
                  {unlocked ? `Lv. ${t.startLevel}` : "🔒"}
                </span>
              </button>
            );
          })}
        </div>

        {/* Native-select picker — phones. Hidden on desktop via CSS.
            Locked tiers are still rendered (with a 🔒) so the player
            can see what's coming, but disabled so they can't pick. */}
        <label className="raid-tier-select">
          <select
            value={selectedTier}
            onChange={(e) => setSelectedTier(e.target.value as RaidTierId)}
            aria-label="Raid tier"
          >
            {raidTiersOrdered.map((t) => {
              const unlocked = isTierUnlocked(t, state);
              const hint = tierUnlockHintShort(t);
              return (
                <option
                  key={t.id}
                  value={t.id}
                  disabled={!unlocked}
                >
                  {unlocked
                    ? `${t.name} · Lv. ${t.startLevel}`
                    : `🔒 ${t.name}${hint ? ` · ${hint}` : ""}`}
                </option>
              );
            })}
          </select>
        </label>

        <button
          type="button"
          className="raid-begin-btn"
          disabled={!canRaid || !tierUnlocked}
          onClick={() => dispatch({ type: "START_RAID", payload: { tier: selectedTier } })}
          title={
            !canRaid
              ? onCooldown
                ? "On cooldown"
                : "Already raiding"
              : !tierUnlocked
                ? tierUnlockHint(tier)
                : `Begin a ${tier.name} raid at Lv. ${tier.startLevel}`
          }
        >
          ⚡ Begin {tier.name} raid
        </button>

        <div className="raid-lineup-label dim small">
          Possible spawns ({lineup.length})
        </div>
        <ul className="raid-lineup">
          {lineup.map(({ speciesKey, weight }) => {
            const caught = state.pokedexCaught.includes(speciesKey);
            const tagged = tier.rarityTag;
            return (
              <li
                key={speciesKey}
                className={`raid-lineup-row ${caught ? "caught" : ""} ${tier.id === "mythical" ? "mythical" : ""}`}
                title={
                  `${humaniseSpecies(speciesKey)} · spawn weight ${weight}` +
                  (caught ? " · already caught" : "")
                }
              >
                <img
                  src={pokemonSpriteUrl(speciesKey)}
                  alt={speciesKey}
                  width={28}
                  height={28}
                  style={{
                    imageRendering: "pixelated",
                    filter: caught ? "none" : "brightness(0.7)",
                  }}
                />
                <span className="raid-lineup-name">{humaniseSpecies(speciesKey)}</span>
                {tagged && <span className="raid-mythical-tag">{tagged}</span>}
                {caught && <span className="raid-caught-tag">✓</span>}
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}

function tierUnlockHint(t: RaidTier): string {
  const parts: string[] = [];
  if (t.unlockBadges > 0) parts.push(`Earn ${t.unlockBadges} badge${t.unlockBadges === 1 ? "" : "s"}`);
  if (t.unlockChampionDefeated) parts.push("Defeat the Champion");
  return parts.length === 0 ? "Locked" : `Locked — ${parts.join(" + ")}`;
}

// Compact unlock hint for the mobile <select> options where the long
// "Locked — Earn 8 badges + Defeat the Champion" string overflows the
// dropdown row on small viewports. e.g. "8 badges + champion".
function tierUnlockHintShort(t: RaidTier): string {
  const parts: string[] = [];
  if (t.unlockBadges > 0) parts.push(`${t.unlockBadges} badge${t.unlockBadges === 1 ? "" : "s"}`);
  if (t.unlockChampionDefeated) parts.push("champion");
  return parts.length === 0 ? "" : parts.join(" + ");
}

// Convert a camelCase species key into a display label. Special-cases
// the few legendary keys that need different punctuation than what
// generic camel-split would produce.
function humaniseSpecies(key: string): string {
  const overrides: Record<string, string> = {
    hoOh: "Ho-Oh",
    typeNull: "Type: Null",
    tapuKoko: "Tapu Koko",
    tapuLele: "Tapu Lele",
    tapuBulu: "Tapu Bulu",
    tapuFini: "Tapu Fini",
    woChien: "Wo-Chien",
    chienPao: "Chien-Pao",
    tingLu: "Ting-Lu",
    chiYu: "Chi-Yu",
    walkingWake: "Walking Wake",
    ironLeaves: "Iron Leaves",
  };
  if (overrides[key]) return overrides[key];
  // Generic camelCase → "Camel Case"
  return key.charAt(0).toUpperCase() + key.slice(1).replace(/([A-Z])/g, " $1");
}

// Render a remaining-cooldown duration as M:SS so the player can read it
// at a glance instead of decoding "542s".
function formatCooldown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function MetaPanel() {
  const { state } = useGame();
  const label =
    state.phase === "healing" ? "Healing your party…"
    : state.phase === "evolution" ? "A Pokémon is evolving…"
    : state.phase === "starterSelect" ? "Pick your starter."
    : "—";
  return (
    <section className="ctx-section">
      <p className="dim small">{label}</p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

function TeamBalls({ total, spent, label }: { total: number; spent: number; label: string }) {
  return (
    <div className="ctx-team-balls">
      <span className="dim small">{label}</span>
      <span className="ctx-balls">
        {Array.from({ length: total }, (_, i) => (
          <img
            key={i}
            src={itemSpriteUrl("pokeball")}
            alt={i < spent ? "fainted" : "ready"}
            className={i < spent ? "spent" : ""}
            width={14}
            height={14}
          />
        ))}
      </span>
    </div>
  );
}

function WildPokemonSection({ routeKey }: { routeKey: string }) {
  const { state } = useGame();
  const enc = encounters[routeKey]?.encounters ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const totalWeight = enc.reduce((s, e) => s + e.weight, 0);

  // Active repel/honey effects keyed by species
  const effects: Record<string, { repel?: boolean; honey?: boolean }> = {};
  for (const e of state.activeEffects) {
    if (e.routeKey !== routeKey) continue;
    if (!effects[e.speciesKey]) effects[e.speciesKey] = {};
    if (e.itemId === "repel") effects[e.speciesKey].repel = true;
    if (e.itemId === "honey") effects[e.speciesKey].honey = true;
  }

  return (
    <section className="ctx-section">
      <header className="ctx-row-head">
        <h4>Wild Pokémon</h4>
        <button
          type="button"
          className="ctx-link"
          onClick={() => openCatchSettings(routeKey)}
        >
          Catch settings →
        </button>
      </header>
      <div className="wild-grid">
        {enc.map((e) => {
          const seen = state.pokedexSeen.includes(e.speciesKey);
          const caught = state.pokedexCaught.includes(e.speciesKey);
          const ratePct = totalWeight > 0 ? (e.weight / totalWeight) * 100 : 0;
          const rarity = rarityFromRate(ratePct);
          const sp = pokemonTable[e.speciesKey];
          const eff = effects[e.speciesKey] ?? {};
          return (
            <button
              key={e.speciesKey}
              className={`wild-cell rarity-border-${rarity} ${seen ? "seen" : "unknown"} ${caught ? "caught" : ""} ${selected === e.speciesKey ? "selected" : ""}`}
              onClick={() =>
                setSelected((cur) => (cur === e.speciesKey ? null : e.speciesKey))
              }
              title={seen ? `${sp.name} · ${ratePct.toFixed(1)}%` : "???"}
            >
              <img
                src={pokemonSpriteUrl(e.speciesKey)}
                alt={seen ? sp.name : "???"}
                width={40}
                height={40}
                style={{
                  imageRendering: "pixelated",
                  filter: caught
                    ? "none"
                    : seen
                    ? "grayscale(1) brightness(0.85)"
                    : "brightness(0)",
                }}
              />
              <small>{seen ? sp.name : "???"}</small>
              {(eff.repel || eff.honey) && (
                <span className={`wild-effect-badge ${eff.repel ? "repel" : "honey"}`}>
                  {eff.repel ? "R" : "H"}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {selected && (
        <WildPokemonDetail
          speciesKey={selected}
          routeKey={routeKey}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}

// Always-visible goal tracker. Shows the next location to unlock (with
// progress bars for each requirement) plus a one-line preview of what's
// coming after it, so the player has a clear path forward regardless of
// which screen they're on.
function UnlockHint() {
  const { state } = useGame();
  const candidates = Object.values(routes)
    .filter((r) => !state.unlockedLocations.includes(r.id))
    .sort((a, b) => a.unlockOrder - b.unlockOrder);
  const next = candidates[0];
  if (!next) {
    return (
      <section className="ctx-section unlock-hint">
        <h4>Goal</h4>
        <strong>All locations unlocked!</strong>
        <p className="dim small" style={{ margin: "4px 0 0" }}>
          {state.championDefeated
            ? "You've cleared everything. Try filling the Pokédex."
            : "Defeat the Elite Four and become Champion."}
        </p>
      </section>
    );
  }
  const reqs = describeRequirements(next.unlock, state);
  const peek = candidates[1];
  return (
    <section className="ctx-section unlock-hint">
      <h4>Next Goal</h4>
      <div className="unlock-target">
        <span className="unlock-target-icon">{iconFor(next.type)}</span>
        <strong>{next.name}</strong>
      </div>
      <ul>
        {reqs.map((r, i) => (
          <li key={i} className={r.done ? "done" : ""}>
            <span className="unlock-req-label">{r.label}</span>
            <span className="unlock-req-bar">
              <span
                className="unlock-req-fill"
                style={{ width: `${Math.min(100, (r.cur / Math.max(1, r.target)) * 100)}%` }}
              />
            </span>
            <span className="unlock-req-num">{r.cur}/{r.target}</span>
          </li>
        ))}
      </ul>
      {peek && (
        <p className="unlock-peek dim small">
          After this → <strong>{peek.name}</strong>
        </p>
      )}
    </section>
  );
}

interface RequirementProgress {
  label: string;
  cur: number;
  target: number;
  done: boolean;
}

function describeRequirements(u: any, state: ReturnType<typeof useGame>["state"]): RequirementProgress[] {
  const out: RequirementProgress[] = [];
  if (u.battlesAtLocation) {
    for (const r of u.battlesAtLocation) {
      const won = state.battlesWonByLocation[r.locationId] ?? 0;
      out.push({
        label: `Battles at ${routes[r.locationId]?.name ?? r.locationId}`,
        cur: Math.min(won, r.count),
        target: r.count,
        done: won >= r.count,
      });
    }
  }
  if (u.badgesRequired) {
    const cur = state.defeatedGyms.length;
    out.push({ label: "Badges", cur: Math.min(cur, u.badgesRequired), target: u.badgesRequired, done: cur >= u.badgesRequired });
  }
  if (u.championDefeated) {
    out.push({ label: "Defeat the Champion", cur: state.championDefeated ? 1 : 0, target: 1, done: !!state.championDefeated });
  }
  return out;
}

function iconFor(type?: string): ReactNode {
  switch (type) {
    case "town":        return <IconHome size={14} />;
    case "cave":        return <IconMountain size={14} />;
    case "victoryRoad": return <IconMountain size={14} />;
    case "raid":        return <IconIsland size={14} />;
    default:            return <IconLeaf size={14} />;
  }
}

// Indigo Plateau league card — Elite Four roster + Champion + a single
// "Begin gauntlet" button that builds the boss queue and dispatches the
// first fight (the rest chain automatically through bossQueue).
function LeagueCard() {
  const { state, dispatch } = useGame();
  const allBadges = state.defeatedGyms.length >= gymLeaders.length;
  const eliteCleared = state.defeatedEliteFour.length >= eliteFour.length;
  const championBeaten = state.championDefeated;

  function startGauntlet() {
    const queue: BossBattle[] = [];
    for (const e4 of eliteFour) {
      const { team } = buildTeam(e4.team, `e4_${e4.id}_${Date.now()}`);
      queue.push({
        bossId: e4.id,
        bossType: "e4",
        trainerName: e4.name,
        trainerClass: "e4",
        trainerTeam: team,
        currentTrainerPokemonIndex: 0,
        spriteKey: e4.spriteKey,
      });
    }
    const { team: champTeam } = buildTeam(champion.team, `champion_${champion.id}_${Date.now()}`);
    queue.push({
      bossId: champion.id,
      bossType: "champion",
      trainerName: champion.name,
      trainerClass: "champion",
      trainerTeam: champTeam,
      currentTrainerPokemonIndex: 0,
      spriteKey: champion.spriteKey,
    });
    const [first, ...rest] = queue;
    dispatch({
      type: "START_BOSS_BATTLE",
      payload: {
        bossId: first.bossId,
        bossType: first.bossType,
        trainerName: first.trainerName,
        trainerClass: first.trainerClass,
        trainerTeam: first.trainerTeam,
        spriteKey: first.spriteKey,
        bossQueue: rest,
      },
    });
  }

  return (
    <section className="ctx-section">
      <h4>Pokémon League</h4>
      {!allBadges ? (
        <p className="dim small" style={{ margin: 0 }}>
          Earn all 8 Gym Badges to challenge the Elite Four. ({state.defeatedGyms.length}/{gymLeaders.length})
        </p>
      ) : (
        <>
          <ul className="league-roster">
            {eliteFour.map((m) => {
              const beaten = state.defeatedEliteFour.includes(m.id);
              return (
                <li key={m.id} className={beaten ? "beaten" : ""}>
                  <img
                    src={trainerSpriteUrl(m.spriteKey)}
                    alt={m.name}
                    width={28}
                    height={28}
                    style={{ imageRendering: "pixelated" }}
                  />
                  <span className="league-name">
                    {m.name}
                    {beaten && <span className="league-check"> ✓</span>}
                  </span>
                </li>
              );
            })}
            <li className={championBeaten ? "beaten champion" : "champion"}>
              <img
                src={trainerSpriteUrl(champion.spriteKey)}
                alt={champion.name}
                width={28}
                height={28}
                style={{ imageRendering: "pixelated" }}
              />
              <span className="league-name">
                {champion.name} <small className="dim">Champion</small>
                {championBeaten && <span className="league-check"> ✓</span>}
              </span>
            </li>
          </ul>
          <button
            type="button"
            onClick={startGauntlet}
            style={{ width: "100%", marginTop: 8 }}
            title="Bails out of any active battle, heals your party, and starts the gauntlet — no healing between fights."
          >
            {eliteCleared && championBeaten ? "Rematch league" : "Begin gauntlet"}
          </button>
          <button
            type="button"
            onClick={openRewardShop}
            style={{ width: "100%", marginTop: 6 }}
            title="Trade Victory Tokens for evolution stones and other utility items"
          >
            Reward Shop · {state.victoryTokens} 🎟
          </button>
        </>
      )}
    </section>
  );
}
