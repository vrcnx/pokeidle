import { useEffect, useState } from "react";
import { useGame } from "../state/GameContext";
import { PokemonSprite } from "./Sprite";
import { useModalEnter } from "../utils/animate";
import { useT } from "../i18n/useT";
import type { Pokemon } from "../types";

// Modal for picking a 1-6 Pokémon team for PvP. Selection is constrained
// to the player's actual party + box — no fabricated mons. The same
// modal is reused for: (1) sending a battle invite, (2) accepting an
// incoming invite, (3) entering the random matchmaking queue, and
// (4) joining a tournament. The caller passes a `mode` for the title
// and a callback that receives the picked team.
//
// Module-scoped open()/close() actions so any component (TrainerCard,
// invite toast, dock buttons) can launch the picker without prop-
// drilling. Same pattern as openPokemonDetail.

export type TeamBuilderMode = "invite" | "accept" | "queue" | "tournament";

interface OpenRequest {
  mode: TeamBuilderMode;
  /** Optional level cap to display alongside each row, e.g. "Lv 50 cap"
   *  for random matchmaking or whatever the tournament admin set. The
   *  server ultimately enforces the cap; this is just for UX clarity. */
  levelCap?: number;
  /** What to do once the user confirms a team. Receives the chosen
   *  Pokémon objects in selection order. */
  onConfirm: (team: Pokemon[]) => void;
  /** Optional cancel hook for flows that need to know the user
   *  bailed (e.g., decline an incoming invite). */
  onCancel?: () => void;
}

let _request: OpenRequest | null = null;
const _listeners = new Set<(r: OpenRequest | null) => void>();

export function openTeamBuilder(req: OpenRequest): void {
  _request = req;
  _listeners.forEach((l) => l(req));
}
export function closeTeamBuilder(): void {
  _request = null;
  _listeners.forEach((l) => l(null));
}

function useRequest(): OpenRequest | null {
  const [r, setR] = useState<OpenRequest | null>(_request);
  useEffect(() => {
    _listeners.add(setR);
    return () => { _listeners.delete(setR); };
  }, []);
  return r;
}

/**
 * The builder itself - two columns, no dialog chrome.
 *
 * Left: the team you are taking, in order. Right: everything you own. It
 * used to be one column of full-width rows above a five-across grid, so the
 * thing you were BUILDING and the parts you were building it from could not
 * be on screen together - every pick was a scroll up to see what it did.
 */
