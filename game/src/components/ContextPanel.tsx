import { useState, useEffect } from "react";
import { useGame } from "../state/GameContext";
import { routes } from "../data/routes";
import { encounters } from "../data/encounters";
import { REPEL_IDS } from "../utils/encounters";
import { BALL_ORDER } from "../utils/items";
import { pokeballs } from "../data/pokeballs";
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
import { regions, regionForLocation, DEFAULT_REGION } from "../data/regions";
import { regionBadgeCount, regionEliteFourCount } from "../utils/unlocks";
import { openRewardShop } from "./RewardShopPanel";
import type { BossBattle } from "../types";
import type { ReactNode } from "react";
import { useT } from "../i18n/useT";

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
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase-specific panels
// ---------------------------------------------------------------------------


// Persistent "Gym Leader" card with the Challenge/Rematch button. Extracted
// so the SAME card renders whether the player is idling in the gym town or
// mid town-trainer battle there — otherwise it vanished for the whole battle
// (reported at Blackthorn, which is also the League town: the League branch
// used to skip the gym card entirely, so Clair "flickered away in between
// battles"). Self-contained — reads the current location. Renders null when
// there is no gym leader here.
function GymLeaderCard() {
  const { state, dispatch } = useGame();
  const t = useT();
  const leader = getGymLeaderForLocation(state.currentLocation);
  if (!leader || !leader.name) return null;
  const defeated = state.defeatedGyms.includes(leader.id);
  const reqBadges = gymBadgeRequirement(leader.id);
  const haveBadges = state.defeatedGyms.length;
  const lockedByBadges = !defeated && reqBadges > haveBadges;
  const challenge = () => {
    if (lockedByBadges) return;
    const { team } = buildTeam(leader.team, `gym_${leader.id}_${Date.now()}`);
    dispatch({
      type: "START_BOSS_BATTLE",
      payload: {
        bossId: leader.id, bossType: "gym", trainerName: leader.name,
        trainerClass: "gym", trainerTeam: team, spriteKey: leader.spriteKey,
      },
    });
  };
  return (
    <section className="ctx-section">
      <h4>{t("Gym Leader")}</h4>
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
          disabled={lockedByBadges}
          onClick={challenge}
          title={
            lockedByBadges
              ? `Earn ${reqBadges} badges before challenging ${leader.name} (you have ${haveBadges})`
              : defeated
              ? t("You've already beaten this gym — challenge again for the rematch")
              : t("Bails out of any active battle, heals your party, and starts the gym fight")
          }
        >
          {lockedByBadges ? `🔒 ${reqBadges} badges` : defeated ? t("Rematch") : t("Challenge")}
        </button>
      </div>
    </section>
  );
}

function BattleTrainerPanel() {
  const { state } = useGame();
  // Named `translate` (not `t`) to avoid shadowing the `trainerBattle`
  // local below, which has used the name `t` throughout this component.
  const translate = useT();
  const t = state.trainerBattle;
  if (!t) return null;

  const atLeague = isLeagueLocation(state.currentLocation);
  const leader = getGymLeaderForLocation(state.currentLocation);
  const hasGym = !!(leader && leader.name);

  // At a gym and/or League town, keep the League + Gym cards on screen even
  // mid town-trainer-battle, so the player can always punch through to the
  // gauntlet or the gym challenge and the cards don't flicker away between
  // the town's rapid auto-battles.
  if (atLeague || hasGym) {
    return (
      <>
        {atLeague && <LeagueCard />}
        {hasGym && <GymLeaderCard />}
        <section className="ctx-section">
          <h4>{translate("Currently battling")}</h4>
          <p className="dim small" style={{ margin: 0 }}>
            <strong>{t.trainerName}</strong> ({t.trainerClass})
          </p>
          <TeamBalls
            total={t.trainerTeam.length}
            spent={t.currentTrainerPokemonIndex}
            label={translate("Their team")}
          />
        </section>
      </>
    );
  }

  // No gym in this location — fall back to the original trainer card.
  return (
    <section className="ctx-section">
      <h4>{translate("Trainer battle")}</h4>
      {/* Keyed on the trainer so React REMOUNTS this card when the opponent
          changes — that's what replays the fade-in. Without a key React
          reuses the node and the new trainer just pops in. */}
      <div className="ctx-trainer-card ctx-trainer-card--enter" key={`${t.trainerName}:${t.spriteKey}`}>
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
        label={translate("Their team")}
      />
    </section>
  );
}

