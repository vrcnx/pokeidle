import { useEffect, useState } from "react";
import { api, type DailyStatus } from "../net/api";
import { pushToast } from "../components/Toast";
import { contributeDaily } from "./welcomeBack";

// Module store for the daily-reward status, mirroring the presence /
// announcement stores. Fetched once on bind and after each claim; a hook
// exposes it to the dock (claimable dot) and the modal.

let _status: DailyStatus | null = null;
const _listeners = new Set<(s: DailyStatus | null) => void>();
let _openModal: (() => void) | null = null;
let _fetched = false;

function emit() { for (const fn of _listeners) fn(_status); }

export function useDailyStatus(): DailyStatus | null {
  const [s, setS] = useState(_status);
  useEffect(() => {
    _listeners.add(setS);
    return () => { _listeners.delete(setS); };
  }, []);
  return s;
}

export function setDailyStatus(s: DailyStatus | null) { _status = s; emit(); }

export async function refreshDailyStatus(): Promise<void> {
  try { setDailyStatus(await api.dailyStatus()); }
  catch { /* offline / not signed in — retried on next bind */ }
}

// Registers the modal opener and does the first fetch.
//
// It no longer auto-opens. A claimable daily is now one section of the
// welcome-back dialog (state/welcomeBack.ts), which is the only thing in the
// app allowed to open itself at boot — four surfaces each deciding
// independently to pop up is what produced the stack of overlays a returning
// player had to clear before playing. The status is CONTRIBUTED there instead,
// including when the fetch fails, because the collector waits on this source
// and a silent failure would hold the dialog until its timeout.
export function bindDailies(openOnClaimable: () => void) {
  _openModal = openOnClaimable;
  if (_fetched) return;
  _fetched = true;
  api.dailyStatus()
    .then((s) => {
      setDailyStatus(s);
      contributeDaily(s);
    })
    .catch(() => {
      // Offline at boot. openDailyReward() below retries on demand; tell the
      // collector so it stops waiting on us.
      contributeDaily(null);
    });
}

// The Settings "Daily reward" button. This used to just flip the modal
// open, on the assumption bindDailies' boot fetch had already populated
// _status — but that fetch runs exactly once (the _fetched guard above),
// so a single network blip at login left _status permanently null, the
// modal's `if (!status) return null` meant it rendered nothing, and the
// player could click this button for the rest of the session and get no
// response at all — no modal, no error, nothing. If we still don't have a
// status, retry right here rather than trusting a fetch that may have
// already failed for good.
export function openDailyReward() {
  if (_status) { _openModal?.(); return; }
  api.dailyStatus()
    .then((s) => { setDailyStatus(s); _openModal?.(); })
    .catch(() => {
      pushToast({ kind: "warn", text: "Couldn't load your daily reward — check your connection and try again." });
    });
}
