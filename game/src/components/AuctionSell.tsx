// Listing something for auction.
//
// ── WHAT WAS WRONG ────────────────────────────────────────────────────────
// Step one was a five-column grid of name-and-level tiles crammed into the
// LEFT HALF of the dialog, with its own horizontal scrollbar AND a vertical
// one, while the right half held a single "Cancel" button in empty space. No
// search, no sort, no filter: finding one Pokémon in a box of hundreds meant
// scrolling past all of them. The tiles showed a name and a level, so the
// question "which of these is worth listing" — IVs, nature, shiny — could not
// be answered without leaving.
//
// Step two inverted it: the form went to the right third and the left half
// went empty. The Pokémon you were selling was a 24px sprite and its name.
// And the suggested price could land BELOW the minimum starting bid, with a
// "Use" button that would fill in a number the server refuses.
//
// ── WHAT THIS IS INSTEAD ──────────────────────────────────────────────────
// Two steps that each use the whole width.
//
//   PICK   — everything you own that can be sold, Pokémon and spare machines
//            together, searchable and sortable, with the stats that decide
//            worth on the tile itself.
//   PRICE  — the lot shown at size, beside the two fields, with a suggestion
//            that is always a number the server will accept.

import { useMemo, useState } from "react";
import { api } from "../net/api";
import { useGame } from "../state/GameContext";
import { HubViews } from "./HubModal";
import { PokemonSprite, Sprite } from "./Sprite";
import { itemSpriteUrl } from "../utils/sprites";
import { itemSpriteSlug } from "../utils/items";
import { genderSymbol } from "../data/gender";
import { machines, machineLearnsets, type MachineDef } from "../data/tms";
import { moves as movesTable } from "../data/moves";
import { valuePokemon, suggestedStartingBid, explain } from "../utils/pokemonValue";
import { MIN_STARTING_BID, formatMoney } from "../utils/auctionBidRules";
import { pushToast } from "./Toast";
import { useT } from "../i18n/useT";
import { displayName } from "../utils/pokemon";
import type { Pokemon } from "../types";
import { ivPercent } from "./AuctionHouse";
import "./auctionHouse.css";

type Sellable =
  | { kind: "pokemon"; id: string; mon: Pokemon }
  | { kind: "machine"; id: string; machine: MachineDef };

type SellSort = "value" | "level" | "iv" | "name";

const DURATIONS: { minutes: number; label: string }[] = [
  { minutes: 60, label: "1 hour" },
  { minutes: 60 * 6, label: "6 hours" },
  { minutes: 60 * 12, label: "12 hours" },
  { minutes: 60 * 24, label: "1 day" },
  { minutes: 60 * 48, label: "2 days" },
];

