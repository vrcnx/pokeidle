import { useEffect, useMemo, useState } from "react";
import { confirm, notify } from "../components/Confirm";
import { api, type AdminGiveaway, type AdminGiveawayEntry, type GiveawayPrizeInput } from "../api";
import { PrizeBuilder } from "../components/PrizeBuilder";
import { navigateTo } from "../App";
import { PageNote } from "../components/PageChrome";
import { SectionHead } from "../components/Section";

// Giveaway operations.
//
// ── WHY THIS IS ORGANISED BY LIFECYCLE ──────────────────────────────
// It used to be one flat column of identical fat cards — every giveaway at
// every stage, each carrying a title, a description, a prize block, a winners
// block, a fairness-seed disclosure and four buttons. Ten giveaways was a
// wall of text with no shape, and the two things that actually need doing
// were somewhere inside it.
//
// A giveaway's stage completely changes what you care about:
//
//   draft     still being set up. Is it ready to open?
//   open      collecting entries. How many, and when does it close?
//   closed    READY TO DRAW. This is the one that wants doing.
//   drawn     over — except for one thing: did the winners actually get paid?
//   cancelled archive.
//
// So: an attention strip for the two live concerns, full cards for the stages
// you still act on, and a compact expandable row for the ones you don't.
//
// ── THE SHARP EDGE ──────────────────────────────────────────────────
// The draw is irreversible: it writes prizes into real saves and announces
// itself in global chat. The confirm states the entry count, the winner count
// and the exact prize string, and the result comes back per-winner so a
// failed grant is visible rather than assumed.

const STATUS_FLOW: Record<string, string[]> = {
  draft:     ["open", "cancelled"],
  open:      ["closed", "cancelled"],
  closed:    ["open", "drawn", "cancelled"],
  drawn:     [],
  cancelled: [],
};

const ACTIVE = new Set(["draft", "open", "closed"]);

/**
 * The three payout states of a winner. There are THREE, not two, because
 * granting no longer means "written to their save this instant" — it means a
 * durable PendingGrant row that their next upload absorbs.
 *
 *   failed  no claimedAt          the grant itself failed. Pay by hand.
 *   owed    claimedAt, undelivered guaranteed; do NOT re-grant, that pays twice.
 *   paid    delivered              it is in their save.
 *
 * Collapsing owed into "unpaid" is exactly what steers an operator into a
 * double payout, which is why the middle state has its own word everywhere.
 */
function payoutOf(entries: AdminGiveawayEntry[]) {
  const winners = entries.filter((e) => e.isWinner);
  return {
    winners,
    failed: winners.filter((e) => !e.claimedAt),
    owed: winners.filter((e) => e.claimedAt && !e.prizeDelivered),
    paid: winners.filter((e) => e.claimedAt && e.prizeDelivered),
  };
}

