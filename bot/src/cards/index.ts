// The card renderers.
//
// Each function takes a DTO from the API client and returns a PNG Buffer.
// None of them fetch game data, none of them know about interactions — the
// handlers do that and hand the result here.
//
// ── WHY EVERY CARD IS A FIXED-WIDTH IMAGE ───────────────────────────
// Discord renders an embed differently on desktop, mobile and in compact
// mode, and an embed's field layout reflows in ways you cannot control. A
// card is the same everywhere. The cost is that the text is not selectable
// and not translatable, which is why the giveaway and prize cards still
// carry their key facts in the message body as well.

import type { SKRSContext2D } from "@napi-rs/canvas";
import {
  C,
  bar,
  drawSpriteFit,
  ellipsize,
  font,
  header,
  newCard,
  panel,
  pill,
  sprite,
  text,
  toPng,
  type Card,
} from "./draw.js";
import {
  TYPE_COLOR,
  abilityName,
  itemName,
  itemSpriteUrl,
  moveName,
  pokemonStaticUrl,
  species,
  typeColorFor,
} from "../sprites.js";
import type { Identity, MonDetail, MonSummary, Rating } from "../api.js";

const W = 900;

/** Nickname (species) when nicknamed, else the species name. Matches how the
 *  game labels a Pokémon everywhere else. */
function label(m: MonSummary): string {
  const base = m.name || species(m.speciesKey)?.name || m.speciesKey;
  return m.nickname ? `${m.nickname}` : base;
}

function speciesLabel(m: MonSummary): string {
  return m.name || species(m.speciesKey)?.name || m.speciesKey;
}

/** Type chips for a species, drawn left to right. Returns the width used. */
function typeChips(ctx: SKRSContext2D, speciesKey: string, x: number, y: number): number {
  const types = species(speciesKey)?.types ?? [];
  let cx = x;
  for (const t of types) {
    cx += pill(ctx, t.toUpperCase(), cx, y, { fill: TYPE_COLOR[t] ?? C.panelEdge, color: "#12151c", size: 12 }) + 6;
  }
  return cx - x;
}

// ── /profile ────────────────────────────────────────────────────────

export async function profileCard(p: Identity, party: MonSummary[]): Promise<Buffer> {
  const card = newCard(W, 420);
  const { ctx } = card;
  header(card, p.name ?? p.username, `@${p.username}`);

  // Party strip along the top — a trainer card without their team on it is
  // just a table of numbers.
  const imgs = await Promise.all(party.slice(0, 6).map((m) => sprite(pokemonStaticUrl(m.speciesKey, m.isShiny))));
  const stripY = 108;
  panel(ctx, 32, stripY, W - 64, 108);
  for (let i = 0; i < 6; i++) {
    const x = 44 + i * ((W - 88) / 6);
    const cellW = (W - 88) / 6 - 8;
    const m = party[i];
    if (!m) {
      text(ctx, "—", x + cellW / 2, stripY + 60, { size: 20, color: C.textFaint, align: "center" });
      continue;
    }
    drawSpriteFit(ctx, imgs[i], x, stripY + 8, cellW, 62);
    text(ctx, `Lv ${m.level}`, x + cellW / 2, stripY + 90, {
      size: 14,
      color: m.isShiny ? C.shiny : C.textDim,
      align: "center",
    });
  }

  // Stat tiles.
  const tiles: Array<[string, string, string]> = [
    ["ACCOUNT LEVEL", String(p.accountLevel), C.gold],
    ["POKÉDEX", String(p.pokedexCaughtCount), C.blue],
    ["DAILY STREAK", p.dailyStreak > 0 ? `${p.dailyStreak}d` : "—", C.green],
    ["PVP", p.rating.unranked ? "Unranked" : String(p.rating.rating), p.rating.unranked ? C.textDim : C.gold],
  ];
  const tileW = (W - 64 - 3 * 12) / 4;
  for (let i = 0; i < tiles.length; i++) {
    const x = 32 + i * (tileW + 12);
    panel(ctx, x, 240, tileW, 92);
    text(ctx, tiles[i][0], x + 16, 268, { size: 12, weight: "bold", color: C.textDim });
    text(ctx, tiles[i][1], x + 16, 308, { size: 30, weight: "bold", color: tiles[i][2], maxWidth: tileW - 32 });
  }

  const record = p.rating.unranked
    ? "No rated matches yet"
    : `${p.rating.wins}W – ${p.rating.losses}L` +
      (p.rating.ladderPosition ? `  ·  ladder #${p.rating.ladderPosition}` : "");
  text(ctx, record, 32, 368, { size: 16, color: C.textDim });
  text(ctx, `Playing since ${new Date(p.createdAt).toLocaleDateString("en-GB", { month: "short", year: "numeric" })}`,
    W - 32, 368, { size: 15, color: C.textFaint, align: "right" });

  return toPng(card);
}

