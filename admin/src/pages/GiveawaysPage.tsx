import { useEffect, useState } from "react";
import { confirm, notify } from "../components/Confirm";
import { api, type AdminGiveaway, type GiveawayPrizeInput } from "../api";
import { POKEMON_LIST, ITEM_LIST, createPokemon } from "../data/gameCatalog";
import { Combobox } from "../components/Combobox";

// Giveaway operations.
//
// The draw is the sharp edge here: it is irreversible, it writes prizes
// into real players' saves, and it announces itself in global chat. So
// the UI's job is to make the operator certain BEFORE they click — the
// confirm states the entry count, the winner count and the exact prize
// string, and the result comes back per-winner so a failed grant is
// visible rather than assumed.

const STATUS_FLOW: Record<string, string[]> = {
  draft:     ["open", "cancelled"],
  open:      ["closed", "cancelled"],
  closed:    ["open", "drawn", "cancelled"],
  drawn:     [],
  cancelled: [],
};

export function GiveawaysPage() {
  const [list, setList] = useState<AdminGiveaway[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);

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
    // Everything irreversible about this is stated up front. "Draw" with
    // no numbers attached is how an operator draws the wrong giveaway.
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
    if (!await confirm(`Delete "${g.title}"? This removes it and its entries.`)) return;
    setBusy(true); setErr(null);
    try { await api.deleteGiveaway(g.id); load(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const rows = (list ?? []) as AdminGiveaway[];

  return (
    <div className="page giveaways-page">
      <header className="page-head">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16 }}>
          <div>
            <h1>Giveaways</h1>
            <p className="dim">
              Free prize draws. One entry per player, winners picked from a stored
              seed so the draw can be independently verified.
            </p>
          </div>
          <button className="btn-primary" onClick={() => setCreating(true)}>New giveaway</button>
        </div>
      </header>

      {err && <div className="page-err">{err}</div>}
      {creating && (
        <CreateGiveaway
          onCancel={() => setCreating(false)}
          onCreated={() => { setCreating(false); load(); }}
        />
      )}

      {!list && <div className="page-loading">Loading…</div>}
      {list && rows.length === 0 && !creating && (
        <p className="dim">No giveaways yet. Create one to get started.</p>
      )}

      <div className="gv-list">
        {rows.map((g) => (
          <article key={g.id} className={`gv-card gv-card--${g.status}`}>
            <header className="gv-card-head">
              <div className="gv-card-title">
                <strong>{g.title}</strong>
                <span className={`tag gv-status gv-status--${g.status}`}>{g.status.toUpperCase()}</span>
              </div>
              <span className="dim small">
                <strong className="tabular">{g.entryCount}</strong> entries ·{" "}
                {g.winnerCount} winner{g.winnerCount === 1 ? "" : "s"}
              </span>
            </header>

            <p className="gv-card-desc dim small">{g.description || <em>No description</em>}</p>
            <div className="gv-card-prize">
              <span className="gv-prize-label">Prize</span>
              <strong>{g.prizeSummary}</strong>
            </div>

            {g.drawnAt && (
              <div className="gv-card-result">
                <span className="gv-winners-label">Winners</span>
                <span>
                  {g.entries.filter((e) => e.isWinner).map((e) =>
                    // Three states, not two, because granting no longer means
                    // "written to their save this instant" — it means a
                    // durable PendingGrant row that their next upload absorbs.
                    //
                    //   no claimedAt      → the grant itself failed. Pay by hand.
                    //   claimedAt, unsent → OWED. Guaranteed; do NOT re-grant,
                    //                       that would pay them twice.
                    //   delivered         → in their save.
                    //
                    // Printing "UNPAID" for the middle state is what steers an
                    // operator into a double payout.
                    <span
                      key={e.id}
                      className={e.claimedAt ? "gv-winner" : "gv-winner gv-winner--unpaid"}
                      title={
                        !e.claimedAt ? "Prize grant failed — pay this winner by hand."
                        : e.prizeDelivered ? "Prize is in their save."
                        : "Prize is queued and guaranteed — it lands on their next save upload. Do not re-grant."
                      }
                    >
                      @{e.username}
                      {!e.claimedAt ? " (UNPAID)" : !e.prizeDelivered ? " (OWED)" : ""}
                    </span>
                  )}
                </span>
                {g.drawSeed && (
                  <details className="gv-seed-details">
                    <summary className="dim small">Fairness seed</summary>
                    <code className="gv-seed">{g.drawSeed}</code>
                    <p className="dim small">
                      Winners = lowest SHA-256 of <code>seed:entryId</code> across all
                      entries. Published to players so anyone can recompute it.
                    </p>
                  </details>
                )}
              </div>
            )}

            <footer className="gv-card-foot">
              {(STATUS_FLOW[g.status] ?? []).map((next) => (
                <button
                  key={next}
                  className="btn-ghost btn-small"
                  disabled={busy}
                  onClick={() => patch(g.id, { status: next })}
                >
                  {next === "open" ? "Open entries"
                    : next === "closed" ? "Close entries"
                    : next === "cancelled" ? "Cancel"
                    : next}
                </button>
              ))}
              {(g.status === "open" || g.status === "closed") && (
                <button
                  className="btn-primary btn-small gv-draw"
                  disabled={busy || g.entryCount === 0}
                  title={g.entryCount === 0 ? "No entries to draw from" : "Pick winners and grant prizes"}
                  onClick={() => draw(g)}
                >
                  🎲 Draw {g.winnerCount > 1 ? `${g.winnerCount} winners` : "winner"}
                </button>
              )}
              {!g.drawnAt && (
                <button className="btn-danger btn-small" disabled={busy} onClick={() => del(g)}>
                  Delete
                </button>
              )}
            </footer>
          </article>
        ))}
      </div>
    </div>
  );
}

