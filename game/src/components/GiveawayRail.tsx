import { useEffect, useState } from "react";
import { openGiveaways } from "./GiveawayModal";
import { useGiveaways, seenWins, refreshGiveaways } from "../utils/giveawayStore";
import { railState, shortCountdown, type RailState } from "../utils/giveawayRail";
import { primaryPrizeLabel } from "../utils/prizeDisplay";
import { useT } from "../i18n/useT";
import "./giveaways.css";

// The standing giveaway control.
//
// Giveaways were effectively invisible: the only ways in were a chat card that
// scrolls away, an announcement banner that has NEVER been published in
// production (the Announcement table has zero rows, ever), and a button three
// clicks deep inside Settings → Stats. 67 of 2,405 accounts have ever entered
// one — 2.8%. That is not a demand problem, it is a discovery problem, and
// this row is the fix: one always-present control in the rail the player
// already watches.
//
// Three rules it has to hold at once:
//
//   * It must SAY something. A button labelled "Giveaways" that opens a modal
//     to find out whether anything is running is barely better than the
//     Settings route. So the row reports live/entered/closing/won, and when
//     nothing is running it reports that the feature is real and recurring.
//   * It must not vanish when idle. Production is empty ~16% of the time, in
//     multi-hour stretches; chrome that disappears is how this became
//     invisible in the first place. Same row, same height, quieter tone.
//   * It must not steal height from chat beyond its own. The left rail is a
//     flex column where .chat-card is the only elastic child, so this is
//     `flex: 0 0 auto` at a fixed 42px in every state — including loading,
//     which renders the same row rather than a skeleton that resizes.
//
// It is one <button>, not a row with a nested Enter button. Nested interactive
// controls are a mis-tap waiting to happen in a 250px strip, and one-click
// entry from a strip means entering without having seen the prize or the
// rules. The pill reads "ENTER" because there IS something to do; the doing
// happens in the dialog, one click later, where the prize is on screen.

export function GiveawayRail({ variant = "rail" }: { variant?: "rail" | "mobile" }) {
  const snap = useGiveaways();
  const t = useT();

  // Re-render often enough for the countdown to be honest, and no more. A
  // giveaway closing in three days does not need a 1Hz timer in the rail.
  const [, tick] = useState(0);
  const live = snap.giveaways?.some((g) => g.status === "open") ?? false;
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => tick((n) => n + 1), 20_000);
    return () => window.clearInterval(id);
  }, [live]);

  const st = railState({
    giveaways: snap.giveaways,
    stats: snap.stats,
    now: Date.now(),
    seenWins: seenWins(),
    error: snap.error,
    promos: snap.promos,
  });
  const copy = railCopy(st, t);

  return (
    <button
      type="button"
      className={`gw-rail gw-rail--${st.tone}${variant === "mobile" ? " gw-rail--mobile" : ""}`}
      onClick={() => {
        // The offline row is the one state where the click has a second job:
        // the store only retries on its own poll, and a player looking at a
        // row that says "tap to retry" expects the tap to retry.
        if (st.kind === "offline") void refreshGiveaways({ force: true });
        openGiveaways(st.targetId ?? undefined);
      }}
      aria-label={copy.aria}
      title={copy.aria}
    >
      <span className="gw-rail-icon" aria-hidden>
        {st.kind === "won" ? "🏆" : st.kind === "promo" ? "✦" : "🎁"}
      </span>
      <span className="gw-rail-text">
        <span className="gw-rail-label">{copy.label}</span>
        <span className="gw-rail-sub">{copy.sub}</span>
      </span>
      {st.pulse && <span className="gw-rail-dot" aria-hidden />}
      {copy.pill && <span className="gw-rail-pill">{copy.pill}</span>}
      <span className="gw-rail-chev" aria-hidden>›</span>
    </button>
  );
}

interface RailCopy {
  label: string;
  sub: string;
  pill: string;
  aria: string;
}

/**
 * State → words. At ~250px of usable text width the label has room for about
 * thirty characters, so every line here is short on purpose: "2 live", not
 * "2 giveaways are currently running". The full sentence goes in `aria`.
 */
function railCopy(st: RailState, t: (s: string) => string): RailCopy {
  const prize = st.primary ? primaryPrizeLabel(st.primary.prizes) : "";
  const closes =
    st.endsInMs == null
      ? ""
      : st.endsInMs <= 0
      ? t("drawing now")
      : `${t("closes in ")}${shortCountdown(st.endsInMs)}`;

  switch (st.kind) {
    case "loading":
      return {
        label: t("Giveaways"),
        sub: t("Checking…"),
        pill: "",
        aria: t("Giveaways — loading"),
      };

    // Never loaded, and the reason is a failed request rather than one still
    // in flight. "Checking…" here would be a lie that never corrects itself.
    case "offline":
      return {
        label: t("Giveaways"),
        sub: t("Couldn't load — tap to retry"),
        pill: t("RETRY"),
        aria: t("Giveaways could not be loaded. Tap to retry."),
      };

    case "won":
      return {
        label: t("You won!"),
        sub: prize || st.primary?.title || t("Tap to see your prize"),
        pill: t("VIEW"),
        aria: `${t("You won a giveaway")}${prize ? ` — ${prize}` : ""}. ${t("Open giveaways")}`,
      };

    case "live-unentered":
      return {
        label: t("Giveaway live"),
        sub: prize || st.primary?.title || t("Free to enter"),
        pill: t("ENTER"),
        aria: `${t("A giveaway is live")}${prize ? ` — ${prize}` : ""}. ${t("You have not entered")}. ${closes}`,
      };

    case "live-mixed":
      return {
        label: `${st.liveCount}${t(" live")}`,
        sub: `${st.unenteredCount}${t(" not entered")}${closes ? ` · ${closes}` : ""}`,
        pill: t("ENTER"),
        aria: `${st.liveCount}${t(" giveaways live")}, ${st.unenteredCount}${t(" not entered yet")}.`,
      };

    // Something free that has not been collected, and no giveaway with a
    // deadline competing for the line. The label names the PRIZE, not the
    // errand: "Free Master Ball" is the reason to click, "Join the Discord" is
    // the price. The errand goes in the sub, where it belongs.
    case "promo": {
      const promoPrize = st.promo ? primaryPrizeLabel(st.promo.prizes) : "";
      return {
        label: promoPrize ? `${t("Free ")}${promoPrize}` : t("Free reward"),
        sub: st.promo?.title ?? t("Waiting to be claimed"),
        pill: t("FREE"),
        aria: `${t("A free reward is waiting")}${promoPrize ? ` — ${promoPrize}` : ""}. ${st.promo?.title ?? ""}`,
      };
    }

    case "live-entered":
      return {
        label: st.liveCount > 1 ? `${t("Entered ")}${st.liveCount}` : t("Entered"),
        sub: closes || t("waiting on the draw"),
        pill: "✓",
        aria: `${t("You are entered")}. ${closes || t("Waiting on the draw")}.`,
      };

    case "idle":
    default: {
      // The whole point of the idle row: prove the feature recurs. A player
      // who missed the last three needs to see that there WERE three.
      const held = st.totalHeld > 0 ? `${st.totalHeld}${t(" held")}` : t("none yet");
      return {
        label: t("Giveaways"),
        sub: st.lastTitle ? `${held} · ${t("last: ")}${st.lastTitle}` : held,
        pill: t("SEE"),
        aria: `${t("No giveaway running right now")}. ${held}. ${t("Open giveaways")}`,
      };
    }
  }
}
