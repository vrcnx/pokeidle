import { useEffect, useState } from "react";
import { useGame } from "../state/GameContext";
import { itemsCatalog } from "../data/itemsCatalog";
import { itemSpriteUrl } from "../utils/sprites";
import { getItemInfo } from "../utils/items";
import { PokemonSprite } from "./Sprite";
import { useModalEnter } from "../utils/animate";
import { pushToast } from "./Toast";
import { useT } from "../i18n/useT";
import type { Pokemon } from "../types";
import "./useItem.css";

// Two dialogs that were one bad inline strip each.
//
// ── GIVE A HELD ITEM ────────────────────────────────────────────────
// The picker was a row that expanded INSIDE the detail sheet, pushing the
// stats down, with no description, no count, and — when you owned none — a
// full-width bar reading "NO HELD ITEMS IN BAG" where the control had been.
// It was also the only way to change a held item, so an empty bag left the
// player looking at an error message with nothing to do about it.
//
// ── USE A BOTTLE CAP ────────────────────────────────────────────────
// Hyper Training only existed at the bottom of a Pokémon's detail sheet,
// which means the item in your bag was not a thing you could use — it was a
// thing that made a button appear somewhere else, if you found it. The Bag
// hands you a target picker instead, which is what "use an item" means
// everywhere else in the genre.
//
// Both are modal, both are opened by a module-level function, and both mount
// once from GameShell. Same pattern as openPokemonDetail.

type Request =
  | { kind: "held"; pokemonId: string }
  | { kind: "cap"; itemId: "goldbottlecap" | "silverbottlecap" };

let _req: Request | null = null;
const _listeners = new Set<(r: Request | null) => void>();
function publish(r: Request | null) {
  _req = r;
  for (const fn of _listeners) fn(r);
}

/** Choose a held item for this Pokémon (or take the one it has). */
export function openHeldItemPicker(pokemonId: string) {
  publish({ kind: "held", pokemonId });
}
/** Choose which Pokémon a bottle cap is spent on. */
export function openBottleCap(itemId: "goldbottlecap" | "silverbottlecap") {
  publish({ kind: "cap", itemId });
}
export function closeUseItem() { publish(null); }

export function UseItemMount() {
  const [req, setReq] = useState<Request | null>(_req);
  useEffect(() => {
    _listeners.add(setReq);
    setReq(_req);
    return () => { _listeners.delete(setReq); };
  }, []);
  if (!req) return null;
  return req.kind === "held"
    ? <HeldItemDialog pokemonId={req.pokemonId} />
    : <BottleCapDialog itemId={req.itemId} />;
}

