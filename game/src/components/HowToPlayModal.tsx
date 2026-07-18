import { useEffect, useState } from "react";
import { useGame } from "../state/GameContext";
import { useT } from "../i18n/useT";
import type { GameState } from "../types";

// How to play.
//
// Two ways in, exactly like the What's-New modal:
//   1. Automatically, ONCE, for a genuinely new player — right after they
//      pick their starter and land in the game.
//   2. On demand from Settings → "How to play", any time.
//
// Getting the auto-show right has the same shape as the changelog's
// brand-new-player rule, inverted:
//   * It must fire for a NEW player and NEVER again — not next session, not
//     next update. A dismiss (or just having seen it) is permanent until
//     they reopen it themselves.
//   * It must NOT ambush the ~1,780 existing players on their next load.
//     They have no "seen" flag either, so the flag alone can't tell a new
//     player from an old one. We also require the save to look brand-new
//     (no battles won, no gyms, at most the starter in the dex). An
//     existing player fails that check; a player who just started passes.

const SEEN_KEY = "pokemon-idle-howtoplay-seen";

function readSeen(): boolean {
  try { return localStorage.getItem(SEEN_KEY) === "1"; } catch { return false; }
}
function writeSeen() {
  try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* private mode */ }
}

// Has this player done essentially nothing yet? True only in the sliver of
// time between picking a starter and winning a first battle — precisely the
// new-player window, and never true for anyone with real progress.
function isBrandNewPlayer(s: GameState): boolean {
  return (s.wildBattlesWon ?? 0) === 0
    && (s.trainerBattlesWon ?? 0) === 0
    && (s.defeatedGyms?.length ?? 0) === 0
    && (s.pokedexCaught?.length ?? 0) <= 1;
}

let _open: (() => void) | null = null;
/** Open the how-to-play guide on demand (from Settings). */
export function openHowToPlay() { _open?.(); }

interface Step {
  icon: string;
  title: string;
  body: string;
}
const STEPS: Step[] = [
  {
    icon: "⚔️",
    title: "Battles run themselves",
    body: "Your lead Pokémon fights wild encounters automatically. Sit back and watch, or speed it up — this is an idle game, so it plays even while you read this.",
  },
  {
    icon: "🔴",
    title: "Catch as you go",
    body: "Auto-catch throws a Poké Ball at what you want. Stock up at the Mart, and tune exactly what to catch in Catch Settings.",
  },
  {
    icon: "📈",
    title: "Grow your team",
    body: "Wins give EXP. Pokémon level up, learn moves, and evolve. Keep six strong ones in your party; the rest wait in the PC box.",
  },
  {
    icon: "🗺️",
    title: "Explore outward",
    body: "Clear a route to unlock the next town — new Pokémon, better gear, tougher fights. Travel from the location panel.",
  },
  {
    icon: "🏅",
    title: "Beat gyms, become Champion",
    body: "Eight Gym Leaders, then the Elite Four. Badges are the backbone of your progress — the whole map opens up as you win them.",
  },
  {
    icon: "🌐",
    title: "You're not alone",
    body: "Trade with other trainers, battle them in PvP, and enter free giveaways. Your progress saves automatically, on every device.",
  },
];

export function HowToPlayModal() {
  const { state } = useGame();
  const [open, setOpen] = useState(false);
  const t = useT();

  // On-demand opener wiring.
  useEffect(() => {
    _open = () => setOpen(true);
    return () => { _open = null; };
  }, []);

  // Auto-show once for a genuinely new player. GameShell (which mounts this)
  // mounts fresh the moment a player leaves starter select, so this []-deps
  // effect runs exactly at "new player just entered the game".
  useEffect(() => {
    if (readSeen()) return;
    if (!state.playerPokemon) return;
    if (!isBrandNewPlayer(state)) {
      // An existing player predating this feature. Mark seen so they are
      // never shown it, and it can't fire later if their state churns.
      writeSeen();
      return;
    }
    writeSeen();   // exactly-once, even across a reload mid-read
    setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div
        className="g-modal howto-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t("How to play")}
      >
        <header className="howto-head">
          <div className="howto-head-text">
            <span className="howto-eyebrow">{t("Welcome, trainer")}</span>
            <h2>{t("How to play")}</h2>
          </div>
          <button className="g-modal-close" onClick={() => setOpen(false)} aria-label={t("Close")}>×</button>
        </header>

        <p className="howto-intro">
          {t("The basics in thirty seconds. You can reopen this any time from Settings.")}
        </p>

        <ol className="howto-steps">
          {STEPS.map((s) => (
            <li key={s.title} className="howto-step">
              <span className="howto-step-icon" aria-hidden>{s.icon}</span>
              <div className="howto-step-text">
                <h3>{t(s.title)}</h3>
                <p>{t(s.body)}</p>
              </div>
            </li>
          ))}
        </ol>

        <footer className="howto-foot">
          <button className="g-btn-primary howto-dismiss" onClick={() => setOpen(false)}>
            {t("Start playing")}
          </button>
        </footer>
      </div>
    </div>
  );
}
