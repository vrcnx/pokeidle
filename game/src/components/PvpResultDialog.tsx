// The end of a battle, and the start of the next one.
//
// WHAT THIS REPLACES. A finished battle dropped an inline bar reading
// "You win!  +17 → 1217  [Back to the game]". That was a dead end, and it is
// the single biggest reason PvP was a thing you did once rather than a thing
// you played. It also got two things wrong that a live battle confirmed: a
// genuine tie rendered as "Battle cancelled" (the verdict derived
// `cancelled = winnerId == null`, so a draw and an abort were the same case),
// and the end reason was dropped for everything except forfeit and timeout, so
// a KO win said nothing about why the battle stopped. Both are fixed in
// utils/pvpResult.ts, which is pure and has a test per branch.
//
// ─── THE LOOP ─────────────────────────────────────────────────────────
//
// PRIMARY ACTION IS "BATTLE AGAIN", and what that means differs honestly by
// opponent:
//
//   * An AI practice battle is one-sided, so it is INSTANT. The team is
//     recovered from the finished room (utils/pvpRematch.ts) and the same AI
//     trainer is requested by id, derived from its seat label. `battle:start`
//     then replaces the room underneath this dialog and the next battle is on
//     screen with no interstitial. The server accepts it because a completed
//     room is skipped by its "one battle per user" walk.
//
//   * A HUMAN rematch needs the other player to agree, and there is no
//     rematch-handshake event on the server (server/ is out of scope for this
//     change, and inventing a client-only one would be a button that cannot
//     work). So it is built on the handshake that already exists and is
//     already two-sided: `battle:invite`. Pressing "Ask for a rematch" sends a
//     real challenge to the same opponent in the same format, they get the
//     normal invite toast, and this dialog shows it PENDING with the server's
//     own 60-second expiry counting down. If they accept, `battle:start` lands
//     and we are in the next battle. If they decline or it expires the server
//     emits `battle:cancelled` with a reason, which the pvp store surfaces as
//     `cancelMessage` — watched below, so a decline is reported rather than
//     hanging. If they are gone, the invite's ack says `"user is offline"` and
//     the button is replaced by the plain statement that they have left.
//
//     Presence cannot be known before asking — there is no presence field on
//     the room — so the design is "ask, then say", not "guess". The one signal
//     that IS available is used: an opponent who was still inside their
//     disconnect grace window when the battle ended cannot be invited, and the
//     button says so instead of pretending.
//
// SECONDARY ACTION IS THE QUEUE, so "again" never has to mean "against the
// same person". It goes to the battle hub, which is where the ranked queue,
// the practice picker and the freshly-updated rating and streak all live —
// reusing that screen rather than building a second front door.
//
// THE EXIT ALWAYS WORKS. "Back to the game" is present in every state,
// including voided, including mid-rematch, and Escape does the same thing. It
// is the only control that clears the room, and clearing the room is what
// resumes the idle game.
//
// WHAT HAPPENS BETWEEN BATTLES, stated because it is a real decision and not an
// oversight: the arena STAYS MOUNTED and the idle game stays parked. The board
// you just fought on is still behind this dialog (dimmed, and "View final
// board" hides the dialog entirely so it can be read, with the summary bar
// keeping a way back), because a player who just lost wants to see how, and the
// rail still has the full transcript and both teams. The idle game is suspended
// while a room exists (App.tsx passes `useIsPvpBattle()` into `useBattleLoop`),
// so it does not resume until the player exits — which is the right trade for a
// decision screen but IS a cost, so the dialog says so out loud rather than
// quietly eating idle progress. Choosing "Battle again" goes straight from one
// battle into the next and the idle loop never wakes at all.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  clearBattleRoom,
  startBotBattle,
  sendBattleInvite,
  usePvpState,
  isBotBattle,
  type BattleRoom,
} from "../state/pvp";
import { useGame } from "../state/GameContext";
import { summarisePvpResult, outcomeClass } from "../utils/pvpResult";
import { botTrainerIdFromLabel, resolveRematchTeam, rematchFormatFor } from "../utils/pvpRematch";
import { displayNarration } from "../utils/pvpNarrationText";
import { openTeamBuilder } from "./TeamBuilderModal";
import { openPvpHub } from "./PvpHubModal";
import { useT } from "../i18n/useT";
import type { Pokemon } from "../types";

/** The server's own invite expiry (socket.ts: `expiresAt: Date.now() + 60_000`).
 *  Mirrored rather than guessed so the countdown cannot outlive the invite. */
const INVITE_TTL_MS = 60_000;

