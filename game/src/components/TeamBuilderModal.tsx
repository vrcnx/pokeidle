import { useEffect, useState } from "react";
import { useGame } from "../state/GameContext";
import { pokemonSpriteUrl } from "../utils/sprites";
import { useModalEnter } from "../utils/animate";
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

// ── Modal ───────────────────────────────────────────────────────────
export function TeamBuilderModal() {
  const req = useRequest();
  const { state } = useGame();
  const dialogRef = useModalEnter(".g-card");
  // Selected Pokémon ids — order matters for lead vs. bench. We store
  // ids rather than indices because the box can be re-sorted.
  const [picked, setPicked] = useState<string[]>([]);

  // Reset selection whenever the modal opens fresh.
  useEffect(() => {
    if (req) setPicked([]);
  }, [req?.mode]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!req) return null;

  const all = [
    ...state.party.map((p) => ({ source: "party" as const, mon: p })),
    ...state.box.map((p) => ({ source: "box" as const, mon: p })),
  ];

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
    req.onConfirm(team);
    closeTeamBuilder();
  };

  const cancel = () => {
    req.onCancel?.();
    closeTeamBuilder();
  };

  const title =
    req.mode === "invite"     ? "Pick a team to send"
    : req.mode === "accept"   ? "Accept battle — pick a team"
    : req.mode === "queue"    ? "Random battle — pick a team"
    :                            "Tournament — pick a team";

  const ready = picked.length >= 1;

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
          <button className="g-modal-close" onClick={cancel} aria-label="Cancel">×</button>
        </header>

        <div className="g-modal-body">
          {req.levelCap != null && (
            <p className="dim small team-builder-cap">
              Levels in this match are capped to <strong>Lv {req.levelCap}</strong>
              . Your saved Pokémon are unchanged.
            </p>
          )}

          {/* Picked-team strip */}
          <section className="g-card g-card-full team-builder-strip">
            <h3>Your team <span className="dim small">({picked.length}/6)</span></h3>
            {picked.length === 0 ? (
              <p className="dim small team-builder-empty">
                Tap up to 6 Pokémon below. The first one you pick is sent out first.
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
                      <img
                        src={pokemonSpriteUrl(p.speciesKey, false, !!p.isShiny)}
                        alt=""
                        width={40}
                        height={40}
                        style={{ imageRendering: "pixelated" }}
                      />
                      <div className="team-builder-strip-info">
                        <strong>{p.nickname ?? p.name}{p.isShiny ? " ✨" : ""}</strong>
                        <small className="dim">Lv {p.level}</small>
                      </div>
                      <div className="team-builder-strip-actions">
                        <button
                          className="g-btn-ghost g-btn-tiny"
                          onClick={() => move(id, -1)}
                          disabled={i === 0}
                          title="Move up"
                        >↑</button>
                        <button
                          className="g-btn-ghost g-btn-tiny"
                          onClick={() => move(id, +1)}
                          disabled={i === picked.length - 1}
                          title="Move down"
                        >↓</button>
                        <button
                          className="g-btn-ghost g-btn-tiny"
                          onClick={() => toggle(id)}
                          title="Remove"
                        >×</button>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          {/* Available pool — party first, then box */}
          <section className="g-card g-card-full team-builder-pool">
            <h3>Pick from your party + box</h3>
            <div className="team-builder-pool-grid">
              {all.length === 0 && <p className="dim">No Pokémon yet.</p>}
              {all.map(({ source, mon }) => {
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
                    <img
                      src={pokemonSpriteUrl(mon.speciesKey, false, !!mon.isShiny)}
                      alt=""
                      width={48}
                      height={48}
                      style={{ imageRendering: "pixelated" }}
                    />
                    <strong>{mon.nickname ?? mon.name}{mon.isShiny ? " ✨" : ""}</strong>
                    <small className="dim">Lv {mon.level} · {source}</small>
                    {sel && <span className="team-builder-pool-slot">{slotNum}</span>}
                  </button>
                );
              })}
            </div>
          </section>
        </div>

        <footer className="g-modal-foot">
          <button className="g-btn-ghost" onClick={cancel}>Cancel</button>
          <span style={{ flex: 1 }} />
          <button
            className="g-btn-primary"
            onClick={confirm}
            disabled={!ready}
            title={ready ? undefined : "Pick at least one Pokémon."}
          >
            Confirm team
          </button>
        </footer>
      </div>
    </div>
  );
}