export function SellFlow({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { state } = useGame();
  const t = useT();
  const [picked, setPicked] = useState<Sellable | null>(null);

  if (picked) {
    return (
      <PriceStep
        lot={picked}
        onBack={() => setPicked(null)}
        onDone={onDone}
      />
    );
  }
  return <PickStep onPick={setPicked} onCancel={onCancel} />;
}

// ── Step one: what are you selling ────────────────────────────────────────

function PickStep({ onPick, onCancel }: { onPick: (s: Sellable) => void; onCancel: () => void }) {
  const { state } = useGame();
  const t = useT();
  const [kind, setKind] = useState<"pokemon" | "machine">("pokemon");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SellSort>("value");

  // A listed Pokémon is escrowed server-side but stays in the client's box,
  // so it has to be filtered out here or you can list the same one twice and
  // the second attempt fails with a 409 you did nothing to deserve.
  const listed = new Set(state.listedPokemonIds ?? []);

  const mons = useMemo(() => {
    const all: Sellable[] = [];
    for (const p of state.party) {
      if (p && !listed.has(p.id)) all.push({ kind: "pokemon", id: p.id, mon: p });
    }
    for (const p of state.box) {
      if (p && !listed.has(p.id)) all.push({ kind: "pokemon", id: p.id, mon: p });
    }
    return all;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.party, state.box, state.listedPokemonIds]);

  const owned = useMemo<Sellable[]>(() => {
    const out: Sellable[] = [];
    for (const [id, n] of Object.entries(state.inventory)) {
      if (n > 0 && machines[id]) out.push({ kind: "machine", id, machine: machines[id] });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }, [state.inventory]);

  const pool = kind === "pokemon" ? mons : owned;
  const needle = q.trim().toLowerCase();

  const shown = useMemo(() => {
    const filtered = pool.filter((s) => {
      if (!needle) return true;
      return s.kind === "pokemon"
        ? displayName(s.mon).toLowerCase().includes(needle)
        : `${s.machine.label} ${s.machine.moveName}`.toLowerCase().includes(needle);
    });
    if (kind === "machine") return filtered;
    const by: Record<SellSort, (a: Sellable, b: Sellable) => number> = {
      // Sorted by what it is WORTH by default. "Which of these should I sell"
      // is the question, and the old picker's answer was box order.
      value: (a, b) => valueOf(b) - valueOf(a),
      level: (a, b) => (b.kind === "pokemon" ? b.mon.level : 0) - (a.kind === "pokemon" ? a.mon.level : 0),
      iv: (a, b) => (b.kind === "pokemon" ? ivPercent(b.mon) : 0) - (a.kind === "pokemon" ? ivPercent(a.mon) : 0),
      name: (a, b) => labelOf(a).localeCompare(labelOf(b)),
    };
    return [...filtered].sort(by[sort]);
  }, [pool, needle, sort, kind]);

  return (
    <div className="tab-pane ah-pane">
      <HubViews>
        <div className="g-tabs" role="tablist" aria-label={t("What to sell")}>
          <button
            type="button" role="tab" aria-selected={kind === "pokemon"}
            className={`g-tab${kind === "pokemon" ? " active" : ""}`}
            onClick={() => setKind("pokemon")}
          >
            {t("Pokémon")} <span className="dim">{mons.length}</span>
          </button>
          <button
            type="button" role="tab" aria-selected={kind === "machine"}
            className={`g-tab${kind === "machine" ? " active" : ""}`}
            onClick={() => setKind("machine")}
          >
            {t("TMs")} <span className="dim">{owned.length}</span>
          </button>
        </div>
        <input
          className="ah-search"
          type="search"
          placeholder={kind === "pokemon" ? t("Search your Pokémon") : t("Search your machines")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label={t("Search what you can sell")}
        />
        {kind === "pokemon" && (
          <select
            className="ah-sort"
            value={sort}
            onChange={(e) => setSort(e.target.value as SellSort)}
            aria-label={t("Sort")}
          >
            <option value="value">{t("Most valuable")}</option>
            <option value="iv">{t("Best IVs")}</option>
            <option value="level">{t("Highest level")}</option>
            <option value="name">{t("Name")}</option>
          </select>
        )}
        <button type="button" className="ah-btn is-ghost" onClick={onCancel}>{t("Back to the floor")}</button>
      </HubViews>

      {shown.length === 0 ? (
        <p className="ah-note">
          {kind === "machine"
            ? t("You have no machines to sell. TMs turn up on routes, in raids, and at the TM Mart.")
            : needle
              ? t("Nothing by that name.")
              : t("Nothing to sell — everything you own is already listed.")}
        </p>
      ) : (
        <ul className="ah-pick-grid">
          {shown.map((s) => (
            <li key={s.id}>
              <button type="button" className="ah-pick" onClick={() => onPick(s)}>
                <span className="ah-pick-art">
                  {s.kind === "pokemon" ? (
                    <PokemonSprite
                      speciesKey={s.mon.speciesKey}
                      isShiny={!!s.mon.isShiny}
                      alt=""
                      width={56}
                      height={56}
                      style={{ imageRendering: "pixelated" }}
                    />
                  ) : (
                    <Sprite
                      src={itemSpriteUrl(s.machine.id, itemSpriteSlug(s.machine.id))}
                      alt=""
                      width={44}
                      height={44}
                      style={{ imageRendering: "pixelated" }}
                    />
                  )}
                </span>
                <span className="ah-pick-name">
                  {s.kind === "pokemon" && s.mon.isShiny && <span className="ah-shiny">✨</span>}
                  {labelOf(s)}
                  {s.kind === "pokemon" && genderSymbol(s.mon.gender) && (
                    <span className={`mon-gender is-${s.mon.gender === "M" ? "male" : "female"}`}>
                      {genderSymbol(s.mon.gender)}
                    </span>
                  )}
                </span>
                {/* The stats that answer "is this worth listing" — the whole
                    thing the old picker's name-and-level tile could not. */}
                <span className="ah-pick-tags">
                  {s.kind === "pokemon" ? (
                    <>
                      <span className="ah-tag">Lv{s.mon.level}</span>
                      {s.mon.ivs && (
                        <span className={`ah-tag ah-is-iv${ivPercent(s.mon) >= 90 ? " ah-is-great" : ""}`}>
                          {Math.round(ivPercent(s.mon))}%
                        </span>
                      )}
                      {s.mon.nature && <span className="ah-tag">{s.mon.nature}</span>}
                    </>
                  ) : (
                    <span className={`ah-tag type-${s.machine.moveType.toLowerCase()}`}>
                      {s.machine.moveType}
                    </span>
                  )}
                </span>
                {s.kind === "pokemon" && (
                  <span className="ah-pick-worth">≈ {formatMoney(valueOf(s))}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Step two: price and duration ──────────────────────────────────────────

function PriceStep({ lot, onBack, onDone }: {
  lot: Sellable;
  onBack: () => void;
  onDone: () => void;
}) {
  const { state, syncNow } = useGame();
  const t = useT();

  /**
   * The suggestion, CLAMPED TO THE FLOOR.
   *
   * The old form could suggest $260 and print "Minimum starting bid: $500"
   * directly underneath, with a Use button that filled in the 260 — a
   * one-click path to a rejection. A suggestion the server would refuse is
   * not a suggestion.
   */
  const suggested = lot.kind === "pokemon"
    ? Math.max(MIN_STARTING_BID, suggestedStartingBid(lot.mon))
    : machineSuggestion(lot.machine);

  const [text, setText] = useState<string>(String(suggested));
  const [minutes, setMinutes] = useState(60 * 24);
  const [busy, setBusy] = useState(false);

  const value = Math.floor(Number(text.replace(/[^0-9]/g, "")) || 0);
  const tooLow = value < MIN_STARTING_BID;

  const submit = async () => {
    if (tooLow) return;
    setBusy(true);
    try {
      // Same reason the bid path syncs first: the server reads the last
      // uploaded save to confirm you still hold what you are listing.
      await syncNow();
      await api.createAuction(
        lot.kind === "pokemon"
          ? { pokemonId: lot.id, startingBid: value, durationMinutes: minutes }
          : { itemId: lot.id, startingBid: value, durationMinutes: minutes },
      );
      pushToast({ kind: "success", icon: "🔨", text: `${labelOf(lot)} ${t("is up for auction.")}` });
      onDone();
    } catch (e: any) {
      pushToast({ kind: "warn", text: e?.message ?? t("Couldn't list that.") });
    } finally {
      setBusy(false);
    }
  };

  const mon = lot.kind === "pokemon" ? lot.mon : null;
  const machine = lot.kind === "machine" ? lot.machine : null;
  const breakdown = mon ? explain(valuePokemon(mon)) : [];

  return (
    <div className="tab-pane ah-pane">
      <HubViews>
        <button type="button" className="ah-btn is-ghost" onClick={onBack}>{t("← Pick something else")}</button>
        <span className="mart-wallet-chip">${state.money.toLocaleString()}</span>
      </HubViews>

      <div className="ah-sell-grid">
        {/* LEFT: what the buyer will see. The old step two put the thing
            being sold in a 24px sprite and left half the dialog black. */}
        <section className="ah-sell-preview">
          <div className="ah-hero">
            {mon ? (
              <PokemonSprite
                speciesKey={mon.speciesKey}
                isShiny={!!mon.isShiny}
                alt=""
                width={120}
                height={120}
                style={{ imageRendering: "pixelated" }}
              />
            ) : machine ? (
              <Sprite
                src={itemSpriteUrl(machine.id, itemSpriteSlug(machine.id))}
                alt=""
                width={88}
                height={88}
                style={{ imageRendering: "pixelated" }}
              />
            ) : null}
          </div>
          <h3 className="ah-hero-name">
            {mon?.isShiny && <span className="ah-shiny">✨</span>}
            {labelOf(lot)}
          </h3>
          {mon && (
            <>
              <p className="ah-hero-sub">
                Lv {mon.level}
                {mon.nature ? ` · ${mon.nature}` : ""}
                {mon.ivs ? ` · ${t("IV")} ${Math.round(ivPercent(mon))}%` : ""}
              </p>
              {breakdown.length > 0 && (
                <ul className="ah-worth">
                  {breakdown.map((line) => <li key={line}>{line}</li>)}
                </ul>
              )}
            </>
          )}
          {machine && (
            <>
              <p className="ah-hero-sub">
                {machine.label} · {movesTable[machine.moveId]?.type}
              </p>
              <p className="ah-sell-note">
                {t("Selling the disc gives it up — but anything you have already taught the move to keeps it.")}
              </p>
              <p className="ah-sell-note">
                {countLearners(machine.id)} {t("species in the game can learn it.")}
              </p>
            </>
          )}
        </section>

        {/* RIGHT: the two decisions. */}
        <section className="ah-sell-form">
          <label className="ah-bid-label" htmlFor="ah-start">{t("Starting bid")}</label>
          <div className="ah-bid-row">
            <span className="ah-bid-currency">$</span>
            <input
              id="ah-start"
              className="ah-bid-input"
              type="text"
              inputMode="numeric"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          {tooLow ? (
            <p className="ah-bid-warn">{t("Minimum is")} {formatMoney(MIN_STARTING_BID)}.</p>
          ) : (
            <p className="ah-hint">{t("Bidders can't open below this.")}</p>
          )}

          <button
            type="button"
            className="ah-suggest"
            onClick={() => setText(String(suggested))}
            disabled={value === suggested}
          >
            {t("Use the suggested")} <strong>{formatMoney(suggested)}</strong>
          </button>

          <label className="ah-bid-label" htmlFor="ah-dur">{t("Runs for")}</label>
          {/* Buttons, not a bare <select> — it was the only native select on
              the page and looked like it belonged to a different app. */}
          <div className="ah-durations" id="ah-dur">
            {DURATIONS.map((d) => (
              <button
                key={d.minutes}
                type="button"
                className={`ah-duration${minutes === d.minutes ? " is-active" : ""}`}
                onClick={() => setMinutes(d.minutes)}
              >
                {t(d.label)}
              </button>
            ))}
          </div>
          <p className="ah-hint">
            {t("A bid in the final minute pushes the end out by a minute, so it can't be sniped.")}
          </p>

          <div className="ah-sell-actions">
            <button type="button" className="ah-btn is-ghost" onClick={onBack}>{t("Back")}</button>
            <button
              type="button"
              className="ah-btn is-primary"
              disabled={busy || tooLow}
              onClick={submit}
            >
              {busy ? t("Listing…") : t("List for auction")}
            </button>
          </div>
          <p className="ah-hint">
            {lot.kind === "pokemon"
              ? t("It leaves your party the moment it is listed, and comes back if nobody bids.")
              : t("It leaves your bag the moment it is listed, and comes back if nobody bids.")}
          </p>
        </section>
      </div>
    </div>
  );
}

// ── helpers ───────────────────────────────────────────────────────────────

function labelOf(s: Sellable): string {
  return s.kind === "pokemon" ? displayName(s.mon) : `${s.machine.label} ${s.machine.moveName}`;
}

function valueOf(s: Sellable): number {
  return s.kind === "pokemon" ? valuePokemon(s.mon).value : (s.machine.price ?? 0);
}

/** How many species in the game can learn a machine's move. */
function countLearners(machineId: string): number {
  let n = 0;
  for (const ids of Object.values(machineLearnsets)) if (ids.includes(machineId)) n++;
  return n;
}

/**
 * An opening price for a machine.
 *
 * The TM Mart's own price is the anchor — a buyer will not pay far above what
 * the counter charges when it comes round — so the suggestion opens a little
 * under it, and never under the floor the server enforces.
 */
function machineSuggestion(m: MachineDef): number {
  const anchor = Math.round((m.price ?? MIN_STARTING_BID) * 0.6);
  return Math.max(MIN_STARTING_BID, anchor);
}
