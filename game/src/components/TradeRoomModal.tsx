import { useEffect, useState } from "react";
import { useGame } from "../state/GameContext";
import {
  useTradeState, setOffer, setLock, cancelTrade, clearRoom, type RoomState, type TradeOffer,
} from "../state/trade";
import { pokemonSpriteUrl, itemSpriteUrl } from "../utils/sprites";
import { itemsCatalog } from "../data/itemsCatalog";
import { useModalEnter } from "../utils/animate";
import { playTradeAnimation } from "./TradeAnimation";
import type { Pokemon } from "../types";

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
  const { state, dispatch, forceSave } = useGame();
  const dialogRef = useModalEnter(".g-card");
  const [now, setNow] = useState(Date.now());
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
    const sentName = sent?.nickname ?? sent?.name ?? "your Pokémon";
    const received = c.received as unknown as Pokemon;
    playTradeAnimation({
      from: {
        name: "You",
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

  const onPick = (p: Pokemon) => {
    setOffer(room.tradeId, p);
  };
  const onUnpick = () => setOffer(room.tradeId, null);
  // Lock toggles need to flush the cloud save before emitting the
  // trade:lock event — otherwise the server's canonical mon lookup
  // can return a pre-evolution version of the offered Pokémon (the
  // bug where Haunter showed up on the recipient's side as Gastly).
  // Unlocking has no such constraint; pass through directly.
  const [syncing, setSyncing] = useState(false);
  const onToggleLock = async () => {
    if (room.myLocked) {
      setLock(room.tradeId, false);
      return;
    }
    setSyncing(true);
    try {
      await forceSave();
      setLock(room.tradeId, true);
    } catch {
      // Save failed; don't lock the trade against a stale cloud copy.
      // Server-side guard would catch a mismatch anyway, but better
      // to fail fast and let the user retry.
    } finally {
      setSyncing(false);
    }
  };
  // Cancelling a trade was previously instant — clicking the X or the
  // backdrop fired cancelTrade() right away, which meant a stray click
  // on the dimmed area threw away both sides' offers. Now the X / cancel
  // button flips to a confirm state in-place; the user has to click
  // "Yes, cancel" before we actually emit. Backdrop clicks no-op.
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const requestCancel = () => setConfirmingCancel(true);
  const onConfirmCancel = () => {
    setConfirmingCancel(false);
    cancelTrade(room.tradeId);
  };
  const onAbortCancel = () => setConfirmingCancel(false);

  return (
    <div className="modal-overlay">
      <div
        ref={dialogRef}
        className="g-modal trade-room-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Trade room"
      >
        <header className="g-modal-head">
          <h2>
            Trading with <strong>{room.other.username}</strong>
          </h2>
          <span className="dim small trade-room-timer">{secondsLeft}s</span>
          <button className="g-modal-close" onClick={requestCancel} aria-label="Cancel">×</button>
        </header>
        {confirmingCancel && (
          <div className="trade-cancel-confirm" role="alertdialog" aria-label="Confirm cancel">
            <span>
              Cancel this trade? Both sides will lose any locked offers.
            </span>
            <div className="trade-cancel-confirm-actions">
              <button className="g-btn-ghost g-btn-small" onClick={onAbortCancel}>
                Keep trading
              </button>
              <button className="g-btn-danger-ghost g-btn-small" onClick={onConfirmCancel}>
                Yes, cancel
              </button>
            </div>
          </div>
        )}

        <div className="g-modal-body">
          <div className="trade-room-board">
            <SidePanel
              title="Your offer"
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
            <h3>Pick a Pokémon to send</h3>
            {room.myLocked ? (
              <p className="g-help">
                You've locked your offer. Unlock to change your selection.
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
                        <small className="dim">Lv {p.level} · {p.name}</small>
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
                        {selected ? "Selected" : "Select"}
                      </button>
                    </li>
                  );
                })}
                {state.party.length <= 1 && (
                  <li className="dim small" style={{ padding: 8 }}>
                    Need at least 2 party Pokémon to trade — your last mon
                    can't be traded away.
                  </li>
                )}
              </ul>
            )}
          </section>
        </div>

        <footer className="g-modal-foot">
          <button className="g-btn-danger-ghost" onClick={requestCancel}>Cancel trade</button>
          <span style={{ flex: 1 }} />
          <button
            className={room.myLocked ? "g-btn-ghost" : "g-btn-primary"}
            onClick={onToggleLock}
            disabled={!room.myOffer || state.party.length <= 1 || syncing}
            title={
              !room.myOffer ? "Pick a Pokémon first"
              : state.party.length <= 1 ? "Need at least 2 party Pokémon"
              : syncing ? "Syncing your save…"
              : undefined
            }
          >
            {syncing ? "Syncing…" : room.myLocked ? "Unlock" : "Lock in offer"}
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
  const heldName = offer?.heldItem ? itemsCatalog[offer.heldItem]?.name : null;
  return (
    <section className="g-card trade-side-card">
      <header className="trade-side-head">
        <strong>{title}</strong>
        <span className={`trade-side-status ${locked ? "locked" : "open"}`}>
          {locked ? "✓ Locked" : isMine ? "Choosing…" : "Waiting…"}
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
            <small className="dim">Lv {offer.level}</small>
            {heldName && (
              <small className="dim trade-side-held">
                Holding {heldName}
              </small>
            )}
          </div>
          {onUnpick && (
            <button
              className="g-btn-ghost g-btn-small trade-side-unpick"
              onClick={onUnpick}
            >
              Change
            </button>
          )}
        </div>
      ) : (
        <p className="dim small trade-side-empty">
          {isMine ? "Pick a Pokémon below." : "Waiting for them to choose…"}
        </p>
      )}
    </section>
  );
}