type RematchState =
  | { kind: "idle" }
  | { kind: "sending" }
  /** `sinceCancel` is the value of the store's global `cancelMessage` at the
   *  moment the invite was sent. A decline is a CHANGE from that, not merely a
   *  non-null value: `cancelMessage` is a shared banner with its own 5-second
   *  auto-clear, so a message still on screen from an unrelated cancellation
   *  would otherwise be read as an instant "they declined". */
  | { kind: "pending"; until: number; sinceCancel: string | null }
  | { kind: "gone"; message: string }
  | { kind: "error"; message: string };

export function PvpResultDialog({ room }: { room: BattleRoom }) {
  const t = useT();
  const pvp = usePvpState();
  const { state } = useGame();
  const [showDialog, setShowDialog] = useState(true);
  const [rematch, setRematch] = useState<RematchState>({ kind: "idle" });
  const primaryRef = useRef<HTMLButtonElement | null>(null);

  const summary = useMemo(
    () => summarisePvpResult({
      voided: room.voided,
      format: room.format,
      opponent: room.opponent,
      result: room.result,
      ended: room.view.ended,
    }),
    [room.voided, room.format, room.opponent, room.result, room.view.ended],
  );

  const bot = isBotBattle(room);
  // A voided battle has no opponent state worth trusting — the room it lived in
  // evaporated with the process — so it gets the two exits and no rematch.
  const canRematch = !room.voided;
  // The one presence fact available without asking.
  const opponentDisconnected = !bot && room.opponentAway != null;

  const exit = () => clearBattleRoom();

  // Escape always exits, in every state. `capture` so a nested control cannot
  // swallow it, and it is deliberately the same action as the button rather
  // than "close the dialog" — a dialog you can dismiss into a dead battle
  // screen is the dead end this replaces.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); exit(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  useEffect(() => {
    if (showDialog) primaryRef.current?.focus();
  }, [showDialog]);

  // A pending human rematch resolves one of three ways: they accept (a new
  // battle:start replaces the room and this whole component unmounts), they
  // decline or it expires (battle:cancelled → cancelMessage), or the countdown
  // runs out on our side. The last one exists because a cancel message can be
  // missed — a reload, a socket blip — and a spinner that never stops is worse
  // than an honest "no answer".
  useEffect(() => {
    if (rematch.kind !== "pending") return;
    if (pvp.cancelMessage && pvp.cancelMessage !== rematch.sinceCancel) {
      setRematch({ kind: "error", message: pvp.cancelMessage });
      return;
    }
    const id = window.setTimeout(
      () => setRematch({ kind: "error", message: t("No answer — they didn't accept in time.") }),
      Math.max(0, rematch.until - Date.now()),
    );
    return () => window.clearTimeout(id);
  }, [rematch, pvp.cancelMessage, t]);

  /** The team this battle was fought with, as real save Pokémon. Party first
   *  so a duplicate species resolves to the party copy. */
  const rematchTeam = (): Pokemon[] | null => {
    const roster = room.request?.side?.pokemon ?? [];
    return resolveRematchTeam(roster, [...state.party, ...state.box]);
  };

  const startBot = (team: Pokemon[]) => {
    setRematch({ kind: "sending" });
    startBotBattle(
      team,
      { trainer: botTrainerIdFromLabel(room.opponent.username) ?? undefined },
      (res) => {
        // On success battle:start replaces the room and unmounts this — there
        // is nothing to set. Only the failure needs saying.
        if (!res.ok) {
          setRematch({ kind: "error", message: botErrorText(res.error, t) });
        }
      },
    );
  };

  const onBattleAgain = () => {
    const team = rematchTeam();
    if (!team) {
      // Could not map the roster back onto the save (a Pokémon released
      // between battles, a rename mid-match). Rather than guess a team, hand
      // over to the picker the hub uses — one extra tap, never a wrong team.
      setRematch({ kind: "idle" });
      clearBattleRoom();
      openTeamBuilder({
        mode: "queue",
        onConfirm: (picked) => {
          if (bot) {
            startBotBattle(picked, { trainer: botTrainerIdFromLabel(room.opponent.username) ?? undefined });
          } else {
            sendBattleInvite(room.opponent.id, picked, rematchFormatFor(room.format));
          }
        },
      });
      return;
    }
    if (bot) { startBot(team); return; }

    setRematch({ kind: "sending" });
    const sinceCancel = pvp.cancelMessage;
    sendBattleInvite(room.opponent.id, team, rematchFormatFor(room.format), (res) => {
      if (res.ok) {
        setRematch({ kind: "pending", until: Date.now() + INVITE_TTL_MS, sinceCancel });
        return;
      }
      const gone = res.error === "user is offline" || res.error === "user not found";
      setRematch(
        gone
          ? { kind: "gone", message: t("They've left the game — no rematch this time.") }
          : { kind: "error", message: inviteErrorText(res.error, t) },
      );
    });
  };

  const onFindOpponent = () => {
    clearBattleRoom();
    openPvpHub();
  };

  const cls = outcomeClass(summary.outcome);
  const lastLine = room.narration.length > 0
    ? displayNarration(room.narration[room.narration.length - 1], room.view)
    : null;

  // The summary bar. Always rendered, so the action area is never empty and
  // there is always a way back to the dialog after "View final board".
  const bar = (
    <div className={`pvp2-result ${cls}`} role="status">
      <strong className="pvp2-result-verdict">{t(summary.headline)}</strong>
      {summary.delta != null && (
        <span className={`pvp2-result-delta ${summary.delta >= 0 ? "up" : "down"}`}>
          {summary.delta >= 0 ? "+" : ""}{summary.delta}
          <small className="dim"> → {summary.rating}</small>
        </span>
      )}
      {!showDialog && (
        <button className="g-btn-primary g-btn-small" onClick={() => setShowDialog(true)}>
          {t("Show result")}
        </button>
      )}
      <button className="g-btn-ghost g-btn-small" onClick={exit}>{t("Back to the game")}</button>
    </div>
  );

  if (!showDialog) return bar;

  return (
    <>
      {bar}
      <div className="pvp2-result-overlay modal-overlay">
        <div
          className={`g-modal pvp2-result-dialog outcome-${cls}`}
          role="dialog"
          aria-modal="true"
          aria-label={t("Battle result")}
          onClick={(e) => e.stopPropagation()}
        >
          {/* ONE verdict. This carried both "You lose." and a DEFEAT chip —
              the same fact twice, competing for the same glance, with the chip
              shouting it in a register the sentence had already covered. The
              sentence wins: it is the human phrasing, and the outcome colour
              carries the rest without a second element saying it again. */}
          <header className="g-modal-head pvp2-result-head">
            <h2>{t(summary.headline)}</h2>
            <p className="pvp2-result-reason">{t(summary.reasonText)}</p>
          </header>

          <div className="g-modal-body pvp2-result-body">
            {/* The rating, and only when there IS one. A rated result gets
                the number at full size, because it is the thing the player
                came for. An unrated one gets a single quiet line — it used to
                get a bordered panel of its own, a caveat with a hero's
                treatment, sitting louder than the result above it. */}
            {summary.rated && summary.delta != null ? (
              <div className="pvp2-result-rating is-rated">
                <span className={`pvp2-result-delta big ${summary.delta >= 0 ? "up" : "down"}`}>
                  {summary.delta >= 0 ? "+" : ""}{summary.delta}
                </span>
                <span className="pvp2-result-rating-now">
                  {t("Rating")} <strong>{summary.rating}</strong>
                </span>
                <small className="dim">{t(summary.ratedNote)}</small>
              </div>
            ) : (
              // Still said. An unrated result with nothing stated reads as
              // "the rating update failed", which is the bug this line exists
              // to prevent — it just does not need a box around it.
              <p className="pvp2-result-unrated dim small">{t(summary.ratedNote)}</p>
            )}

            {/* ONE row of facts, not four tiles. As a grid these wrapped 3+1
                at dialog width and read as four separate findings; they are
                one sentence about how the battle went. The two standings sit
                together because the comparison IS the meaning — "3/6" on its
                own says nothing. */}
            <div className="pvp2-result-facts">
              <span className="pvp2-fact">
                <span className="dim">{t("vs")}</span>
                <strong>{room.opponent.username}</strong>
                {bot && <span className="pvp2-ai-chip">{t("AI")}</span>}
              </span>
              <span className="pvp2-fact">
                <strong>{room.view.turn > 0 ? room.view.turn : "—"}</strong>
                <span className="dim">{t("turns")}</span>
              </span>
              <span className="pvp2-fact">
                <strong>{standing(room.view.you)}</strong>
                <span className="dim">{t("left, to their")}</span>
                <strong>{standing(room.view.foe)}</strong>
              </span>
            </div>

            {lastLine && <p className="pvp2-result-last">{lastLine}</p>}

            <RematchNotice
              state={rematch}
              bot={bot}
              opponent={room.opponent.username}
              disconnected={opponentDisconnected}
            />

          </div>

          {/* ── ONE PRIMARY, THEN THE WAYS OUT ────────────────────────
              This was four ghost buttons on a single row, styled identically,
              and at dialog width the leftmost was clipped off the edge. Four
              equal-weight choices is no choice at all: the player wants to go
              again, and everything else is a way out.

              So the rematch is the only thing that looks like a button, on its
              own row where nothing can crop it, and the three exits are a row
              of quiet links beneath — still one tap each, no longer competing
              with the action or with one another. */}
          <footer className="g-modal-foot pvp2-result-foot">
            {canRematch && (
              <button
                ref={primaryRef}
                className="g-btn-primary pvp2-result-primary"
                disabled={
                  rematch.kind === "sending"
                  || rematch.kind === "pending"
                  || rematch.kind === "gone"
                  || opponentDisconnected
                }
                onClick={onBattleAgain}
              >
                {rematch.kind === "sending" ? t("Setting up…")
                  : rematch.kind === "pending" ? t("Waiting for their answer…")
                  : bot ? t("Battle again")
                  : t("Ask for a rematch")}
              </button>
            )}
            <div className="pvp2-result-exits">
              <button className="pvp2-result-exit" onClick={onFindOpponent}>
                {t("Find another opponent")}
              </button>
              <button className="pvp2-result-exit" onClick={() => setShowDialog(false)}>
                {t("View final board")}
              </button>
              <button className="pvp2-result-exit" onClick={exit}>
                {t("Back to the game")}
              </button>
            </div>
            {/* Housekeeping, as small print under the actions — it was a
                paragraph in the body, competing with the result itself. */}
            <p className="pvp2-result-idle dim small">
              {t("Your idle game is paused while this is open — leaving resumes it.")}
            </p>
          </footer>
        </div>
      </div>
    </>
  );
}