export function GiveawaysPage() {
  const [list, setList] = useState<AdminGiveaway[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showFinished, setShowFinished] = useState(false);

  const load = () => {
    api.listGiveawaysAdmin()
      .then((d) => { setList(d.giveaways); setErr(null); })
      .catch((e) => setErr(e.message));
  };
  useEffect(load, []);

  const patch = async (id: string, body: Record<string, unknown>) => {
    setBusy(true); setErr(null);
    try { await api.patchGiveaway(id, body); load(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const draw = async (g: AdminGiveaway) => {
    // Everything irreversible about this is stated up front. "Draw" with no
    // numbers attached is how an operator draws the wrong giveaway.
    if (!await confirm(
      `Draw "${g.title}" now?\n\n`
      + `• ${g.entryCount} entries\n`
      + `• ${g.winnerCount} winner${g.winnerCount === 1 ? "" : "s"}\n`
      + `• Prize: ${g.prizeSummary}\n\n`
      + `Prizes are written straight into the winners' saves and the result is `
      + `announced in global chat.\n\nThis CANNOT be undone or re-drawn.`
    )) return;
    setBusy(true); setErr(null);
    try {
      const res = await api.drawGiveaway(g.id);
      const failed = res.winners.filter((w) => !w.ok);
      const won = res.winners.map((w) => `@${w.username}`).join(", ");
      if (failed.length > 0) {
        // Never let a partial payout look like a clean one.
        setErr(
          `Drawn — winners: ${won}. But ${failed.length} prize grant(s) FAILED `
          + `(${failed.map((f) => `@${f.username}: ${f.error}`).join("; ")}). `
          + `Those players are marked winners but need a manual grant.`
        );
      } else {
        void notify(`Drawn!\n\nWinners: ${won}\n\nPrizes granted and announced in global chat.`);
      }
      load();
    } catch (e) {
      setErr(`Draw failed: ${(e as Error).message}`);
    } finally { setBusy(false); }
  };

  const del = async (g: AdminGiveaway) => {
    if (!await confirm(`Delete "${g.title}"? This removes it and its ${g.entryCount} entries.`)) return;
    setBusy(true); setErr(null);
    try { await api.deleteGiveaway(g.id); load(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const rows = list ?? [];
  const active = rows.filter((g) => ACTIVE.has(g.status));
  const finished = rows.filter((g) => !ACTIVE.has(g.status));

  // ── The two things that actually need doing ───────────────────────
  const attention = useMemo(() => {
    const readyToDraw = rows.filter((g) => g.status === "closed" && g.entryCount > 0);
    // Unpaid winners are the real operational failure here: a grant that
    // failed leaves a player who was told they won and never received it.
    // It used to be a "(UNPAID)" suffix inside a card you had to scroll to
    // and read the parenthetical of.
    const unpaid = rows
      .map((g) => ({ g, failed: payoutOf(g.entries).failed }))
      .filter((x) => x.failed.length > 0);
    return { readyToDraw, unpaid, count: readyToDraw.length + unpaid.length };
  }, [rows]);

  const openCount = rows.filter((g) => g.status === "open").length;

  return (
    <div className="giveaways-page">
      <PageNote>
        {list === null ? "Loading…"
          : `${openCount} open${attention.readyToDraw.length ? ` · ${attention.readyToDraw.length} ready to draw` : ""}`}
      </PageNote>

      {err && <div className="page-err">{err}</div>}

      {creating && (
        <CreateGiveaway
          onCancel={() => setCreating(false)}
          onCreated={() => { setCreating(false); load(); }}
        />
      )}

      {/* ── Attention ─────────────────────────────────────────────
          Rendered only when there IS something. A permanent "0 issues"
          panel is a panel people stop reading. */}
      {attention.count > 0 && (
        <div className="gv-attention">
          {attention.unpaid.map(({ g, failed }) => (
            <div className="gv-alert gv-alert--bad" key={`u${g.id}`}>
              <strong>{failed.length} winner{failed.length === 1 ? "" : "s"} of “{g.title}” never got the prize.</strong>
              <span>
                The grant failed for {failed.map((e) => `@${e.username}`).join(", ")} — they need paying by hand.
              </span>
              <button className="btn-secondary btn-tiny" onClick={() => navigateTo("massgift")}>
                Open Mass gift
              </button>
            </div>
          ))}
          {attention.readyToDraw.map((g) => (
            <div className="gv-alert" key={`d${g.id}`}>
              <strong>“{g.title}” is closed and undrawn.</strong>
              <span>{g.entryCount} entries · {g.winnerCount} winner{g.winnerCount === 1 ? "" : "s"} · {g.prizeSummary}</span>
              <button className="btn-primary btn-tiny" disabled={busy} onClick={() => draw(g)}>
                Draw now
              </button>
            </div>
          ))}
        </div>
      )}

      <SectionHead
        title="Active"
        blurb="Drafts, open entry periods, and anything closed but not yet drawn."
        aside={<button className="btn-primary btn-small" onClick={() => setCreating(true)}>New giveaway</button>}
      />

      {list === null && <p className="dim">Loading…</p>}
      {list !== null && active.length === 0 && (
        <p className="dim">
          {rows.length === 0 ? "No giveaways yet. Create one to get started." : "Nothing active — everything has been drawn or cancelled."}
        </p>
      )}

      <div className="gv-list">
        {active.map((g) => (
          <ActiveCard key={g.id} g={g} busy={busy}
                      onPatch={(body) => patch(g.id, body)}
                      onDraw={() => draw(g)} onDelete={() => del(g)} />
        ))}
      </div>

      {finished.length > 0 && (
        <>
          <SectionHead
            title="Finished"
            blurb="Drawn and cancelled giveaways, kept for the record."
            aside={
              <button className="btn-ghost btn-small" onClick={() => setShowFinished((s) => !s)}>
                {showFinished ? "Hide" : `Show ${finished.length}`}
              </button>
            }
          />
          {showFinished && (
            <ul className="gv-finished card">
              {finished.map((g) => <FinishedRow key={g.id} g={g} busy={busy} onDelete={() => del(g)} />)}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

// ─── Active card ─────────────────────────────────────────────────────
// One line of identity, one line of facts, one row of actions. The old card
// stacked six blocks whether or not they had content — a draft with no
// description still rendered an "No description" line and an empty prize row.
function ActiveCard({ g, busy, onPatch, onDraw, onDelete }: {
  g: AdminGiveaway;
  busy: boolean;
  onPatch: (body: Record<string, unknown>) => void;
  onDraw: () => void;
  onDelete: () => void;
}) {
  const canDraw = (g.status === "open" || g.status === "closed") && g.entryCount > 0;
  const endsAt = g.endsAt ? new Date(g.endsAt) : null;
  const ended = endsAt != null && endsAt.getTime() < Date.now();

  return (
    <article className={`card gv-card gv-card--${g.status}`}>
      <div className="gv-card__main">
        <div className="gv-card__id">
          <span className={`tag gv-status gv-status--${g.status}`}>{g.status}</span>
          <strong className="gv-card__title">{g.title}</strong>
        </div>
        {g.description && <p className="gv-card__desc dim small">{g.description}</p>}
        <div className="gv-card__facts">
          <span><strong className="tabular">{g.entryCount.toLocaleString()}</strong> entries</span>
          <span className="dim">·</span>
          <span><strong className="tabular">{g.winnerCount}</strong> winner{g.winnerCount === 1 ? "" : "s"}</span>
          <span className="dim">·</span>
          <span className="gv-card__prize">{g.prizeSummary}</span>
          {g.minAccountLevel != null && (<><span className="dim">·</span><span className="dim">Lv {g.minAccountLevel}+</span></>)}
          {endsAt && (
            <>
              <span className="dim">·</span>
              {/* An open giveaway past its end date is a real state the old
                  card never showed: entries have stopped but nobody has
                  closed or drawn it. */}
              <span className={ended && g.status === "open" ? "gv-ended" : "dim"}
                    title={endsAt.toLocaleString()}>
                {ended ? "ended " : "ends "}{relative(endsAt.getTime())}
              </span>
            </>
          )}
          {g.announceToDiscord && (<><span className="dim">·</span><span className="dim">Discord {g.discordMessageId ? "posted" : "queued"}</span></>)}
        </div>
      </div>

      <div className="gv-card__actions">
        {(STATUS_FLOW[g.status] ?? []).filter((n) => n !== "drawn").map((next) => (
          <button key={next} className="btn-ghost btn-small" disabled={busy}
                  onClick={() => onPatch({ status: next })}>
            {next === "open" ? "Open entries" : next === "closed" ? "Close entries" : "Cancel"}
          </button>
        ))}
        {canDraw && (
          <button className="btn-primary btn-small" disabled={busy} onClick={onDraw}
                  title="Pick winners and grant prizes — irreversible">
            Draw {g.winnerCount > 1 ? `${g.winnerCount} winners` : "winner"}
          </button>
        )}
        {(g.status === "open" || g.status === "closed") && g.entryCount === 0 && (
          <span className="dim small">No entries yet</span>
        )}
        {!g.drawnAt && (
          <button className="btn-ghost btn-small gv-delete" disabled={busy} onClick={onDelete}>Delete</button>
        )}
      </div>
    </article>
  );
}

// ─── Finished row ────────────────────────────────────────────────────
// Collapsed by default. A drawn giveaway is history, except for the payout
// state — so THAT is the one thing shown without expanding.
function FinishedRow({ g, busy, onDelete }: { g: AdminGiveaway; busy: boolean; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const p = payoutOf(g.entries);

  return (
    <li className={`gv-finished-row${open ? " is-open" : ""}`}>
      <button className="gv-finished-summary" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`report-chevron${open ? " is-open" : ""}`} aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
            <path d="M9 6l6 6-6 6" />
          </svg>
        </span>
        <span className={`tag gv-status gv-status--${g.status}`}>{g.status}</span>
        <span className="gv-finished-title">{g.title}</span>
        <span className="dim small gv-finished-meta">{g.prizeSummary}</span>
        {/* Payout at a glance. Only the states that need saying are shown —
            an all-paid giveaway gets a quiet tick, not three badges. */}
        <span className="gv-payout">
          {p.failed.length > 0 && <span className="tag tag-bad">{p.failed.length} unpaid</span>}
          {p.owed.length > 0 && <span className="tag tag-warn">{p.owed.length} owed</span>}
          {p.failed.length === 0 && p.owed.length === 0 && p.winners.length > 0 && (
            <span className="tag tag-good">paid</span>
          )}
        </span>
        <time className="dim small" dateTime={g.drawnAt ?? g.createdAt}>
          {relative(new Date(g.drawnAt ?? g.createdAt).getTime())}
        </time>
      </button>

      {open && (
        <div className="gv-finished-detail">
          {g.description && <p className="dim small">{g.description}</p>}

          {p.winners.length === 0 ? (
            <p className="dim small">No winners recorded.</p>
          ) : (
            <ul className="gv-winner-list">
              {p.winners.map((e) => {
                const state = !e.claimedAt ? "failed" : !e.prizeDelivered ? "owed" : "paid";
                return (
                  <li key={e.id} className={`gv-winner gv-winner--${state}`}>
                    <button className="linklike" onClick={() => navigateTo("users", { userId: e.userId })}>
                      @{e.username}
                    </button>
                    <span className={`tag ${state === "failed" ? "tag-bad" : state === "owed" ? "tag-warn" : "tag-good"}`}
                          title={
                            state === "failed" ? "The prize grant failed. Pay this winner by hand."
                            : state === "owed" ? "Queued and guaranteed — it lands on their next save upload. Do NOT re-grant, that pays them twice."
                            : "The prize is in their save."
                          }>
                      {state === "failed" ? "grant failed" : state === "owed" ? "owed" : "delivered"}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          {g.drawSeed && (
            <details className="gv-seed-details">
              <summary className="dim small">Fairness seed</summary>
              <code className="gv-seed">{g.drawSeed}</code>
              <p className="dim small">
                Winners = lowest SHA-256 of <code>seed:entryId</code> across all entries.
                Published to players so anyone can recompute it.
              </p>
            </details>
          )}

          {!g.drawnAt && (
            <div className="profile-actions">
              <button className="btn-ghost btn-small gv-delete" disabled={busy} onClick={onDelete}>Delete</button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// ─── Create form ──────────────────────────────────────────────────────
function CreateGiveaway({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [winnerCount, setWinnerCount] = useState(1);
  const [endsInDays, setEndsInDays] = useState(7);
  const [minLevel, setMinLevel] = useState<number | "">("");
  // Discord announcement. The game server never talks to Discord — this is a
  // flag the bot polls for, so ticking it queues a post rather than making one.
  const [toDiscord, setToDiscord] = useState(false);
  const [discordChannelId, setDiscordChannelId] = useState("");
  const [prizes, setPrizes] = useState<GiveawayPrizeInput[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!title.trim()) { setErr("Give it a title."); return; }
    if (prizes.length === 0) { setErr("Add at least one prize."); return; }
    // Checked here rather than only server-side so the operator finds out
    // before the giveaway exists — the server's regex would reject the whole
    // create, and "invalid body" is a poor explanation for a mistyped id.
    if (toDiscord && discordChannelId.trim() && !/^\d{5,32}$/.test(discordChannelId.trim())) {
      setErr("Discord channel id should be the numeric id (right-click the channel → Copy Channel ID).");
      return;
    }
    setBusy(true); setErr(null);
    try {
      await api.createGiveaway({
        title: title.trim(),
        description: description.trim(),
        winnerCount,
        prizes,
        minAccountLevel: minLevel === "" ? null : Number(minLevel),
        endsAt: endsInDays > 0
          ? new Date(Date.now() + endsInDays * 86400000).toISOString()
          : null,
        announceToDiscord: toDiscord,
        discordChannelId: toDiscord && discordChannelId.trim() ? discordChannelId.trim() : null,
      });
      onCreated();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <section className="card gv-create">
      <header className="card-head">
        <div>
          <h2>New giveaway</h2>
          <p>Created as a draft — nobody sees it until you open entries.</p>
        </div>
      </header>
      {err && <div className="page-err">{err}</div>}

      <div className="gv-form-grid">
        <label className="gv-field">
          <span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Master Ball Friday" maxLength={120} />
        </label>
        <label className="gv-field">
          <span>Winners</span>
          <input type="number" min={1} max={100} value={winnerCount} onChange={(e) => setWinnerCount(Math.max(1, Number(e.target.value) || 1))} />
        </label>
        <label className="gv-field">
          <span>Runs for (days) <em className="dim">0 = no end date</em></span>
          <input type="number" min={0} max={90} value={endsInDays} onChange={(e) => setEndsInDays(Number(e.target.value) || 0)} />
        </label>
        <label className="gv-field">
          <span>Min account level <em className="dim">(optional)</em></span>
          <input type="number" min={0} value={minLevel} onChange={(e) => setMinLevel(e.target.value === "" ? "" : Number(e.target.value))} placeholder="any" />
        </label>
      </div>

      <label className="gv-field">
        <span>Description</span>
        <textarea
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Thanks for 1700 trainers! One entry each, drawn Sunday."
          maxLength={2000}
        />
      </label>

      <PrizeBuilder prizes={prizes} setPrizes={setPrizes} />

      {/* Note the wording: the bot POLLS for this, so the post appears within
          its sync interval rather than instantly. Say so, or the first thing
          an operator does is tick the box, look at Discord, see nothing, and
          assume it is broken. */}
      <label className="gv-field gv-check">
        <input type="checkbox" checked={toDiscord} onChange={(e) => setToDiscord(e.target.checked)} />
        <span>
          Announce in Discord <em className="dim">— the bot posts an entry card with a button, usually within a minute</em>
        </span>
      </label>
      {toDiscord && (
        <label className="gv-field">
          <span>Discord channel id <em className="dim">(optional — blank uses the bot's default channel)</em></span>
          <input
            value={discordChannelId}
            onChange={(e) => setDiscordChannelId(e.target.value)}
            placeholder="e.g. 1180000000000000000"
            inputMode="numeric"
          />
        </label>
      )}

      <footer className="gv-create-foot">
        <button className="btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="btn-primary" onClick={submit} disabled={busy || !title.trim() || prizes.length === 0}>
          {busy ? "Creating…" : "Create as draft"}
        </button>
      </footer>
    </section>
  );
}

/** "in 3d" / "2h ago" — a date only once relative stops meaning anything. */
function relative(ts: number): string {
  const diff = ts - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60_000);
  const unit = mins < 60 ? `${Math.max(1, mins)}m`
    : abs < 48 * 3600_000 ? `${Math.round(abs / 3600_000)}h`
    : abs < 30 * 86400_000 ? `${Math.round(abs / 86400_000)}d`
    : null;
  if (unit === null) return new Date(ts).toLocaleDateString();
  return diff > 0 ? `in ${unit}` : `${unit} ago`;
}
