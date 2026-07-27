// Auction settlement — runs on a server-side timer (not tied to either
// player being connected, unlike the live 1:1 trade engine in socket.ts,
// which only ever runs while both participants are online in a shared
// TradeRoom). An auction's endsAt can fire while the seller and/or the
// winning bidder are offline, so this is the one place in the codebase
// where the SERVER is the sole authoritative writer of a player's
// saveData — everywhere else, the client uploads its own save and the
// server only validates it.
//
// Deliberately no upfront escrow (see schema.prisma's Auction doc
// comment): both sides are re-verified against LIVE saveData right here,
// and the whole transfer is one atomic transaction — if either side no
// longer checks out, or the OTHER side's compare-and-swap loses a race
// against their own concurrent autosave, NOTHING is written and the
// attempt is retried from a fresh read. No partial state is possible:
// either both saves and the Auction row update together, or none of them
// do.
import { prisma } from "../db.js";
import { sendToUserGlobal } from "../socket.js";
import { validateSave } from "./saveValidation.js";
import { computeAccountLevel } from "./level.js";
import { recordError } from "./errorReporting.js";
import { emitSaveAdopt } from "./saveAdopt.js";

// Return an ESCROWED Pokémon to the seller's box — used when an auction ends
// without a sale (cancelled, expired with no bids, or a failed settlement).
// The mon was removed from the seller's save at listing time, so it lives only
// in the auction's pokemonSnapshot until then. Bumps saveAdoptSeq + emits
// save:adopt so the seller's client picks it back up authoritatively (online
// and offline). Retries against the seller's live version a few times so a
// concurrent autosave doesn't silently drop the restore.
async function restoreEscrowedMon(sellerId: string, snapshotJson: string): Promise<void> {
  let mon: Record<string, unknown> | null = null;
  try { mon = JSON.parse(snapshotJson); } catch { return; }
  if (!mon || typeof mon.id !== "string") return;
  for (let attempt = 0; attempt < 3; attempt++) {
    const u = await prisma.user.findUnique({ where: { id: sellerId }, select: { saveData: true, saveVersion: true } });
    const save = safeParseSave(u?.saveData ?? null);
    if (!save) return;
    const box = Array.isArray(save.box) ? (save.box as Record<string, unknown>[]) : [];
    const party = Array.isArray(save.party) ? (save.party as Record<string, unknown>[]) : [];
    if (box.some((m) => m && m.id === mon!.id) || party.some((m) => m && m.id === mon!.id)) return; // already restored
    const restored = { ...save, box: [...box, mon] };
    const derived = computeAccountLevel(restored);
    const claim = await prisma.user.updateMany({
      where: { id: sellerId, saveVersion: u!.saveVersion },
      data: {
        saveData: JSON.stringify(restored),
        saveVersion: { increment: 1 },
        saveAdoptSeq: { increment: 1 },
        saveUpdatedAt: new Date(),
        accountLevel: derived.accountLevel,
        totalCaughtLevels: derived.totalCaughtLevels,
        pokedexCaughtCount: derived.pokedexCaughtCount,
      },
    });
    if (claim.count > 0) { emitSaveAdopt(sellerId); return; }
  }
  void recordError({ kind: "server", message: "auction_restore_escrow_failed", source: "auctionSettlement.restoreEscrowedMon", meta: { sellerId } });
}

const SETTLEMENT_INTERVAL_MS = 15_000;
const MAX_SETTLE_RETRIES = 5;

// Thrown inside the interactive transaction to force a rollback — a
// plain early `return` from the callback would still COMMIT whatever
// writes already happened in that transaction, which is exactly the
// partial-transfer bug this whole module exists to avoid.
class SettlementConflict extends Error {}