// ─── Create form ──────────────────────────────────────────────────────
function CreateGiveaway({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [winnerCount, setWinnerCount] = useState(1);
  const [endsInDays, setEndsInDays] = useState(7);
  const [minLevel, setMinLevel] = useState<number | "">("");
  const [prizes, setPrizes] = useState<GiveawayPrizeInput[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Prize builder inputs
  const [pKind, setPKind] = useState<"item" | "money" | "pokemon">("item");
  const [itemId, setItemId] = useState("masterball");
  const [itemQuery, setItemQuery] = useState("Master Ball");
  const [qty, setQty] = useState(1);
  const [amount, setAmount] = useState(50000);
  const [species, setSpecies] = useState("mew");
  const [speciesQuery, setSpeciesQuery] = useState("Mew");
  const [level, setLevel] = useState(50);
  const [shiny, setShiny] = useState(false);

  const addPrize = () => {
    if (pKind === "item") {
      setPrizes((p) => [...p, { kind: "item", itemId, quantity: qty }]);
    } else if (pKind === "money") {
      setPrizes((p) => [...p, { kind: "money", amount }]);
    } else {
      // Build the REAL mon here — the admin owns the stat formula. The
      // server has no Pokemon table and would have to fabricate stats,
      // which is exactly how the save editor used to hand out a Lv50
      // Charizard with 24 HP.
      const mon = createPokemon(species, level, Date.now() % 1_000_000, shiny);
      const sp = POKEMON_LIST.find((x) => x.speciesKey === species);
      setPrizes((p) => [...p, {
        kind: "pokemon",
        label: `${shiny ? "Shiny " : ""}${sp?.name ?? species} Lv${level}`,
        mon: mon as unknown as Record<string, unknown>,
      }]);
    }
  };

  const submit = async () => {
    if (!title.trim()) { setErr("Give it a title."); return; }
    if (prizes.length === 0) { setErr("Add at least one prize."); return; }
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
      });
      onCreated();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <section className="card gv-create">
      <h2>New giveaway</h2>
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
          <span>Runs for (days)</span>
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

      <div className="gv-prize-builder">
        <h3>Prizes</h3>
        {prizes.length > 0 && (
          <ul className="gv-prize-list">
            {prizes.map((p, i) => (
              <li key={i}>
                <span>
                  {p.kind === "item" ? `${p.quantity}x ${p.itemId}`
                    : p.kind === "money" ? `$${p.amount?.toLocaleString()}`
                    : p.label}
                </span>
                <button className="btn-ghost btn-tiny" onClick={() => setPrizes((x) => x.filter((_, j) => j !== i))}>×</button>
              </li>
            ))}
          </ul>
        )}

        <div className="gv-prize-add">
          <div className="seg-tabs">
            {(["item", "money", "pokemon"] as const).map((k) => (
              <button key={k} className={`seg-tab ${pKind === k ? "active" : ""}`} onClick={() => setPKind(k)}>
                {k}
              </button>
            ))}
          </div>

          {pKind === "item" && (
            <>
              <Combobox
                value={itemQuery}
                onChange={(t) => { setItemQuery(t); }}
                onSelect={(i) => { setItemId(i.id); setItemQuery(i.name); }}
                options={ITEM_LIST}
                placeholder="Search items…"
                getKey={(i) => i.id}
                getSearchText={(i) => `${i.name} ${i.id} ${i.category}`}
                renderOption={(i, hl) => (
                  <div className={`combo-opt ${hl ? "hl" : ""}`}>
                    <strong>{i.name}</strong> <span className="dim small">{i.category}</span>
                  </div>
                )}
              />
              <input type="number" min={1} max={999} value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))} style={{ width: 80 }} />
            </>
          )}
          {pKind === "money" && (
            <input type="number" min={1} value={amount} onChange={(e) => setAmount(Math.max(1, Number(e.target.value) || 1))} />
          )}
          {pKind === "pokemon" && (
            <>
              <Combobox
                value={speciesQuery}
                onChange={(t) => setSpeciesQuery(t)}
                onSelect={(sp) => { setSpecies(sp.speciesKey); setSpeciesQuery(`${sp.name} (#${sp.id})`); }}
                options={POKEMON_LIST}
                placeholder="Search Pokemon…"
                getKey={(sp) => sp.speciesKey}
                getSearchText={(sp) => `${sp.name} ${sp.speciesKey}`}
                renderOption={(sp, hl) => (
                  <div className={`combo-opt ${hl ? "hl" : ""}`}>
                    <strong>{sp.name}</strong> <span className="dim small">#{sp.id}</span>
                  </div>
                )}
              />
              <input type="number" min={1} max={100} value={level} onChange={(e) => setLevel(Math.min(100, Math.max(1, Number(e.target.value) || 1)))} style={{ width: 70 }} />
              <label className="gv-shiny-toggle">
                <input type="checkbox" checked={shiny} onChange={(e) => setShiny(e.target.checked)} /> Shiny
              </label>
            </>
          )}
          <button className="btn-secondary btn-small" onClick={addPrize}>Add prize</button>
        </div>
      </div>

      <footer className="gv-create-foot">
        <button className="btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="btn-primary" onClick={submit} disabled={busy}>
          {busy ? "Creating…" : "Create as draft"}
        </button>
      </footer>
      <p className="dim small">
        Created as a draft — nobody sees it until you hit “Open entries”.
      </p>
    </section>
  );
}
