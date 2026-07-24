import { useEffect, useRef, useState } from "react";
import { api, type GiveawayPrizeInput, type AdminUser } from "../api";
import { POKEMON_LIST, ITEM_LIST, createPokemon } from "../data/gameCatalog";
import { Combobox } from "../components/Combobox";

// Mass gift — a DIRECT grant (not an opt-in raffle like a Giveaway) of any
// item / money / Pokémon to a whole audience at once: everyone online right
// now, every account, or a hand-picked set. The server writes the prizes into
// each recipient's save; anyone online gets them live, anyone offline picks
// them up on their next load. See server/src/routes/admin.ts POST /mass-gift.

type Audience = "all" | "online" | "selected";

export function MassGiftPage() {
  const [audience, setAudience] = useState<Audience>("online");
  const [selected, setSelected] = useState<{ id: string; username: string }[]>([]);
  const [minLevel, setMinLevel] = useState<number | "">("");
  const [announce, setAnnounce] = useState("");
  const [prizes, setPrizes] = useState<GiveawayPrizeInput[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  // Prize builder inputs (mirrors the giveaway builder).
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
      const mon = createPokemon(species, level, Date.now() % 1_000_000, shiny);
      const sp = POKEMON_LIST.find((x) => x.speciesKey === species);
      setPrizes((p) => [...p, {
        kind: "pokemon",
        label: `${shiny ? "Shiny " : ""}${sp?.name ?? species} Lv${level}`,
        mon: mon as unknown as Record<string, unknown>,
      }]);
    }
  };

  const send = async () => {
    setErr(null); setResult(null);
    if (prizes.length === 0) { setErr("Add at least one prize."); return; }
    if (audience === "selected" && selected.length === 0) { setErr("Pick at least one recipient (or change the audience)."); return; }
    const who =
      audience === "all" ? "EVERY account"
      : audience === "online" ? "everyone online right now"
      : `${selected.length} selected player${selected.length === 1 ? "" : "s"}`;
    if (!window.confirm(`Send this gift to ${who}? This writes directly to their saves and can't be undone.`)) return;
    setBusy(true);
    try {
      const res = await api.massGift({
        audience,
        userIds: audience === "selected" ? selected.map((u) => u.id) : undefined,
        prizes,
        announce: announce.trim() || undefined,
        minAccountLevel: minLevel === "" ? null : Number(minLevel),
      });
      setResult(`Sent to ${res.recipientCount.toLocaleString()} player${res.recipientCount === 1 ? "" : "s"}. Delivery is running in the background.`);
      setPrizes([]);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Mass gift</h1>
          <p className="dim">Grant items, money, or Pokémon to a whole audience at once.</p>
        </div>
      </header>

      {err && <div className="page-err">{err}</div>}
      {result && <div className="page-ok" role="status">{result}</div>}

      <section className="card gv-create">
        <h2>Audience</h2>
        <div className="seg-tabs" style={{ marginBottom: 10 }}>
          {(["online", "all", "selected"] as const).map((a) => (
            <button key={a} className={`seg-tab ${audience === a ? "active" : ""}`} onClick={() => setAudience(a)}>
              {a === "online" ? "Online now" : a === "all" ? "All players" : "Select players"}
            </button>
          ))}
        </div>

        {audience === "selected" && (
          <UserPicker selected={selected} setSelected={setSelected} />
        )}

        <label className="gv-field" style={{ maxWidth: 260 }}>
          <span>Min account level <em className="dim">(optional filter)</em></span>
          <input type="number" min={0} value={minLevel}
            onChange={(e) => setMinLevel(e.target.value === "" ? "" : Number(e.target.value))} placeholder="any" />
        </label>

        <h2 style={{ marginTop: 18 }}>Gift contents</h2>
        <div className="gv-prize-builder">
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
                <button key={k} className={`seg-tab ${pKind === k ? "active" : ""}`} onClick={() => setPKind(k)}>{k}</button>
              ))}
            </div>
            {pKind === "item" && (
              <>
                <Combobox
                  value={itemQuery}
                  onChange={setItemQuery}
                  onSelect={(i) => { setItemId(i.id); setItemQuery(i.name); }}
                  options={ITEM_LIST}
                  placeholder="Search items…"
                  getKey={(i) => i.id}
                  getSearchText={(i) => `${i.name} ${i.id} ${i.category}`}
                  renderOption={(i, hl) => (
                    <div className={`combo-opt ${hl ? "hl" : ""}`}><strong>{i.name}</strong> <span className="dim small">{i.category}</span></div>
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
                  onChange={setSpeciesQuery}
                  onSelect={(sp) => { setSpecies(sp.speciesKey); setSpeciesQuery(`${sp.name} (#${sp.id})`); }}
                  options={POKEMON_LIST}
                  placeholder="Search Pokemon…"
                  getKey={(sp) => sp.speciesKey}
                  getSearchText={(sp) => `${sp.name} ${sp.speciesKey}`}
                  renderOption={(sp, hl) => (
                    <div className={`combo-opt ${hl ? "hl" : ""}`}><strong>{sp.name}</strong> <span className="dim small">#{sp.id}</span></div>
                  )}
                />
                <input type="number" min={1} max={100} value={level} onChange={(e) => setLevel(Math.min(100, Math.max(1, Number(e.target.value) || 1)))} style={{ width: 70 }} />
                <label className="gv-shiny-toggle">
                  <input type="checkbox" checked={shiny} onChange={(e) => setShiny(e.target.checked)} /> Shiny
                </label>
              </>
            )}
            <button className="btn-secondary btn-small" onClick={addPrize}>Add</button>
          </div>
        </div>

        <label className="gv-field">
          <span>Chat announcement <em className="dim">(optional — posts to Global as a gift card)</em></span>
          <textarea rows={2} value={announce} onChange={(e) => setAnnounce(e.target.value)}
            placeholder="🎁 Gift for everyone online — thanks for playing!" maxLength={300} />
        </label>

        <footer className="gv-create-foot" style={{ flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          <button className="btn-primary" onClick={send} disabled={busy}>
            {busy ? "Sending…" : "Send gift"}
          </button>
          {/* Feedback next to the button — the page-top banners are easy to
              miss because the Send button sits far below them. */}
          {result && <span className="page-ok" role="status" style={{ flex: "1 1 240px" }}>✓ {result}</span>}
          {err && <span className="page-err" role="alert" style={{ flex: "1 1 240px" }}>{err}</span>}
        </footer>
      </section>
    </div>
  );
}

// Search + chip multi-select for the "Select players" audience.
function UserPicker({ selected, setSelected }: {
  selected: { id: string; username: string }[];
  setSelected: (v: { id: string; username: string }[]) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<AdminUser[]>([]);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (q.trim().length < 2) { setResults([]); return; }
    timer.current = window.setTimeout(() => {
      api.listUsers(q.trim(), 0, 8).then((r) => setResults(r.users)).catch(() => setResults([]));
    }, 250);
    return () => window.clearTimeout(timer.current);
  }, [q]);

  const add = (u: AdminUser) => {
    if (!selected.some((s) => s.id === u.id)) setSelected([...selected, { id: u.id, username: u.username }]);
    setQ(""); setResults([]);
  };

  return (
    <div className="massgift-userpicker" style={{ marginBottom: 12 }}>
      {selected.length > 0 && (
        <div className="massgift-chips" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {selected.map((u) => (
            <span key={u.id} className="tag" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              @{u.username}
              <button className="btn-ghost btn-tiny" onClick={() => setSelected(selected.filter((s) => s.id !== u.id))}>×</button>
            </span>
          ))}
        </div>
      )}
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a username to add…" style={{ maxWidth: 320 }} />
      {results.length > 0 && (
        <ul className="massgift-results" style={{ listStyle: "none", margin: "6px 0 0", padding: 0, maxWidth: 320 }}>
          {results.map((u) => (
            <li key={u.id}>
              <button className="btn-ghost btn-small" style={{ width: "100%", textAlign: "left" }} onClick={() => add(u)}>
                @{u.username} <span className="dim small">Lv {u.accountLevel}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
