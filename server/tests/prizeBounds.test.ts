// THE PRIZE BOUNDS, and the fact that every route which mints one shares them.
//
// ── THE DEFECT THIS PINS ─────────────────────────────────────────────
// Three operator paths turn an admin request into a PendingGrant that is folded
// into a player's save. Two of them validated the prize list with a zod schema
// bounding an item at 999 units and money at $10,000,000. The third — the
// tournament champion prize — took the same list as an opaque JSON STRING and
// ran only `checkPrizesDeliverable(parsePrizes(...))` on it:
//
//   * `parsePrizes` is the LENIENT reader for rows that were validated on the
//     way in. It JSON.parses and casts. It checks nothing.
//   * `checkPrizesDeliverable` folds onto an empty save and asks validateSave,
//     whose only item rule is MAX_INVENTORY_STACK (999,999).
//
// So `POST /api/admin/tournaments` with
// `prizes: '[{"kind":"item","itemId":"expShare","quantity":999999}]'` was
// accepted, where the identical payload to `/admin/giveaways` or
// `/admin/mass-gift` was a 400. Measured, both before and after — see the
// "before" reproduction below, which reconstructs the old check and asserts it
// really was permissive, so this file fails if someone "simplifies" the fix by
// pointing the tournament routes back at parsePrizes.
//
// ── WHY IT MATTERS MORE THAN AN ORDINARY BOUND ───────────────────────
// A prize is delivered by the PendingGrant fold, which runs INSIDE commitSave,
// on top of the client's uploaded bytes — i.e. strictly AFTER lib/saveGainGuard
// has run. The gain guard is blind to server-issued payments by construction,
// and that blindness is correct (it is what stops the guard flagging the
// server's own money). The consequence is that the guard's restricted-item
// ceiling — ITEM_STACK_RESTRICTED, 1,000 — can never see a prize. The schema is
// the only bound a prize has, so a path that skips it has no bound at all.
//
// Nothing exploited it: production holds zero Tournament rows and every
// PendingGrant ever written is 1-50 units of an ordinary item.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  PrizeListSchema,
  parsePrizes,
  parsePrizesStrict,
  type Prize,
} from "../src/lib/giveaway.js";

const ADMIN_SRC = fs.readFileSync(
  path.resolve(__dirname, "../src/routes/admin.ts"),
  "utf8",
);

/** The payloads that separated the two regimes. */
const OVER_BOUND: Array<[string, string]> = [
  ["999,999x expShare", '[{"kind":"item","itemId":"expShare","quantity":999999}]'],
  ["999,999x masterball", '[{"kind":"item","itemId":"masterball","quantity":999999}]'],
  ["999,999x shinycharm", '[{"kind":"item","itemId":"shinycharm","quantity":999999}]'],
  ["1,000x anything (one over the item bound)", '[{"kind":"item","itemId":"nugget","quantity":1000}]'],
  ["$999,999,999", '[{"kind":"money","amount":999999999}]'],
  ["$10,000,001 (one over the money bound)", '[{"kind":"money","amount":10000001}]'],
  ["an itemId that is not a legal id", '[{"kind":"item","itemId":"../../etc; DROP TABLE","quantity":5}]'],
  ["a 41-char itemId", `[{"kind":"item","itemId":"${"a".repeat(41)}","quantity":1}]`],
  ["zero quantity", '[{"kind":"item","itemId":"nugget","quantity":0}]'],
  ["a fractional quantity", '[{"kind":"item","itemId":"nugget","quantity":1.5}]'],
  ["an unknown prize kind", '[{"kind":"admin","grant":"everything"}]'],
  ["an empty list", "[]"],
];

/** Real prize lists that have actually shipped — these must all still pass. */
const REAL_GIVEAWAY_PRIZES: string[] = [
  '[{"kind":"item","itemId":"masterball","quantity":1}]',
  '[{"kind":"item","itemId":"thunderstone","quantity":1}]',
  '[{"kind":"item","itemId":"nugget","quantity":3}]',
  '[{"kind":"item","itemId":"shinycharm","quantity":1}]',
  '[{"kind":"item","itemId":"goldbottlecap","quantity":1},{"kind":"item","itemId":"silverbottlecap","quantity":2}]',
  '[{"kind":"item","itemId":"moonstone","quantity":1},{"kind":"item","itemId":"firestone","quantity":1},'
    + '{"kind":"item","itemId":"waterstone","quantity":1},{"kind":"item","itemId":"thunderstone","quantity":1},'
    + '{"kind":"item","itemId":"leafstone","quantity":1},{"kind":"item","itemId":"sunstone","quantity":1}]',
  '[{"kind":"item","itemId":"shinycharm","quantity":1},{"kind":"item","itemId":"bignugget","quantity":3}]',
  '[{"kind":"money","amount":250000},{"kind":"item","itemId":"ultraball","quantity":50},'
    + '{"kind":"item","itemId":"masterball","quantity":1}]',
  '[{"kind":"pokemon","label":"Shiny Mew (Lv70)","mon":{"speciesKey":"mew","level":70,"isShiny":true}}]',
];

