import { useEffect, useState } from "react";
import { api, type DailyStatus } from "../net/api";
import { pushToast } from "../components/Toast";

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

// Registers the modal opener and does the first fetch. Auto-opens the reward
// modal once if a claim is available, so the player sees it on login.
export function bindDailies(openOnClaimable: () => void) {
  _openModal = openOnClaimable;
  if (_fetched) return;
  _fetched = true;
  api.dailyStatus()
    .then((s) => {
      setDailyStatus(s);
      if (!s.claimedToday) _openModal?.();
    })
    .catch(() => { /* offline at boot — openDailyReward() below retries */ });
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