// ── /team ───────────────────────────────────────────────────────────

export async function teamCard(username: string, party: MonSummary[]): Promise<Buffer> {
  const rows = Math.max(party.length, 1);
  const rowH = 92;
  const card = newCard(W, 120 + rows * (rowH + 10) + 24);
  const { ctx } = card;
  header(card, `${username}'s team`, party.length ? `${party.length} Pokémon` : undefined);

  if (party.length === 0) {
    panel(ctx, 32, 116, W - 64, 76);
    text(ctx, "No Pokémon in the party right now.", W / 2, 162, {
      size: 18, color: C.textDim, align: "center",
    });
    return toPng(card);
  }

  const imgs = await Promise.all(party.map((m) => sprite(pokemonStaticUrl(m.speciesKey, m.isShiny))));

  for (let i = 0; i < party.length; i++) {
    const m = party[i];
    const y = 116 + i * (rowH + 10);
    panel(ctx, 32, y, W - 64, rowH, { accent: typeColorFor(m.speciesKey) });

    drawSpriteFit(ctx, imgs[i], 44, y + 8, 76, 76);

    const nameX = 136;
    text(ctx, label(m), nameX, y + 32, { size: 21, weight: "bold", maxWidth: 300 });
    if (m.isShiny) {
      ctx.font = font(21, "bold");
      const nameW = Math.min(ctx.measureText(label(m)).width, 300);
      pill(ctx, "SHINY", nameX + nameW + 10, y + 16, { fill: C.shiny, color: "#12151c", size: 11 });
    }

    const sub = m.nickname ? `${speciesLabel(m)}  ·  Lv ${m.level}` : `Lv ${m.level}`;
    text(ctx, sub, nameX, y + 56, { size: 15, color: C.textDim, maxWidth: 280 });
    typeChips(ctx, m.speciesKey, nameX, y + 66);

    // Moves, right-aligned in two columns so four fit without crowding.
    const movesX = 470;
    for (let mi = 0; mi < Math.min(4, m.moves.length); mi++) {
      const col = mi % 2;
      const row = Math.floor(mi / 2);
      text(ctx, moveName(m.moves[mi]), movesX + col * 200, y + 34 + row * 24, {
        size: 14, color: C.textDim, maxWidth: 190,
      });
    }
    if (m.nature) {
      text(ctx, m.nature, W - 48, y + 78, { size: 13, color: C.textFaint, align: "right" });
    }
  }

  return toPng(card);
}

// ── /mon ────────────────────────────────────────────────────────────

const STATS: Array<[string, keyof MonDetail, string]> = [
  ["HP", "maxHp", "hp"],
  ["ATK", "attack", "attack"],
  ["DEF", "defense", "defense"],
  ["SPA", "spAttack", "spAttack"],
  ["SPD", "spDefense", "spDefense"],
  ["SPE", "speed", "speed"],
];

