import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { GameProvider } from "./state/GameContext";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { LoginScreen } from "./auth/LoginScreen";
import { ResetPasswordScreen } from "./auth/ResetPasswordScreen";
import { LinkDiscordScreen } from "./auth/LinkDiscordScreen";
import { FirstVisitDisclaimer } from "./components/FirstVisitDisclaimer";
import { api } from "./net/api";
import { applyMapPositionOverrides } from "./data/regions";
import { GlobalErrorBoundary } from "./components/GlobalErrorBoundary";
import { installGlobalErrorReporters } from "./net/errorReporter";
import { captureFirstTouch } from "./net/attribution";
import "./app.css";

// Wire window.onerror + unhandledrejection capture before the React
// tree mounts so anything that blows up during initial render is
// caught. The reporter dedups + rate-limits client-side and the server
// has its own limiter as the second wall.
installGlobalErrorReporters();

// Remember where this visitor came from, before anything can navigate and
// overwrite document.referrer. No-op on every visit after the first — it is
// FIRST touch, so the Reddit post that brought someone here still gets the
// credit for the signup they make a week later. Sent to the server only once
// there is an account to attach it to (see net/attribution.ts).
captureFirstTouch();

// Pull admin-edited map positions before the first render. We don't
// block on this — if the network fails (offline, server down) the
// hard-coded routes.ts defaults stay in place. Position changes take
// effect on the next render cycle once routes.ts is mutated.
api.mapPositions()
  .then((res) => applyMapPositionOverrides(res.positions))
  .catch(() => undefined);

// Gate the entire app on an authenticated session. Auth state loads on
// mount via /api/auth/get-session — until it resolves we show a
// branded splash so the login screen doesn't flash for logged-in
// users and the moment of suspense feels intentional.
function Root() {
  const { status } = useAuth();
  // Reset-password landing — when Better Auth's email link redirects
  // back here with `?token=...`, render the dedicated reset screen
  // instead of the login form, regardless of auth status (the user is
  // anonymous at this point but might still hit /reset-password while
  // authenticated if they reuse a stale browser tab).
  if (window.location.pathname.startsWith("/reset-password")) {
    return <ResetPasswordScreen />;
  }
  // Discord link landing — where /link in the Discord server sends people.
  // Rendered ABOVE the auth gate for the same reason the reset screen is: it
  // has its own handling for every auth status, and it explains why a signed-
  // out visitor is being asked to sign in rather than dumping them on a bare
  // login form with no context for how they got there.
  if (window.location.pathname.startsWith("/link-discord")) {
    return <LinkDiscordScreen />;
  }
  return (
    <>
      {/* First-visit fan-game disclaimer — sits above whatever the user
          would otherwise see (login screen or game). Locks scroll until
          accepted; once dismissed, never shown again on this device. */}
      <FirstVisitDisclaimer />
      {status === "loading" ? (
        <LoadingSplash />
      ) : status === "anonymous" ? (
        <LoginScreen />
      ) : (
        <GameProvider>
          <App />
        </GameProvider>
      )}
    </>
  );
}

function LoadingSplash() {
  return (
    <div className="loading-splash" aria-busy aria-label="Loading">
      <div className="loading-backdrop">
        <img src="/backgrounds/grassland.webp" alt="" aria-hidden />
        <div className="loading-scrim" />
      </div>
      <img className="loading-logo" src="/logos/Pokeidle.svg" alt="Pokémon Idle" />
      <div className="loading-dots" aria-hidden>
        <span /><span /><span />
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <GlobalErrorBoundary>
      <AuthProvider>
        <Root />
      </AuthProvider>
    </GlobalErrorBoundary>
  </StrictMode>
);
