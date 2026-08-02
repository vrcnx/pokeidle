import { useState, useEffect, useRef } from "react";
import { useGame } from "../state/GameContext";
import { routes } from "../data/routes";
import { encounters } from "../data/encounters";
import { REPEL_IDS } from "../utils/encounters";
import { BALL_ORDER, getItemInfo } from "../utils/items";
import { pokeballs } from "../data/pokeballs";
import { pokemonTable } from "../data/pokemon";
import { itemSpriteUrl } from "../utils/sprites";
import { PokemonSprite, TrainerSprite } from "./Sprite";
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
import type { ActiveEffect, BossBattle } from "../types";
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

  // The League and Gym cards belong to the LOCATION, not to the phase, so they
  // live here rather than inside the town/trainer panels. They used to be
  // rendered by both IdleTownPanel and BattleTrainerPanel — different component
  // types at the same position, so every time a town auto-battle started or
  // ended React unmounted the cards and mounted fresh ones. In a town with
  // back-to-back trainers (Blackthorn is the worst) that reads as a constant
  // flicker. Rendering them once, above the phase switch, keeps them mounted
  // across the swap.
  const showsLocationCards = phase === "idle-town" || phase === "battle-trainer";
  const leader = getGymLeaderForLocation(state.currentLocation);
  const hasGym = !!(leader && leader.name);
  const atLeague = isLeagueLocation(state.currentLocation);

  return (
    <div className="context-panel">
      <div className="context-panel-body">
        {showsLocationCards && atLeague && <LeagueCard />}
        {showsLocationCards && hasGym && <GymLeaderCard />}
        {/* Wild battles use the same route rendering as idle so the panel
            doesn't flicker between encounters at higher speeds. Manual ball
            throws live in the moves-panel "⋯ → Catch" popover. */}
        {(phase === "battle-wild" || phase === "idle-route") && <IdleRoutePanel />}
        {phase === "battle-trainer" && <BattleTrainerPanel />}
        {phase === "battle-boss" && <BattleBossPanel />}
        {phase === "idle-town" && <IdleTownPanel />}
        {/* The raid picker that used to live here is gone. Raids are chosen
            from the Map's Raids tab, which shows every tier with its lineup
            and does the travelling — so this was a second picker for the
            same six tiers, reachable only by standing in the one place the
            other picker sends you. And a raid puts you back where it found
            you now (useRaidReturn), so idling here is rare. */}
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
        <TrainerSprite
          spriteKey={leader.spriteKey}
          alt={leader.name}
          width={48}
          height={48}
          style={{ imageRendering: "pixelated" }}
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

  // The League + Gym cards are rendered by ContextPanel for this phase, so the
  // player can still punch through to the gauntlet or the gym challenge mid
  // town-battle. This branch only decides how the OPPONENT is presented: in a
  // gym/League town the trainers arrive back-to-back, so the card is plain
  // text that updates in place rather than a sprite card that re-runs its
  // fade-in on every swap.
  if (atLeague || hasGym) {
    return (
      <>
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
        <TrainerSprite
          spriteKey={t.spriteKey}
          alt={t.trainerName}
          width={48}
          height={48}
          style={{ imageRendering: "pixelated" }}
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
        <TrainerSprite
          spriteKey={b.spriteKey}
          alt={b.trainerName}
          width={56}
          height={56}
          style={{ imageRendering: "pixelated" }}
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
// them — especially for a rare spawn their catch rules would skip. Shows for
// the whole time the player is on a route, live encounter or not.
function ManualCatchSection() {
  const { state, dispatch } = useGame();
  const t = useT();
  // Deliberately NOT gated on there being a live encounter. This box used to
  // unmount between wild battles, so on a route it vanished and reappeared
  // every few seconds — the whole right column jumped with it. It stays put
  // now and the buttons carry the state instead.
  const target = state.phase === "battle" ? state.enemyPokemon : null;
  // A throw is already in the air — queueing another would burn a second ball
  // against an outcome that's already decided.
  const throwing = !!state.catchAnim;
  // A fainted target can't be caught by anything, Master Ball included, so a
  // throw at one was a guaranteed wasted ball.
  const fainted = !!target && target.currentHp <= 0;
  const canThrow = !!target && !fainted && !throwing;
  const hpPct = target
    ? Math.max(0, Math.round((target.currentHp / target.maxHp) * 100))
    : 0;

  return (
    <section className="ctx-section manual-catch ctx-fade-in">
      <h3 className="ctx-h3">
        {t("Throw a ball")}
        <span className="dim small" style={{ marginLeft: 6 }}>
          {!target
            ? t("no wild Pokémon right now")
            : fainted
            ? `${target.name} · ${t("fainted")}`
            : `${target.name} · ${hpPct}% HP`}
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
              disabled={owned <= 0 || !canThrow}
              title={
                owned <= 0 ? t("You have none of these")
                : !target ? t("Wait for a wild Pokémon to appear")
                : fainted ? t("It has fainted — a ball would be wasted")
                : `${ball.name} ×${owned}`
              }
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
      {/* The League + Gym cards are rendered by ContextPanel for this phase —
          see the note there. `showsSomething` still tracks whether they were
          shown, since it decides whether this town needs the empty-state copy
          below. */}
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

// IdleRaidPanel — the arrival picker — was here. ~280 lines of tier cards,
// per-tier cooldown timers, a lineup table and a live ticker, all of it a
// second implementation of what the Map's Raids tab now does, reachable only
// by standing in the one place that tab sends you to. Deleted rather than
// left unmounted: dead UI that still compiles is dead UI somebody maintains.
//
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

  // Active repel/honey effects keyed by species. Keep the effect itself, not
  // just a flag, so the badge can name the tier that's running and how many
  // battles are left instead of a bare "R".
  const effects: Record<string, { repel?: ActiveEffect; honey?: ActiveEffect }> = {};
  for (const e of state.activeEffects) {
    if (e.routeKey !== routeKey) continue;
    if (!effects[e.speciesKey]) effects[e.speciesKey] = {};
    if (REPEL_IDS.has(e.itemId)) effects[e.speciesKey].repel = e;
    if (e.itemId === "honey") effects[e.speciesKey].honey = e;
  }
  const effectLabel = (e: ActiveEffect): string =>
    `${getItemInfo(e.itemId).name} · ${e.battlesRemaining.toLocaleString()} ${t("battles left")}${e.paused ? ` (${t("paused")})` : ""}`;
  // Which effect the cell's badge should speak for. Whatever is actually
  // APPLYING wins: pausing the repel is the supported way to free a species
  // for honey, and the badge used to take the repel unconditionally — so the
  // live honey showed up as a greyed-out "R". Both applying at once is only
  // reachable on saves written before USE_EFFECT_ITEM refused the pair, and
  // it means neither is doing anything, so it gets its own badge rather than
  // being reported as one of them.
  const badgeFor = (eff: { repel?: ActiveEffect; honey?: ActiveEffect }) => {
    const live = [eff.repel, eff.honey].filter((e): e is ActiveEffect => !!e && !e.paused);
    const shown = live[0] ?? eff.repel ?? eff.honey;
    if (!shown) return null;
    const conflict = live.length > 1;
    const kind = conflict ? "conflict" : REPEL_IDS.has(shown.itemId) ? "repel" : "honey";
    const title = [eff.repel, eff.honey]
      .filter((e): e is ActiveEffect => !!e)
      .map(effectLabel)
      .join(" · ");
    return {
      kind,
      paused: !!shown.paused,
      text: conflict ? "!" : kind === "repel" ? "R" : "H",
      title: conflict
        ? `${title} — ${t("these cancel each other out")}`
        : title,
    };
  };

  return (
    // --grow: the one card in the route phases allowed to absorb the
    // column's leftover height. It is also the one whose height varies most
    // (2 species on some routes, 21 in the Safari Zone), so growing it means a
    // short route fills the column instead of leaving a gap, and a long one
    // scrolls inside its own card rather than pushing the catch card away.
    // Exactly one flexible sibling — see the growth policy in app.css.
    <section className="ctx-section ctx-section--grow">
      <header className="ctx-row-head">
        {/* WHERE, not just what. "Wild Pokémon" alone described this card
            without ever saying which route it was describing — and the list
            underneath changes completely when you travel, so the one fact
            that makes it readable was the one fact missing. The name is on
            the map, in the goal card and in the battle log, but never beside
            the encounter table it belongs to. */}
        <h4>
          {t("Wild Pokémon")}
          <span className="ctx-row-head-where">{routes[routeKey]?.name ?? routeKey}</span>
        </h4>
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
          const badge = badgeFor(eff);
          return (
            <button
              key={e.speciesKey}
              className={`wild-cell rarity-border-${rarity} ${seen ? "seen" : "unknown"} ${caught ? "caught" : ""} ${selected === e.speciesKey ? "selected" : ""}`}
              onClick={() =>
                setSelected((cur) => (cur === e.speciesKey ? null : e.speciesKey))
              }
              title={seen ? `${sp.name} · ${ratePct.toFixed(1)}%` : "???"}
            >
              <PokemonSprite
                speciesKey={e.speciesKey}
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
              {badge && (
                <span
                  className={`wild-effect-badge ${badge.kind}${badge.paused ? " paused" : ""}`}
                  title={badge.title}
                >
                  {badge.text}
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
            <ul className="dim unlock-endgame">
              <li>{t("Battle legendaries at ")}<strong>{t("Raid Island")}</strong>{t(" (top-right of the map).")}</li>
              <li>{t("Spend Victory Tokens at the ")}<strong>{t("Reward Shop")}</strong>.</li>
              {/* This is the prompt players follow to the end of the game, so
                  it names the actual reward and where it lands. It used to
                  promise "the Shiny Charm" for a charm that was never granted
                  and never appeared anywhere the player could see. */}
              <li>{t("Finish the Pokédex — catch every obtainable species and the ")}<strong>{t("Shiny Charm")}</strong>{t(" goes straight into your Bag (double shiny rate).")}</li>
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
                  <TrainerSprite
                    spriteKey={m.spriteKey}
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
              <TrainerSprite
                spriteKey={champion.spriteKey}
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
