import { useState } from "react";
import { api, ApiError } from "../net/api";
import { useAuth } from "./AuthContext";
import { useModalEnter } from "../utils/animate";
import { LegalModal, openLegal } from "../components/LegalModal";

// Sign-in / sign-up overlay shown when the player isn't authenticated.
// Renders as a centered modal over a blurred backdrop (the same backdrop
// the game uses inside, so the auth screen feels like a continuation
// rather than a separate page). One-form-toggle UI; each branch posts
// to its own Better Auth endpoint.
type Mode = "signin" | "signup" | "forgot";

// Map Better Auth error codes (and a few HTTP-status fallbacks) to
// player-friendly copy. Better Auth returns { message, code } pairs;
// the message is correct but a bit terse, so we override the most
// common ones for clarity. Anything we don't know how to map falls
// through to the server's own message.
function friendlyAuthError(err: ApiError, mode: Mode, googleEnabled: boolean): string {
  // Hint appended to credential errors when the email might be on a
  // Google-linked account. Better Auth doesn't tell us "this email is
  // Google-only" (and shouldn't, for enumeration safety) so we just
  // surface the option whenever Google is configured.
  const googleHint = googleEnabled
    ? " If you signed up with Google, use Continue with Google below."
    : "";

  // Banned account — server middleware returns 403 with banReason.
  if (err.status === 403 && err.details?.error === "banned") {
    const until = err.details?.bannedUntil
      ? new Date(err.details.bannedUntil).toLocaleString()
      : null;
    return until
      ? `Your account is suspended until ${until}.`
      : "Your account is suspended.";
  }
  // Rate limit — server returns 429 from auth limiter.
  if (err.status === 429) {
    return "Too many attempts. Try again in a few minutes.";
  }

  switch (err.code) {
    // ── Sign-up rejections ────────────────────────────────────────────
    case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
    case "USER_ALREADY_EXISTS":
      return "An account with that email already exists. Try signing in instead." + googleHint;
    case "USERNAME_IS_ALREADY_TAKEN":
      return "That username is already taken. Pick another.";
    case "USERNAME_TOO_SHORT":
      return "Username must be at least 3 characters.";
    case "USERNAME_TOO_LONG":
      return "Username must be 20 characters or fewer.";
    case "INVALID_USERNAME":
    case "INVALID_DISPLAY_USERNAME":
      return "Username can only contain letters, digits, and underscores (3–20 chars).";
    case "PASSWORD_TOO_SHORT":
      return "Password must be at least 8 characters.";
    case "PASSWORD_TOO_LONG":
      return "Password is too long.";
    case "INVALID_EMAIL":
      return "That email isn't valid.";

    // ── Sign-in rejections ────────────────────────────────────────────
    case "INVALID_EMAIL_OR_PASSWORD":
    case "INVALID_USERNAME_OR_PASSWORD":
      return (mode === "signin"
        ? "Wrong email/username or password."
        : "Wrong credentials.") + googleHint;
    case "USER_NOT_FOUND":
      return "No account found with that email or username." + googleHint;
    case "EMAIL_NOT_VERIFIED":
      return "Please verify your email before signing in.";

    default:
      // Some validators return a 400 with no `code` but a useful
      // `message` — surface that. If the message looks like a raw
      // validator dump, replace with a generic line.
      if (err.message && /^[a-z0-9 _-]+$/i.test(err.message) && err.message.length < 120) {
        return err.message;
      }
      if (mode === "signup") return "Couldn't create your account. Please check your inputs and try again.";
      return "Couldn't sign you in. Please check your inputs and try again.";
  }
}

