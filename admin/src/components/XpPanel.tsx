import { useEffect, useState } from "react";
import { api, type DiscordConfig } from "../api";
import { notify } from "./Confirm";

// Community XP settings.
//
// ── THE COPY MATTERS HERE ───────────────────────────────────────────
// XP is a SEPARATE currency from the game economy: it buys Discord standing
// and nothing the game can see. An operator reading this panel should come
// away certain of that, because the natural assumption for anything in a game
// admin dashboard is that it pays out — and the one change that would make it
// pay out is the one that puts a faucet on the economy.

export function XpPanel({ onSaved }: { onSaved?: () => void } = {}) {
  const [cfg, setCfg] = useState<DiscordConfig | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [min, setMin] = useState(15);
  const [max, setMax] = useState(25);
  const [cooldown, setCooldown] = useState(60);
  const [ignored, setIgnored] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const apply = (d: DiscordConfig) => {
    setCfg(d);
    setEnabled(d.xp.enabled);
    setMin(d.xp.perMessageMin);
    setMax(d.xp.perMessageMax);
    setCooldown(d.xp.cooldownSec);
    setIgnored(d.xp.ignoredChannels);
  };

  useEffect(() => {
    api.getDiscordConfig().then(apply).catch((e) => setErr((e as Error).message));
  }, []);

  const save = async (nextEnabled = enabled) => {
    if (min > max) { setErr("Minimum XP can't be above the maximum."); return; }
    setBusy(true); setErr(null);
    try {
      const d = await api.putDiscordConfig({
        // Carried through unchanged so this panel and the reward panel don't
        // clobber each other through the one shared endpoint.
        linkRewardEnabled: cfg?.linkRewardEnabled ?? false,
        xpEnabled: nextEnabled,
        xpPerMessageMin: min,
        xpPerMessageMax: max,
        xpCooldownSec: cooldown,
        xpIgnoredChannels: ignored,
      });
      apply(d);
      void notify(nextEnabled ? "Community XP is ON." : "Community XP is OFF.");
      onSaved?.();
    } catch (e) {
      setEnabled(cfg?.xp.enabled ?? false);
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <section className="card">
      <header className="gv-dr-head">
        <div>
          <h2>Community XP</h2>
          <p className="dim small">
            Levels earned by talking and joining in. <strong>Discord-only</strong> —
            XP doesn't convert into money, items or account level, and nothing here
            can pay out in-game.
          </p>
        </div>
        <span className={`tag ${enabled ? "gv-status--open" : ""}`}>{enabled ? "ON" : "OFF"}</span>
      </header>

      {err && <div className="page-err">{err}</div>}

      <label className="gv-field gv-check">
        <input
          type="checkbox" checked={enabled} disabled={busy}
          onChange={(e) => { setEnabled(e.target.checked); void save(e.target.checked); }}
        />
        <span>Award XP for messages and participation</span>
      </label>

      <div className="gv-form-grid">
        <label className="gv-field">
          <span>XP per message — min</span>
          <input type="number" min={0} max={1000} value={min}
            onChange={(e) => setMin(Math.max(0, Number(e.target.value) || 0))} />
        </label>
        <label className="gv-field">
          <span>XP per message — max</span>
          <input type="number" min={0} max={1000} value={max}
            onChange={(e) => setMax(Math.max(0, Number(e.target.value) || 0))} />
        </label>
        <label className="gv-field">
          <span>Cooldown (seconds)</span>
          <input type="number" min={0} max={86400} value={cooldown}
            onChange={(e) => setCooldown(Math.max(0, Number(e.target.value) || 0))} />
        </label>
      </div>
      {/* The cooldown is the entire anti-spam story, so it says so. Set it to
          zero and XP measures typing speed rather than participation. */}
      <p className="dim small">
        The cooldown is what stops XP measuring typing speed — one paid message per
        person per {cooldown}s, enforced server-side so a bot restart can't reset it.
      </p>

      <label className="gv-field">
        <span>Ignored channels <em className="dim">(comma-separated channel IDs)</em></span>
        <input value={ignored} onChange={(e) => setIgnored(e.target.value)}
          placeholder="bot-commands, counting — channels where volume is the point" />
      </label>

      <footer className="gv-create-foot">
        <button className="btn-primary" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save XP settings"}
        </button>
      </footer>
      <p className="dim small">
        Bonuses on top of messages: linking a game account, entering a giveaway,
        posting a trade listing, and filing a bug report that gets ingested.
      </p>
    </section>
  );
}