export async function monCard(username: string, m: MonDetail): Promise<Buffer> {
  const card = newCard(W, 460);
  const { ctx } = card;
  header(card, label(m), `${username}  ·  slot ${m.slot}  ·  Level ${m.level}`);

  const img = await sprite(pokemonStaticUrl(m.speciesKey, m.isShiny));

  // Sprite panel, tinted by primary type.
  //
  // Laid out from the panel's own bottom edge rather than from hard-coded
  // offsets: the species line used to be computed as `y + 84` and landed four
  // pixels BELOW the panel, outside its fill, which reads as a rendering bug
  // rather than as a caption.
  const panelY = 116;
  const panelH = 300;
  panel(ctx, 32, panelY, 260, panelH, { accent: typeColorFor(m.speciesKey) });
  drawSpriteFit(ctx, img, 52, panelY + 20, 220, 170);
  const chipsY = panelY + 200;
  typeChips(ctx, m.speciesKey, 52, chipsY);
  if (m.isShiny) pill(ctx, "SHINY", 52, chipsY + 34, { fill: C.shiny, color: "#12151c", size: 12 });
  if (m.nickname) {
    text(ctx, speciesLabel(m), 52, panelY + panelH - 20, { size: 14, color: C.textFaint, maxWidth: 210 });
  }

  // Stat block. Each row: label, value, bar, then IV/EV as a tail.
  //
  // The bar maxes at 400, which is above any legal stat in this game and is
  // therefore a fair common scale — normalising each stat to its own maximum
  // would make a bad stat and a good stat look identical.
  const sx = 316;
  const sw = W - sx - 32;
  panel(ctx, sx, 116, sw, 232);
  for (let i = 0; i < STATS.length; i++) {
    const [lbl, key, ivKey] = STATS[i];
    const y = 148 + i * 34;
    const value = Number(m[key] ?? 0);
    text(ctx, lbl, sx + 18, y + 5, { size: 14, weight: "bold", color: C.textDim });
    text(ctx, String(value), sx + 74, y + 5, { size: 15, weight: "bold", align: "right" });
    bar(ctx, sx + 88, y - 7, sw - 250, 12, value, 400, typeColorFor(m.speciesKey));
    const iv = m.ivs[ivKey];
    const ev = m.evs[ivKey];
    const tail = [iv !== undefined ? `IV ${iv}` : null, ev ? `EV ${ev}` : null].filter(Boolean).join("  ");
    text(ctx, tail || "—", W - 48, y + 5, { size: 13, color: C.textFaint, align: "right" });
  }

  // Footer facts.
  const facts: Array<[string, string]> = [
    ["NATURE", m.nature ?? "—"],
    ["ABILITY", m.ability ? abilityName(m.ability) : "—"],
    ["HELD ITEM", m.heldItem ? itemName(m.heldItem) : "—"],
  ];
  const fw = (sw - 2 * 10) / 3;
  for (let i = 0; i < facts.length; i++) {
    const x = sx + i * (fw + 10);
    panel(ctx, x, 360, fw, 56);
    text(ctx, facts[i][0], x + 14, 382, { size: 11, weight: "bold", color: C.textDim });
    text(ctx, facts[i][1], x + 14, 404, { size: 15, maxWidth: fw - 28 });
  }

  return toPng(card);
}

// ── /rank ───────────────────────────────────────────────────────────

export async function rankCard(username: string, r: Rating): Promise<Buffer> {
  const card = newCard(W, r.unranked ? 260 : 340);
  const { ctx } = card;
  header(card, username, "PvP ladder");

  if (r.unranked) {
    panel(ctx, 32, 116, W - 64, 108);
    text(ctx, "Unranked", W / 2, 162, { size: 30, weight: "bold", color: C.textDim, align: "center" });
    text(ctx, "No rated matches played yet — win one and you're on the board.", W / 2, 194, {
      size: 16, color: C.textFaint, align: "center",
    });
    return toPng(card);
  }

  // Hero rating.
  panel(ctx, 32, 116, 300, 140, { accent: C.gold });
  text(ctx, "RATING", 52, 146, { size: 12, weight: "bold", color: C.textDim });
  text(ctx, String(r.rating), 52, 202, { size: 56, weight: "bold", color: C.gold });
  text(ctx, r.ladderPosition ? `Ladder #${r.ladderPosition}` : "", 52, 232, { size: 16, color: C.textDim });

  const tiles: Array<[string, string, string]> = [
    ["PEAK", String(r.peakRating), C.text],
    ["MATCHES", String(r.matchesPlayed), C.text],
    ["WINS", String(r.wins), C.green],
    ["LOSSES", String(r.losses), C.red],
  ];
  const tw = (W - 32 - 344 - 3 * 12) / 4;
  for (let i = 0; i < tiles.length; i++) {
    const x = 344 + i * (tw + 12);
    panel(ctx, x, 116, tw, 140);
    text(ctx, tiles[i][0], x + 14, 146, { size: 11, weight: "bold", color: C.textDim });
    text(ctx, tiles[i][1], x + 14, 196, { size: 34, weight: "bold", color: tiles[i][2] });
  }

  // Win-rate bar across the bottom.
  const total = r.wins + r.losses;
  const wr = total > 0 ? Math.round((r.wins / total) * 100) : 0;
  text(ctx, `Win rate  ${wr}%`, 32, 296, { size: 15, color: C.textDim });
  bar(ctx, 32, 306, W - 64, 14, r.wins, Math.max(1, total), C.green);

  return toPng(card);
}

