import { useState } from "react";
import { POKEMON_LIST, ITEM_LIST, createPokemon } from "../data/gameCatalog";
import { Combobox } from "./Combobox";
import type { GiveawayPrizeInput } from "../api";

// The prize picker, shared by every operator surface that hands out prizes.
//
// Extracted from GiveawaysPage's create form when the Discord link reward
// needed the same control. Two copies would have drifted immediately — and the
// thing they would drift on is the Pokémon branch, which is the one part of
// this that MUST NOT be reimplemented casually: the real mon is built HERE, by
// the admin client, because it is the only place that owns the stat formula.
// The server has no Pokemon table and would have to fabricate stats, which is
// exactly how the save editor once handed out a Lv50 Charizard with 24 HP.

export function PrizeBuilder({
  prizes,
  setPrizes,
  title = "Prizes",
}: {
  prizes: GiveawayPrizeInput[];
  setPrizes: (updater: (p: GiveawayPrizeInput[]) => GiveawayPrizeInput[]) => void;
  title?: string;
}) {
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
      // See the header: the REAL mon is built here, with the real formula.
      const mon = createPokemon(species, level, Date.now() % 1_000_000, shiny);
      const sp = POKEMON_LIST.find((x) => x.speciesKey === species);
      setPrizes((p) => [...p, {
        kind: "pokemon",
        label: `${shiny ? "Shiny " : ""}${sp?.name ?? species} Lv${level}`,
        mon: mon as unknown as Record<string, unknown>,
      }]);
    }
  };

  return (
    <div className="gv-prize-builder">
      <h3>{title}</h3>
      {prizes.length > 0 && (
        <ul className="gv-prize-list">
          {prizes.map((p, i) => (
            <li key={i}>
              <span>
                {p.kind === "item" ? `${p.quantity}x ${p.itemId}`
                  : p.kind === "money" ? `$${p.amount?.toLocaleString()}`
                  : p.label}
              </span>
              <button
                className="btn-ghost btn-tiny"
                onClick={() => setPrizes((x) => x.filter((_, j) => j !== i))}
              >×</button>
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
  );
}
