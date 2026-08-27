import { useEffect, useState } from "react";
import { api, type AwayProgress } from "../net/api";
import { contributeAway } from "./welcomeBack";

// Away-time catch-up progress — the client half of br_876bae56ef21c9021c
// ("its annoying to always have to keep the game open… if the PC shuts down
// nothing is counted in the background").
//
// ── WHY THE CLIENT CANNOT FIX THIS ITSELF ────────────────────────────
// The simulation is a setTimeout chain (hooks/useBattleLoop.ts) and browsers
// clamp background-tab timers to about 1/second, then freeze them entirely
// once a tab is discarded or the device sleeps. At ×5 — a 200ms tick — a
// backgrounded tab runs at under a twentieth speed, and a closed tab or a
// powered-off PC runs at zero. There is no client-side trick that changes that,
// because for most of the away time there is no client.
//
// So the progress is COMPUTED ON RETURN from elapsed time, by the server, from
// timestamps only the server writes (server/src/lib/awayProgress.ts). This
// module sends no time, no duration and no amount — a tampered system clock
// gets nothing — and it does not touch the save. Payment is a PendingGrant row
// that the next autosave folds in, which is why the whole feature adds no new
// save-write path and no new compare-and-swap.
//
// Module store + bus, mirroring state/dailies.ts: the away report is view state
// for one boot, not game progress, and it must never reach the save blob.

let _report: AwayProgress | null = null;
const _listeners = new Set<(p: AwayProgress | null) => void>();

/** Whether this session has already asked. The claim is idempotent server-side
 *  (a conditional UPDATE on `awayClaimedAt`), so a second request is harmless
 *  — but the boot reconcile retries with backoff on network failure, and
 *  re-requesting on every retry is pointless traffic. */
let _settled = false;
// Guards against two concurrent boots racing the claim. Separate from
// _settled because a failed attempt must clear this but NOT latch that.
let _inFlight = false;

function emit() { for (const fn of _listeners) fn(_report); }

export function useAwayReport(): AwayProgress | null {
  const [p, setP] = useState(_report);
  useEffect(() => {
    _listeners.add(setP);
    return () => { _listeners.delete(setP); };
  }, []);
  return p;
}

/** Dismiss the report. Purely visual — the money was granted server-side
 *  before this ever rendered, so closing without reading loses nothing. */
export function clearAwayReport() {
  _report = null;
  emit();
}

/**
 * Collect away progress for this session.
 *
 * ── CALL ORDER IS LOAD-BEARING ───────────────────────────────────────
 * The away period is measured from `max(saveUpdatedAt, awayClaimedAt)`, and
 * `saveUpdatedAt` is stamped by the server on every accepted upload. The boot
 * reconcile ITSELF uploads (it pushes the merged save), so this must complete
 * before that upload — otherwise the anchor has already moved to "now", the
 * gap measures ~0, and the player silently forfeits the night they were away.
 *
 * That is why the boot sequence in GameContext starts this concurrently with
 * `getSave` (a pure read, which cannot move the anchor) and awaits it before
 * any `putSave`. Concurrent, so boot pays one round trip rather than two.
 *
 * Never throws and never blocks progress: away progress is a bonus, and the
 * save path must not be able to fail because of it. On error the away period
 * stays unconsumed — the claim's transaction guarantees that — so the next boot
 * tries again.
 */
export async function settleAwayProgress(): Promise<void> {
  if (_settled) return;
  // NOT latched here. This used to set _settled BEFORE the request, so a
  // single transient failure — an offline boot, a 502 mid-deploy, a dropped
  // mobile connection — permanently disabled the claim for the whole session.
  // The comment below promises "the next boot tries again", and that promise
  // is broken by the anchor: a successful putSave later in this same session
  // moves it forward, so the absence is CONSUMED without ever being paid and
  // the next boot measures a ~0 gap. A whole night's away progress, gone to
  // one failed request.
  //
  // Latching on success only means a failure leaves the claim genuinely
  // retryable, which is what the transaction on the server side already
  // assumes.
  if (_inFlight) return;
  _inFlight = true;
  try {
    const res = await api.claimAway();
    _settled = true;
    // `claimed: false` is the ordinary answer — the player was gone two
    // minutes, or another tab collected first. Nothing to report.
    if (res.claimed && res.money > 0) {
      _report = res;
      emit();
      contributeAway(res);
    } else {
      contributeAway(null);
    }
  } catch {
    /* Offline, signed out, or a server that predates this route. Nothing was
       consumed server-side, and _settled was NOT latched, so this stays
       genuinely retryable rather than being silently forfeited. */
    // Reported either way: the welcome dialog WAITS on this source, and a
    // silent failure would hold it open until the timeout for no reason.
    contributeAway(null);
  } finally {
    // Always released. _settled is what makes a SUCCESS final; this only
    // stops two concurrent boots issuing the claim at once.
    _inFlight = false;
  }
}