function BattleBossPanel() {
  const { state } = useGame();
  const t = useT();
  const b = state.bossBattle;
  if (!b) return null;
  const queueLeft = state.bossQueue.length;
  return (
    <section className="ctx-section">
      <h4>{b.bossType === "champion" ? t("Champion") : b.bossType === "e4" ? t("Elite Four") : t("Gym Leader")}</h4>
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
        label={t("Their team")}
      />
      {queueLeft > 0 && (
        <p className="dim small" style={{ margin: "6px 0 0" }}>
          {queueLeft}{t(" fight")}{queueLeft === 1 ? "" : "s"}{t(" left in this gauntlet.")}
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
      <ManualCatchSection />
      {enc.length > 0 && <WildPokemonSection routeKey={here} />}
    </>
  );
}

// Manual ball throwing. Auto-catch handles the grind, but players repeatedly
// asked for a way to just throw a ball themselves at whatever is in front of
// them — especially for a rare spawn their catch rules would skip. Only shows
// during a live wild battle.
function ManualCatchSection() {
  const { state, dispatch } = useGame();
  const t = useT();
  if (state.phase !== "battle" || !state.enemyPokemon) return null;
  const target = state.enemyPokemon;
  // A throw is already in the air — queueing another would burn a second ball
  // against an outcome that's already decided.
  const throwing = !!state.catchAnim;
  const hpPct = Math.max(0, Math.round((target.currentHp / target.maxHp) * 100));

  return (
    <section className="ctx-section manual-catch ctx-fade-in">
      <h3 className="ctx-h3">
        {t("Throw a ball")}
        <span className="dim small" style={{ marginLeft: 6 }}>
          {target.name} · {hpPct}% HP
        </span>
      </h3>
      <div className="manual-catch-balls">
        {BALL_ORDER.map((id) => {
          const owned = state.inventory[id] ?? 0;
          const ball = pokeballs[id];
          if (!ball) return null;
          return (
            <button
              key={id}
              className="manual-catch-ball"
              disabled={owned <= 0 || throwing}
              title={owned <= 0 ? t("You have none of these") : `${ball.name} ×${owned}`}
              // TRY_CATCH, not CATCH_POKEMON: the former pre-rolls the
              // result and hands it to the ball-throw animation (arc + three
              // shakes), which is the same path auto-catch uses. Dispatching
              // CATCH_POKEMON resolved the catch instantly, so a manual throw
              // skipped the animation entirely and felt like a free catch.
              onClick={() => dispatch({ type: "TRY_CATCH", payload: { ballId: id } })}
            >
              <img src={itemSpriteUrl(id)} alt="" width={22} height={22} />
              <span>{ball.name}</span>
              <span className="dim">×{owned}</span>
            </button>
          );
        })}
      </div>
      <p className="dim small" style={{ margin: "6px 0 0" }}>
        {t("Weakening it first (and using a better ball) raises the catch rate.")}
      </p>
    </section>
  );
}

function IdleTownPanel() {
  const { state } = useGame();
  const t = useT();
  const here = state.currentLocation;
  const route = routes[here];
  const leader = getGymLeaderForLocation(here);
  const showsSomething = isLeagueLocation(here) || !!(leader && leader.name);

  return (
    <>
      {isLeagueLocation(here) && <LeagueCard />}
      {leader && leader.name && <GymLeaderCard />}
      {/* A town with no gym and no League rendered nothing at all here —
          reads as "the game is broken" rather than "there's nothing to
          do in town, go find a route." Most jarring at New Bark Town
          specifically, since it's a brand-new region's very first stop
          and several players reported it as a bug. */}
      {!showsSomething && (
        <section className="ctx-section">
          <p className="dim small" style={{ margin: 0 }}>
            {t("No gym here — wild Pokémon (and battles) are out on the connected routes.")}
          </p>
          {route?.connections && route.connections.length > 0 && (
            <p className="dim small" style={{ margin: "4px 0 0" }}>
              {t("Try: ")}
              {route.connections.map((id) => routes[id]?.name ?? id).join(", ")}
            </p>
          )}
        </section>
      )}
    </>
  );
}

function IdleRaidPanel() {
  const { state, dispatch } = useGame();
  const t = useT();
  const route = routes[state.currentLocation];

  // Default the picker to the first unlocked tier the player has access
  // to. The user can click any unlocked tier card to switch.
  const firstUnlocked = raidTiersOrdered.find((t) => isTierUnlocked(t, state)) ?? raidTiersOrdered[0];
  const [selectedTier, setSelectedTier] = useState<RaidTierId>(firstUnlocked.id);
  const tier = raidTiersOrdered.find((t) => t.id === selectedTier) ?? firstUnlocked;
  const tierUnlocked = isTierUnlocked(tier, state);

  // Per-tier cooldown — clearing one tier no longer locks every
  // tier. Falls back to the legacy global field for old saves that
  // predate the per-tier map.
  const tierCooldown = state.raidCooldowns?.[selectedTier] ?? 0;
  const legacyCooldown = state.raidCooldownEnd ?? 0;
  const cooldown = Math.max(tierCooldown, 0);
  // Old saves that only have raidCooldownEnd — honor it for the
  // currently-set selectedTier so we don't suddenly unlock raids
  // mid-cooldown for upgrading players. Once any new raid completes
  // the per-tier map takes over.
  const effectiveCooldown = state.raidCooldowns ? cooldown : legacyCooldown;
  const cdLeft = Math.max(0, effectiveCooldown - Date.now());
  const onCooldown = cdLeft > 0;
  const canRaid = !onCooldown && !state.inRaid;

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
          {t("Legendary Raids")}
          <button
            type="button"
            className="ctx-info-btn"
            title={tierInfo}
            aria-label={t("About Legendary Raids")}
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
              <strong>{t("On cooldown")}</strong>
              <span className="raid-cooldown-time">
                {formatCooldown(cdLeft)} <span className="dim">{t("until next raid")}</span>
              </span>
            </div>
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
            aria-label={t("Raid tier")}
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
                ? t("On cooldown")
                : t("Already raiding")
              : !tierUnlocked
                ? tierUnlockHint(tier)
                : `Begin a ${tier.name} raid at Lv. ${tier.startLevel}`
          }
        >
          {t("⚡ Begin raid")}
        </button>

        <div className="raid-lineup-label dim small">
          {t("Possible spawns (")}{lineup.length})
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

// How many badges the player must already own before they're allowed
// to challenge a given gym leader. Most gyms are open from the start
// — the player just needs to physically reach the city. Giovanni is
// the exception: he's positioned in Viridian (which the player can
// reach almost immediately) but is canonically the final gym, so we
// gate him behind 7 prior badges to preserve the intended progression.
function gymBadgeRequirement(leaderId: string): number {
  if (leaderId === "giovanni") return 7;
  return 0;
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
  const t = useT();
  const label =
    state.phase === "healing" ? t("Healing your party…")
    : state.phase === "evolution" ? t("A Pokémon is evolving…")
    : state.phase === "starterSelect" ? t("Pick your starter.")
    : state.phase === "regionStarterSelect" ? t("Pick your starter.")
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
  const t = useT();
  return (
    <div className="ctx-team-balls">
      <span className="dim small">{label}</span>
      <span className="ctx-balls">
        {Array.from({ length: total }, (_, i) => (
          <img
            key={i}
            src={itemSpriteUrl("pokeball")}
            alt={i < spent ? t("fainted") : t("ready")}
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
  const t = useT();
  const enc = encounters[routeKey]?.encounters ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const totalWeight = enc.reduce((s, e) => s + e.weight, 0);

  // Active repel/honey effects keyed by species
  const effects: Record<string, { repel?: boolean; honey?: boolean }> = {};
  for (const e of state.activeEffects) {
    if (e.routeKey !== routeKey) continue;
    if (!effects[e.speciesKey]) effects[e.speciesKey] = {};
    if (REPEL_IDS.has(e.itemId)) effects[e.speciesKey].repel = true;
    if (e.itemId === "honey") effects[e.speciesKey].honey = true;
  }

  return (
    <section className="ctx-section">
      <header className="ctx-row-head">
        <h4>{t("Wild Pokémon")}</h4>
        <button
          type="button"
          className="ctx-link"
          onClick={() => openCatchSettings(routeKey)}
        >
          {t("Catch settings →")}
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
// which screen they're on. Rendered in the right column above MiniChat
// (was inside ContextPanel previously; moved out so it sits next to
// chat, where the player's eye lands more often).
const UNLOCK_COLLAPSED_KEY = "pokeidle.unlockHint.collapsed";

function readCollapsed(): boolean {
  try { return localStorage.getItem(UNLOCK_COLLAPSED_KEY) === "1"; } catch { return false; }
}

export function UnlockHint() {
  const { state } = useGame();
  const t = useT();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem(UNLOCK_COLLAPSED_KEY, next ? "1" : "0"); } catch { /* */ }
      return next;
    });
  };

  const candidates = Object.values(routes)
    .filter((r) => !state.unlockedLocations.includes(r.id))
    .sort((a, b) => a.unlockOrder - b.unlockOrder);
  const next = candidates[0];
  if (!next) {
    // Player feedback: "lost on what to do after elite 4". Post-Champion
    // surface the actual endgame loops by name (Raid Island for legendary
    // catches, Victory Token reward shop for evo stones + utility) so
    // the player isn't left with a generic "go fill the dex" pat.
    return (
      <section className="ctx-section unlock-hint">
        <h4>{t("Goal")}</h4>
        <strong>{t("All locations unlocked!")}</strong>
        {state.championDefeated ? (
          <>
            <ul style={{ margin: "6px 0 0", paddingLeft: 16, fontSize: 11, lineHeight: 1.5 }} className="dim">
              <li>{t("Battle legendaries at ")}<strong>{t("Raid Island")}</strong>{t(" (top-right of the map).")}</li>
              <li>{t("Spend Victory Tokens at the ")}<strong>{t("Reward Shop")}</strong>.</li>
              <li>{t("Finish the Pokédex — every species still counts toward the Shiny Charm.")}</li>
            </ul>
            {/* Direct affordance — the Reward Shop was previously
                reachable only via the LeagueCard at Indigo Plateau.
                Surfacing it inline here closes the discoverability
                gap surfaced in player feedback. */}
            <button
              type="button"
              className="ctx-link"
              onClick={openRewardShop}
              style={{ marginTop: 8, fontSize: 11 }}
              title={t("Spend Victory Tokens on stones, items, and tokens")}
            >
              {t("Open Reward Shop · ")}{state.victoryTokens} 🎟 →
            </button>
          </>
        ) : (
          <p className="dim small" style={{ margin: "4px 0 0" }}>
            {t("Defeat the Elite Four and become Champion.")}
          </p>
        )}
      </section>
    );
  }
  const reqs = describeRequirements(next.unlock, state);
  const peek = candidates[1];
  // Combined progress for the collapsed pill — average of all
  // requirements (clamped 0..1). Gives the player one number to glance
  // at without expanding the card.
  const overall = reqs.length === 0
    ? 0
    : reqs.reduce((sum, r) => sum + Math.min(1, r.cur / Math.max(1, r.target)), 0) / reqs.length;
  return (
    <section className={`ctx-section unlock-hint ${collapsed ? "collapsed" : ""}`}>
      <button type="button" className="unlock-header" onClick={toggle} aria-expanded={!collapsed}>
        <span className="unlock-header-label">{t("Next Goal")}</span>
        <strong className="unlock-header-target">
          <span className="unlock-target-icon">{iconFor(next.type)}</span>
          <span>{next.name}</span>
        </strong>
        <span className="unlock-header-bar" aria-hidden>
          <span className="unlock-header-bar-fill" style={{ width: `${overall * 100}%` }} />
        </span>
        <span className={`unlock-header-chev ${collapsed ? "" : "open"}`} aria-hidden>▾</span>
      </button>
      {!collapsed && (
        <div className="unlock-body">
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
              {t("After this → ")}<strong>{peek.name}</strong>
            </p>
          )}
        </div>
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

// True at whichever single location hosts a region's League gauntlet
// (Kanto: Indigo Plateau; Johto: Blackthorn City) — every region's E4
// and champion share one locationKey, same as Kanto's own convention.
function isLeagueLocation(locationId: string): boolean {
  const region = regions[regionForLocation(locationId) ?? DEFAULT_REGION];
  return region?.champion?.locationKey === locationId;
}

// League card — Elite Four roster + Champion + a single "Begin gauntlet"
// button that builds the boss queue and dispatches the first fight (the
// rest chain automatically through bossQueue). Region-scoped: shows
// whichever region's own League the player is currently standing in
// (Kanto's Indigo Plateau or Johto's Blackthorn City), not a hardcoded
// Kanto roster — see regionBadgeCount's doc comment for why a raw
// state.defeatedGyms.length would be wrong here once a second region
// exists.
function LeagueCard() {
  const { state, dispatch } = useGame();
  const t = useT();
  const region = regions[regionForLocation(state.currentLocation) ?? DEFAULT_REGION];
  const gymLeaders = region.gymLeaders;
  const eliteFour = region.eliteFour;
  const champion = region.champion!;
  const allBadges = regionBadgeCount(state, region) >= gymLeaders.length;
  const eliteCleared = regionEliteFourCount(state, region) >= eliteFour.length;
  const championBeaten = state.defeatedChampions.includes(champion.id);

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
      <h4>{t("Pokémon League")}</h4>
      {!allBadges ? (
        <p className="dim small" style={{ margin: 0 }}>
          {t("Earn all ")}{gymLeaders.length}{t(" Gym Badges to challenge the Elite Four. (")}{regionBadgeCount(state, region)}/{gymLeaders.length})
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
                {champion.name} <small className="dim">{t("Champion")}</small>
                {championBeaten && <span className="league-check"> ✓</span>}
              </span>
            </li>
          </ul>
          <button
            type="button"
            className="league-gauntlet-btn"
            onClick={startGauntlet}
            title={t("Bails out of any active battle, heals your party, and starts the gauntlet — no healing between fights.")}
          >
            {eliteCleared && championBeaten ? t("Rematch league") : t("Begin gauntlet")}
          </button>
          <button
            type="button"
            onClick={openRewardShop}
            style={{ width: "100%", marginTop: 6 }}
            title={t("Trade Victory Tokens for evolution stones and other utility items")}
          >
            {t("Reward Shop · ")}{state.victoryTokens} 🎟
          </button>
        </>
      )}
    </section>
  );
}
