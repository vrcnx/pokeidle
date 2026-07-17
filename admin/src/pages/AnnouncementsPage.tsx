import { useEffect, useMemo, useState } from "react";
import { api, type ChatMessage, type AdminAnnouncement, type AdminAnnouncementRow, type AnnouncementType } from "../api";

// Two distinct tools live here, because they are genuinely different things:
//
//   1. PINNED BANNER — a persistent card at the top of every player's chat
//      column. Stays until an admin replaces or clears it; a player who
//      joins hours later still sees it. One is live at a time.
//
//   2. CHAT BROADCAST — a one-off 📢 message dropped into global chat. It
//      scrolls away like any message. Good for "restart in 5 min", bad for
//      anything a player needs to still see after the chat moves on.

const ANNOUNCEMENT_PREFIX = "📢 SERVER ANNOUNCEMENT — ";
const MAX_LEN = 500;
const BANNER_MAX = 200;

const TYPES: { value: AnnouncementType; label: string; icon: string; hint: string }[] = [
  { value: "info",        label: "Info",        icon: "📣", hint: "General news" },
  { value: "event",       label: "Event",       icon: "✨", hint: "Double XP, live events" },
  { value: "giveaway",    label: "Giveaway",     icon: "🎁", hint: "A giveaway is live" },
  { value: "warning",     label: "Heads up",     icon: "⚠️", hint: "Non-critical warning" },
  { value: "maintenance", label: "Maintenance",  icon: "🔧", hint: "Downtime / restart" },
];

// The DB `active` flag alone lies: nothing sweeps it when a banner expires,
// so an expired row keeps active=true. The truth is: exactly the row the
// server reports as `live` is live; an active row scheduled for later is
// "scheduled"; an active row past its expiry is "expired"; everything else
// "ended".
function rowStatus(r: AdminAnnouncementRow, live: AdminAnnouncement | null): string {
  if (live && r.id === live.id) return "LIVE";
  const now = Date.now();
  if (r.active && r.startsAt && new Date(r.startsAt).getTime() > now) return "scheduled";
  if (r.active && r.expiresAt && new Date(r.expiresAt).getTime() <= now) return "expired";
  return "ended";
}

export function AnnouncementsPage() {
  return (
    <div className="page announcements-page">
      <header className="page-head">
        <h1>Announcements</h1>
        <p className="dim">Two tools: a persistent banner pinned to every player's chat header, and a one-off broadcast into global chat.</p>
      </header>
      <BannerManager />
      <ChatBroadcast />
    </div>
  );
}