describe("prize bounds are one schema, not three", () => {
  it.each(OVER_BOUND)("refuses %s on the JSON-STRING path too", (_label, json) => {
    // The parsed path (giveaway create, mass-gift).
    expect(PrizeListSchema.safeParse(JSON.parse(json)).success).toBe(false);
    // The string path (tournament create/patch). Same verdict.
    const strict = parsePrizesStrict(json);
    expect(strict.ok).toBe(false);
  });

  it.each(REAL_GIVEAWAY_PRIZES)("still accepts a prize list that really shipped: %s", (json) => {
    expect(PrizeListSchema.safeParse(JSON.parse(json)).success).toBe(true);
    const strict = parsePrizesStrict(json);
    expect(strict.ok).toBe(true);
  });

  it("bounds the LIST length, not just each element", () => {
    // 300 items at 999,999 each fits inside the route's 20,000-char body cap.
    const many = JSON.stringify(
      Array.from({ length: 300 }, (_, i) => ({ kind: "item", itemId: `k${i}`, quantity: 999_999 })),
    );
    expect(many.length).toBeLessThan(20_000);
    expect(parsePrizesStrict(many).ok).toBe(false);
    // …and 11 perfectly legal ones are still one too many.
    const eleven = JSON.stringify(
      Array.from({ length: 11 }, (_, i) => ({ kind: "item", itemId: `k${i}`, quantity: 1 })),
    );
    expect(parsePrizesStrict(eleven).ok).toBe(false);
  });

  it("refuses a payload that is not an array at all", () => {
    for (const json of ['{"kind":"money","amount":5}', '"nope"', "5", "null", "not json"]) {
      expect(parsePrizesStrict(json).ok).toBe(false);
    }
  });

  it("returns prizes RE-NORMALISED, so nothing unchecked round-trips into the row", () => {
    const strict = parsePrizesStrict(
      '[{"kind":"item","itemId":"nugget","quantity":3,"secretAdminFlag":true}]',
    );
    expect(strict.ok).toBe(true);
    if (!strict.ok) return;
    expect(strict.prizes).toEqual([{ kind: "item", itemId: "nugget", quantity: 3 }]);
    expect(JSON.stringify(strict.prizes)).not.toContain("secretAdminFlag");
  });
});

describe("the old tournament check really was permissive", () => {
  // Reconstructs what the tournament routes used to do — parsePrizes, the
  // lenient reader — so this file states the defect rather than asserting the
  // fix against nothing. If someone routes an inbound body through parsePrizes
  // again, the contrast below is what says why that is wrong.
  it("parsePrizes waves through every payload the schema refuses", () => {
    const wavedThrough = OVER_BOUND
      .map(([label, json]) => [label, parsePrizes(json)] as const)
      // The empty list and the non-array cases are the two parsePrizes does
      // stop, and only because there is nothing to return.
      .filter(([, prizes]) => prizes.length > 0);
    expect(wavedThrough.length).toBeGreaterThanOrEqual(10);
    // Specifically: the exact shape of the koruem2 pile.
    const exp = parsePrizes('[{"kind":"item","itemId":"expShare","quantity":999999}]');
    expect(exp).toEqual([{ kind: "item", itemId: "expShare", quantity: 999_999 }]);
    expect(parsePrizesStrict('[{"kind":"item","itemId":"expShare","quantity":999999}]').ok).toBe(false);
  });
});

describe("the wiring, at the source level", () => {
  // "Exactly one schema" is a property of the file, not of any single call.
  it("routes/admin.ts declares no private prize schema of its own", () => {
    expect(ADMIN_SRC).not.toMatch(/const\s+PrizeSchema\s*=/);
    expect(ADMIN_SRC).not.toMatch(/z\.array\(\s*PrizeSchema\s*\)/);
  });

  it("every inbound prize body is gated by the shared schema", () => {
    // A ratchet, not a fact about the world: the count only has to change when
    // a new prize-taking body is added, and changing it should mean somebody
    // looked at that body and confirmed it uses the shared schema rather than
    // rolling its own bounds.
    //
    // The three: GiveawayBody, MassGiftBody, RedditConfigBody. (The referral
    // config also takes prize lists, but under `perReferral`/`milestone`/
    // `shinyPool` rather than `prizes`, so it does not match here — it is
    // covered by the no-private-schema assertion above.)
    const parsedSites = ADMIN_SRC.match(/prizes:\s*PrizeListSchema/g) ?? [];
    expect(parsedSites.length).toBe(3);
    // Tournament create + patch take the string form.
    const stringSites = ADMIN_SRC.match(/parsePrizesStrict\(/g) ?? [];
    expect(stringSites.length).toBe(2);
  });

  it("no inbound handler reaches for the lenient reader", () => {
    // parsePrizes is legitimate for READING stored rows (the giveaway list, the
    // draw). It must never be the gate on a request body again, which is what
    // `checkPrizesDeliverable(parsePrizes(<body field>))` was.
    expect(ADMIN_SRC).not.toMatch(/checkPrizesDeliverable\(\s*parsePrizes\(/);
  });
});

describe("the delivered shape is unchanged", () => {
  it("a validated list is still a Prize[] the fold understands", () => {
    // The real mass-gift payload: $250,000 + 50x ultraball + 1x masterball.
    const strict = parsePrizesStrict(REAL_GIVEAWAY_PRIZES[7]);
    expect(strict.ok).toBe(true);
    if (!strict.ok) return;
    const prizes: Prize[] = strict.prizes;
    expect(prizes.map((p) => p.kind)).toEqual(["money", "item", "item"]);
  });
});
