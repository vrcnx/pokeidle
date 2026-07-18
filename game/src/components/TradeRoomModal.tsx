import { useEffect, useState } from "react";
import { useGame } from "../state/GameContext";
import {
  useTradeState, setOffer, setLock, cancelTrade, clearRoom, type RoomState, type TradeOffer,
} from "../state/trade";
import { pokemonSpriteUrl, itemSpriteUrl } from "../utils/sprites";
import { itemsCatalog } from "../data/itemsCatalog";
import { useModalEnter } from "../utils/animate";
import { playTradeAnimation } from "./TradeAnimation";
import { openPublicTrainerCard } from "./TrainerCardModal";
import { pushToast } from "./Toast";
import type { Pokemon } from "../types";
import { useT } from "../i18n/useT";

// Live two-sided trade UI. Mounts whenever there's an active room in
// the trade state (set by trade:start from the server after both sides
// accept). The flow:
//
//   1. Pick which mon to send — clicking a party row sets the offer
//      via `trade:offer`; the server broadcasts the update so the
//      other side sees the same picture.
//   2. Lock in — both sides must lock for the trade to commit.
//      Re-picking a mon unlocks both sides automatically.
//   3. When both sides lock with valid offers, the server fires
//      `trade:complete` with the agreed swap. We play the trade
//      animation, then dispatch TRADE_COMPLETE to commit the swap +
//      auto-fire any trade-only evolution.
//
// Either side can cancel at any time.
export function TradeRoomModal() {
  const { room } = useTradeState();
  if (!room) return null;
  return <TradeRoomDialog room={room} />;
}

