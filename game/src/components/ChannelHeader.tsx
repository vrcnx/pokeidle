import { useEffect, useState } from "react";
import { useGame } from "../state/GameContext";
import { useOnlineCount } from "../state/presence";
import { useAnnouncement } from "../state/announcement";
import { openGiveaways } from "./GiveawayModal";
import { useT } from "../i18n/useT";
import type { SaveStatus } from "../state/GameContext";
import type { Announcement, AnnouncementType } from "../net/api";

// The announcement band at the top of the chat column — and NOTHING when
// there is no announcement.
//
// It used to render a permanent 44px row reading "CHAT" plus the online
// count, sitting directly above MiniChat's tab row, which carries its own
// online pill. That was two rows and two copies of the same number to say
// one thing. The label was redundant with the tabs beneath it (GLOBAL /
// AUCTIONS is unambiguously a chat), so the row is gone and its two pieces
// that DO carry information — the save-status warning and the online count —
// moved into MiniChat's tab row, which was already there.
//
// The banner still gets its own band, because an admin pinning "the server
// restarts in 10 minutes" must not have to compete with tab chrome for the
// space. It just no longer reserves that band when there is nothing to say.
//
// SaveStatusDot is exported for MiniChat. It is worth noting that MiniChat
// also renders standalone on mobile (MobileShell), which never had a
// ChannelHeader — so before this change a phone could never show the
// "Not backing up" warning at all. Moving it here fixes that too.
export function ChannelHeader() {
  const { saveStatus } = useGame();
  const online = useOnlineCount();
  const announcement = useAnnouncement();
  const dismissed = useDismissed(announcement?.id ?? null);
  const t = useT();

  const showBanner = !!announcement && !(dismissed && META[announcement.type].dismissible);
  // No banner, no band. MiniChat's tab row carries presence and save status.
  if (!showBanner) return null;

  return (
    <div
      className={`channel-header${showBanner ? ` channel-header--announce ann-${announcement!.type}` : ""}`}
      role="banner"
      aria-label={showBanner ? t("Announcement") : t("Chat")}
    >
      <AnnouncementBody a={announcement!} onDismiss={() => dismiss(announcement!.id)} />
    </div>
  );
}

// Per-type presentation. `dismissible` gates the × — operational banners
// (a restart is coming, something is broken) stay put; nice-to-knows can be
// dismissed. Colour comes from the `ann-<type>` class in app.css.
const META: Record<AnnouncementType, { icon: string; label: string; dismissible: boolean }> = {
  info:        { icon: "📣", label: "Announcement", dismissible: true },
  event:       { icon: "✨", label: "Event",        dismissible: true },
  giveaway:    { icon: "🎁", label: "Giveaway",     dismissible: true },
  warning:     { icon: "⚠️", label: "Heads up",     dismissible: false },
  maintenance: { icon: "🔧", label: "Maintenance",  dismissible: false },
};

function AnnouncementBody({ a, onDismiss }: { a: Announcement; onDismiss: () => void }) {
  const t = useT();
  const meta = META[a.type] ?? META.info;
  const cta = resolveCta(a);
  return (
    <span className="channel-header-announce-body" role="status" aria-live="polite">
      <span className="channel-header-announce-icon" aria-hidden>{meta.icon}</span>
      <span className="channel-header-announce-text" title={`${meta.label}: ${a.message}`}>
        {a.message}
      </span>
      {cta && (
        cta.kind === "external"
          ? (
            <a className="channel-header-announce-cta" href={cta.href} target="_blank" rel="noopener noreferrer">
              {cta.label}
            </a>
          )
          : (
            <button className="channel-header-announce-cta" type="button" onClick={cta.onClick}>
              {cta.label}
            </button>
          )
      )}
      {meta.dismissible && (
        <button
          className="channel-header-announce-x"
          type="button"
          onClick={onDismiss}
          aria-label={t("Dismiss announcement")}
          title={t("Dismiss")}
        >
          ×
        </button>
      )}
    </span>
  );
}

