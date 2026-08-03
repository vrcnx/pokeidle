// The TM Mart.
//
// A shop with six things on the counter and a clock. Everything about the
// page follows from that: the stock is small enough to show whole, so it is
// shown whole — no shelves, no tabs, no search over what is in front of you.
// The search is for what ISN'T, which is the question a rotating shop
// actually creates.
//
// ── THE DECISION THIS PAGE HAS TO SUPPORT ─────────────────────────────────
// "Should I buy this one?" is not a question about the move. It is a question
// about whether anything you own can learn it — a 60,000 Fire Blast is worth
// nothing to a box full of Water types, and a player cannot hold 59
// compatibility lists in their head. So every card answers it directly, with
// the count and the names, before you spend anything. That is the one piece
// of information the ordinary Mart's cards could never carry, and it is why
// this is a separate page rather than another shelf.

import { useEffect, useMemo, useState } from "react";
import { useGame } from "../state/GameContext";
import { HubViews } from "./HubModal";
import { Sprite } from "./Sprite";
import { itemSpriteUrl } from "../utils/sprites";
import { itemSpriteSlug } from "../utils/items";
import { pushToast } from "./Toast";
import { useT } from "../i18n/useT";
import { machineList, type MachineDef } from "../data/tms";
import { machineLearnsets } from "../data/tms";
import { machineSource, machineDropRoute } from "../data/machineSources";
import { tmMartStock, tmMartPrice, nextRotationAt, daysUntilStocked, TM_MART_POOL } from "../data/tmMart";
import { machineEffectText } from "../utils/machines";
import { moves as movesTable } from "../data/moves";
import { mergedRoutes } from "../data/regions";
import { openTeachMachine } from "./UseItemModal";
import { displayName } from "../utils/pokemon";
import type { Pokemon } from "../types";
import "./tmMart.css";

/** Ticks once a minute — the countdown is in hours and minutes, so a
 *  per-second timer would repaint sixty times for no visible change. */
function useMinuteTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function countdown(ms: number): string {
  if (ms <= 0) return "any moment";
  const mins = Math.floor(ms / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h >= 1) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Who in the player's party and box could learn this machine's move. */
function eligibleFor(machineId: string, party: Pokemon[], box: (Pokemon | null)[]): Pokemon[] {
  const out: Pokemon[] = [];
  const seen = new Set<string>();
  for (const p of [...party, ...box]) {
    if (!p) continue;
    if (!(machineLearnsets[p.speciesKey] ?? []).includes(machineId)) continue;
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

export function TmMartPane() {
  const { state, dispatch } = useGame();
  const t = useT();
  const now = useMinuteTick();

  const stock = useMemo(() => tmMartStock(), [Math.floor(now / 86_400_000)]);
  const untilRestock = nextRotationAt(now) - now;

  const buy = (m: MachineDef) => {
    const price = tmMartPrice(m);
    if (state.money < price) return;
    dispatch({ type: "BUY_ITEM", payload: { itemId: m.id, quantity: 1 } });
    pushToast({ kind: "success", icon: "💿", text: `Bought ${m.label} ${m.moveName}` });
  };

  const owned = machineList.filter((m) => (state.inventory[m.id] ?? 0) > 0).length;

  return (
    <div className="tab-pane tmmart-pane">
      <HubViews>
        {/* The clock IS the shop's rule, so it goes where the shelves go in
            the ordinary Mart — read before anything is bought, not after. */}
        <span className="tmmart-clock" title={t("The counter restocks at midnight UTC")}>
          <span className="tmmart-clock-dot" aria-hidden="true" />
          {t("New stock in")} <strong>{countdown(untilRestock)}</strong>
        </span>
        <span className="tmmart-collected" title={t("Machines you own, of every machine in the game")}>
          {owned}<span className="dim">/{machineList.length}</span>
        </span>
        <span className="mart-wallet-chip" title={t("Your money")}>
          ${state.money.toLocaleString()}
        </span>
      </HubViews>

      <ul className="tmmart-grid">
        {stock.map((m) => (
          <StockCard
            key={m.id}
            machine={m}
            price={tmMartPrice(m)}
            money={state.money}
            owned={(state.inventory[m.id] ?? 0) > 0}
            eligible={eligibleFor(m.id, state.party, state.box)}
            onBuy={() => buy(m)}
          />
        ))}
      </ul>

      <NotOnTheCounter inventory={state.inventory} />
    </div>
  );
}

function StockCard({
  machine, price, money, owned, eligible, onBuy,
}: {
  machine: MachineDef;
  price: number;
  money: number;
  owned: boolean;
  eligible: Pokemon[];
  onBuy: () => void;
}) {
  const t = useT();
  const def = movesTable[machine.moveId];
  const effect = machineEffectText(machine.id);
  const afford = money >= price;
  const route = machineDropRoute[machine.id];
  const premium = machineSource[machine.id] === "route";

  return (
    <li className={`tmmart-card${owned ? " is-owned" : ""}`}>
      <div className="tmmart-card-top">
        <Sprite
          className="tmmart-disc"
          src={itemSpriteUrl(machine.id, itemSpriteSlug(machine.id))}
          alt=""
          width={40}
          height={40}
          style={{ imageRendering: "pixelated" }}
        />
        <div className="tmmart-card-id">
          <span className="tmmart-label">{machine.label}</span>
          <strong className="tmmart-move">{machine.moveName}</strong>
        </div>
        <span className={`tmmart-type type-${machine.moveType.toLowerCase()}`}>
          {machine.moveType}
        </span>
      </div>

      {def && (
        <div className="tmmart-stats">
          <span><em>{def.power || "—"}</em>{t("pwr")}</span>
          <span><em>{def.accuracy}%</em>{t("acc")}</span>
          <span><em>{def.pp}</em>{t("pp")}</span>
          <span><em>{def.category}</em></span>
        </div>
      )}

      {effect && <p className="tmmart-effect">{effect}</p>}

      {/* ── THE ACTUAL DECISION ──────────────────────────────────────
          How many of YOUR Pokémon this would do anything for. Naming the
          first few matters more than the count: "3 can learn it" still
          leaves you opening the PC to find out which, and the answer is
          usually two sprites wide. */}
      <div className={`tmmart-fit${eligible.length === 0 ? " is-none" : ""}`}>
        {eligible.length === 0 ? (
          <span>{t("Nothing you own can learn this")}</span>
        ) : (
          <span>
            <strong>{eligible.length}</strong>{" "}
            {eligible.length === 1 ? t("of yours can learn it") : t("of yours can learn it")}
            <span className="dim">
              {" — "}
              {eligible.slice(0, 3).map((p) => displayName(p)).join(", ")}
              {eligible.length > 3 ? `, +${eligible.length - 3}` : ""}
            </span>
          </span>
        )}
      </div>

      {/* Where it comes from otherwise. A player who knows Rock Slide drops
          on Route 8 can decide to walk instead of paying double for it, and
          that choice only exists if the card says so. */}
      <p className="tmmart-origin">
        {premium && route
          ? `${t("Also found on")} ${mergedRoutes[route]?.name ?? route} ${t("— half this price if you walk")}`
          : t("Sold here only")}
      </p>

      <div className="tmmart-actions">
        {owned ? (
          <button type="button" className="tmmart-buy is-owned" onClick={() => openTeachMachine(machine.id)}>
            {t("Owned — Teach…")}
          </button>
        ) : (
          <button
            type="button"
            className="tmmart-buy"
            disabled={!afford}
            onClick={onBuy}
            title={afford ? undefined : t("You can't afford this")}
          >
            {t("Buy")}
            <span className="tmmart-price">${price.toLocaleString()}</span>
          </button>
        )}
      </div>
    </li>
  );
}

/**
 * Everything the counter is NOT selling today, and when it will.
 *
 * A rotating shop's real cost to the player is uncertainty: you came for
 * Earthquake, it isn't here, and now you have to check back every day
 * forever. Because the pool is dealt rather than drawn (see data/tmMart.ts)
 * the wait is always knowable, so it is always shown. This turns "check back
 * tomorrow" into "Thursday", which is the difference between a mechanic and
 * a chore.
 */
function NotOnTheCounter({ inventory }: { inventory: Record<string, number> }) {
  const t = useT();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);

  const upcoming = useMemo(() => {
    const today = new Set(tmMartStock().map((m) => m.id));
    return TM_MART_POOL
      .filter((m) => !today.has(m.id))
      .map((m) => ({ m, days: daysUntilStocked(m.id) ?? 99 }))
      .sort((a, b) => a.days - b.days || a.m.id.localeCompare(b.m.id));
  }, []);

  const needle = q.trim().toLowerCase();
  const shown = needle
    ? upcoming.filter(({ m }) =>
        m.moveName.toLowerCase().includes(needle) || m.label.toLowerCase().includes(needle))
    : upcoming;

  return (
    <section className={`tmmart-upcoming${open ? " is-open" : ""}`}>
      <header className="tmmart-upcoming-head">
        <button
          type="button"
          className="tmmart-upcoming-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="tmmart-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
          {t("Not today")}
          <span className="dim">{upcoming.length}</span>
        </button>
        {open && (
          <input
            className="tmmart-search"
            type="search"
            placeholder={t("Find a machine")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label={t("Search machines not on sale today")}
          />
        )}
      </header>

      {open && (
        <ul className="tmmart-upcoming-list">
          {shown.length === 0 && <li className="g-help">{t("No machine by that name.")}</li>}
          {shown.map(({ m, days }) => {
            const have = (inventory[m.id] ?? 0) > 0;
            return (
              <li key={m.id} className={have ? "is-owned" : ""}>
                <span className={`tmmart-dot type-${m.moveType.toLowerCase()}`} aria-hidden="true" />
                <span className="tmmart-up-label">{m.label}</span>
                <span className="tmmart-up-move">{m.moveName}</span>
                <span className="tmmart-up-when">
                  {have
                    ? t("owned")
                    : days === 1
                      ? t("tomorrow")
                      : `${t("in")} ${days} ${t("days")}`}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