// ── /leaderboard ────────────────────────────────────────────────────

export async function leaderboardCard(
  rows: Array<{ rank: number; username: string; rating: number; wins: number; losses: number; accountLevel: number }>,
): Promise<Buffer> {
  const card = newCard(W, 120 + Math.max(rows.length, 1) * 52 + 24);
  const { ctx } = card;
  header(card, "PvP ladder", rows.length ? `Top ${rows.length}` : undefined);

  if (rows.length === 0) {
    panel(ctx, 32, 116, W - 64, 76);
    text(ctx, "Nobody's on the board yet.", W / 2, 162, { size: 18, color: C.textDim, align: "center" });
    return toPng(card);
  }

  const top = rows[0].rating;
  const medal = ["#f2c94c", "#c9d1d9", "#cd7f32"];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const y = 116 + i * 52;
    const accent = i < 3 ? medal[i] : undefined;
    panel(ctx, 32, y, W - 64, 44, { radius: 10, accent });

    text(ctx, `#${r.rank}`, 52, y + 29, { size: 17, weight: "bold", color: accent ?? C.textDim });
    text(ctx, r.username, 104, y + 29, { size: 17, weight: "bold", maxWidth: 240 });
    text(ctx, `Lv ${r.accountLevel}`, 360, y + 29, { size: 14, color: C.textFaint });

    // Rating bar, scaled against the leader so the shape of the ladder reads
    // at a glance rather than every bar looking full.
    //
    // The bar STOPS at 690 and the rating is right-aligned at 760, with the
    // gap sized for a four-digit number. Previously the bar ran to 700 and the
    // rating was right-aligned at 720, so a rating like 1622 rendered on top of
    // the bar's own end cap.
    bar(ctx, 430, y + 16, 260, 12, r.rating, top, accent ?? C.blue);
    text(ctx, String(r.rating), 760, y + 29, { size: 16, weight: "bold", align: "right" });
    text(ctx, `${r.wins}W-${r.losses}L`, W - 52, y + 29, { size: 14, color: C.textDim, align: "right" });
  }

  return toPng(card);
}

// ── /dex ────────────────────────────────────────────────────────────

export async function dexCard(d: {
  username: string;
  caughtCount: number;
  seenCount: number | null;
  shinyCaughtCount: number | null;
}): Promise<Buffer> {
  const card = newCard(W, 300);
  const { ctx } = card;
  header(card, `${d.username}'s Pokédex`);

  const tiles: Array<[string, string, string]> = [
    ["CAUGHT", String(d.caughtCount), C.green],
    ["SEEN", d.seenCount === null ? "—" : String(d.seenCount), C.blue],
    ["SHINY", d.shinyCaughtCount === null ? "—" : String(d.shinyCaughtCount), C.shiny],
  ];
  const tw = (W - 64 - 2 * 12) / 3;
  for (let i = 0; i < tiles.length; i++) {
    const x = 32 + i * (tw + 12);
    panel(ctx, x, 116, tw, 120);
    text(ctx, tiles[i][0], x + 18, 148, { size: 12, weight: "bold", color: C.textDim });
    text(ctx, tiles[i][1], x + 18, 208, { size: 48, weight: "bold", color: tiles[i][2] });
  }

  // No percentage, deliberately — the server has no species table, so there is
  // no honest denominator. See BotDex.totalSpecies.
  text(ctx, "Counts only — completion % isn't shown because the species list keeps growing.",
    32, 268, { size: 14, color: C.textFaint });

  return toPng(card);
}

// ── Prizes ──────────────────────────────────────────────────────────

/** A prize descriptor, as stored. Mirrors the server's Prize union. */
export type PrizeDescriptor =
  | { kind: "item"; itemId: string; quantity: number }
  | { kind: "money"; amount: number }
  | { kind: "pokemon"; label: string; mon?: { speciesKey?: string; isShiny?: boolean; level?: number } };

function prizeText(p: PrizeDescriptor): string {
  if (p.kind === "item") return `${p.quantity}× ${itemName(p.itemId)}`;
  if (p.kind === "money") return `$${p.amount.toLocaleString()}`;
  return p.label;
}

function prizeSpriteUrl(p: PrizeDescriptor): string {
  if (p.kind === "item") return itemSpriteUrl(p.itemId);
  if (p.kind === "pokemon" && p.mon?.speciesKey) {
    return pokemonStaticUrl(p.mon.speciesKey, !!p.mon.isShiny);
  }
  return "";
}

