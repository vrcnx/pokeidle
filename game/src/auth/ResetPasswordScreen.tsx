import { useEffect, useState } from "react";
import { api, ApiError } from "../net/api";
import { useModalEnter } from "../utils/animate";

// Reset-password screen — rendered when the user lands on /reset-password
// after clicking a link from their email. The token comes in via
// `?token=...` (Better Auth's GET /reset-password/:token validates the
// token and 302s to our redirectTo with the token re-attached as a
// query param).
//
// On success we redirect to / and let AuthProvider re-fetch the
// session — Better Auth signs the user in automatically after a
// successful reset, so they land back in the game.
export function ResetPasswordScreen() {
  const dialogRef = useModalEnter();
  const [token] = useState<string>(() => {
    const u = new URL(window.location.href);
    return u.searchParams.get("token") ?? "";
  });
  const [error] = useState<string | null>(() => {
    const u = new URL(window.location.href);
    return u.searchParams.get("error");
  });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Auto-redirect to /  on successful reset after a short pause so the
  // user sees the confirmation copy before the page replaces. Better
  // Auth's reset-password endpoint does NOT auto-sign-in the user
  // (no session cookie set), so we drop a flag for the login screen to
  // show a "your password was reset, sign in below" banner.
  useEffect(() => {
    if (!done) return;
    try { sessionStorage.setItem("pkmn-pw-reset", "1"); } catch { /* */ }
    const t = window.setTimeout(() => {
      window.location.replace("/");
    }, 1600);
    return () => window.clearTimeout(t);
  }, [done]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    if (password.length < 8) {
      setSubmitError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setSubmitError("Passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      await api.resetPassword({ token, newPassword: password });
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "INVALID_TOKEN" || err.status === 400) {
          setSubmitError("This reset link is invalid or has expired. Request a new one from the sign-in screen.");
        } else if (err.code === "PASSWORD_TOO_SHORT") {
          setSubmitError("Password must be at least 8 characters.");
        } else {
          setSubmitError(err.message || "Couldn't reset your password.");
        }
      } else {
        setSubmitError("Couldn't reach the server. Check your connection.");
      }
    } finally {
      setBusy(false);
    }
  };

  // Token missing / invalid — show an error landing instead of a form.
  if (!token || error) {
    return (
      <div className="auth-shell">
        <div className="auth-backdrop">
          <img src="/backgrounds/grassland.webp" alt="" aria-hidden />
          <div className="auth-backdrop-scrim" />
        </div>
        <div ref={dialogRef} className="g-modal auth-modal" role="dialog" aria-label="Reset password">
          <header className="g-modal-head auth-brand-head">
            <img className="auth-brand" src="/logos/Pokeidle.svg" alt="Pokémon Idle" />
          </header>
          <div className="g-modal-body">
            <div className="auth-error">
              {error === "INVALID_TOKEN"
                ? "This reset link is invalid or has expired."
                : "We couldn't find a reset token in this URL."}
              {" "}Request a new link from the sign-in screen.
            </div>
            <button
              type="button"
              className="g-btn-primary auth-submit"
              onClick={() => window.location.replace("/")}
            >Back to sign in</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-shell">
      <div className="auth-backdrop">
        <img src="/backgrounds/grassland.webp" alt="" aria-hidden />
        <div className="auth-backdrop-scrim" />
      </div>
      <div ref={dialogRef} className="g-modal auth-modal" role="dialog" aria-label="Reset password">
        <header className="g-modal-head auth-brand-head">
          <img className="auth-brand" src="/logos/Pokeidle.svg" alt="Pokémon Idle" />
        </header>
        <div className="g-modal-body">
          <p className="auth-tag">
            {done
              ? "Your password's been reset. Sending you back to sign in…"
              : "Choose a new password. You'll need to sign in with it once it's saved."}
          </p>
          {done ? (
            <div className="auth-success">
              All set. Redirecting you to the sign-in screen.
            </div>
          ) : (
            <form onSubmit={submit} className="auth-form">
              <label className="auth-label">
                <span>New password</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  autoFocus
                  autoComplete="new-password"
                  placeholder="8+ characters"
                />
              </label>
              <label className="auth-label">
                <span>Confirm password</span>
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  minLength={8}
                  autoComplete="new-password"
                />
              </label>
              {submitError && <div className="auth-error">{submitError}</div>}
              <button type="submit" className="g-btn-primary auth-submit" disabled={busy}>
                {busy ? "…" : "Reset password"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