export function LoginScreen() {
  const { refresh, providers } = useAuth();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  // Set after a successful "forgot password" submission so the form
  // becomes a confirmation screen ("check your inbox") instead of
  // letting the player resubmit and get rate-limited.
  const [forgotSent, setForgotSent] = useState(false);
  const dialogRef = useModalEnter();
  // Show a banner if we were just kicked by a session-replaced event
  // (another device signed into the same account). The flag is set in
  // net/socket.ts and consumed once.
  const [kickedNotice, setKickedNotice] = useState<string | null>(() => {
    try {
      if (sessionStorage.getItem("pkmn-kicked") === "1") {
        sessionStorage.removeItem("pkmn-kicked");
        return "You were signed out because your account signed in on another device.";
      }
    } catch { /* */ }
    return null;
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "signup") {
        if (!username.trim()) {
          setError("Pick a username (3-20 chars).");
          setBusy(false);
          return;
        }
        if (password.length < 8) {
          setError("Password must be at least 8 characters.");
          setBusy(false);
          return;
        }
        if (!acceptedTerms) {
          setError("Please accept the Terms and acknowledge the Privacy Policy.");
          setBusy(false);
          return;
        }
        await api.signUp({
          email: email.trim().toLowerCase(),
          password,
          name: name.trim() || username.trim(),
          username: username.trim(),
        });
        await refresh();
      } else if (mode === "forgot") {
        // Forgot password — send the reset email. We always show the
        // same confirmation screen regardless of whether the email is
        // actually registered, so an attacker can't enumerate valid
        // addresses by trying random ones.
        if (!email.trim()) {
          setError("Enter the email on your account.");
          setBusy(false);
          return;
        }
        await api.requestPasswordReset({
          email: email.trim().toLowerCase(),
          redirectTo: window.location.origin + "/reset-password",
        });
        setForgotSent(true);
      } else {
        if (email.includes("@")) {
          await api.signInEmail({ email: email.trim().toLowerCase(), password });
        } else {
          await api.signInUsername({ username: email.trim(), password });
        }
        await refresh();
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setError(friendlyAuthError(err, mode, providers.google));
      } else {
        setError("Couldn't reach the server. Check your connection and try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      {/* Blurred ambient backdrop — same image the game uses as its
          AppBackground. Stays static here since there's no current
          location yet; we use the grassland fallback. */}
      <div className="auth-backdrop">
        <img src="/backgrounds/grassland.png" alt="" aria-hidden />
        <div className="auth-backdrop-scrim" />
      </div>

      <div ref={dialogRef} className="g-modal auth-modal" role="dialog" aria-label="Sign in">
        <header className="g-modal-head auth-brand-head">
          <img className="auth-brand" src="/logos/Pokeidle.svg" alt="Pokémon Idle" />
        </header>

        <div className="g-modal-body">
          {kickedNotice && (
            <div className="auth-kicked-banner" role="status">
              {kickedNotice}
              <button
                type="button"
                className="auth-kicked-dismiss"
                onClick={() => setKickedNotice(null)}
                aria-label="Dismiss"
              >×</button>
            </div>
          )}
          <p className="auth-tag">
            {mode === "signin"
              ? "Welcome back, trainer. Sign in to pick up where you left off."
              : mode === "signup"
                ? "New here? Pick a username — your save will sync to the cloud automatically."
                : forgotSent
                  ? "Check your inbox — if that email is on file, we've sent a reset link."
                  : "Enter your email and we'll send a reset link."}
          </p>

          <div className="auth-tabs">
            <button
              type="button"
              className={`auth-tab ${mode === "signin" ? "active" : ""}`}
              onClick={() => { setMode("signin"); setError(null); setForgotSent(false); }}
            >Sign in</button>
            <button
              type="button"
              className={`auth-tab ${mode === "signup" ? "active" : ""}`}
              onClick={() => { setMode("signup"); setError(null); setForgotSent(false); }}
            >Create account</button>
          </div>

          {mode === "forgot" && forgotSent ? (
            <div className="auth-form">
              <div className="auth-success">
                We sent a password-reset link to <strong>{email}</strong>. The
                link expires in 1 hour. Check your spam folder if it doesn't
                arrive within a few minutes.
              </div>
              <button
                type="button"
                className="g-btn-primary auth-submit"
                onClick={() => { setMode("signin"); setForgotSent(false); setPassword(""); }}
              >Back to sign in</button>
            </div>
          ) : (
          <form onSubmit={submit} className="auth-form">
            <label className="auth-label">
              <span>{mode === "signin" ? "Email or username" : "Email"}</span>
              <input
                type={mode === "signup" ? "email" : mode === "forgot" ? "email" : "text"}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                autoComplete={mode === "signup" ? "email" : "username"}
                placeholder={mode === "signin" ? "you@example.com or @username" : "you@example.com"}
              />
            </label>
            {mode === "signup" && (
              <>
                <label className="auth-label">
                  <span>Username</span>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))}
                    required
                    minLength={3}
                    maxLength={20}
                    autoComplete="username"
                    placeholder="ash_ketchum"
                  />
                </label>
                <label className="auth-label">
                  <span>Display name <em className="dim">(optional)</em></span>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={40}
                    placeholder="Ash"
                  />
                </label>
              </>
            )}
            {mode !== "forgot" && (
              <label className="auth-label">
                <span>Password</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={mode === "signup" ? 8 : 1}
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                  placeholder={mode === "signup" ? "8+ characters" : ""}
                />
              </label>
            )}
            {mode === "signin" && (
              <div className="auth-forgot-row">
                <button
                  type="button"
                  className="auth-link"
                  onClick={() => { setMode("forgot"); setError(null); setPassword(""); }}
                >Forgot password?</button>
              </div>
            )}

            {mode === "signup" && (
              <label className="auth-consent">
                <input
                  type="checkbox"
                  checked={acceptedTerms}
                  onChange={(e) => setAcceptedTerms(e.target.checked)}
                />
                <span>
                  I agree to the{" "}
                  <button
                    type="button"
                    className="auth-link"
                    onClick={() => openLegal("terms")}
                  >Terms</button>
                  {" "}and acknowledge the{" "}
                  <button
                    type="button"
                    className="auth-link"
                    onClick={() => openLegal("privacy")}
                  >Privacy Policy</button>
                  . I understand this is an unaffiliated fan project (
                  <button
                    type="button"
                    className="auth-link"
                    onClick={() => openLegal("disclaimer")}
                  >disclaimer</button>
                  ).
                </span>
              </label>
            )}

            {error && <div className="auth-error">{error}</div>}

            <button type="submit" className="g-btn-primary auth-submit" disabled={busy}>
              {busy
                ? "…"
                : mode === "signin"
                  ? "Sign in"
                  : mode === "signup"
                    ? "Create account"
                    : "Send reset link"}
            </button>
            {mode === "forgot" && (
              <button
                type="button"
                className="auth-link auth-back-link"
                onClick={() => { setMode("signin"); setError(null); }}
              >← Back to sign in</button>
            )}
          </form>
          )}

          {providers.google && mode !== "forgot" && (
            <>
              <div className="auth-divider"><span>or</span></div>
              <button
                type="button"
                className="auth-google"
                disabled={busy}
                onClick={async () => {
                  setError(null);
                  setBusy(true);
                  try {
                    const res = await api.signInSocial({
                      provider: "google",
                      callbackURL: window.location.origin,
                    });
                    if (res?.url) {
                      window.location.assign(res.url);
                    } else {
                      setError("Couldn't start Google sign-in. Try again.");
                      setBusy(false);
                    }
                  } catch (err) {
                    if (err instanceof ApiError) {
                      setError(friendlyAuthError(err, mode, providers.google));
                    } else {
                      setError("Couldn't reach the server. Try again.");
                    }
                    setBusy(false);
                  }
                }}
              >
                Continue with Google
              </button>
            </>
          )}

          <div className="auth-legal-row">
            <button type="button" className="auth-link" onClick={() => openLegal("terms")}>Terms</button>
            <span className="dim">·</span>
            <button type="button" className="auth-link" onClick={() => openLegal("privacy")}>Privacy</button>
            <span className="dim">·</span>
            <button type="button" className="auth-link" onClick={() => openLegal("disclaimer")}>Disclaimer</button>
          </div>
        </div>
      </div>

      <LegalModal />
    </div>
  );
}
