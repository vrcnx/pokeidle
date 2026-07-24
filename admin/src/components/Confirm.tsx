import { useEffect, useState } from "react";

// In-app confirm/alert, replacing window.confirm / window.alert.
//
// Why this exists: after a few native dialogs, Chrome (and others) offer a
// "don't let this page create more dialogs" checkbox. Once ticked, EVERY
// window.confirm returns false and window.alert is a no-op — silently. That
// made half the admin's action buttons (gift, giveaways, reset, ban, …)
// "do nothing". These dialogs render in-app, so the browser can't suppress
// them. Promise-based so callers keep the `if (!(await confirm(...))) return`
// shape.

type Req = {
  id: number;
  kind: "confirm" | "alert";
  message: string;
  resolve: (ok: boolean) => void;
};

let _push: ((r: Req) => void) | null = null;
let _seq = 1;

export function confirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!_push) { resolve(window.confirm(message)); return; } // host not mounted yet
    _push({ id: _seq++, kind: "confirm", message, resolve });
  });
}

export function notify(message: string): Promise<void> {
  return new Promise((resolve) => {
    if (!_push) { window.alert(message); resolve(); return; }
    _push({ id: _seq++, kind: "alert", message, resolve: () => resolve() });
  });
}

export function ConfirmHost() {
  const [reqs, setReqs] = useState<Req[]>([]);
  useEffect(() => {
    _push = (r) => setReqs((x) => [...x, r]);
    return () => { _push = null; };
  }, []);

  const top = reqs[0];
  if (!top) return null;
  const close = (ok: boolean) => {
    top.resolve(ok);
    setReqs((x) => x.slice(1));
  };

  return (
    <div className="confirm-overlay" onClick={() => close(false)} role="dialog" aria-modal="true">
      <div className="confirm-box" onClick={(e) => e.stopPropagation()}>
        <p className="confirm-msg">{top.message}</p>
        <div className="confirm-actions">
          {top.kind === "confirm" && (
            <button className="btn-ghost btn-small" onClick={() => close(false)}>Cancel</button>
          )}
          <button className="btn-primary btn-small" onClick={() => close(true)} autoFocus>OK</button>
        </div>
      </div>
    </div>
  );
}
