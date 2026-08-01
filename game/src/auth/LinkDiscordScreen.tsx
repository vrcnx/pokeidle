import { useEffect, useState } from "react";
import { api, ApiError } from "../net/api";
import { useAuth } from "./AuthContext";
import { useModalEnter } from "../utils/animate";

// Discord link landing — rendered when the player lands on /link-discord after
// running /link in the Discord server. The bot DM's them a six-character code;
// this screen is where they hand it back while signed in.
//
// ── WHY THE SITE IS THE SIDE THAT REDEEMS ───────────────────────────
// The game session is the strong credential — Better Auth, first-party cookie,
// single active session. The Discord side only has to prove possession of a
// secret we sent to exactly one Discord user in a DM. Running it the other way
// (mint here, type into Discord) would look symmetrical and be worse: it puts
// the secret in a channel where a mistyped command posts it publicly.
//
// Follows ResetPasswordScreen's shape: a standalone auth-shell screen reached
// by a pathname branch in main.tsx rather than a router, because this app has
// no router and adding one for two landing pages would be a large change to
// make a small one.
export function LinkDiscordScreen() {
  const dialogRef = useModalEnter();
  const { status, me } = useAuth();
  const [code, setCode] = useState<string>(() => {
    // Accept ?code= so the bot's DM can carry a one-click link. Still shown in
    // the field rather than auto-submitted: binding an outside identity to the
    // account is not something a URL someone clicked should do silently.
    const u = new URL(window.location.href);
    return (u.searchParams.get("code") ?? "").toUpperCase();
  });
  const [peek, setPeek] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkedTo, setLinkedTo] = useState<string | null>(null);
  const [reward, setReward] = useState<string | null>(null);
  const [already, setAlready] = useState(false);

  // Is this account already linked? Answered before the form renders so
  // somebody who has already done this is told so, rather than being handed a
  // form that can only 409.
  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;
    api.discordLinkStatus()
      .then((r) => { if (!cancelled) setAlready(r.linked); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [status]);

  // Name the Discord account the code belongs to, so the confirm button can
  // say WHO is about to be bound. Debounced — this fires as the player types.
  useEffect(() => {
    if (status !== "authenticated") return;
    const trimmed = code.replace(/[^A-Z0-9]/gi, "");
    if (trimmed.length < 6) { setPeek(null); return; }
    let cancelled = false;
    const t = window.setTimeout(() => {
      api.discordLinkPeek(trimmed)
        .then((r) => { if (!cancelled) setPeek(r.found ? (r.discordLabel ?? "that Discord account") : null); })
        .catch(() => { if (!cancelled) setPeek(null); });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [code, status]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api.discordLinkRedeem({ code });
      setLinkedTo(res.discordLabel || "your Discord account");
      setReward(res.reward?.summary ?? null);
    } catch (err) {
      if (err instanceof ApiError) {
        // The server already writes player-facing copy for every one of these
        // (see routes/discord.ts) — prefer it over re-deriving the wording
        // here, so the bot, the site and the API cannot disagree about what
        // went wrong.
        setError(err.details?.reason ?? err.message ?? "Couldn't link that code.");
      } else {
        setError("Couldn't reach the server. Check your connection.");
      }
    } finally {
      setBusy(false);
    }
  };

  const shell = (body: React.ReactNode, label: string) => (
    <div className="auth-shell">
      <div className="auth-backdrop">
        <img src="/backgrounds/grassland.webp" alt="" aria-hidden />
        <div className="auth-backdrop-scrim" />
      </div>
      <div ref={dialogRef} className="g-modal auth-modal" role="dialog" aria-label={label}>
        <header className="g-modal-head auth-brand-head">
          <img className="auth-brand" src="/logos/Pokeidle.svg" alt="Pokémon Idle" />
        </header>
        <div className="g-modal-body">{body}</div>
      </div>
    </div>
  );

  // Not signed in — the whole point of this page is proving the game account
  // is yours, so there is nothing to do until there is a session. main.tsx
  // renders the login screen for anonymous visitors on every other path; here
  // we explain why they are seeing it.
  if (status === "loading") {
    return shell(<p className="auth-tag">Checking your session…</p>, "Link Discord");
  }
  if (status === "anonymous") {
    return shell(
      <>
        <p className="auth-tag">
          Sign in first — linking proves this game account is yours, so we need
          to know which one you're holding.
        </p>
        <button
          type="button"
          className="g-btn-primary auth-submit"
          onClick={() => window.location.replace("/")}
        >Go to sign in</button>
      </>,
      "Link Discord",
    );
  }

  if (linkedTo) {
    return shell(
      <>
        <div className="auth-success">
          Linked to <strong>{linkedTo}</strong>. You've got the Trainer role — head
          back to Discord and try <code>/profile</code>.
        </div>
        {reward && (
          <p className="auth-tag">
            🎁 Your reward — <strong>{reward}</strong> — is on its way. It lands
            the next time the game saves, which is every few seconds while
            you're playing, so head back in and it'll be there.
          </p>
        )}
        <button
          type="button"
          className="g-btn-primary auth-submit"
          onClick={() => window.location.replace("/")}
        >Back to the game</button>
      </>,
      "Link Discord",
    );
  }

  if (already) {
    return shell(
      <>
        <p className="auth-tag">
          <strong>{me?.username ?? "This account"}</strong> is already linked to a
          Discord account. One game account per Discord account, both ways.
        </p>
        <p className="auth-tag">
          To move it somewhere else, run <code>/unlink</code> in Discord first —
          that works even if you've lost access to this account.
        </p>
        <button
          type="button"
          className="g-btn-primary auth-submit"
          onClick={() => window.location.replace("/")}
        >Back to the game</button>
      </>,
      "Link Discord",
    );
  }

  return shell(
    <>
      <p className="auth-tag">
        Run <code>/link</code> in the Pokémon Idle Discord and I'll DM you a
        six-character code. Type it here to connect it to{" "}
        <strong>{me?.username ?? "this account"}</strong>.
      </p>
      <form onSubmit={submit} className="auth-form">
        <label className="auth-label">
          <span>Link code</span>
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            required
            autoFocus
            autoComplete="off"
            spellCheck={false}
            maxLength={12}
            placeholder="ABC234"
            style={{ letterSpacing: "0.35em", textTransform: "uppercase" }}
          />
        </label>
        {peek && (
          <div className="auth-tag">
            This code is for <strong>{peek}</strong>.
          </div>
        )}
        {error && <div className="auth-error">{error}</div>}
        <button type="submit" className="g-btn-primary auth-submit" disabled={busy || code.length < 6}>
          {busy ? "…" : "Link Discord account"}
        </button>
      </form>
      <p className="auth-tag">
        Codes last ten minutes. If yours has expired, run <code>/link</code> again.
      </p>
    </>,
    "Link Discord",
  );
}
