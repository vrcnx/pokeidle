import { useEffect, useRef } from "react";
import { api } from "../net/api";
import { useAuth } from "../auth/AuthContext";
import { pushToast } from "../components/Toast";
import { sendTradeInvite } from "../state/trade";

// `?trade=<username>` — the deep link the Discord trade noticeboard hands out.
//
// ── WHAT A DEEP LINK CAN AND CANNOT DO HERE ─────────────────────────
// It cannot open a trade on its own, and it is important that the copy never
// implies otherwise. A trade is a LIVE handshake: `trade:invite` goes over the
// socket to a connected recipient, who accepts, and only then does a trade
// room exist (see server/src/socket.ts). If the person who posted the listing
// is offline there is nothing to open — no queue, no offline invite, and
// deliberately so, because the mutual-consent structure of that handshake is
// exactly what makes the swap safe.
//
// So this hook does the honest version: resolve the name, fire the invite if
// they are there, and say plainly that they are not if they aren't. A listing
// on a noticeboard is a lead, not an appointment.
//
// ── WHY THE PARAM IS CONSUMED IMMEDIATELY ───────────────────────────
// The query string is stripped via replaceState before the invite is sent, so
// a refresh — or the browser restoring the tab tomorrow — does not fire a
// second invite at someone who has by then forgotten the conversation. One
// click, one invite.
export function useTradeDeepLink(): void {
  const { status } = useAuth();
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    if (status !== "authenticated") return;

    const url = new URL(window.location.href);
    const target = url.searchParams.get("trade");
    if (!target) { done.current = true; return; }
    done.current = true;

    // Consume the param before doing anything async. See above.
    url.searchParams.delete("trade");
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);

    void (async () => {
      try {
        const profile = await api.publicProfile(target);
        const me = await api.meProfile().catch(() => null);
        if (me && me.id === profile.id) {
          pushToast({ kind: "info", text: "That's your own trade listing." });
          return;
        }
        sendTradeInvite(profile.id, (res) => {
          if (res?.ok) {
            pushToast({ kind: "info", text: `Trade invite sent to ${profile.username}.` });
          } else {
            // The server's ack carries the real reason — offline, already in a
            // trade, rate-limited. Surfacing it beats a generic failure, and
            // this is the one path where "they're not online" is the expected
            // outcome rather than an error.
            pushToast({
              kind: "warn",
              text:
                res?.error === "offline" || res?.error === "not_found"
                  ? `${profile.username} isn't online right now — try again when they are.`
                  : `Couldn't start a trade with ${profile.username}.`,
            });
          }
        });
      } catch {
        pushToast({ kind: "warn", text: `Couldn't find a trainer called "${target}".` });
      }
    })();
  }, [status]);
}
