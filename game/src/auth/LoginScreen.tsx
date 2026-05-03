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
type Mode = "signin" | "signup";

export function LoginScreen() {
  const { refresh } = useAuth();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const dialogRef = useModalEnter();

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
      } else {
        if (email.includes("@")) {
          await api.signInEmail({ email: email.trim().toLowerCase(), password });
        } else {
          await api.signInUsername({ username: email.trim(), password });
        }
      }
      await refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message || `Request failed (${err.status})`);
      } else {
        setError("Network error. Is the server running?");
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
          <p className="auth-tag">
            {mode === "signin"
              ? "Welcome back, trainer. Sign in to pick up where you left off."
              : "New here? Pick a username — your save will sync to the cloud automatically."}
          </p>

          <div className="auth-tabs">
            <button
              type="button"
              className={`auth-tab ${mode === "signin" ? "active" : ""}`}
              onClick={() => { setMode("signin"); setError(null); }}
            >Sign in</button>
            <button
              type="button"
              className={`auth-tab ${mode === "signup" ? "active" : ""}`}
              onClick={() => { setMode("signup"); setError(null); }}
            >Create account</button>
          </div>

          <form onSubmit={submit} className="auth-form">
            <label className="auth-label">
              <span>{mode === "signin" ? "Email or username" : "Email"}</span>
              <input
                type={mode === "signup" ? "email" : "text"}
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
              {busy ? "…" : mode === "signin" ? "Sign in" : "Create account"}
            </button>
          </form>

          <div className="auth-divider"><span>or</span></div>
          <a className="auth-google" href={api.googleSignInUrl()}>
            Continue with Google
          </a>

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
