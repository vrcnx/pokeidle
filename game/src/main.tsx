import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { GameProvider } from "./state/GameContext";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { LoginScreen } from "./auth/LoginScreen";
import { api } from "./net/api";
import { applyMapPositionOverrides } from "./data/regions";
import { GlobalErrorBoundary } from "./components/GlobalErrorBoundary";
import { installGlobalErrorReporters } from "./net/errorReporter";
import "./app.css";

// Wire window.onerror + unhandledrejection capture before the React
// tree mounts so anything that blows up during initial render is
// caught. The reporter dedups + rate-limits client-side and the server
// has its own limiter as the second wall.
installGlobalErrorReporters();

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
  if (status === "loading") return <LoadingSplash />;
  if (status === "anonymous") return <LoginScreen />;
  return (
    <GameProvider>
      <App />
    </GameProvider>
  );
}

function LoadingSplash() {
  return (
    <div className="loading-splash" aria-busy aria-label="Loading">
      <div className="loading-backdrop">
        <img src="/backgrounds/grassland.png" alt="" aria-hidden />
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
