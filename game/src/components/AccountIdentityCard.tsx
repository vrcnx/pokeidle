import { useEffect, useId, useState, type ReactNode } from "react";
import { api, ApiError } from "../net/api";
import { useAuth } from "../auth/AuthContext";
import { useT } from "../i18n/useT";

// Editor for the two names other players actually see: the display name
// chat and the leaderboards print, and the @handle everything else keys
// off.
//
// Rendered in BOTH Settings → Account and the self trainer card, on
// purpose. Signing up with Google assigns both names — the display name
// comes straight off the Google profile, which for most people is their
// real full name — and the player who wants that off a public leaderboard
// goes looking at their profile, not at a settings tab they have no
// reason to open. ("I checked every inch of my profile and couldn't find
// it.") Two entry points is cheaper than one that isn't found.
//
// Server rules, cooldowns and the audit trail live in
// server/src/lib/nameChange.ts + server/src/routes/profile.ts; this file
// only mirrors them well enough to fail fast and explain itself.

export function AccountIdentityCard() {
  const { me, refresh } = useAuth();
  const t = useT();
  // A stream auto-login is a restricted session and the server refuses
  // renames from it outright — showing the form would only offer a button
  // that 403s.
  if (!me || me.isStream) return null;

  return (
    <section className="g-card g-card-full account-identity">
      <h3>{t("Your name")}</h3>
      <p className="g-help" style={{ marginTop: 0 }}>
        {t("If you signed in with Google we filled both of these in for you — the display name comes straight from your Google profile, which is usually your real name. Nothing here is permanent: change them to whatever you'd rather be called.")}
      </p>

      <RenameRow
        label={t("Display name")}
        help={t("What other trainers see in chat, the trainer directory and the leaderboards.")}
        initial={me.name ?? ""}
        placeholder={t("Ash")}
        maxLength={40}
        allowedAt={me.displayNameChangeAllowedAt ?? null}
        onSave={async (value) => { await api.updateDisplayName(value); await refresh(); }}
      />

      <RenameRow
        label={t("Username")}
        help={t("Your @handle — how people find you, add you as a friend and open your trainer card. Letters, digits and underscores only, and always shown in lowercase.")}
        initial={me.username}
        placeholder="ash_ketchum"
        maxLength={20}
        prefix="@"
        sanitize={(v) => v.replace(/[^a-zA-Z0-9_]/g, "")}
        allowedAt={me.usernameChangeAllowedAt ?? null}
        onSave={async (value) => { await api.updateUsername(value); await refresh(); }}
      />
    </section>
  );
}

interface RenameRowProps {
  label: string;
  help: ReactNode;
  initial: string;
  placeholder: string;
  maxLength: number;
  prefix?: string;
  sanitize?: (v: string) => string;
  /** ISO instant this field unlocks again, or null when it's free now. */
  allowedAt: string | null;
  onSave: (value: string) => Promise<void>;
}

function RenameRow({
  label, help, initial, placeholder, maxLength, prefix, sanitize, allowedAt, onSave,
}: RenameRowProps) {
  const t = useT();
  const inputId = useId();
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Track the server's copy. After a successful save the profile reloads
  // and `initial` becomes the new name; without this the field would keep
  // showing what was typed even if the server cleaned it up (collapsed
  // whitespace, lowercased a handle).
  useEffect(() => { setValue(initial); }, [initial]);

  const lockedUntil = allowedAt && new Date(allowedAt).getTime() > Date.now() ? allowedAt : null;
  const trimmed = value.trim();
  const dirty = trimmed.length > 0 && trimmed !== initial.trim();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty || busy || lockedUntil) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await onSave(trimmed);
      setSaved(true);
    } catch (err) {
      setError(renameError(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="rename-row" onSubmit={submit}>
      {/* htmlFor rather than wrapping, because the Save button sits on the
          same line: a <button> inside a <label> steals the label's click. */}
      <label className="auth-label rename-label" htmlFor={inputId}>
        <span>{label}</span>
      </label>
      <div className="rename-input-row">
        {prefix && <span className="rename-prefix" aria-hidden>{prefix}</span>}
        <input
          id={inputId}
          type="text"
          value={value}
          maxLength={maxLength}
          placeholder={placeholder}
          disabled={busy || !!lockedUntil}
          onChange={(e) => {
            setValue(sanitize ? sanitize(e.target.value) : e.target.value);
            setSaved(false);
            setError(null);
          }}
        />
        <button
          type="submit"
          className="g-btn-primary g-btn-small"
          disabled={!dirty || busy || !!lockedUntil}
        >
          {busy ? "…" : t("Save")}
        </button>
      </div>
      <p className="g-help">{help}</p>
      {lockedUntil && (
        <p className="g-help rename-locked">
          {t("Changed recently — you can change this again on")}{" "}
          {new Date(lockedUntil).toLocaleString()}.
        </p>
      )}
      {error && <p className="auth-error rename-error">{error}</p>}
      {saved && !error && <p className="g-help rename-saved">{t("Saved.")}</p>}
    </form>
  );
}

// Map the server's machine codes to copy a player can act on. Same split
// LoginScreen already uses for Better Auth's codes: the server owns the
// rule, the client owns the wording, so the message can be translated
// instead of arriving pre-baked in English.
function renameError(err: unknown, t: (s: string) => string): string {
  if (!(err instanceof ApiError)) {
    return t("Couldn't reach the server. Check your connection and try again.");
  }
  const code = typeof err.details?.error === "string" ? err.details.error : null;
  switch (code) {
    case "username_taken":
      return t("That username is already taken. Pick another.");
    case "username_reserved":
      return t("That username is reserved.");
    case "username_too_short":
      return t("Username must be at least 3 characters.");
    case "username_too_long":
      return t("Username must be 20 characters or fewer.");
    case "username_invalid":
      return t("Username can only contain letters, digits, and underscores.");
    case "name_too_short":
      return t("Display name must be at least 2 characters.");
    case "name_too_long":
      return t("Display name must be 40 characters or fewer.");
    case "name_invalid":
      return t("Display name needs at least one letter or number.");
    case "name_taken_by_handle":
      return t("That display name is another trainer's username — pick something else.");
    case "username_rejected":
    case "name_rejected":
      return t("That name isn't allowed. Pick another.");
    case "cooldown": {
      const at = typeof err.details?.allowedAt === "string" ? err.details.allowedAt : null;
      return at
        ? `${t("You've changed this recently. You can change it again on")} ${new Date(at).toLocaleString()}.`
        : t("You've changed this recently. Try again later.");
    }
    case "rate_limited":
      return t("Too many attempts. Try again in a few minutes.");
    case "stream_restricted":
      return t("This action is disabled for stream auto-login sessions.");
    default:
      return err.message || t("Couldn't save that. Try again.");
  }
}
