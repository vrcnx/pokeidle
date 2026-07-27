import { sendToUserGlobal } from "../socket.js";

// Server-authoritative save adoption.
//
// Problem: the game client is save-authoritative — it holds the live game
// state and constantly re-uploads it, and the boot reconcile can legitimately
// decide the browser's own copy is the one to keep (it does that whenever the
// local lineage holds more play than the cloud one — see mergeCloudAdvance in
// game/src/state/saveReconcile.ts). That means an ADMIN edit which REDUCES or
// REPLACES a save (reset, snapshot restore, save-patch, item-set) can be
// silently undone: the client re-uploads its intact local copy over it.
//
// Fix: whenever the server AUTHORITATIVELY rewrites a save, bump the User's
// `saveAdoptSeq` (do this in the same update as the write) and then call
// emitSaveAdopt(userId). The client:
//   * online  — receives the `save:adopt` socket event, re-fetches the cloud
//     save and adopts it WHOLESALE (bypassing the protective merge).
//   * offline — on next boot sees getSave().saveAdoptSeq > the seq it last
//     adopted and does the same wholesale adopt.
//
// ── WHAT MAY BUMP IT, AND WHAT MAY NOT ──────────────────────────────
// The rule is about WHERE THE BYTES CAME FROM, not about whether the write
// adds or removes.
//
// SAFE — bump: the stored blob is the player's own newest bytes with the
// server's change applied on top. Adopting it can only cost a session the
// play it has not uploaded yet, and it can never resurrect anything, because
// the copy being adopted already contains everything the server knows about.
//   * admin save-patch / item-set / snapshot restore (routes/admin.ts) —
//     re-read under CAS, mutate, write.
//   * auction listing escrow and cancel-restore (routes/auctions.ts),
//     settlement and escrow return (lib/auctionSettlement.ts).
//   * the prize fold in POST /api/saves — the server adds the prize ON TOP OF
//     the bytes the client sent in that very request. See below.
//
// UNSAFE — do not bump: a save the SERVER composed from a read it took at
// some earlier moment, racing the client's own uploads. That is the mass-gift
// cash-reset incident: the old grant path read saveData, added the prize, and
// wrote the whole blob back with no CAS, so the stored copy was a snapshot
// from seconds ago. Telling clients to adopt THAT is how a player's cash went
// backwards. The failure was the stale composition, not the adopt — the
// PendingGrant inbox removed the stale read (a grant writes no save at all),
// and the fold now composes from the request in hand, which is why the fold
// may bump this and the old path could not.
//
// Every bump site increments saveAdoptSeq in the SAME update as saveVersion.
// Keep it that way: it is what guarantees a client cannot learn the new
// version — which is what would let its stale bytes pass the version CAS —
// without seeing the new adopt seq in the same response.
export function emitSaveAdopt(userId: string): void {
  try {
    sendToUserGlobal(userId, "save:adopt", {});
  } catch {
    /* socket layer may be down; the offline saveAdoptSeq check still covers it */
  }
}
