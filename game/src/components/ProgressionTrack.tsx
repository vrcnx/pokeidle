import { useEffect, useRef, useState } from "react";
import type { ProgressionStop } from "../net/api";
import { PrizeChips } from "./PrizeChips";
import { useT } from "../i18n/useT";

// The level ladder, as a track you move along.
//
// ── WHY A TRACK AND NOT A NUMBER ────────────────────────────────────
// The first version was one line — "Level 1225 — $492,000 + 5x Ultra Ball" —
// and it answered the smaller half of the question. A player at 1,197 could
// see the next stop and had no way to learn that a Master Ball was waiting at
// 1,250. What makes a ladder worth climbing is being able to see up it.
//
// ── THE FILL ANIMATES FROM EMPTY, ONCE ──────────────────────────────
// On mount the line grows to the player's position rather than appearing
// already there. It is the one moment the card can say "this is how far you
// have come" instead of "this is where you are", and it costs a single
// transition. It does NOT re-run on every re-render — a bar that re-fills
// whenever the parent updates stops reading as progress and starts reading as
// a loading state.
//
// ── AND IT IS A WINDOW ──────────────────────────────────────────────
// The server sends a few stops, never the ~4,007 that exist. Anything here
// that assumed it had the whole ladder would be wrong at level 40 and
// catastrophic at level 40,000.
//
// ── IT DRAWS ANY LADDER, NOT THE ACCOUNT-LEVEL ONE ──────────────────
// The prop is the three fields a track needs rather than a whole
// ProgressionStatus, because the Discord rank ladder is the same picture of a
// different number. Both servers emit the same stop shape for exactly this
// reason — see DiscordRankStop in server/src/lib/discordRankRewards.ts, whose
// rank field is named `level` to keep one renderer instead of two.

export interface TrackData {
  track: ProgressionStop[];
  /** 0..1 across the gap to the next stop. */
  progress: number;
  /** Which tier the player has reached — the scroll anchor depends on it. */
  reachedTier: number;
}

export function ProgressionTrack({ data }: { data: TrackData }) {
  const t = useT();
  const [filled, setFilled] = useState(false);
  const trackRef = useRef<HTMLDivElement | null>(null);
  // Which edges have more track behind them. Drives the fades, and drives them
  // per-side: a fade over content that is fully visible does not read as
  // "scroll for more", it reads as a rendering fault.
  const [more, setMore] = useState({ left: false, right: false });

  // One frame later, so the browser has a 0% to transition FROM. Setting the
  // final width in the same commit as the mount paints it full with no
  // animation at all.
  useEffect(() => {
    const id = requestAnimationFrame(() => setFilled(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Park the view on the player's own position rather than the start of the
  // window. The stops behind are context; the reason to look at this is what
  // is ahead.
  //
  // `scrollLeft` rather than scrollIntoView: the latter walks up the ancestor
  // chain and scrolls every scrollable box it finds, so centring a stop inside
  // this track also yanked the Rewards dialog behind it.
  useEffect(() => {
    const track = trackRef.current;
    const el = track?.querySelector<HTMLElement>(".prog-stop.prog-next");
    if (!track || !el) return;
    track.scrollLeft = el.offsetLeft - (track.clientWidth - el.offsetWidth) / 2;
  }, [data.reachedTier]);

  // Keep the fades honest — on scroll, and on resize, because a card that
  // grows wide enough to show the whole window has nothing left to fade.
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const sync = () => {
      const max = track.scrollWidth - track.clientWidth;
      setMore({
        left: track.scrollLeft > 1,
        // 1px of slack: fractional layout widths leave scrollLeft a hair short
        // of max at the true end, which would strand the fade on forever.
        right: track.scrollLeft < max - 1,
      });
    };
    sync();
    track.addEventListener("scroll", sync, { passive: true });
    const ro = new ResizeObserver(sync);
    ro.observe(track);
    return () => { track.removeEventListener("scroll", sync); ro.disconnect(); };
  }, [data.track.length]);

  const stops = data.track;
  if (stops.length === 0) return null;

  // How far along the drawn line the player actually is: every completed stop,
  // plus the fraction of the gap they are through. Computed against the
  // WINDOW, not the ladder, because the line only draws the window.
  const doneInWindow = stops.filter((s) => s.state === "paid" || s.state === "queued").length;
  const pct = ((doneInWindow - 1 + data.progress) / Math.max(1, stops.length - 1)) * 100;

  return (
    <div className="prog-track-wrap">
      <div
        className={[
          "prog-track",
          more.left ? "prog-track--more-left" : "",
          more.right ? "prog-track--more-right" : "",
        ].filter(Boolean).join(" ")}
        ref={trackRef}
      >
        {/* An inner box at CONTENT width, because the rail has to be as long as
            the stops. Absolutely positioning it against the scroller itself
            measures the visible width instead, so the line stayed pinned to the
            viewport while the stops slid underneath it. */}
        <div className="prog-track-inner">
          {/* The rail and its fill sit behind the stops, one element each, so
              the line is continuous rather than assembled from per-stop
              segments that never quite meet. */}
          <div className="prog-rail" aria-hidden>
            <div
              className="prog-rail-fill"
              style={{ width: filled ? `${Math.max(0, Math.min(100, pct))}%` : "0%" }}
            />
          </div>

          <ol className="prog-stops">
            {stops.map((s) => (
              <li
                key={s.tier}
                className={[
                  "prog-stop",
                  // Prefixed, not `is-${state}`. Bare state names like
                  // `is-queued` are already app.css's, and borrowing one means
                  // a rule written for something else lands on these nodes —
                  // see tests/cssCollisions.test.ts, which refuses it.
                  `prog-${s.state}`,
                  s.milestone ? "prog-milestone" : "",
                ].filter(Boolean).join(" ")}
              >
                <span className="prog-node" aria-hidden>
                  {s.state === "paid" ? "✓" : s.milestone ? "★" : ""}
                </span>
                <span className="prog-stop-level">{s.level.toLocaleString()}</span>
                <span className="prog-stop-prizes">
                  <PrizeChips prizes={s.prizes} size="sm" />
                </span>
              </li>
            ))}
          </ol>
        </div>
      </div>

      <p className="prog-legend dim small">
        {t("Rewards land the next time the game saves. The ladder never ends — it keeps paying more as you climb.")}
      </p>
    </div>
  );
}