function TradeRoomDialog({ room }: { room: RoomState }) {
  const { state, dispatch } = useGame();
  const t = useT();
  const dialogRef = useModalEnter(".g-card");
  const [now, setNow] = useState(Date.now());
  // Cancelling a trade was previously instant — clicking the X or the
  // backdrop fired cancelTrade() right away, which meant a stray click
  // on the dimmed area threw away both sides' offers. Now the X / cancel
  // button flips to a confirm state in-place; the user has to click
  // "Yes, cancel" before we actually emit. Backdrop clicks no-op.
  //
  // This hook must stay above the `room.completion` early return below —
  // every hook in this component has to run on every render regardless
  // of which branch we take, or React throws "Rendered fewer hooks than
  // expected" the instant a trade completes (error #300/#310).
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const secondsLeft = Math.max(0, Math.ceil((room.expiresAt - now) / 1000));

  // Drive the cinematic + commit when the server fires trade:complete.
  // We only run this once per completion: the room state is cleared
  // from the trade store after the animation finishes.
  useEffect(() => {
    if (!room.completion) return;
    const c = room.completion;
    const sent = state.party.find((p) => p.id === c.sentMonId)
      ?? state.box.find((p) => p.id === c.sentMonId);
    const sentName = sent?.nickname ?? sent?.name ?? t("your Pokémon");
    const received = c.received as unknown as Pokemon;
    playTradeAnimation({
      from: {
        name: t("You"),
        pokemonName: sentName,
        speciesKey: sent?.speciesKey ?? "pidgey",
        isShiny: sent?.isShiny ?? false,
      },
      to: {
        name: c.otherUser.username,
        pokemonName: received.nickname ?? received.name,
        speciesKey: received.speciesKey,
        isShiny: received.isShiny ?? false,
      },
      onComplete: () => {
        dispatch({
          type: "TRADE_COMPLETE",
          payload: { sentMonId: c.sentMonId, received },
        });
        clearRoom();
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.completion?.tradeId]);

  // While the cinematic plays we hide the modal so it doesn't sit in
  // front of the animation. The completion useEffect above will clear
  // the room when the animation finishes.
  if (room.completion) return null;

  // A rejection here means the click did nothing, with a real second
  // player watching on the other side — silence would read as a broken
  // trade, or worse, as an offer that "went through" when it didn't.
  const onTradeAck = (action: string) => (r: { ok: boolean; error?: string }) => {
    if (!r.ok) pushToast({ kind: "warn", text: `Couldn't ${action}${r.error ? `: ${r.error}` : "."}` });
  };
  const onPick = (p: Pokemon) => {
    setOffer(room.tradeId, p, onTradeAck("update your offer"));
  };
  const onUnpick = () => setOffer(room.tradeId, null, onTradeAck("clear your offer"));
  // The lock event carries a fresh {party, box} snapshot of the
  // player's current state. Server uses that snapshot (not the DB
  // saveData) as the canonical source for the offered mon. Without
  // this, just-evolved mons could ship as their pre-evolution form
  // because the autosave debounces ~1.5s and the DB lags behind real
  // local state.
  const onToggleLock = () => {
    if (room.myLocked) {
      setLock(room.tradeId, false, undefined, onTradeAck("unlock"));
      return;
    }
    setLock(room.tradeId, true, { party: state.party, box: state.box }, onTradeAck("lock in your offer"));
  };
  const requestCancel = () => setConfirmingCancel(true);
  const onConfirmCancel = () => {
    setConfirmingCancel(false);
    cancelTrade(room.tradeId, onTradeAck("cancel the trade"));
  };
  const onAbortCancel = () => setConfirmingCancel(false);

  return (
    <div className="modal-overlay">
      <div
        ref={dialogRef}
        className="g-modal trade-room-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t("Trade room")}
      >
        <header className="g-modal-head">
          <h2>
            {t("Trading with")}{" "}
            <button
              type="button"
              className="pvp-opponent-link"
              onClick={() => openPublicTrainerCard(room.other.username)}
              title={`View ${room.other.username}'s trainer card`}
            >
              <strong>{room.other.username}</strong>
            </button>
          </h2>
          <span className="dim small trade-room-timer">{secondsLeft}s</span>
          <button className="g-modal-close" onClick={requestCancel} aria-label={t("Cancel")}>×</button>
        </header>
        {confirmingCancel && (
          <div className="trade-cancel-confirm" role="alertdialog" aria-label={t("Confirm cancel")}>
            <span>
              {t("Cancel this trade? Both sides will lose any locked offers.")}
            </span>
            <div className="trade-cancel-confirm-actions">
              <button className="g-btn-ghost g-btn-small" onClick={onAbortCancel}>
                {t("Keep trading")}
              </button>
              <button className="g-btn-danger-ghost g-btn-small" onClick={onConfirmCancel}>
                {t("Yes, cancel")}
              </button>
            </div>
          </div>
        )}

        <div className="g-modal-body">
          <div className="trade-room-board">
            <SidePanel
              title={t("Your offer")}
              offer={room.myOffer}
              locked={room.myLocked}
              onUnpick={room.myOffer && !room.myLocked ? onUnpick : undefined}
              isMine
            />
            <div className="trade-room-arrows" aria-hidden>⇄</div>
            <SidePanel
              title={`${room.other.username}'s offer`}
              offer={room.theirOffer}
              locked={room.theirLocked}
            />
          </div>

          <section className="g-card g-card-full">
            <h3>{t("Pick a Pokémon to send")}</h3>
            {room.myLocked ? (
              <p className="g-help">
                {t("You've locked your offer. Unlock to change your selection.")}
              </p>
            ) : (
              <ul className="trade-room-party">
                {state.party.map((p) => {
                  const selected = room.myOffer?.id === p.id;
                  return (
                    <li
                      key={p.id}
                      className={`trade-room-party-row ${selected ? "selected" : ""}`}
                    >
                      <img
                        className="trade-room-sprite"
                        src={pokemonSpriteUrl(p.speciesKey, false, p.isShiny)}
                        alt={p.name}
                        width={32}
                        height={32}
                        style={{ imageRendering: "pixelated" }}
                      />
                      <div className="trade-room-party-info">
                        <strong>{p.nickname ?? p.name}{p.isShiny ? " ✨" : ""}</strong>
                        <small className="dim">{t("Lv ")}{p.level} · {p.name}</small>
                      </div>
                      {p.heldItem && (
                        <span
                          className="trade-room-held-tag"
                          title={`Holding ${itemsCatalog[p.heldItem]?.name ?? p.heldItem}`}
                        >
                          <img
                            src={itemSpriteUrl(p.heldItem, itemsCatalog[p.heldItem]?.spriteOverride)}
                            alt=""
                            width={14}
                            height={14}
                            style={{ imageRendering: "pixelated" }}
                          />
                        </span>
                      )}
                      <button
                        className="g-btn-ghost g-btn-small"
                        onClick={() => onPick(p)}
                        disabled={selected}
                      >
                        {selected ? t("Selected") : t("Select")}
                      </button>
                    </li>
                  );
                })}
                {state.party.length <= 1 && (
                  <li className="dim small" style={{ padding: 8 }}>
                    {t("Need at least 2 party Pokémon to trade — your last mon can't be traded away.")}
                  </li>
                )}
              </ul>
            )}
          </section>
        </div>

        <footer className="g-modal-foot">
          <button className="g-btn-danger-ghost" onClick={requestCancel}>{t("Cancel trade")}</button>
          <span style={{ flex: 1 }} />
          <button
            className={room.myLocked ? "g-btn-ghost" : "g-btn-primary"}
            onClick={onToggleLock}
            disabled={!room.myOffer || state.party.length <= 1}
            title={
              !room.myOffer ? t("Pick a Pokémon first")
              : state.party.length <= 1 ? t("Need at least 2 party Pokémon")
              : undefined
            }
          >
            {room.myLocked ? t("Unlock") : t("Lock in offer")}
          </button>
        </footer>
      </div>
    </div>
  );
}

function SidePanel({
  title, offer, locked, onUnpick, isMine,
}: {
  title: string;
  offer: TradeOffer | null;
  locked: boolean;
  onUnpick?: () => void;
  isMine?: boolean;
}) {
  const t = useT();
  const heldName = offer?.heldItem ? itemsCatalog[offer.heldItem]?.name : null;
  return (
    <section className="g-card trade-side-card">
      <header className="trade-side-head">
        <strong>{title}</strong>
        <span className={`trade-side-status ${locked ? "locked" : "open"}`}>
          {locked ? t("✓ Locked") : isMine ? t("Choosing…") : t("Waiting…")}
        </span>
      </header>
      {offer ? (
        <div className="trade-side-body">
          <img
            className="trade-side-sprite"
            src={pokemonSpriteUrl(offer.speciesKey, false, !!offer.isShiny)}
            alt={offer.name}
            width={64}
            height={64}
            style={{ imageRendering: "pixelated" }}
          />
          <div className="trade-side-info">
            <strong>{offer.nickname ?? offer.name}{offer.isShiny ? " ✨" : ""}</strong>
            <small className="dim">{t("Lv ")}{offer.level}</small>
            {heldName && (
              <small className="dim trade-side-held">
                {t("Holding ")}{heldName}
              </small>
            )}
          </div>
          {onUnpick && (
            <button
              className="g-btn-ghost g-btn-small trade-side-unpick"
              onClick={onUnpick}
            >
              {t("Change")}
            </button>
          )}
        </div>
      ) : (
        <p className="dim small trade-side-empty">
          {isMine ? t("Pick a Pokémon below.") : t("Waiting for them to choose…")}
        </p>
      )}
    </section>
  );
}
