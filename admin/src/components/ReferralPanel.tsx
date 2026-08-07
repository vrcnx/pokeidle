import { useEffect, useState } from "react";
import { api, type ReferralConfig, type GiveawayPrizeInput } from "../api";
import { PrizeBuilder } from "./PrizeBuilder";
import { notify } from "./Confirm";

// The referral programme, configured here rather than in the environment
// because these are promotion CONTENT — an operator changes them as a
// judgement call and needs to be able to see them.
//
// ── WHY THE SWITCH IS THE LOUDEST THING ON THIS PANEL ───────────────
// The programme pays on SIGNUP with no eligibility gate. That was a
// deliberate call (see server/src/lib/referrals.ts), and it means the
// defence against farming is not prevention but noticing — so the counts
// that would reveal a farm sit directly beside the switch that stops it,
// rather than a page away in analytics.
//
// The prize pickers are the SAME component the giveaway form uses. That
// matters most for the shiny pool: the Pokémon branch builds a real mon with
// the real stat formula, and a second hand-rolled picker is how you end up
// handing out a Lv50 Charizard with 24 HP.

type Section = "per" | "milestone" | "pool" | null;

export function ReferralPanel({ onSaved }: { onSaved?: () => void } = {}) {
  const [cfg, setCfg] = useState<ReferralConfig | null>(null);
  const [perReferral, setPerReferral] = useState<GiveawayPrizeInput[]>([]);
  const [milestone, setMilestone] = useState<GiveawayPrizeInput[]>([]);
  const [shinyPool, setShinyPool] = useState<GiveawayPrizeInput[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState<Section>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const adopt = (d: ReferralConfig) => {
    setCfg(d);
    setPerReferral(d.perReferral);
    setMilestone(d.milestone);
    setShinyPool(d.shinyPool);
    setEnabled(d.enabled);
  };

  const load = () => {
    api.getReferralConfig().then((d) => { adopt(d); setErr(null); })
      .catch((e) => setErr((e as Error).message));
  };
  useEffect(load, []);

  const save = async (nextEnabled: boolean) => {
    setBusy(true); setErr(null);
    try {
      const d = await api.putReferralConfig({
        enabled: nextEnabled,
        // OMITTED when empty rather than sent as [], because PrizeListSchema
        // is .min(1) — an empty array is a schema violation, which would
        // surface as a bare "invalid body" instead of the real reason. It
        // also means a save can never clobber a configured prize with
        // nothing.
        ...(perReferral.length > 0 ? { perReferral } : {}),
        ...(milestone.length > 0 ? { milestone } : {}),
        ...(shinyPool.length > 0 ? { shinyPool } : {}),
      });
      adopt(d);
      void notify(d.enabled
        ? "Referrals are ON."
        // Worth saying, because the player-facing card disappears entirely
        // when this is off — an operator who does not know that will read the
        // empty Rewards page as a bug.
        : "Referrals are OFF — signups are still recorded, and the invite card is hidden from players.");
      onSaved?.();
    } catch (e) {
      // Reset the toggle to what the SERVER believes, not what was clicked.
      // Leaving it on the attempted state after a rejection is how an operator
      // walks away thinking a promotion is live when it is not.
      setEnabled(cfg?.enabled ?? false);
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  const cap = cfg?.perReferralCap ?? 10;

  return (
    <section className="card gv-discord-reward">
      <header className="gv-dr-head">
        <div>
          <h2>Referral programme</h2>
          <p className="dim small">
            Players share a <code>?ref=</code> link. Every signup through it pays them,
            up to {cap}, with a bonus on the {cap}th.
          </p>
        </div>
        <div className="gv-dr-state">
          {/* Nothing until the server has answered. Rendering a default here
              means the tag reads OFF for a moment on a programme that is on,
              which is the same "is this broken or just paused?" confusion the
              whole default change exists to end. */}
          {cfg && (
            <span className={`tag ${enabled ? "gv-status--open" : ""}`}>
              {enabled ? "ON" : "OFF"}
            </span>
          )}
        </div>
      </header>

      {err && <div className="page-err">{err}</div>}

      {/* The farm-watch numbers, beside the switch. A referral count far above
          the grant count means the cap is doing its job; both climbing fast
          for one account is the shape worth looking at — the per-referrer
          query is in server/src/lib/referrals.ts. */}
      {cfg && (cfg.totalReferrals !== undefined) && (
        <p className="dim small">
          {cfg.totalReferrals} referral{cfg.totalReferrals === 1 ? "" : "s"} recorded
          {" · "}{cfg.totalGrants ?? 0} grant{(cfg.totalGrants ?? 0) === 1 ? "" : "s"} paid
          {cfg.updatedBy ? ` · last changed by ${cfg.updatedBy}` : ""}
        </p>
      )}

      <div className="gv-dr-actions">
        <label className="gv-field gv-check">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy}
            onChange={(e) => { setEnabled(e.target.checked); void save(e.target.checked); }}
          />
          <span>
            Pay for referrals
            {/* ON unless somebody turned it off. Unlike the Discord reward this
                needs no prizes configured first — the server falls back to a
                documented default, so "running with nothing set" is a working
                programme rather than one that silently pays nothing. */}
            <em className="dim"> — running by default: 1x masterball each, $1,000,000 at {cap}</em>
          </span>
        </label>
      </div>

      <div className="gv-dr-actions">
        <button className="btn-ghost btn-small" onClick={() => setOpen(open === "per" ? null : "per")}>
          {open === "per" ? "Hide" : "Per-referral prize"}
        </button>
        <button className="btn-ghost btn-small" onClick={() => setOpen(open === "milestone" ? null : "milestone")}>
          {open === "milestone" ? "Hide" : `${cap}th-referral bonus`}
        </button>
        <button className="btn-ghost btn-small" onClick={() => setOpen(open === "pool" ? null : "pool")}>
          {open === "pool" ? "Hide" : `Shiny pool (${shinyPool.length})`}
        </button>
      </div>

      {open === "per" && (
        <PrizeBuilder prizes={perReferral} setPrizes={setPerReferral} title="Each friend" />
      )}
      {open === "milestone" && (
        <PrizeBuilder prizes={milestone} setPrizes={setMilestone} title={`Reaching ${cap}`} />
      )}
      {open === "pool" && (
        <>
          <p className="dim small">
            Pokémon only, and the {cap}th-referral bonus draws <strong>one at random</strong>.
            Build a few shinies here — an empty pool means the bonus pays its money
            half and nothing else, because the server cannot invent a Pokémon with
            correct stats.
          </p>
          <PrizeBuilder prizes={shinyPool} setPrizes={setShinyPool} title="Shiny pool" />
        </>
      )}

      {open && (
        <footer className="gv-create-foot">
          <button className="btn-primary" disabled={busy} onClick={() => void save(enabled)}>
            {busy ? "Saving…" : "Save"}
          </button>
        </footer>
      )}
    </section>
  );
}