// ── 1. Pinned banner ────────────────────────────────────────────────
function BannerManager() {
  const [live, setLive] = useState<AdminAnnouncement | null>(null);
  const [recent, setRecent] = useState<AdminAnnouncementRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const [type, setType] = useState<AnnouncementType>("info");
  const [message, setMessage] = useState("");
  const [href, setHref] = useState("");
  const [linkLabel, setLinkLabel] = useState("");
  const [expiresInHours, setExpiresInHours] = useState("");

  const reload = () => {
    api.listAnnouncements()
      .then((d) => { setLive(d.live); setRecent(d.recent); })
      .catch((e) => setErr(e.message));
  };
  useEffect(reload, []);

  const flash = (m: string) => { setNote(m); setTimeout(() => setNote(null), 4000); };

  const publish = async () => {
    const m = message.trim();
    if (!m) return;
    if (m.length > BANNER_MAX) { setErr(`Banner too long — max ${BANNER_MAX} characters.`); return; }
    const h = href.trim();
    // Keep in lockstep with the server's isValidHref / KNOWN_HASH_ROUTES:
    // only in-app routes the game can actually open are accepted, so we
    // never publish a CTA that renders nothing.
    const KNOWN_HASH_ROUTES = ["#giveaways"];
    if (h && !(KNOWN_HASH_ROUTES.includes(h) || /^https?:\/\//i.test(h))) {
      setErr(`Link must be an https:// URL or a known in-app route (${KNOWN_HASH_ROUTES.join(", ")}).`);
      return;
    }
    const hours = expiresInHours.trim() ? Number(expiresInHours) : null;
    if (hours !== null && (!Number.isFinite(hours) || hours <= 0)) {
      setErr("Expiry must be a positive number of hours, or blank for no expiry.");
      return;
    }
    const expiresAt = hours !== null ? new Date(Date.now() + hours * 3_600_000).toISOString() : null;

    if (!window.confirm(`Pin this ${type} banner to EVERY player's chat header?\n\n"${m}"${h ? `\n\nLink: ${h}` : ""}${expiresAt ? `\n\nAuto-clears in ${hours}h.` : ""}`)) return;

    setBusy(true); setErr(null);
    try {
      await api.publishAnnouncement({
        type, message: m,
        href: h || null,
        linkLabel: h ? (linkLabel.trim() || null) : null,
        expiresAt,
      });
      setMessage(""); setHref(""); setLinkLabel(""); setExpiresInHours("");
      flash("Banner published — live for every player now.");
      reload();
    } catch (e: any) {
      setErr(e?.message ?? "publish failed");
    } finally { setBusy(false); }
  };

  const clear = async () => {
    if (!window.confirm("Take the banner down for everyone?")) return;
    setBusy(true); setErr(null);
    try {
      await api.clearAnnouncement();
      flash("Banner cleared.");
      reload();
    } catch (e: any) {
      setErr(e?.message ?? "clear failed");
    } finally { setBusy(false); }
  };

  const remaining = BANNER_MAX - message.length;
  const meta = TYPES.find((t) => t.value === type)!;

  return (
    <>
      {err && <div className="page-err">{err}</div>}
      {note && <div className="page-banner page-banner--good">{note}</div>}

      <section className="card">
        <h2>Pinned banner</h2>
        <p className="dim small">Shows at the top of every player's chat column until replaced or cleared. One is live at a time.</p>

        {live
          ? (
            <div className={`ann-live ann-live--${live.type}`}>
              <div className="ann-live-main">
                <span className="ann-live-icon">{(TYPES.find((t) => t.value === live.type) ?? TYPES[0]).icon}</span>
                <div>
                  <div className="ann-live-msg">{live.message}</div>
                  <div className="dim small">
                    Live · {live.type}
                    {live.href ? ` · link → ${live.linkLabel || live.href}` : ""}
                    {live.expiresAt ? ` · clears ${new Date(live.expiresAt).toLocaleString()}` : ""}
                  </div>
                </div>
              </div>
              <button className="btn-danger btn-tiny" onClick={clear} disabled={busy}>Clear banner</button>
            </div>
          )
          : <p className="dim small ann-none">No banner is live right now.</p>}

        <div className="ann-form">
          <label className="ann-field">
            <span className="dim small">Type</span>
            <div className="ann-type-row">
              {TYPES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  className={`ann-type-chip${type === t.value ? " is-active" : ""} ann-type-chip--${t.value}`}
                  onClick={() => setType(t.value)}
                  title={t.hint}
                >
                  <span aria-hidden>{t.icon}</span> {t.label}
                </button>
              ))}
            </div>
          </label>

          <label className="ann-field">
            <span className="dim small">Message <span className={remaining < 0 ? "over-limit" : "dim"}>· {remaining} left</span></span>
            <input
              className="ann-input"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={`${meta.icon} e.g. Double XP weekend is live until Sunday!`}
              maxLength={BANNER_MAX + 40}
            />
          </label>

          <div className="ann-field-row">
            <label className="ann-field">
              <span className="dim small">Link (optional) — https:// or #giveaways</span>
              <input className="ann-input" value={href} onChange={(e) => setHref(e.target.value)} placeholder="#giveaways" />
            </label>
            <label className="ann-field">
              <span className="dim small">Button label</span>
              <input className="ann-input" value={linkLabel} onChange={(e) => setLinkLabel(e.target.value)} placeholder="View giveaway" disabled={!href.trim()} />
            </label>
            <label className="ann-field ann-field--narrow">
              <span className="dim small">Auto-clear (hours)</span>
              <input className="ann-input" value={expiresInHours} onChange={(e) => setExpiresInHours(e.target.value)} placeholder="none" inputMode="numeric" />
            </label>
          </div>

          <div className="ann-actions">
            <button className="btn-primary" onClick={publish} disabled={busy || !message.trim() || remaining < 0}>
              {busy ? "Publishing…" : live ? "Replace banner" : "Publish banner"}
            </button>
          </div>
        </div>

        {recent.length > 0 && (
          <details className="ann-history-wrap">
            <summary className="dim small">Recent banners · {recent.length}</summary>
            <ul className="announce-history">
              {recent.map((r) => (
                <li key={r.id} className="announce-history-row">
                  <div className="announce-history-meta">
                    <strong>{(TYPES.find((t) => t.value === r.type) ?? TYPES[0]).icon} {r.type}</strong>
                    <span className="dim small">
                      {rowStatus(r, live)} · {new Date(r.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="announce-history-body">{r.message}</div>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </>
  );
}

// ── 2. Chat broadcast (unchanged behaviour) ─────────────────────────
function ChatBroadcast() {
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [sentBanner, setSentBanner] = useState<string | null>(null);

  const reloadHistory = () => {
    api.recentChat(200, { channel: "global" })
      .then((d) => setHistory(d.messages.filter((m) => m.content.startsWith(ANNOUNCEMENT_PREFIX))))
      .catch((e) => setErr(e.message));
  };
  useEffect(reloadHistory, []);

  const send = async () => {
    const c = content.trim();
    if (!c) return;
    if (c.length > MAX_LEN) { setErr(`Too long — max ${MAX_LEN} characters (you have ${c.length}).`); return; }
    if (!window.confirm(`Send this as a one-off message into global chat?\n\n"${c}"\n\nIt will scroll away like any chat message. For something players should keep seeing, use the pinned banner above.`)) return;
    setBusy(true); setErr(null);
    try {
      const res = await api.announce(c);
      setHistory((h) => [res.message, ...h]);
      setContent("");
      setSentBanner("Broadcast sent to global chat.");
      setTimeout(() => setSentBanner(null), 4000);
    } catch (e: any) {
      setErr(e?.message ?? "send failed");
    } finally { setBusy(false); }
  };

  const remaining = MAX_LEN - content.length;
  const overLimit = remaining < 0;

  const presets = useMemo(() => ([
    "Server restart in 5 minutes — please save your progress.",
    "Maintenance complete — sorry for the delay, thanks for your patience.",
  ]), []);

  return (
    <>
      {err && <div className="page-err">{err}</div>}
      {sentBanner && <div className="page-banner page-banner--good">{sentBanner}</div>}

      <section className="card announce-composer">
        <h2>Broadcast to chat</h2>
        <p className="dim small">A one-off 📢 message in global chat. It scrolls away — for anything persistent, use the pinned banner.</p>
        <textarea
          className="announce-input"
          placeholder="Type a one-off chat message…"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={3}
          maxLength={MAX_LEN + 50}
        />
        <div className="announce-row">
          <div className="announce-presets">
            {presets.map((p) => (
              <button key={p} className="btn-ghost btn-tiny" onClick={() => setContent(p)}>
                {p.length > 32 ? p.slice(0, 30) + "…" : p}
              </button>
            ))}
          </div>
          <div className="announce-actions">
            <span className={`dim small ${overLimit ? "over-limit" : ""}`}>{remaining} characters left</span>
            <button className="btn-primary" onClick={send} disabled={busy || !content.trim() || overLimit}>
              {busy ? "Sending…" : "Broadcast"}
            </button>
          </div>
        </div>
      </section>

      <section className="card">
        <h2>Recent chat broadcasts <span className="dim small">· {history.length}</span></h2>
        {history.length === 0
          ? <p className="dim small">Nothing broadcast in the last 200 messages.</p>
          : (
            <ul className="announce-history">
              {history.map((m) => (
                <li key={m.id} className="announce-history-row">
                  <div className="announce-history-meta">
                    <strong>@{m.user.username}</strong>
                    <span className="dim small">{new Date(m.createdAt).toLocaleString()}</span>
                  </div>
                  <div className="announce-history-body">{m.content.replace(ANNOUNCEMENT_PREFIX, "")}</div>
                </li>
              ))}
            </ul>
          )
        }
      </section>
    </>
  );
}
