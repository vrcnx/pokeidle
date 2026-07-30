import type { GiveawayPrize } from "../net/api";
import { getItemInfo, itemSpriteSlug } from "./items";
import { itemSpriteUrl, pokemonSpriteUrl, pokemonStaticSpriteUrl } from "./sprites";
import { pokemonTable } from "../data/pokemon";

// Turning a stored prize descriptor into something that looks like the rest of
// the game.
//
// What players see today, verbatim from production, is `describePrizes()`
// output — the raw stored ids, joined:
//
//     1x masterball
//     1x goldbottlecap + 2x silverbottlecap
//     1x moonstone + 1x firestone + 1x waterstone + 1x thunderstone + …
//
// Every one of those ids resolves in data/itemsCatalog.ts, and every Pokémon
// prize already ships its whole serialised mon (speciesKey, isShiny, level).
// So the information needed to draw a Master Ball sprite next to the words
// "Master Ball" was always on the wire; nothing rendered it.
//
// This module is deliberately pure — no React, no DOM — so the mapping is unit
// testable against the real stored shapes. It emits the SAME sprite URLs the
// Bag, Mart and party already use, via the same helpers, so a prize chip is
// the game's existing visual language rather than a second one.

export interface PrizeChip {
  /** Stable per-list key; a giveaway can list the same item twice. */
  key: string;
  kind: "item" | "money" | "pokemon";
  /** What to print: "Master Ball", "$50,000", "Shiny Mew (Lv70)". */
  name: string;
  /** Shown as "×N" when > 1. Always 1 for money / pokemon. */
  qty: number;
  /** Primary sprite URL, or "" when this kind has no sprite (money). */
  spriteUrl: string;
  /** Second source for <Sprite fallbackSrc> — "" when there isn't one. */
  fallbackSpriteUrl: string;
  /** Emoji stand-in used when there is no sprite at all. */
  glyph: string;
  isShiny: boolean;
  /**
   * False when the id/species did not resolve. The chip still renders — with
   * the raw id as its name — because a visible unknown is a bug someone can
   * report and a blank chip is a bug nobody can.
   */
  known: boolean;
}

/** Money, formatted the way the game formats money everywhere else. */
export function formatPrizeMoney(amount: number): string {
  return `$${Math.round(amount).toLocaleString()}`;
}

function speciesKeyOf(mon: Record<string, unknown> | undefined): string | null {
  const k = mon?.speciesKey;
  return typeof k === "string" && k.length > 0 ? k : null;
}

function itemChip(p: GiveawayPrize, key: string): PrizeChip {
  const id = typeof p.itemId === "string" ? p.itemId : "";
  const info = getItemInfo(id);
  // getItemInfo echoes the id back when it knows nothing about it.
  const known = id !== "" && info.name !== id;
  return {
    key,
    kind: "item",
    name: info.name || id || "Unknown item",
    qty: Math.max(1, Math.round(p.quantity ?? 1)),
    spriteUrl: id ? itemSpriteUrl(id, itemSpriteSlug(id)) : "",
    fallbackSpriteUrl: "",
    glyph: "🎁",
    isShiny: false,
    known,
  };
}

function pokemonChip(p: GiveawayPrize, key: string): PrizeChip {
  const species = speciesKeyOf(p.mon);
  const isShiny = p.mon?.isShiny === true;
  const id = species ? pokemonTable[species]?.id : undefined;
  // `label` is authored by the admin client and is already human — "Shiny Mew
  // (Lv70)", "Shiny Gengar Lv50". Prefer it; it says more than the species
  // name alone (level, shininess) and it is what chat already announced.
  const label = typeof p.label === "string" && p.label.trim() ? p.label.trim() : null;
  const speciesName = species ? pokemonTable[species]?.name : undefined;
  return {
    key,
    kind: "pokemon",
    name: label ?? speciesName ?? "Pokémon",
    qty: 1,
    spriteUrl: species ? pokemonSpriteUrl(species, false, isShiny) : "",
    // Same chain the rest of the app uses: animated GIF, then the static PNG
    // on a different CDN subtree (survives ad-blockers matching "/animated/").
    fallbackSpriteUrl: id != null ? pokemonStaticSpriteUrl(id, isShiny, false) : "",
    glyph: "✨",
    isShiny,
    known: species != null && id != null,
  };
}

function moneyChip(p: GiveawayPrize, key: string): PrizeChip {
  const amount = Math.max(0, Math.round(p.amount ?? 0));
  return {
    key,
    kind: "money",
    name: formatPrizeMoney(amount),
    qty: 1,
    spriteUrl: "",
    fallbackSpriteUrl: "",
    // Matches the money glyph in the mobile header strip.
    glyph: "💰",
    isShiny: false,
    known: true,
  };
}

/**
 * Render-ready chips for a stored prize list. Never throws and never returns
 * a chip with no name — a giveaway whose prize row is corrupt should still
 * show a giveaway.
 */
export function prizeChips(prizes: readonly GiveawayPrize[] | null | undefined): PrizeChip[] {
  if (!Array.isArray(prizes)) return [];
  return prizes.map((p, i) => {
    const key = `${p?.kind ?? "?"}-${p?.itemId ?? p?.label ?? p?.amount ?? ""}-${i}`;
    if (p?.kind === "money") return moneyChip(p, key);
    if (p?.kind === "pokemon") return pokemonChip(p, key);
    return itemChip(p ?? { kind: "item" }, key);
  });
}

/**
 * One-line text version of the same chips — for `title`/`aria-label`, and for
 * the rail, where there is no room for sprites.
 *
 * Note this is the CLIENT's naming. The server's describePrizes() still emits
 * stored ids ("1x masterball") and still feeds the global-chat announcement;
 * this refines the same facts rather than contradicting them.
 */
export function describeChips(chips: readonly PrizeChip[]): string {
  if (chips.length === 0) return "";
  return chips.map((c) => (c.qty > 1 ? `${c.name} ×${c.qty}` : c.name)).join(" + ");
}

/**
 * The headline prize — what the rail shows when it has one line to spend.
 *
 * The tail reads "& 2 more", not "+2". `+N` is already the history row's
 * notation for *winners you cannot see* ("@a, @b, @c +9"), and the same
 * sigil counting two different nouns inside one feature is exactly the kind
 * of thing a player has to stop and decode. `&` counts prizes, `+` counts
 * winners, and neither is ever both.
 */
export function primaryPrizeLabel(prizes: readonly GiveawayPrize[] | null | undefined): string {
  const chips = prizeChips(prizes);
  if (chips.length === 0) return "";
  const [first] = chips;
  const head = first.qty > 1 ? `${first.name} ×${first.qty}` : first.name;
  return chips.length === 1 ? head : `${head} & ${chips.length - 1} more`;
}
