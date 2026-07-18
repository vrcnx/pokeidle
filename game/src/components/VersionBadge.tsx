import { CURRENT_VERSION } from "../data/changelog";
import { openChangelog } from "./ChangelogModal";
import { useT } from "../i18n/useT";

// Subtle build stamp pinned to the bottom-left of the page (desktop only —
// hidden on mobile via CSS, where screen space is precious). Clicking it
// opens the changelog, so the version doubles as a shortcut to "what's new".
export function VersionBadge() {
  const t = useT();
  return (
    <button
      className="version-badge"
      type="button"
      onClick={openChangelog}
      title={t("What's new")}
      aria-label={`Version ${CURRENT_VERSION} — view changelog`}
    >
      v{CURRENT_VERSION}
    </button>
  );
}