function safeParseSave(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function findMon(
  save: Record<string, unknown>,
  id: string,
): { mon: Record<string, unknown>; where: "party" | "box"; index: number } | null {
  const party = Array.isArray(save.party) ? (save.party as Record<string, unknown>[]) : [];
  const box = Array.isArray(save.box) ? (save.box as Record<string, unknown>[]) : [];
  const pi = party.findIndex((m) => m && m.id === id);
  if (pi >= 0) return { mon: party[pi], where: "party", index: pi };
  const bi = box.findIndex((m) => m && m.id === id);
  if (bi >= 0) return { mon: box[bi], where: "box", index: bi };
  return null;
}

type Outcome = "settled" | "cancelled" | "retry" | "skipped";

async function cancelAuction(auctionId: string, reason: string): Promise<void> {
  const row = await prisma.auction.findUnique({
    where: { id: auctionId },
    select: { sellerId: true, currentBidderId: true, pokemonSnapshot: true },
  });
  const claim = await prisma.auction.updateMany({
    where: { id: auctionId, status: "active" },
    data: { status: "cancelled", settledAt: new Date() },
  });
  if (claim.count === 0 || !row) return;
  // The listed mon was escrowed out of the seller's save — give it back.
  await restoreEscrowedMon(row.sellerId, row.pokemonSnapshot);
  sendToUserGlobal(row.sellerId, "auction:cancelled", { auctionId, reason });
  if (row.currentBidderId) sendToUserGlobal(row.currentBidderId, "auction:cancelled", { auctionId, reason });
}

async function attemptSettle(auctionId: string): Promise<Outcome> {
  const auction = await prisma.auction.findUnique({ where: { id: auctionId } });
  if (!auction || auction.status !== "active") return "skipped";
  if (auction.endsAt.getTime() > Date.now()) return "skipped";

  // No bids — nothing sold; expire the listing and RETURN the escrowed mon.
  if (!auction.currentBidderId || auction.currentBid <= 0) {
    const claim = await prisma.auction.updateMany({
      where: { id: auction.id, status: "active" },
      data: { status: "expired", settledAt: new Date() },
    });
    if (claim.count > 0) {
      await restoreEscrowedMon(auction.sellerId, auction.pokemonSnapshot);
      sendToUserGlobal(auction.sellerId, "auction:expired", { auctionId: auction.id });
    }
    return "settled";
  }

  const [seller, winner] = await Promise.all([
    prisma.user.findUnique({
      where: { id: auction.sellerId },
      select: { saveData: true, saveVersion: true, username: true },
    }),
    prisma.user.findUnique({
      where: { id: auction.currentBidderId },
      select: { saveData: true, saveVersion: true, username: true },
    }),
  ]);
  if (!seller || !winner) {
    await cancelAuction(auction.id, "seller_or_bidder_account_missing");
    return "cancelled";
  }

  const sellerSave = safeParseSave(seller.saveData);
  const winnerSave = safeParseSave(winner.saveData);
  if (!sellerSave || !winnerSave) {
    await cancelAuction(auction.id, "corrupt_save");
    return "cancelled";
  }

  // The mon is in ESCROW — it was removed from the seller at listing and lives
  // only in the snapshot now. Deliver it to the winner from there; the seller
  // no longer has (and doesn't need) it in their save.
  let mon: Record<string, unknown> | null = null;
  try { mon = JSON.parse(auction.pokemonSnapshot); } catch { /* */ }
  if (!mon || typeof mon.id !== "string") {
    await cancelAuction(auction.id, "corrupt_snapshot");
    return "cancelled";
  }

  const winnerMoney = Number(winnerSave.money ?? 0);
  if (!Number.isFinite(winnerMoney) || winnerMoney < auction.currentBid) {
    // Winner can't pay — cancel, which returns the escrowed mon to the seller.
    await cancelAuction(auction.id, "winning_bidder_insufficient_funds");
    return "cancelled";
  }

  // Seller: just gains the proceeds (the mon already left at listing time).
  const sellerMerged: Record<string, unknown> = {
    ...sellerSave,
    money: Number(sellerSave.money ?? 0) + auction.currentBid,
  };

  const winnerParty = Array.isArray(winnerSave.party) ? [...(winnerSave.party as Record<string, unknown>[])] : [];
  const winnerBox = Array.isArray(winnerSave.box) ? [...(winnerSave.box as Record<string, unknown>[])] : [];
  if (winnerParty.length < 6) winnerParty.push(mon);
  else winnerBox.push(mon);
  const winnerMerged: Record<string, unknown> = {
    ...winnerSave,
    party: winnerParty,
    box: winnerBox,
    money: winnerMoney - auction.currentBid,
  };

  const sellerValidation = validateSave(sellerMerged);
  const winnerValidation = validateSave(winnerMerged);
  if (!sellerValidation.ok || !winnerValidation.ok) {
    await cancelAuction(auction.id, "settlement_produced_invalid_save");
    void recordError({
      kind: "server",
      message: "auction_settlement_invalid_save",
      source: "auctionSettlement.attemptSettle",
      meta: {
        auctionId: auction.id,
        sellerReason: sellerValidation.ok ? null : sellerValidation.reason,
        winnerReason: winnerValidation.ok ? null : winnerValidation.reason,
      },
    });
    return "cancelled";
  }

  const sellerDerived = computeAccountLevel(sellerMerged);
  const winnerDerived = computeAccountLevel(winnerMerged);

  // Both writes bump saveAdoptSeq, exactly like the escrow paths above and
  // below. This is a SERVER-AUTHORITATIVE money movement into a save neither
  // player's client knows about: without the bump, the buyer's client keeps
  // playing on a blob that still has the money and no mon, and its next upload
  // — which passes the version CAS as soon as it re-reads the version after a
  // 409 — puts the money back and drops the Pokémon. That is +500,000 minted
  // with no tampering at all, and it is the "bought a shiny Nidoran, never
  // received it" report.
  //
  // It is safe to bump here for the same reason it is safe on the fold: the
  // stored blob is each player's OWN latest bytes (re-read under a version CAS
  // in this very attempt) with the settlement applied on top. Adopting it can
  // cost a session only the play it has not uploaded yet.
  try {
    await prisma.$transaction(async (tx) => {
      const sellerClaim = await tx.user.updateMany({
        where: { id: auction.sellerId, saveVersion: seller.saveVersion },
        data: {
          saveData: JSON.stringify(sellerMerged),
          saveVersion: { increment: 1 },
          saveAdoptSeq: { increment: 1 },
          saveUpdatedAt: new Date(),
          accountLevel: sellerDerived.accountLevel,
          totalCaughtLevels: sellerDerived.totalCaughtLevels,
          pokedexCaughtCount: sellerDerived.pokedexCaughtCount,
        },
      });
      if (sellerClaim.count === 0) throw new SettlementConflict("seller");

      const winnerClaim = await tx.user.updateMany({
        where: { id: auction.currentBidderId!, saveVersion: winner.saveVersion },
        data: {
          saveData: JSON.stringify(winnerMerged),
          saveVersion: { increment: 1 },
          saveAdoptSeq: { increment: 1 },
          saveUpdatedAt: new Date(),
          accountLevel: winnerDerived.accountLevel,
          totalCaughtLevels: winnerDerived.totalCaughtLevels,
          pokedexCaughtCount: winnerDerived.pokedexCaughtCount,
        },
      });
      if (winnerClaim.count === 0) throw new SettlementConflict("winner");

      const auctionClaim = await tx.auction.updateMany({
        where: { id: auction.id, status: "active" },
        data: { status: "sold", settledAt: new Date() },
      });
      if (auctionClaim.count === 0) throw new SettlementConflict("auction");
    });
  } catch (e) {
    if (!(e instanceof SettlementConflict)) {
      void recordError({
        kind: "server",
        message: "auction_settlement_transaction_failed",
        source: "auctionSettlement.attemptSettle",
        meta: { auctionId: auction.id, error: String((e as Error)?.message ?? e) },
      });
    }
    // Either a genuine version conflict (a normal autosave landed between
    // our read and the transaction) or an unexpected DB error — both are
    // safe to retry from a fresh read; nothing was committed either way.
    return "retry";
  }

  // Committed — tell both clients to adopt. The `auction:sold` / `auction:won`
  // payloads below patch a LIVE client's state directly (and are what make the
  // UI feel instant), but they are not a guarantee: a client that is offline,
  // socket-less, or simply misses the event would otherwise never learn. The
  // adopt is the guarantee, and it also covers the offline case via the boot
  // saveAdoptSeq check with no socket involved at all.
  emitSaveAdopt(auction.sellerId);
  emitSaveAdopt(auction.currentBidderId);

  sendToUserGlobal(auction.sellerId, "auction:sold", {
    auctionId: auction.id,
    pokemon: mon,
    amount: auction.currentBid,
    buyerUsername: winner.username,
    newSaveVersion: seller.saveVersion + 1,
    newMoney: sellerMerged.money,
  });
  sendToUserGlobal(auction.currentBidderId, "auction:won", {
    auctionId: auction.id,
    pokemon: mon,
    amount: auction.currentBid,
    sellerUsername: seller.username,
    newSaveVersion: winner.saveVersion + 1,
    newMoney: winnerMerged.money,
  });
  return "settled";
}

async function settleOne(auctionId: string): Promise<void> {
  for (let attempt = 0; attempt < MAX_SETTLE_RETRIES; attempt++) {
    const outcome = await attemptSettle(auctionId);
    if (outcome !== "retry") return;
  }
  // Exhausted retries — most likely one of the two accounts is under
  // sustained write pressure right now. Leave the auction active-but-due;
  // the next sweep tick picks it up fresh rather than force-cancelling
  // what's probably a transient contention window.
  void recordError({
    kind: "server",
    message: "auction_settlement_retry_exhausted",
    source: "auctionSettlement.settleOne",
    meta: { auctionId },
  });
}

export async function settleDueAuctions(): Promise<void> {
  const due = await prisma.auction.findMany({
    where: { status: "active", endsAt: { lte: new Date() } },
    select: { id: true },
    take: 50,
  });
  // Serial, not Promise.all — this codebase has previously hit a real
  // Postgres connection-ceiling incident from concurrent-fan-out DB
  // calls; each settleOne can itself issue several sequential queries.
  for (const a of due) {
    await settleOne(a.id);
  }
}

let started = false;
export function startAuctionSettlementLoop(): void {
  if (started) return;
  started = true;
  const tick = () => {
    settleDueAuctions().catch((e) => {
      void recordError({
        kind: "server",
        message: "auction_settlement_sweep_failed",
        source: "auctionSettlement.tick",
        meta: { error: String((e as Error)?.message ?? e) },
      });
    });
  };
  tick();
  setInterval(tick, SETTLEMENT_INTERVAL_MS);
}
