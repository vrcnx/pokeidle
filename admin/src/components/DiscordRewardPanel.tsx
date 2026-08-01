import { useEffect, useState } from "react";
import { api, type DiscordConfig, type GiveawayPrizeInput } from "../api";
import { PrizeBuilder } from "./PrizeBuilder";
import { notify } from "./Confirm";

// "Link your Discord, get a prize" — configured here rather than in the
// environment, because it is promotion CONTENT an operator changes as a
// judgement call, not deployment config. Env would put it behind a Railway
// edit and a redeploy, somewhere this page cannot show it.
//
// The prize picker is the SAME component the giveaway form uses. That matters
// for one reason above all: the Pokémon branch builds the real mon with the
// real stat formula, and a second hand-rolled picker is how you end up
// handing out a Lv50 Charizard with 24 HP.

export function DiscordRewardPanel() {
  const [cfg, setCfg] = useState<DiscordConfig | null>(null);
  const [prizes, setPrizes] = useState<GiveawayPrizeInput[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const load = () => {
    api.getDiscordConfig()
      .then((d) => { setCfg(d); setPrizes(d.linkReward); setEnabled(d.linkRewardEnabled); setErr(null); })
      .catch((e) => setErr((e as Error).message));
  };
  useEffect(load, []);

  const save = async (nextEnabled: boolean, nextPrizes: GiveawayPrizeInput[]) => {
    setBusy(true); setErr(null);
    try {
      const d = await api.putDiscordConfig({
        linkRewardEnabled: nextEnabled,
        linkReward: nextPrizes,
      });
      setCfg(d); setPrizes(d.linkReward); setEnabled(d.linkRewardEnabled);
      void notify(
        d.linkRewardEnabled
          ? `Link reward is ON — new linkers get ${d.linkRewardSummary}.`
          : "Link reward is OFF.",
      );
    } catch (e) {
      // Reset the toggle to what the SERVER believes, not what was clicked.
      // Leaving it showing the attempted state after a rejection is how an
      // operator walks away thinking a promotion is live when it is not.
      setEnabled(cfg?.linkRewardEnabled ?? false);
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <section className="card gv-discord-reward">
      <header className="gv-dr-head">
        <div>
          <h2>Discord link reward</h2>
          <p className="dim small">
            Paid once, the first time someone links their Discord account. Named in
            the bot's <code>/link</code> DM, so it actually persuades people to join.
          </p>
        </div>
        <div className="gv-dr-state">
          <span className={`tag ${enabled ? "gv-status--open" : ""}`}>
            {enabled ? "ON" : "OFF"}
          </span>
          {cfg?.linkRewardSummary && <strong className="small">{cfg.linkRewardSummary}</strong>}
        </div>
      </header>

      {err && <div className="page-err">{err}</div>}

      <div className="gv-dr-actions">
        <label className="gv-field gv-check">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy}
            onChange={(e) => { setEnabled(e.target.checked); void save(e.target.checked, prizes); }}
          />
          <span>Give a reward for linking</span>
        </label>
        <button className="btn-ghost btn-small" onClick={() => setOpen((o) => !o)}>
          {open ? "Hide prize" : "Change prize"}
        </button>
      </div>

      {open && (
        <>
          <PrizeBuilder prizes={prizes} setPrizes={setPrizes} title="Reward" />
          <footer className="gv-create-foot">
            <button
              className="btn-primary"
              disabled={busy || prizes.length === 0}
              onClick={() => void save(enabled, prizes)}
            >
              {busy ? "Saving…" : "Save reward"}
            </button>
          </footer>
          <p className="dim small">
            Delivered through the pending-grant inbox, so it lands on the player's
            next save — nothing is lost if they're offline. Paid once per game
            account <em>and</em> once per Discord account, so unlinking and
            relinking doesn't pay twice.
          </p>
        </>
      )}

      {cfg?.updatedAt && (
        <p className="dim small">
          Last changed {new Date(cfg.updatedAt).toLocaleString()}
          {cfg.updatedBy ? ` by @${cfg.updatedBy}` : ""}.
        </p>
      )}
    </section>
  );
}