/** Draw one prize as sprite + label. Money has no sprite and gets a coin
 *  glyph drawn instead, so the row is never visually empty. */
async function drawPrize(ctx: SKRSContext2D, p: PrizeDescriptor, x: number, y: number, size: number): Promise<void> {
  const url = prizeSpriteUrl(p);
  if (url) {
    drawSpriteFit(ctx, await sprite(url), x, y, size, size);
  } else {
    ctx.beginPath();
    ctx.arc(x + size / 2, y + size / 2, size * 0.32, 0, Math.PI * 2);
    ctx.fillStyle = C.gold;
    ctx.fill();
    text(ctx, "$", x + size / 2, y + size / 2 + 8, {
      size: size * 0.4, weight: "bold", color: "#12151c", align: "center",
    });
  }
}

export async function giveawayCard(input: {
  title: string;
  description: string;
  prizes: PrizeDescriptor[];
  winnerCount: number;
}): Promise<Buffer> {
  const card = newCard(W, 360);
  const { ctx } = card;
  // No emoji in rendered text. The Docker image installs a text font but no
  // COLOUR EMOJI font, so an emoji here draws as a tofu box — and installing
  // fonts-noto-color-emoji to fix one decorative glyph adds ~10MB to the
  // image. Emoji belong in the Discord message body, which Discord renders
  // itself; see the giveaway handler.
  header(card, input.title, input.description || undefined);

  panel(ctx, 32, 128, W - 64, 150, { accent: C.gold });
  const n = Math.min(input.prizes.length, 4);
  const cellW = (W - 96) / Math.max(n, 1);
  for (let i = 0; i < n; i++) {
    const x = 48 + i * cellW;
    await drawPrize(ctx, input.prizes[i], x + cellW / 2 - 44, 148, 88);
    text(ctx, prizeText(input.prizes[i]), x + cellW / 2, 262, {
      size: 17, weight: "bold", align: "center", maxWidth: cellW - 16,
    });
  }
  if (input.prizes.length > 4) {
    text(ctx, `+${input.prizes.length - 4} more`, W - 48, 268, { size: 14, color: C.textDim, align: "right" });
  }

  text(ctx, `${input.winnerCount} winner${input.winnerCount === 1 ? "" : "s"}`, 32, 312, {
    size: 17, weight: "bold", color: C.gold,
  });
  text(ctx, "Press Enter below · you need a linked game account", W - 32, 312, {
    size: 15, color: C.textDim, align: "right",
  });

  return toPng(card);
}

export async function prizesCard(
  username: string,
  grants: Array<{
    summary: string;
    prizes: PrizeDescriptor[];
    delivered: boolean;
    stuck: boolean;
  }>,
): Promise<Buffer> {
  const rowH = 68;
  const card = newCard(W, 120 + Math.max(grants.length, 1) * (rowH + 8) + 48);
  const { ctx } = card;
  header(card, `${username}'s prizes`);

  if (grants.length === 0) {
    panel(ctx, 32, 116, W - 64, 76);
    text(ctx, "Nothing owed and nothing recently delivered.", W / 2, 162, {
      size: 18, color: C.textDim, align: "center",
    });
    return toPng(card);
  }

  for (let i = 0; i < grants.length; i++) {
    const g = grants[i];
    const y = 116 + i * (rowH + 8);
    const accent = g.delivered ? C.green : g.stuck ? C.red : C.gold;
    panel(ctx, 32, y, W - 64, rowH, { accent });

    // Up to three prize sprites per grant, then the summary text.
    let px = 48;
    for (const p of g.prizes.slice(0, 3)) {
      await drawPrize(ctx, p, px, y + 10, 48);
      px += 54;
    }
    const textX = Math.max(px + 8, 120);
    text(ctx, g.summary, textX, y + 30, { size: 17, weight: "bold", maxWidth: W - textX - 220 });
    const status = g.delivered
      ? "Delivered"
      : g.stuck
        ? "Waiting — usually a full box"
        : "Queued — lands next time you load the game";
    text(ctx, status, textX, y + 52, { size: 14, color: accent, maxWidth: W - textX - 220 });
  }

  text(ctx, "Prizes apply on your next save upload. Nothing is lost if you're offline.",
    32, card.h - 24, { size: 14, color: C.textFaint });

  return toPng(card);
}
