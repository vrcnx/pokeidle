import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, type MeProfile } from "../net/api";
import { setStreamMode } from "../state/streamMode";
import { sendFirstTouch } from "../net/attribution";
import { signOutStarted } from "../state/signOutLatch";

interface AuthState {
  status: "loading" | "anonymous" | "authenticated";
  me: MeProfile | null;
  // Which auth providers the server has wired up. Lets the login
  // screen hide buttons that would 404 (e.g. Google when env vars
  // aren't set on the server). Loaded once from /api/auth/providers.
  providers: { google: boolean };
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthState["status"]>("loading");
  const [me, setMe] = useState<MeProfile | null>(null);
  const [providers, setProviders] = useState<{ google: boolean }>({ google: false });

  const refresh = async () => {
    try {
      const profile = await api.meProfile();
      setMe(profile);
      setStreamMode(!!profile.isStream, profile.streamConfig ?? null);
      setStatus("authenticated");
      // There is an account now, so the stored first touch has something to
      // attach to. Deliberately not awaited: this is reporting, and a slow or
      // blocked call must not hold up the game rendering. It self-limits to
      // one request per browser, and the server ignores it for any account
      // older than half an hour — so an existing player costs one no-op.
      void sendFirstTouch();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setMe(null);
        setStatus("anonymous");
      } else {
        // Network down — treat as anonymous so the login screen renders.
        setMe(null);
        setStatus("anonymous");
      }
    }
  };

  // Sign-out: hits Better Auth's POST /api/auth/sign-out so the server
  // deletes the Session row AND returns a Set-Cookie that clears the
  // browser cookie. We then do a full-page reload via location.replace
  // — this guarantees:
  //   - The auth cookie is gone from the in-page request cache
  //   - GameContext's in-memory save state is dropped (so the next
  //     sign-in starts from cloud truth, not stale React state)
  //   - Sockets are reconnected with the new (anonymous) session
  // If the POST itself fails we still reload so the player isn't
  // stranded — the `requireUser` middleware enforces single-active-
  // session at the next request anyway, so a stale cookie can't keep
  // a real session alive past someone else's sign-in.
  const signOut = async () => {
    // Latch FIRST, before anything can be written. GameProvider is not
    // unmounted by this function (it ends in location.replace, not a state
    // change), so its pagehide/visibilitychange flush is still live and fires
    // during the navigation — after the wipe below — recreating the very blob
    // we are about to delete, complete with this account's owner stamp and
    // sync bookkeeping. That is why signing out never actually cleared a
    // shared machine.
    signOutStarted();
    // Two passes: Better Auth's primary sign-out, then our sledgehammer
    // that nukes every session row this user owns and clears the cookie
    // explicitly on the response. Either path on its own has cross-
    // origin Set-Cookie failure modes; together they're idempotent and
    // guaranteed to leave the user signed out at the next request.
    try { await api.signOut(); } catch { /* fall through */ }
    try { await api.signOutAll(); } catch { /* fall through */ }
    // Wipe this browser's cached game save on the way out. It's only an
    // offline cache — the account's real save lives in the cloud — and
    // leaving it behind is how the NEXT account signed into this browser
    // could inherit it (empty-cloud bootstrap). Clearing it here is the
    // first line of defence; the boot reconcile's owner check is the second.
    try {
      for (const k of Object.keys(localStorage)) {
        if (k === "pokemon-idle-save" || k.startsWith("pokemon-idle-save")) localStorage.removeItem(k);
      }
    } catch { /* private mode / disabled storage */ }
    if (typeof window !== "undefined") {
      // replace() so the user can't browser-back into a partially-
      // signed-in state. Hard navigation also drops every module-
      // scoped store (trade._listeners, etc.) cleanly.
      window.location.replace("/");
    } else {
      setMe(null);
      setStatus("anonymous");
    }
  };

  useEffect(() => {
    refresh();
    // Fire-and-forget the providers probe. Default state already shows
    // Google as off, so a network failure here just hides the button —
    // safer than showing a button that 404s.
    api.authProviders()
      .then(setProviders)
      .catch(() => undefined);
  }, []);

  return (
    <AuthCtx.Provider value={{ status, me, providers, refresh, signOut }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
