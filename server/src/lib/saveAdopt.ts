import { sendToUserGlobal } from "../socket.js";

// Server-authoritative save adoption.
//
// Problem: the game client is save-authoritative — it holds the live game
// state and constantly re-uploads it, and the boot reconcile merges
// NON-DESTRUCTIVELY (money = max(local, cloud), items = per-item max, box =
// union, …) so a player can never lose progress to a stale cloud copy. That
// same protection means an ADMIN edit that REDUCES or REPLACES a save (reset,
// snapshot restore, save-patch, item-set) is silently undone: the client
// re-uploads its intact local copy, and the merge keeps the old values.
//
// Fix: whenever the server AUTHORITATIVELY rewrites a save, bump the User's
// `saveAdoptSeq` (do this in the same update as the write) and then call
// emitSaveAdopt(userId). The client:
//   * online  — receives the `save:adopt` socket event, re-fetches the cloud
//     save and adopts it WHOLESALE (bypassing the protective merge).
//   * offline — on next boot sees getSave().saveAdoptSeq > the seq it last
//     adopted and does the same wholesale adopt.
//
// Use this ONLY for deliberate authoritative edits/replacements. Do NOT use it
// for additive gifts (money+/item+/gifted mon) — those go through the additive
// gift:received path so the player keeps unsynced progress. Wholesale-adopting
// a gift is exactly what caused the mass-gift cash-reset incident.
export function emitSaveAdopt(userId: string): void {
  try {
    sendToUserGlobal(userId, "save:adopt", {});
  } catch {
    /* socket layer may be down; the offline saveAdoptSeq check still covers it */
  }
}