/** "3 of 6 still standing" — from the decoded benches, so it counts what the
 *  protocol actually revealed rather than assuming six. */
function standing(side: { bench: { fainted: boolean }[]; teamSize: number }): string {
  const known = side.bench.length;
  const total = Math.max(known, side.teamSize || known);
  if (total === 0) return "—";
  const alive = side.bench.filter((b) => !b.fainted).length + Math.max(0, total - known);
  return `${alive} / ${total}`;
}

/** Everything the rematch flow has to say, in one place, so no state can be
 *  represented by an absent message. */
function RematchNotice({
  state, bot, opponent, disconnected,
}: {
  state: RematchState;
  bot: boolean;
  opponent: string;
  disconnected: boolean;
}) {
  const t = useT();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (state.kind !== "pending") return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [state.kind]);

  if (disconnected) {
    return (
      <p className="pvp2-rematch-note warn">
        {opponent} {t("lost connection, so a rematch isn't possible right now.")}
      </p>
    );
  }
  switch (state.kind) {
    case "pending": {
      const left = Math.max(0, Math.ceil((state.until - now) / 1000));
      return (
        <p className="pvp2-rematch-note pending" role="status">
          {t("Rematch sent —")} {opponent} {t("has")} {left}s {t("to accept.")}
        </p>
      );
    }
    case "gone":
      return <p className="pvp2-rematch-note warn" role="status">{state.message}</p>;
    case "error":
      return <p className="pvp2-rematch-note bad" role="status">{state.message}</p>;
    case "sending":
      return (
        <p className="pvp2-rematch-note pending" role="status">
          {bot ? t("Setting up the next battle…") : t("Sending the rematch challenge…")}
        </p>
      );
    default:
      return bot
        ? null
        : (
          <p className="pvp2-rematch-note dim small">
            {t("A rematch is an invite — they have to accept it.")}
          </p>
        );
  }
}

function botErrorText(error: string | undefined, t: (k: string) => string): string {
  switch (error) {
    case "already in a battle": return t("You're still in another battle.");
    case "rate_limited": return t("Too many battles too quickly — give it a moment.");
    case "server_restarting": return t("The server is restarting — try again shortly.");
    case "stream_restricted": return t("Practice battles are disabled on this account.");
    default: return error ? `${t("Couldn't start the battle:")} ${error}` : t("Couldn't start the battle.");
  }
}

function inviteErrorText(error: string | undefined, t: (k: string) => string): string {
  switch (error) {
    case "already in a battle": return t("They're already in another battle.");
    case "rate_limited": return t("Too many invites too quickly — give it a moment.");
    case "server_restarting": return t("The server is restarting — try again shortly.");
    case "bad target": return t("That opponent can't be challenged.");
    default: return error ? `${t("Couldn't send the rematch:")} ${error}` : t("Couldn't send the rematch.");
  }
}