export function TeamBuilderPane({
  levelCap, onConfirm, onCancel,
}: {
  levelCap?: number;
  onConfirm: (team: Pokemon[]) => void;
  onCancel: () => void;
}) {
  const { state } = useGame();
  const t = useT();
  // Selected Pokémon ids — order matters for lead vs. bench. We store
  // ids rather than indices because the box can be re-sorted.
  const [picked, setPicked] = useState<string[]>([]);
  /** Filters the pool only. The team column is six rows and never needs it. */
  const [query, setQuery] = useState("");

  // Pre-fill with the player's current party on every fresh open. The
  // common flow is "Battle Hub → Ready Up → confirm my usual team",
  // so requiring six taps to re-pick what's already in the party was
  // friction the operator flagged. Order matches party order so the
  // lead stays the lead. The player can deselect / swap in box mons
  // before confirming. Re-runs on each new request (not on party
  // changes mid-modal) so toggling a row doesn't bounce back.
  useEffect(() => {
    setPicked(state.party.slice(0, 6).map((p) => p.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const all = [
    ...state.party.map((p) => ({ source: "party" as const, mon: p })),
    ...state.box.map((p) => ({ source: "box" as const, mon: p })),
  ];

  // Name, nickname or species — whichever the player is thinking in. A box
  // runs to hundreds of rows in production, and scrolling a grid to find one
  // Pokémon is the whole reason this screen felt like work.
  const q = query.trim().toLowerCase();
  const pool = q
    ? all.filter(({ mon }) =>
        (mon.nickname ?? "").toLowerCase().includes(q) ||
        mon.name.toLowerCase().includes(q) ||
        mon.speciesKey.toLowerCase().includes(q))
    : all;

  const toggle = (id: string) => {
    setPicked((cur) => {
      if (cur.includes(id)) return cur.filter((x) => x !== id);
      if (cur.length >= 6) return cur; // hard cap at 6
      return [...cur, id];
    });
  };

  const move = (id: string, dir: -1 | 1) => {
    setPicked((cur) => {
      const i = cur.indexOf(id);
      if (i < 0) return cur;
      const j = i + dir;
      if (j < 0 || j >= cur.length) return cur;
      const next = [...cur];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const confirm = () => {
    const team: Pokemon[] = picked
      .map((id) => all.find((x) => x.mon.id === id)?.mon)
      .filter((p): p is Pokemon => !!p);
    if (team.length < 1) return;
    onConfirm(team);
  };

  const ready = picked.length >= 1;

  return (
    <div className="tb-pane">
        <div className="tb-body">
          {levelCap != null && (
            <p className="dim small team-builder-cap">
              {t("Levels in this match are capped to")} <strong>{t("Lv")} {levelCap}</strong>
              {t(". Your saved Pokémon are unchanged.")}
            </p>
          )}

          <div className="tb-cols">
          {/* LEFT: what you are taking, in order. */}
          <section className="g-card team-builder-strip">
            <h3>{t("Your team")} <span className="dim small">({picked.length}/6)</span></h3>
            {picked.length === 0 ? (
              <p className="dim small team-builder-empty">
                {t("Tap up to 6 Pokémon below. The first one you pick is sent out first.")}
              </p>
            ) : (
              <ol className="team-builder-strip-list">
                {picked.map((id, i) => {
                  const entry = all.find((x) => x.mon.id === id);
                  if (!entry) return null;
                  const p = entry.mon;
                  return (
                    <li key={id} className="team-builder-strip-item">
                      <span className="team-builder-slot">{i + 1}</span>
                      <PokemonSprite
                        speciesKey={p.speciesKey}
                        isShiny={!!p.isShiny}
                        alt=""
                        width={40}
                        height={40}
                        style={{ imageRendering: "pixelated" }}
                      />
                      <div className="team-builder-strip-info">
                        <strong>{p.nickname ?? p.name}{p.isShiny ? " ✨" : ""}</strong>
                        <small className="dim">
                          {levelCap != null && p.level > levelCap
                            ? <>{t("Lv")} {p.level} <span className="tb-capped">{"→"} {levelCap}</span></>
                            : <>{t("Lv")} {p.level}</>}
                        </small>
                      </div>
                      <div className="team-builder-strip-actions">
                        <button
                          className="g-btn-ghost g-btn-tiny"
                          onClick={() => move(id, -1)}
                          disabled={i === 0}
                          title={t("Move up")}
                        >↑</button>
                        <button
                          className="g-btn-ghost g-btn-tiny"
                          onClick={() => move(id, +1)}
                          disabled={i === picked.length - 1}
                          title={t("Move down")}
                        >↓</button>
                        <button
                          className="g-btn-ghost g-btn-tiny"
                          onClick={() => toggle(id)}
                          title={t("Remove")}
                        >×</button>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          {/* RIGHT: everything you own, beside the team rather than under
              it, so a pick and its effect are visible at the same time. */}
          <section className="g-card team-builder-pool">
            <div className="tb-pool-head">
              <h3>{t("Pick from your party + box")}</h3>
              <input
                type="search"
                className="tb-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("Search %n Pokémon").replace("%n", String(all.length))}
                aria-label={t("Search your Pokémon")}
              />
            </div>
            <div className="team-builder-pool-grid">
              {all.length === 0 && <p className="dim">{t("No Pokémon yet.")}</p>}
              {all.length > 0 && pool.length === 0 && (
                <p className="dim small tb-noresults">
                  {t("Nothing matches")} “{query}”.
                </p>
              )}
              {pool.map(({ source, mon }) => {
                const sel = picked.includes(mon.id);
                const slotNum = sel ? picked.indexOf(mon.id) + 1 : null;
                return (
                  <button
                    key={mon.id}
                    type="button"
                    className={`team-builder-pool-card ${sel ? "selected" : ""}`}
                    onClick={() => toggle(mon.id)}
                    title={`${mon.nickname ?? mon.name} · Lv ${mon.level} · ${source}`}
                  >
                    <PokemonSprite
                      speciesKey={mon.speciesKey}
                      isShiny={!!mon.isShiny}
                      alt=""
                      width={48}
                      height={48}
                      style={{ imageRendering: "pixelated" }}
                    />
                    <strong>{mon.nickname ?? mon.name}{mon.isShiny ? " ✨" : ""}</strong>
                    <small className="dim">{t("Lv")} {mon.level} · {source}</small>
                    {sel && <span className="team-builder-pool-slot">{slotNum}</span>}
                  </button>
                );
              })}
            </div>
          </section>
          </div>
        </div>

        <footer className="tb-foot">
          <button className="g-btn-ghost" onClick={onCancel}>{t("Cancel")}</button>
          <span className="tb-foot-spacer" />
          <button
            className="g-btn-primary"
            onClick={confirm}
            disabled={!ready}
            title={ready ? undefined : t("Pick at least one Pokémon.")}
          >
            {t("Confirm team")}
          </button>
        </footer>
    </div>
  );
}

/**
 * The modal wrapper, for callers OUTSIDE the hub - an incoming battle
 * invite, a rematch from the result dialog, a challenge from a trainer
 * card. Those arrive while the player is doing something else, so they
 * need their own overlay.
 *
 * Inside the hub the same builder renders as a pane, because stacking a
 * second dialog on top of the one dialog the hub exists to be is exactly
 * the pile the hub replaced.
 */
export function TeamBuilderModal() {
  const req = useRequest();
  const dialogRef = useModalEnter(".g-card");
  const t = useT();
  if (!req) return null;

  const title =
    req.mode === "invite"     ? t("Pick a team to send")
    : req.mode === "accept"   ? t("Accept battle — pick a team")
    : req.mode === "queue"    ? t("Random battle — pick a team")
    :                            t("Tournament — pick a team");

  return (
    <div className="modal-overlay">
      <div
        ref={dialogRef}
        className="g-modal team-builder-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <header className="g-modal-head">
          <h2>{title}</h2>
          <button
            className="g-modal-close"
            onClick={() => { req.onCancel?.(); closeTeamBuilder(); }}
            aria-label={t("Cancel")}
          >×</button>
        </header>
        <TeamBuilderPane
          levelCap={req.levelCap}
          onConfirm={(team) => { req.onConfirm(team); closeTeamBuilder(); }}
          onCancel={() => { req.onCancel?.(); closeTeamBuilder(); }}
        />
      </div>
    </div>
  );
}
