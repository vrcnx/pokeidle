import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, type MeProfile } from "../net/api";

interface AuthState {
  status: "loading" | "anonymous" | "authenticated";
  me: MeProfile | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthState["status"]>("loading");
  const [me, setMe] = useState<MeProfile | null>(null);

  const refresh = async () => {
    try {
      const profile = await api.meProfile();
      setMe(profile);
      setStatus("authenticated");
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

  const signOut = async () => {
    try { await api.signOut(); } catch { /* ignore — best effort */ }
    setMe(null);
    setStatus("anonymous");
  };

  useEffect(() => { refresh(); }, []);

  return (
    <AuthCtx.Provider value={{ status, me, refresh, signOut }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