// ── Shell ───────────────────────────────────────────────────────────
function Shell({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  const t = useT();
  const ref = useModalEnter();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeUseItem(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    // Above the detail sheet (120) — it is opened FROM it — and below the
    // context menu at 200. See useItem.css.
    <div className="modal-overlay use-item-overlay" onClick={closeUseItem}>
      <div
        ref={ref}
        className="g-modal use-item-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="g-modal-head">
          <div>
            <h2>{title}</h2>
            {sub && <p className="use-item-sub">{sub}</p>}
          </div>
          <button className="g-modal-close" onClick={closeUseItem} aria-label={t("Close")}>×</button>
        </header>
        <div className="use-item-body">{children}</div>
      </div>
    </div>
  );
}

// ── Give a held item ────────────────────────────────────────────────
function HeldItemDialog({ pokemonId }: { pokemonId: string }) {
  const { state, dispatch } = useGame();
  const t = useT();

  // Resolved by ID from live state every render, never captured. A held item
  // can be given while the box is being reorganised in the pane behind this.
  const mon: Pokemon | undefined =
    state.party.find((p) => p.id === pokemonId) ?? state.box.find((p) => p.id === pokemonId);

  const owned = Object.entries(state.inventory ?? {})
    .filter(([id, qty]) => qty > 0 && itemsCatalog[id]?.category === "held")
    .map(([id, qty]) => ({ def: itemsCatalog[id]!, qty }))
    .filter(({ def }) => def.implemented !== false)
    // Exp Share and the Shiny Charm are catalogued as held but are not
    // equippable — they work from the bag and from nowhere.
    .filter(({ def }) => def.id !== "expShare" && def.id !== "shinycharm")
    .sort((a, b) => a.def.name.localeCompare(b.def.name));

  if (!mon) { closeUseItem(); return null; }
  const heldDef = mon.heldItem ? itemsCatalog[mon.heldItem] : null;

  const give = (itemId: string) => {
    dispatch({ type: "GIVE_HELD_ITEM", payload: { pokemonId: mon.id, itemId } });
    pushToast({ kind: "success", icon: "🎁", text: `${getItemInfo(itemId).name} → ${mon.nickname ?? mon.name}` });
    closeUseItem();
  };

  return (
    <Shell title={t("Held item")} sub={mon.nickname ?? mon.name}>
      {heldDef && (
        <div className="use-item-current">
          <img
            src={itemSpriteUrl(heldDef.id, heldDef.spriteOverride)}
            alt=""
            width={28}
            height={28}
            style={{ imageRendering: "pixelated" }}
          />
          <div className="use-item-current-text">
            <strong>{heldDef.name}</strong>
            <span>{heldDef.description}</span>
          </div>
          <button
            type="button"
            className="use-item-take"
            onClick={() => {
              dispatch({ type: "TAKE_HELD_ITEM", payload: { pokemonId: mon.id } });
              closeUseItem();
            }}
          >
            {t("Take it back")}
          </button>
        </div>
      )}

      {owned.length === 0 ? (
        // Says what to do, not just that there is nothing. The old inline
        // strip printed "No held items in bag." and stopped there.
        <p className="use-item-empty">
          {t("No held items in your bag. They are sold at the Mart — Charcoal, Magnet, Mystic Water and the rest — and boost a move type by 20%.")}
        </p>
      ) : (
        <ul className="use-item-grid">
          {owned.map(({ def, qty }) => {
            const isHeld = def.id === mon.heldItem;
            return (
              <li key={def.id}>
                <button
                  type="button"
                  className={`use-item-pick${isHeld ? " is-current" : ""}`}
                  onClick={() => give(def.id)}
                  disabled={isHeld}
                >
                  <img
                    src={itemSpriteUrl(def.id, def.spriteOverride)}
                    alt=""
                    width={30}
                    height={30}
                    style={{ imageRendering: "pixelated" }}
                  />
                  <span className="use-item-pick-text">
                    <strong>
                      {def.name}
                      <span className="use-item-qty">×{qty}</span>
                    </strong>
                    {/* The description, in the dialog, on every item. The
                        strip this replaces hid it in a hover title. */}
                    <span className="use-item-desc">{def.description}</span>
                  </span>
                  {isHeld && <span className="use-item-held-tag">{t("Held")}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Shell>
  );
}

// ── Spend a bottle cap ──────────────────────────────────────────────
type IvKey = keyof NonNullable<Pokemon["ivs"]>;
const STATS: { key: IvKey; label: string }[] = [
  { key: "hp", label: "HP" },
  { key: "attack", label: "Attack" },
  { key: "defense", label: "Defense" },
  { key: "spAttack", label: "Sp. Atk" },
  { key: "spDefense", label: "Sp. Def" },
  { key: "speed", label: "Speed" },
];
const IV_MAX = 31;

function ivTotal(p: Pokemon): number {
  const iv = p.ivs;
  if (!iv) return 0;
  return iv.hp + iv.attack + iv.defense + iv.spAttack + iv.spDefense + iv.speed;
}

function BottleCapDialog({ itemId }: { itemId: "goldbottlecap" | "silverbottlecap" }) {
  const { state, dispatch } = useGame();
  const t = useT();
  const gold = itemId === "goldbottlecap";
  const have = state.inventory[itemId] ?? 0;
  const [q, setQ] = useState("");
  // For a silver cap: which Pokémon is chosen, so the stat buttons know who
  // they are about. Gold needs no second step — it perfects everything.
  const [picked, setPicked] = useState<{ source: "party" | "box"; index: number } | null>(null);

  // Party first, then box. A cap is nearly always spent on something you are
  // actually using, and searching a 9,999-entry box for it is not the common
  // case — but it has to be possible, so there is a filter.
  const rows: { p: Pokemon; source: "party" | "box"; index: number }[] = [];
  state.party.forEach((p, index) => rows.push({ p, source: "party", index }));
  state.box.forEach((p, index) => { if (p) rows.push({ p, source: "box", index }); });
  const needle = q.trim().toLowerCase();
  const shown = rows.filter(({ p }) =>
    !needle
    || p.name.toLowerCase().includes(needle)
    || (p.nickname?.toLowerCase().includes(needle) ?? false));

  const pickedMon = picked
    ? (picked.source === "party" ? state.party[picked.index] : state.box[picked.index])
    : undefined;

  const apply = (source: "party" | "box", index: number, stat?: IvKey) => {
    dispatch({ type: "USE_BOTTLE_CAP", payload: { itemId, source, index, stat } });
    pushToast({ kind: "success", icon: "⭐", text: t("Hyper Training complete") });
    closeUseItem();
  };

  return (
    <Shell
      title={getItemInfo(itemId).name}
      sub={gold
        ? `${t("Makes every IV perfect. You have")} ${have}.`
        : `${t("Makes one stat's IV perfect. You have")} ${have}.`}
    >
      {picked && !gold && pickedMon ? (
        // STEP TWO. A whole view, not a strip that unfolded under one row and
        // pushed the rest of the list down while you read it — with the six
        // stats squeezed into the width of a list item and the Pokemon you
        // were choosing for scrolled halfway off the top.
        //
        // The dialog changes subject instead: who, then which stat, with a
        // way back. Two questions, one at a time.
        <StatStep
          mon={pickedMon}
          onBack={() => setPicked(null)}
          onPick={(stat) => apply(picked.source, picked.index, stat)}
        />
      ) : (
      <>
      <input
        className="use-item-search"
        type="search"
        placeholder={t("Search your Pokémon")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label={t("Search your Pokémon")}
      />

      <ul className="use-item-mons">
        {shown.slice(0, 120).map(({ p, source, index }) => {
          const total = ivTotal(p);
          const perfect = total >= IV_MAX * 6;
          const isPicked = picked?.source === source && picked?.index === index;
          return (
            <li key={`${source}-${index}-${p.id}`} className={isPicked ? "is-picked" : ""}>
              <button
                type="button"
                className="use-item-mon"
                disabled={perfect}
                title={perfect ? t("Already perfect") : undefined}
                onClick={() => {
                  if (gold) apply(source, index);
                  else setPicked(isPicked ? null : { source, index });
                }}
              >
                <PokemonSprite
                  speciesKey={p.speciesKey}
                  isShiny={!!p.isShiny}
                  alt=""
                  width={36}
                  height={36}
                  style={{ imageRendering: "pixelated" }}
                />
                <span className="use-item-mon-text">
                  <strong>{p.nickname ?? p.name}</strong>
                  <span className="use-item-mon-meta">
                    {t("Lv")} {p.level} · {source === "party" ? t("Party") : t("Box")}
                  </span>
                </span>
                {/* The number that decides whether a cap is worth spending
                    here. Without it the picker is a list of names. */}
                <span className={`use-item-iv${perfect ? " is-perfect" : ""}`}>
                  {total}<span className="dim">/{IV_MAX * 6}</span>
                </span>
              </button>

            </li>
          );
        })}
      </ul>
      {shown.length > 120 && (
        // Said out loud rather than silently truncated — a list that stops at
        // 120 with no note reads as "that is all you have".
        <p className="use-item-more">
          {t("Showing the first 120. Search to narrow it down.")}
        </p>
      )}
      </>
      )}
    </Shell>
  );
}

/**
 * Step two: which stat a silver cap perfects.
 *
 * Its own view rather than a strip that unfolded inside the list. The strip
 * pushed everything below it down while you read it, squeezed six stats into
 * the width of a list row, and left the Pokemon you were choosing for
 * scrolled halfway off the top — so the one thing the decision needed on
 * screen was the one thing that was not.
 */
function StatStep({
  mon, onBack, onPick,
}: {
  mon: Pokemon;
  onBack: () => void;
  onPick: (stat: IvKey) => void;
}) {
  const t = useT();
  const total = ivTotal(mon);
  return (
    <div className="use-item-step">
      <button type="button" className="use-item-back" onClick={onBack}>
        &larr; {t("Pick a different Pokemon")}
      </button>

      {/* Who this is for, held at the top of the step so it cannot scroll
          away from the decision it belongs to. */}
      <div className="use-item-subject">
        <PokemonSprite
          speciesKey={mon.speciesKey}
          isShiny={!!mon.isShiny}
          alt=""
          width={48}
          height={48}
          style={{ imageRendering: "pixelated" }}
        />
        <div className="use-item-subject-text">
          <strong>{mon.nickname ?? mon.name}</strong>
          <span>{t("Lv")} {mon.level} &middot; {t("IV total")} {total}/{IV_MAX * 6}</span>
        </div>
      </div>

      <p className="use-item-step-q">{t("Which stat should it perfect?")}</p>

      <ul className="use-item-statlist">
        {STATS.map((s) => {
          const at = mon.ivs?.[s.key] ?? 0;
          const done = at >= IV_MAX;
          const pct = Math.round((at / IV_MAX) * 100);
          return (
            <li key={s.key}>
              <button
                type="button"
                className="use-item-statrow"
                disabled={done}
                onClick={() => onPick(s.key)}
              >
                <span className="use-item-statrow-name">{t(s.label)}</span>
                {/* The current IV as a bar as well as a number. The decision
                    is "which of these is worst", and six numbers in a column
                    do not answer that at a glance. */}
                <span className="use-item-statrow-bar">
                  <span style={{ width: `${pct}%` }} className={done ? "is-done" : ""} />
                </span>
                <span className="use-item-statrow-n">
                  {at}<span className="dim">/{IV_MAX}</span>
                </span>
                <span className="use-item-statrow-go">
                  {done ? t("Perfect") : `→ ${IV_MAX}`}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