// Turn an announcement's href into something clickable. External http(s)
// links open a new tab; the in-app "#giveaways" route opens the giveaway
// modal. Unknown in-app routes render no CTA rather than a dead link.
type Cta =
  | { kind: "external"; href: string; label: string }
  | { kind: "action"; onClick: () => void; label: string };

function resolveCta(a: Announcement): Cta | null {
  const href = a.href?.trim();
  if (!href) return null;
  const label = a.linkLabel?.trim() || "Open";
  if (href === "#giveaways") return { kind: "action", onClick: openGiveaways, label };
  if (/^https?:\/\//i.test(href)) return { kind: "external", href, label };
  return null;
}

// ── Dismiss state ──
// Remembering a dismissal per announcement id (not a boolean) means the NEXT
// banner an admin pins shows again — dismissing "double XP is live" must not
// also hide next week's giveaway. Survives reloads via localStorage.
const DISMISS_KEY = "pkmn-dismissed-announcement";
const _dismissListeners = new Set<() => void>();

function dismiss(id: string) {
  try { localStorage.setItem(DISMISS_KEY, id); } catch { /* private mode */ }
  for (const fn of _dismissListeners) fn();
}

function useDismissed(currentId: string | null): boolean {
  const [dismissedId, setDismissedId] = useState<string | null>(() => {
    try { return localStorage.getItem(DISMISS_KEY); } catch { return null; }
  });
  useEffect(() => {
    const sync = () => {
      try { setDismissedId(localStorage.getItem(DISMISS_KEY)); } catch { /* */ }
    };
    _dismissListeners.add(sync);
    // `storage` fires in OTHER tabs when this key changes, so dismissing in
    // one tab hides the banner in the player's other open tabs too.
    const onStorage = (e: StorageEvent) => { if (e.key === DISMISS_KEY) sync(); };
    window.addEventListener("storage", onStorage);
    return () => {
      _dismissListeners.delete(sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return currentId != null && dismissedId === currentId;
}

// Compact dot+text save status. Only speaks when the game genuinely cannot
// keep the player's progress — see the long note that used to live here.
// When saving works, saving is invisible.
export function SaveStatusDot({ status }: { status: SaveStatus }) {
  const t = useT();
  if (status === "rejected") {
    return (
      <span className="channel-header-save save-status-error" role="alert" title={t("This game's servers rejected your save, so nothing you do now is being backed up. It is still on this device, but anything that syncs — listing an auction, a prize arriving — can replace it with the last copy the server accepted. Report this before you keep playing.")}>
        <span className="channel-header-save-dot" aria-hidden />
        <span>{t("Not backing up")}</span>
      </span>
    );
  }
  if (status === "signedout") {
    return (
      <span className="channel-header-save save-status-error" role="alert" title={t("You have been signed out — signing in somewhere else ends the session here. Nothing is saving to the cloud until you sign in again on this device, and anything you play now can be lost. Sign in again before you keep playing.")}>
        <span className="channel-header-save-dot" aria-hidden />
        <span>{t("Signed out — not saving")}</span>
      </span>
    );
  }
  if (status === "diverged") {
    return (
      <span className="channel-header-save save-status-error" role="alert" title={t("This device and the cloud have both moved on separately, so neither copy contains everything. What you have played here is NOT backed up, and reloading would replace it with the cloud copy. Do not reload — report this so it can be merged for you.")}>
        <span className="channel-header-save-dot" aria-hidden />
        <span>{t("Not merged — don't reload")}</span>
      </span>
    );
  }
  if (status === "conflict") {
    return (
      <span className="channel-header-save save-status-error" role="alert" title={t("Your progress is open in another tab or on another device, which is the one saving to the cloud. Close the others and reload to sync this one.")}>
        <span className="channel-header-save-dot" aria-hidden />
        <span>{t("Open elsewhere")}</span>
      </span>
    );
  }
  return null;
}
