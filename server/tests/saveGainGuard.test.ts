// The rate-of-gain guard, proved by execution at both levels.
//
// PART 1 exercises the pure decision function against the REAL measured
// numbers from production — koruem2's actual observed jump, mangetsu's
// offline-lineage reconcile, marcos10jacaa's grind, dudsdiem's bulk Ultra Ball
// buy — so every threshold is pinned to a number somebody counted rather than
// to a number somebody liked. No database, no clock, no mocks: that is the
// whole reason the decision lives in its own module.
//
// PART 2 drives the REAL POST /api/saves handler with an in-memory fake Prisma
// (same harness shape as savesRoute.test.ts) to prove the two properties that
// only placement can give you:
//
//   * a PendingGrant fold is INVISIBLE to the guard — the fold happens after
//     the comparison, so the server's own money can never be flagged, and a
//     grant far larger than the whole allowance still lands cleanly;
//   * shadow mode STORES the flagged save and answers 200, and flipping
//     ENFORCE_GAIN_GUARD is the only thing that turns it into a refusal.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  let current: any = null;
  return {
    /** A FRESH user id per test. routes/saves.ts's saveLimiter is a real
     *  fixed-window rate limiter keyed by user id (30 uploads / 60s) and this
     *  file makes more than 30 POSTs, so a shared id turns later tests into
     *  429s. It also isolates the per-account cumulative budgets. */
    uid: "u1",
    setDb: (db: any) => { current = db; },
    prismaProxy: new Proxy({} as Record<string, unknown>, {
      get: (_t, prop) => current.client[prop],
    }),
    // Stable across vi.resetModules(), so the enforce-mode test below can
    // re-import the route and still watch the same spy.
    recordError: vi.fn(async () => {}),
    sendToUserGlobal: vi.fn(),
  };
});

vi.mock("../src/db.js", () => ({ prisma: h.prismaProxy }));
vi.mock("../src/socket.js", () => ({ sendToUserGlobal: h.sendToUserGlobal }));
vi.mock("../src/lib/errorReporting.js", () => ({ recordError: h.recordError }));
vi.mock("../src/lib/middleware.js", () => ({
  requireUser: async (c: any, next: () => Promise<void>) => {
    c.set("user", { id: h.uid, username: "koruem2", email: "", name: null, isAdmin: false });
    await next();
  },
}));

import app from "../src/routes/saves.js";
import {
  evaluateGain,
  elapsedHoursFor,
  moneyAllowanceFor,
  itemStackCeiling,
  ENFORCE_GAIN_GUARD,
  MONEY_BURST,
  MONEY_RATE_PER_HOUR,
  MONEY_ELAPSED_CAP_H,
  ITEM_RISE_LIMIT,
  ITEM_STACK_PURCHASABLE,
  ITEM_STACK_RESTRICTED,
  MIN_SHOP_UNIT_PRICE,
  VICTORY_TOKEN_RISE_LIMIT,
  VICTORY_TOKEN_CEILING,
  evaluateGainForAccount,
  shouldRefuse,
  restrictedUnits,
  RESTRICTED_ITEM_RISE_LIMIT,
  RESTRICTED_BUDGET_CAPACITY,
  RESTRICTED_BUDGET_REFILL_PER_HOUR,
  MONEY_BUDGET_CAPACITY,
  MONEY_BUDGET_REFILL_PER_HOUR,
  SHINY_CHARM_DEX_FLOOR,
} from "../src/lib/saveGainGuard.js";
import {
  resetGainBudgets,
  peekGainBudget,
  gainBudgetSize,
  GAIN_LOG_COOLDOWN_MS,
} from "../src/lib/saveGainBudget.js";

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

/** The upload cadence of an actively-playing account: CLOUD_THROTTLE_MS is
 *  2500 and the measured median is one upload per 4.9s. */
const ACTIVE_GAP = 4 * SEC;

const fields = (v: ReturnType<typeof evaluateGain>) => v.violations.map((x) => x.field);
const rules = (v: ReturnType<typeof evaluateGain>) => v.violations.map((x) => `${x.field}:${x.rule}`);

// ─────────────────────────────────────────────────────────────────────
// PART 1 — the pure decision
// ─────────────────────────────────────────────────────────────────────

describe("saveGainGuard: enforcement is PER RULE, not one global switch", () => {
  // The old shape was ENFORCE_GAIN_GUARD = false plus "flip it once the log has
  // been quiet". Both halves were broken: a fully-cheated account at rest logs
  // NOTHING (every refusing rule fires only on a raise), so "quiet" meant "the
  // cheat finished"; and one boolean forced the same decision on the rule whose
  // refusals were measured to hit 52 real accounts and the rule whose refusals
  // were measured to hit exactly one account in the whole corpus.
  it("the master switch is on", () => {
    expect(ENFORCE_GAIN_GUARD).toBe(true);
  });

  it("money:rate — the PER-UPLOAD rule — is detection only, and cannot refuse", () => {
    const v = evaluateGain({ money: 1_000 }, { money: 90_000_000 }, ACTIVE_GAP);
    expect(rules(v)).toEqual(["money:rate"]);
    expect(v.violations[0].enforce).toBe(false);
    expect(shouldRefuse(v)).toBe(false);
  });

  it("purchasable item rules are detection only — that is the class with the FP history", () => {
    const v = evaluateGain(
      { money: 5_000_000, inventory: { pokeball: 20 } },
      { money: 5_000_000, inventory: { pokeball: 26_000 } },
      ACTIVE_GAP,
    );
    expect(rules(v)).toEqual(
      expect.arrayContaining(["inventory.pokeball:rise", "inventory.pokeball:ceiling"]),
    );
    expect(v.violations.every((x) => x.enforce === false)).toBe(true);
    expect(shouldRefuse(v)).toBe(false);
  });

  it("restricted items and victoryTokens ARE enforceable — both measured FP-free", () => {
    const items = evaluateGain({ inventory: {} }, { inventory: { expShare: 100_000 } }, ACTIVE_GAP);
    expect(items.violations.every((x) => x.enforce === true)).toBe(true);
    expect(shouldRefuse(items)).toBe(true);

    const vt = evaluateGain({ victoryTokens: 4 }, { victoryTokens: 9_999 }, ACTIVE_GAP);
    expect(vt.violations.every((x) => x.enforce === true)).toBe(true);
    expect(shouldRefuse(vt)).toBe(true);
  });

  it("the STATE note sees an account that already minted its cheat and is now quiet", () => {
    // koruem2's steady state, byte-for-byte: the same blob on both sides. Every
    // rule that can refuse fires only on a RAISE, so before this note the guard
    // returned an entirely clean verdict for an account holding 100,000 Exp
    // Shares — which is exactly how it sat in the corpus unflagged.
    const held = {
      money: 100_028_732,
      victoryTokens: 5,
      inventory: { pokeball: 0, masterball: 1, expShare: 100_000, shinycharm: 1 },
      pokedexCaught: Array.from({ length: 67 }, (_, i) => `d${i}`),
    };
    const v = evaluateGain(held, held, ACTIVE_GAP);
    expect(v.violations).toEqual([]);              // still not refusable — no brick
    expect(v.notable).toEqual([]);
    expect(v.stateNotes.map((n) => n.field)).toEqual(["inventory.expShare"]);
    expect(v.stateNotes[0]).toMatchObject({ after: 100_000, allowance: ITEM_STACK_RESTRICTED });
  });
});

describe("saveGainGuard: elapsed-time arithmetic is total", () => {
  // There is no division anywhere in the module — the allowance is a
  // multiplication — but every hostile input still has to land on a finite
  // number in [0, cap] or the comparison it feeds is meaningless.
  it.each([
    ["negative (clock skew / NTP correction)", -5 * HOUR, 0],
    ["zero", 0, 0],
    ["NaN", Number.NaN, 0],
    ["-Infinity", Number.NEGATIVE_INFINITY, 0],
    ["+Infinity", Number.POSITIVE_INFINITY, MONEY_ELAPSED_CAP_H],
    ["one hour", HOUR, 1],
    ["exactly the cap", MONEY_ELAPSED_CAP_H * HOUR, MONEY_ELAPSED_CAP_H],
    ["a 25-hour gap clamps to the cap", 25 * HOUR, MONEY_ELAPSED_CAP_H],
    ["a dormant month clamps to the cap", 30 * 24 * HOUR, MONEY_ELAPSED_CAP_H],
  ])("elapsedHoursFor(%s)", (_label, ms, expected) => {
    expect(elapsedHoursFor(ms)).toBe(expected);
  });

  it("the allowance is always finite and monotonic in elapsed", () => {
    for (const ms of [Number.NaN, -1, -HOUR, 0, SEC, HOUR, 6 * HOUR, 1e15, Infinity]) {
      const a = moneyAllowanceFor(ms);
      expect(Number.isFinite(a)).toBe(true);
      expect(a).toBeGreaterThanOrEqual(MONEY_BURST);
      expect(a).toBeLessThanOrEqual(MONEY_BURST + MONEY_RATE_PER_HOUR * MONEY_ELAPSED_CAP_H);
    }
    expect(moneyAllowanceFor(0)).toBe(MONEY_BURST);
    expect(moneyAllowanceFor(HOUR)).toBe(MONEY_BURST + MONEY_RATE_PER_HOUR);
    expect(moneyAllowanceFor(999 * HOUR)).toBe(19_000_000);
  });

  it("a negative elapsed cannot flag a gain the burst floor covers", () => {
    // The dangerous shape: skew makes elapsed negative, and a naive
    // implementation either NaNs (comparison false — silent hole) or yields a
    // negative allowance (comparison true — every save refused).
    const v = evaluateGain({ money: 100_000 }, { money: 1_000_000 }, -12 * HOUR);
    expect(v.ok).toBe(true);
    expect(v.elapsedHours).toBe(0);
    expect(v.moneyAllowance).toBe(MONEY_BURST);
    expect(v.notable).toEqual([]);
  });

  it("a negative elapsed still catches a jump past the burst floor, with a sane allowance", () => {
    const v = evaluateGain({ money: 5_945 }, { money: 100_003_240 }, -12 * HOUR);
    expect(v.ok).toBe(false);
    expect(v.moneyAllowance).toBe(MONEY_BURST);
    expect(Number.isFinite(v.violations[0].allowance)).toBe(true);
  });
});

describe("saveGainGuard: no prior means no verdict", () => {
  it("a first-ever save passes, whatever it holds", () => {
    const v = evaluateGain(null, { money: 999_999_999, inventory: { expShare: 999_999 } }, 0);
    expect(v.ok).toBe(true);
    expect(v.violations).toEqual([]);
    expect(v.notable).toEqual([]);
  });

  it("an unparseable stored save (route passes null) passes — migration path", () => {
    expect(evaluateGain(null, { money: 50_000_000 }, ACTIVE_GAP).ok).toBe(true);
  });

  it("an empty prior object still reads absent balances as 0, not as 'skip'", () => {
    // The two-step bypass: upload with `money` deleted, then upload $500M
    // against a prior the guard declined to read. destructiveLosses SKIPS a
    // non-numeric prior; this must not.
    const v = evaluateGain({}, { money: 500_000_000 }, ACTIVE_GAP);
    expect(v.ok).toBe(false);
    expect(v.violations[0]).toMatchObject({ field: "money", rule: "rate", before: 0 });
  });
});

describe("saveGainGuard: legitimate play passes", () => {
  it("marcos10jacaa, the fastest grinder measured: $2,230/upload at 4s spacing", () => {
    // $1,005,549 in one 30-minute window = $2.01M/h, across 451 uploads.
    const v = evaluateGain({ money: 500_000 }, { money: 502_230 }, ACTIVE_GAP);
    expect(v.ok).toBe(true);
    expect(v.notable).toEqual([]);
    // The margin the measurement claims: ~450×.
    expect(v.moneyAllowance / 2_230).toBeGreaterThan(400);
  });

  it("piui, 11 consecutive windows at $946k–985k/h: ~$1,100/upload", () => {
    expect(evaluateGain({ money: 12_000_000 }, { money: 12_001_100 }, ACTIVE_GAP).ok).toBe(true);
  });

  it("tokyofuck, the $112M stream bot: +$350,468 across 472 uploads", () => {
    const perUpload = Math.ceil(350_468 / 472);
    expect(evaluateGain({ money: 112_000_000 }, { money: 112_000_000 + perUpload }, ACTIVE_GAP).ok).toBe(true);
  });

  it("a $105M whale idling: a huge BALANCE is never the question, only the DELTA", () => {
    const v = evaluateGain({ money: 105_000_000 }, { money: 105_000_000 }, ACTIVE_GAP);
    expect(v.ok).toBe(true);
    expect(v.notable).toEqual([]);
  });

  it("the pre-throttle-fix cohort: someboaty at $91k/upload, hours apart", () => {
    expect(evaluateGain({ money: 900_000 }, { money: 991_000 }, 3 * HOUR).ok).toBe(true);
  });

  it("spending money is never a gain", () => {
    const v = evaluateGain({ money: 6_645_659 }, { money: 38_435 }, ACTIVE_GAP);
    expect(v.ok).toBe(true);
  });
});

describe("saveGainGuard: the offline-lineage reconcile — the case a flat cap breaks", () => {
  // saveReconcile.ts picks SPENDABLE state from ONE lineage whole, so a player
  // who played for hours while uploads were failing uploads the entire
  // accumulated wallet in a single POST after a reload. mangetsu does this
  // repeatedly; it is the largest legitimate single-upload increase measured.
  it("mangetsu +$612,329 in one upload after a 25.2-hour gap", () => {
    const v = evaluateGain({ money: 378_909 }, { money: 991_238 }, 25.2 * HOUR);
    expect(v.ok).toBe(true);
    expect(v.elapsedHours).toBe(MONEY_ELAPSED_CAP_H); // clamped, not 25h of allowance
    expect(v.moneyAllowance).toBe(19_000_000);        // ~31× the actual jump
    expect(v.notable).toEqual([]);                    // still under the $1M burst floor
  });

  it("the measured upper bound on that shape, $669,277, passes at ZERO elapsed", () => {
    // The burst floor exists precisely so this passes without any help from
    // the rate term. If it only passed because of elapsed, a clock problem
    // would start refusing whales.
    const v = evaluateGain({ money: 321_961 }, { money: 321_961 + 669_277 }, 0);
    expect(v.ok).toBe(true);
    expect(v.moneyAllowance).toBe(MONEY_BURST);
  });

  it("mangetsu's smaller reconciles: +$118,322 after 526min, +$106,020 after 72min", () => {
    expect(evaluateGain({ money: 400_000 }, { money: 518_322 }, 526 * MIN).ok).toBe(true);
    expect(evaluateGain({ money: 400_000 }, { money: 506_020 }, 72 * MIN).ok).toBe(true);
  });
});

describe("saveGainGuard: the largest legitimate windfall measured — a $10M auction", () => {
  // gustavokletke sold for $10,000,000 (settled 2026-07-29 11:51:42), the
  // largest legitimate increase by ANY path. lib/auctionSettlement.ts writes
  // the seller's row itself, so the stored blob already holds it and the
  // client's next upload carries a delta of ~0. Both halves are proved: the
  // shape the route actually sees, and the shape it would see if the client
  // somehow carried the windfall itself.
  it("the shape the route sees: settlement already banked it, delta ~0", () => {
    const v = evaluateGain({ money: 10_000_093 }, { money: 10_000_093 }, ACTIVE_GAP);
    expect(v.ok).toBe(true);
    expect(v.notable).toEqual([]);
  });

  it("and even carried by the client, +$10,000,000 fits inside a 6h allowance", () => {
    const v = evaluateGain({ money: 93 }, { money: 10_000_093 }, 6 * HOUR);
    expect(v.ok).toBe(true);
    expect(v.moneyAllowance).toBe(19_000_000);
    // Accepted only because of the elapsed term → Part C records it for a
    // human, and refuses nothing.
    expect(v.notable).toEqual([
      { field: "money", before: 93, after: 10_000_093, delta: 10_000_000, allowance: 19_000_000 },
    ]);
  });

  it("dudsdiem's $5,000,262 settlement echo, and zbeater94's $5M, both pass", () => {
    expect(evaluateGain({ money: 5_048_758 }, { money: 5_048_758 }, ACTIVE_GAP).ok).toBe(true);
    expect(evaluateGain({ money: 5_000_000 }, { money: 5_000_100 }, ACTIVE_GAP).ok).toBe(true);
  });
});

describe("saveGainGuard: grant-shaped credits are covered by the burst floor alone", () => {
  // These are structurally invisible (the fold runs after the comparison —
  // proved by execution in Part 2), but the floor clears them anyway so that
  // an echo, a retry, or any future path that DOES route one through an
  // upload still cannot trip the guard.
  it.each([
    ["largest mass-gift money prize ever enqueued", 250_000],
    ["Diamond-tier PvP win bonus", 200_000],
    ["away-progress hard cap (8h × $16/h)", 54_400],
    ["largest away payout actually paid", 19_541],
  ])("%s: +$%d at zero elapsed", (_label, amount) => {
    const v = evaluateGain({ money: 1_000 }, { money: 1_000 + amount }, 0);
    expect(v.ok).toBe(true);
    expect(v.notable).toEqual([]);
  });
});

describe("saveGainGuard: koruem2 — the confirmed abuse", () => {
  // Pinned to its own SaveSnapshot ring:
  //   saveVersion 8259 @ 17:07:05 — money $5,945, no `expShare` key, vt 2
  //   saveVersion 8689 @ 17:37:06 — money $100,003,240, expShare 100,000, vt 4
  // 430 uploads in that 30-minute window, so elapsed at the offending POST
  // was a few seconds.
  const prior = { money: 5_945, victoryTokens: 2, inventory: { pokeball: 12, ultraball: 3 } };
  const next = {
    money: 100_003_240,
    victoryTokens: 4,
    inventory: { pokeball: 12, ultraball: 3, expShare: 100_000 },
  };

  it("the money is refused by ~100×", () => {
    const v = evaluateGain(prior, next, ACTIVE_GAP);
    expect(v.ok).toBe(false);
    const money = v.violations.find((x) => x.field === "money")!;
    expect(money).toMatchObject({ rule: "rate", before: 5_945, after: 100_003_240 });
    // Allowance ≈ $1,003,333 against a gain of ≈ $99,997,295.
    expect(Math.round(v.moneyAllowance)).toBe(1_003_333);
    expect(money.delta).toBe(99_997_295);
    expect(money.delta / money.allowance).toBeGreaterThan(99);
  });

  it("the 100,000 Exp Shares fail the reward-only ceiling by 100× AND the rise cap by 4,000×", () => {
    const v = evaluateGain(prior, next, ACTIVE_GAP);
    expect(rules(v)).toEqual(
      expect.arrayContaining(["inventory.expShare:rise", "inventory.expShare:ceiling"]),
    );
    const ceiling = v.violations.find((x) => x.field === "inventory.expShare" && x.rule === "ceiling")!;
    expect(ceiling.allowance).toBe(ITEM_STACK_RESTRICTED);
    expect(ceiling.after / ceiling.allowance).toBe(100);
    const rise = v.violations.find((x) => x.field === "inventory.expShare" && x.rule === "rise")!;
    expect(rise.before).toBe(0); // the key did not exist in the prior save
    // A reward-only key gets RESTRICTED_ITEM_RISE_LIMIT, not the purchasable
    // ITEM_RISE_LIMIT it used to share. Before that, a rise of 0 → 100 passed
    // every rule in this module and the whole restricted class rested on the
    // absolute ceiling alone.
    expect(rise.allowance).toBe(RESTRICTED_ITEM_RISE_LIMIT);
    expect(rise.delta / RESTRICTED_ITEM_RISE_LIMIT).toBe(4_000);
  });

  it("a BRAND-NEW inventory key is caught — the shape a keyed diff misses", () => {
    // The first-pass production query partitioned by (userId, item) and
    // silently dropped this event because there was no previous value to lag
    // against. Iterating `next` with absent-reads-as-0 is what fixes it.
    const v = evaluateGain({ inventory: {} }, { inventory: { expShare: 100_000 } }, ACTIVE_GAP);
    expect(v.ok).toBe(false);
    expect(fields(v)).toEqual(["inventory.expShare", "inventory.expShare"]);
  });

  it("either half alone is enough — the item guard needs no clock and no history", () => {
    expect(evaluateGain(prior, { ...next, money: prior.money }, ACTIVE_GAP).ok).toBe(false);
    expect(evaluateGain(prior, { ...next, inventory: prior.inventory }, ACTIVE_GAP).ok).toBe(false);
  });
});

describe("saveGainGuard: items", () => {
  it("dudsdiem's real bulk buy — +3,732 Ultra Balls to 5,825 — passes both bounds", () => {
    // The same snapshot pair shows money falling $6,645,659 → $38,435: a shop
    // purchase at $1,200 each. Largest legitimate per-item rise in the corpus.
    const v = evaluateGain(
      { money: 6_645_659, inventory: { ultraball: 2_093 } },
      { money: 38_435, inventory: { ultraball: 5_825 } },
      30 * MIN,
    );
    expect(v.ok).toBe(true);
  });

  it.each([
    ["parker's ultraball holding", "ultraball", 4_459],
    ["vilmar31ps's ultraball holding", "ultraball", 3_037],
    ["the largest pokeball stack in the game", "pokeball", 1_818],
    ["sak4i's maxrepel", "maxrepel", 900],
    ["the largest linkcable holding", "linkcable", 19],
  ])("%s (%s × %d) passes", (_label, item, qty) => {
    expect(evaluateGain({ inventory: {} }, { inventory: { [item]: qty } }, ACTIVE_GAP).ok).toBe(true);
  });

  // The real acquisition shape, which is what the rise limit has to clear: these
  // arrive from raids and gifts a unit or four at a time, and the largest rise of
  // ANY restricted key in any 30-minute window across every consecutive snapshot
  // pair in production is +4 (silverbottlecap, nicolaswalter555). So the account
  // holding 35 silverbottlecaps got there one drop at a time, and the upload that
  // has to pass is 34 → 35 — not 0 → 35, which is a shape no player produces.
  it.each([
    ["masterball", 9, 1],
    ["silverbottlecap", 35, 4],
    ["goldbottlecap", 10, 2],
    ["nugget", 3, 3],
    ["expShare", 6, 1],
  ])("the largest legitimate reward-only holding (%s × %d, arriving +%d) passes", (item, qty, step) => {
    const v = evaluateGain(
      { inventory: { [item]: qty - step } },
      { inventory: { [item]: qty } },
      ACTIVE_GAP,
    );
    expect(v.violations).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it("silverbottlecap crossing the OLD ceiling of 100 is no longer a refusal", () => {
    // The latent false positive this raised the ceiling for: koruem holds 35 and
    // accumulates ~3.5/day, so a ceiling of 100 was about a month from turning a
    // legitimate raid drop into a 400 that stops the session's uploads.
    expect(evaluateGain(
      { inventory: { silverbottlecap: 100 } },
      { inventory: { silverbottlecap: 101 } },
      ACTIVE_GAP,
    ).ok).toBe(true);
    // …and the backstop is still a backstop.
    expect(evaluateGain(
      { inventory: { silverbottlecap: ITEM_STACK_RESTRICTED } },
      { inventory: { silverbottlecap: ITEM_STACK_RESTRICTED + 1 } },
      ACTIVE_GAP,
    ).ok).toBe(false);
  });

  describe("the Shiny Charm — the reward no quantity rule can see", () => {
    // `shinycharm: 1` is under every limit in the module, and the charm DOUBLES
    // the account-wide shiny rate. game/src/utils/shinyCharm.ts grants it from
    // one place and only on a complete obtainable Pokédex. Measured: 23
    // production accounts hold it; 22 have 250–288 dex entries; the 23rd is
    // koruem2 with 67, and its ring shows the charm arriving as `shinycharm: 10`
    // in the same window as the $100M.
    const dex = (n: number) => Array.from({ length: n }, (_, i) => `d${i}`);

    it("a real holder acquiring it on a complete dex passes", () => {
      const v = evaluateGain(
        { inventory: {}, pokedexCaught: dex(288) },
        { inventory: { shinycharm: 1 }, pokedexCaught: dex(288) },
        ACTIVE_GAP,
      );
      expect(v.violations).toEqual([]);
    });

    it("willielucio2016's REAL arrival at 167 entries passes — the FP a floor of 200 caused", () => {
      // Found by replaying every consecutive snapshot pair in production against
      // this rule. The charm arrived for willielucio2016 at 2026-07-24T18:35 with
      // pokedexCaught.length === 167 and climbed to 247 only afterwards, because
      // completion is "every species in the OBTAINABLE set"
      // (game/src/utils/obtainable.ts), not a count — 167 was the whole
      // obtainable set at that moment. A floor of 200 refused it.
      expect(SHINY_CHARM_DEX_FLOOR).toBe(100);
      for (const n of [167, 246, 250, 288]) {
        expect(evaluateGain(
          { inventory: {}, pokedexCaught: dex(n) },
          { inventory: { shinycharm: 1 }, pokedexCaught: dex(n) },
          ACTIVE_GAP,
        ).ok).toBe(true);
      }
    });

    it("koruem2's charm on 67 dex entries is refused, and the refusal is enforceable", () => {
      const v = evaluateGain(
        { inventory: { masterball: 1 }, pokedexCaught: dex(67) },
        { inventory: { masterball: 1, shinycharm: 1 }, pokedexCaught: dex(67) },
        ACTIVE_GAP,
      );
      expect(rules(v)).toEqual(["inventory.shinycharm:unearned"]);
      expect(v.violations[0].enforce).toBe(true);
      expect(shouldRefuse(v)).toBe(true);
    });

    it("an EXISTING holder is never re-judged, whatever its blob says about its dex", () => {
      // The anti-brick rule: this fires only when the charm ARRIVES. A holder
      // whose stored dex list is short (an older client, a truncated blob) must
      // keep saving forever.
      expect(evaluateGain(
        { inventory: { shinycharm: 1 }, pokedexCaught: dex(3) },
        { inventory: { shinycharm: 1 }, pokedexCaught: dex(3) },
        ACTIVE_GAP,
      ).ok).toBe(true);
    });
  });

  it("classifies reward-only vs purchasable off the game's own catalog", () => {
    for (const id of ["masterball", "shinycharm", "goldbottlecap", "nugget", "hm03", "pokeflute", "expShare"]) {
      expect(itemStackCeiling(id)).toBe(ITEM_STACK_RESTRICTED);
    }
    for (const id of ["pokeball", "ultraball", "maxrepel", "honey", "leftovers", "linkcable", "moonstone"]) {
      expect(itemStackCeiling(id)).toBe(ITEM_STACK_PURCHASABLE);
    }
    // An id this list has never heard of gets the LOOSE ceiling: new game
    // content ships in the client's catalog, and refusing an unknown id would
    // brick the next content deploy. An invented id is inert anyway.
    expect(itemStackCeiling("someFutureBerry")).toBe(ITEM_STACK_PURCHASABLE);
  });

  it("a purchasable item past its own ceiling is still caught", () => {
    const v = evaluateGain({ inventory: { pokeball: 20 } }, { inventory: { pokeball: 26_000 } }, ACTIVE_GAP);
    expect(rules(v)).toEqual(
      expect.arrayContaining(["inventory.pokeball:rise", "inventory.pokeball:ceiling"]),
    );
  });

  it("an account ALREADY over a ceiling can still save — it just cannot climb", () => {
    // Enforcing an absolute bound against a value already in the row would
    // refuse every future upload from that account, forever. That is the
    // MAX_BOX=600 outage repeated. Freezing the stack so it can only go DOWN
    // gets the anti-accumulation property without the brick — and it also
    // stops one compromised account writing a log row on all 430 of its
    // uploads per half hour.
    const over = { inventory: { expShare: 100_000 } };
    expect(evaluateGain(over, { inventory: { expShare: 100_000 } }, ACTIVE_GAP).ok).toBe(true);
    expect(evaluateGain(over, { inventory: { expShare: 99_999 } }, ACTIVE_GAP).ok).toBe(true);
    expect(evaluateGain(over, { inventory: { expShare: 0 } }, ACTIVE_GAP).ok).toBe(true);
    // …but one more is refused.
    expect(evaluateGain(over, { inventory: { expShare: 100_001 } }, ACTIVE_GAP).ok).toBe(false);
  });

  it("using items up is never a gain, and a removed key is not a violation", () => {
    const v = evaluateGain({ inventory: { pokeball: 500, honey: 20 } }, { inventory: { pokeball: 3 } }, ACTIVE_GAP);
    expect(v.ok).toBe(true);
  });

  it("a non-object / array inventory cannot throw", () => {
    expect(evaluateGain({ inventory: 7 }, { inventory: [1, 2, 3] }, ACTIVE_GAP).ok).toBe(true);
    expect(evaluateGain({ inventory: null }, { inventory: { pokeball: "many" } }, ACTIVE_GAP).ok).toBe(true);
  });
});

describe("saveGainGuard: THE MART'S \"Max\" BUTTON — the measured false positive", () => {
  // FALSE POSITIVE, found by replaying evaluateGain over all 2,309 production
  // saves and applying the reducer's own BUY_ITEM arithmetic: 52 legitimate
  // accounts were refused, on BOTH the rise and the ceiling rule, for one click
  // of a button the shipping UI offers them.
  //
  //   game/src/components/BottomTabs.tsx:163
  //     const maxAffordable = Math.max(1, Math.floor(state.money / resolved.price));
  //   game/src/components/BottomTabs.tsx:258   ← "Buy as many as you can afford"
  //     onClick={() => setPending({ itemId: entry.itemId, qty: maxAffordable })}
  //   game/src/state/reducer.ts:1262-1268      ← no clamp on the stack either
  //
  // Cheapest mart item is honey at $100, so the reachable stack is wallet/100 —
  // and validateSave happily stores it, since MAX_INVENTORY_STACK is 999,999.
  // The observed 5,803-Ultra-Ball maximum bounds what players have BOUGHT, not
  // what one upload can carry.
  //
  // The fix is that a purchase is not a gain: an item rise is explained when
  // the wallet fell by at least MIN_SHOP_UNIT_PRICE per unit. These pin it with
  // the real wallets, so the regression cannot come back quietly.
  const maxBuy = (money: number, itemId: string, price: number) => {
    const qty = Math.max(1, Math.floor(money / price));
    return {
      qty,
      prior: { money, inventory: {} as Record<string, number> },
      next: { money: money - price * qty, inventory: { [itemId]: qty } },
    };
  };

  const WHALES: [string, number][] = [
    ["tokyofuck", 112_584_081],
    ["phoenix", 106_901_690],
    ["drwhy", 67_016_484],
    ["parker", 42_259_238],
    ["ma62087", 29_578_440],
    ["gustavokletke", 11_574_130],
    // The thinnest real wallet that still trips the old rise limit: $1,000,100
    // of honey is 10,001 units.
    ["the marginal case", 1_000_100],
  ];

  for (const [who, money] of WHALES) {
    for (const [itemId, price] of [["honey", 100], ["pokeball", 200], ["ultraball", 1200]] as const) {
      it(`${who} ($${money.toLocaleString()}) can press Max on ${itemId}`, () => {
        const { prior, next } = maxBuy(money, itemId, price);
        const v = evaluateGain(prior, next, ACTIVE_GAP);
        expect(v.violations).toEqual([]);
        expect(v.ok).toBe(true);
      });
    }
  }

  it("$100 is the floor price of anything any shop sells", () => {
    // itemsCatalog honey=100 (and the catalog wins in BUY_ITEM's price
    // resolution); pokeballs.ts min 200; consumables.ts min 500; stones 2100.
    expect(MIN_SHOP_UNIT_PRICE).toBe(100);
  });

  it("dudsdiem's real bulk buy — the one production purchase big enough to see", () => {
    // money 6,645,659 -> 38,435 while ultraball went 2,093 -> 5,825.
    const v = evaluateGain(
      { money: 6_645_659, inventory: { ultraball: 2_093 } },
      { money: 38_435, inventory: { ultraball: 5_825 } },
      ACTIVE_GAP,
    );
    expect(v.ok).toBe(true);
  });

  it("a stack that appeared for FREE is still refused — the exemption needs a receipt", () => {
    // Same 26,000 Poké Balls, but the wallet did not move. Nothing paid for
    // them, so both rules still fire. This is the case the ceiling exists for.
    const v = evaluateGain(
      { money: 5_000_000, inventory: { pokeball: 20 } },
      { money: 5_000_000, inventory: { pokeball: 26_000 } },
      ACTIVE_GAP,
    );
    expect(rules(v)).toEqual(
      expect.arrayContaining(["inventory.pokeball:rise", "inventory.pokeball:ceiling"]),
    );
  });

  it("the free allowance degenerates to ITEM_RISE_LIMIT, so nothing got looser", () => {
    // With no money spent the exemption is `d <= moneyAllowance / 100`, which at
    // an ordinary upload interval is ~10,083 — i.e. the limit it replaces. One
    // unit either side of it proves the boundary is where it looks.
    const free = (d: number) => evaluateGain(
      { money: 9_000_000, inventory: { pokeball: 0 } },
      { money: 9_000_000, inventory: { pokeball: d } },
      ACTIVE_GAP,
    );
    expect(free(ITEM_RISE_LIMIT).ok).toBe(true);
    expect(free(Math.floor(moneyAllowanceFor(ACTIVE_GAP) / MIN_SHOP_UNIT_PRICE) + 1).ok).toBe(false);
  });

  it("a RESTRICTED item is exempt from the exemption — no shop sells it", () => {
    // koruem2's shape, with money DELIBERATELY falling far enough to "pay" for
    // 100,000 Exp Shares at the floor price. It must still be refused: the item
    // is unpurchasable, so a wallet movement can never account for it.
    const v = evaluateGain(
      { money: 50_000_000, inventory: {} },
      { money: 10_000_000, inventory: { expShare: 100_000 } },
      ACTIVE_GAP,
    );
    expect(rules(v)).toEqual(
      expect.arrayContaining(["inventory.expShare:rise", "inventory.expShare:ceiling"]),
    );
    // …and the same is true of every other reward-only id.
    for (const id of ["masterball", "shinycharm", "goldbottlecap", "silverbottlecap", "nugget"]) {
      const w = evaluateGain(
        { money: 90_000_000, inventory: {} },
        { money: 1_000, inventory: { [id]: 50_000 } },
        ACTIVE_GAP,
      );
      expect(w.ok).toBe(false);
      expect(itemStackCeiling(id)).toBe(ITEM_STACK_RESTRICTED);
    }
  });

  it("koruem2's real upload is untouched by the exemption — its money ROSE", () => {
    const v = evaluateGain(
      { money: 5_945, inventory: { pokeball: 12, ultraball: 3 } },
      { money: 100_003_240, inventory: { pokeball: 12, ultraball: 3, expShare: 100_000 } },
      ACTIVE_GAP,
    );
    expect(rules(v)).toEqual(
      expect.arrayContaining(["money:rate", "inventory.expShare:rise", "inventory.expShare:ceiling"]),
    );
  });
});

describe("saveGainGuard: victoryTokens — the field validateSave does not bound at all", () => {
  it("the largest legitimate rise in the game (+7) passes", () => {
    expect(evaluateGain({ victoryTokens: 27 }, { victoryTokens: 34 }, 30 * MIN).ok).toBe(true);
  });

  it("koruem2's 2 → 4 in the same window is under the rise cap on its own", () => {
    expect(evaluateGain({ victoryTokens: 2 }, { victoryTokens: 4 }, ACTIVE_GAP).ok).toBe(true);
  });

  it("a minted pile of tokens is refused on both the rise and the ceiling", () => {
    const v = evaluateGain({ victoryTokens: 4 }, { victoryTokens: 9_999 }, ACTIVE_GAP);
    expect(rules(v)).toEqual(
      expect.arrayContaining(["victoryTokens:rise", "victoryTokens:ceiling"]),
    );
    expect(v.violations.find((x) => x.rule === "rise")!.allowance).toBe(VICTORY_TOKEN_RISE_LIMIT);
    expect(v.violations.find((x) => x.rule === "ceiling")!.allowance).toBe(VICTORY_TOKEN_CEILING);
  });

  it("spending tokens in the reward shop is never a gain", () => {
    expect(evaluateGain({ victoryTokens: 30 }, { victoryTokens: 1 }, ACTIVE_GAP).ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// PART 2 — through the real route
// ─────────────────────────────────────────────────────────────────────

interface GrantRow {
  id: string; userId: string; prizes: string; summary: string;
  attempts: number; deliveredAt: Date | null; deliveredSaveVersion?: number;
  lastError?: string; createdAt: Date;
}

/** Trimmed from savesRoute.test.ts — exactly the Prisma surface POST
 *  /api/saves and the libs it calls touch, plus a settable `saveUpdatedAt` so
 *  a test can dictate the elapsed time the guard measures. */
class FakeDb {
  user: {
    id: string; saveVersion: number; saveAdoptSeq: number; saveData: string | null;
    saveUpdatedAt: Date; accountLevel: number; totalCaughtLevels: number; pokedexCaughtCount: number;
  };
  grants: GrantRow[] = [];
  client: any;

  constructor(saveData: Record<string, unknown> | null, saveVersion = 8259, saveAdoptSeq = 0) {
    this.user = {
      id: h.uid, saveVersion, saveAdoptSeq,
      saveData: saveData === null ? null : JSON.stringify(saveData),
      saveUpdatedAt: new Date(Date.now() - ACTIVE_GAP),
      accountLevel: 0, totalCaughtLevels: 0, pokedexCaughtCount: 0,
    };
    this.client = this.makeClient();
  }

  save(): Record<string, unknown> {
    return JSON.parse(this.user.saveData ?? "{}");
  }

  addGrant(id: string, prizes: unknown[]): void {
    this.grants.push({
      id, userId: h.uid, prizes: JSON.stringify(prizes), summary: "prize",
      attempts: 0, deliveredAt: null, createdAt: new Date(this.grants.length),
    });
  }

  private pick(row: Record<string, unknown>, select?: Record<string, boolean>) {
    if (!select) return { ...row };
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(select)) if (select[k]) out[k] = row[k];
    return out;
  }

  private makeClient(): any {
    const db = this;
    return {
      user: {
        findUnique: async ({ where, select }: any) => {
          if (where.id !== db.user.id) return null;
          return db.pick({ ...db.user }, select);
        },
        update: async ({ where, data, select }: any) => {
          const miss =
            where.id !== db.user.id ||
            (where.saveVersion !== undefined && where.saveVersion !== db.user.saveVersion);
          if (miss) {
            const e: any = new Error("Record to update not found.");
            e.code = "P2025";
            throw e;
          }
          if (data.saveData !== undefined) db.user.saveData = data.saveData;
          if (data.saveVersion?.increment) db.user.saveVersion += data.saveVersion.increment;
          if (data.saveAdoptSeq?.increment) db.user.saveAdoptSeq += data.saveAdoptSeq.increment;
          if (data.saveUpdatedAt) db.user.saveUpdatedAt = data.saveUpdatedAt;
          for (const k of ["accountLevel", "totalCaughtLevels", "pokedexCaughtCount"] as const) {
            if (data[k] !== undefined) db.user[k] = data[k];
          }
          return db.pick({ ...db.user }, select);
        },
      },
      pendingGrant: {
        findMany: async ({ where, take, select }: any) => {
          let rows = db.grants.filter(
            (g) => g.userId === where.userId && (where.deliveredAt === null ? g.deliveredAt === null : true),
          );
          rows = [...rows].sort((a, b) =>
            a.attempts - b.attempts || a.createdAt.getTime() - b.createdAt.getTime());
          if (take) rows = rows.slice(0, take);
          return rows.map((r) => db.pick(r as never, select));
        },
        updateMany: async ({ where, data }: any) => {
          const ids: string[] | null = where.id?.in ?? (typeof where.id === "string" ? [where.id] : null);
          let count = 0;
          for (const g of db.grants) {
            if (ids && !ids.includes(g.id)) continue;
            if (where.deliveredAt === null && g.deliveredAt !== null) continue;
            if (where.attempts?.lt !== undefined && !(g.attempts < where.attempts.lt)) continue;
            count += 1;
            if (data.deliveredAt) g.deliveredAt = data.deliveredAt;
            if (data.deliveredSaveVersion !== undefined) g.deliveredSaveVersion = data.deliveredSaveVersion;
            if (data.attempts?.increment) g.attempts += data.attempts.increment;
            if (data.lastError !== undefined) g.lastError = data.lastError;
          }
          return { count };
        },
        count: async ({ where }: any) =>
          db.grants.filter((g) => g.userId === where.userId && g.deliveredAt === null).length,
      },
      saveSnapshot: {
        findFirst: async () => ({ createdAt: new Date() }),
        create: async () => ({}),
        findMany: async () => [],
        deleteMany: async () => ({ count: 0 }),
      },
      $executeRaw: async () => 1,
      $transaction: async (fn: (tx: any) => Promise<unknown>) => {
        const userSnap = { ...db.user };
        const grantsSnap = db.grants.map((g) => ({ ...g }));
        try {
          return await fn(db.client);
        } catch (e) {
          db.user = userSnap;
          db.grants = grantsSnap;
          throw e;
        }
      },
    };
  }
}

let db: FakeDb;

/** koruem2 at saveVersion 8259: a modest early-mid account. */
const koruem2Prior = () => ({
  money: 5_945,
  victoryTokens: 2,
  inventory: { pokeball: 12, ultraball: 3 },
  party: [],
  box: [],
  defeatedGyms: ["g1", "g2", "g3", "g4", "g5"],
  pokedexCaught: Array.from({ length: 67 }, (_, i) => `dex${i}`),
});

let testCounter = 0;

beforeEach(() => {
  h.uid = `u${++testCounter}`;
  db = new FakeDb(koruem2Prior());
  h.setDb(db);
  h.recordError.mockClear();
  h.sendToUserGlobal.mockClear();
  // The cumulative budgets and the log throttle are per-account PROCESS state
  // (see lib/saveGainBudget.ts). Without this, one test's charge is another
  // test's refusal.
  resetGainBudgets();
});

async function post(
  body: Record<string, unknown>,
  target = app,
): Promise<{ status: number; json: any }> {
  const res = await target.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

const logged = (message: string) =>
  h.recordError.mock.calls.map((c: any[]) => c[0]).filter((e: any) => e?.message === message);

describe("POST /api/saves + gain guard: through the real handler", () => {
  it("refuses koruem2's actual upload, stores NOTHING, and records it as an error", async () => {
    const { status, json } = await post({
      saveData: {
        ...koruem2Prior(),
        money: 100_003_240,
        victoryTokens: 4,
        inventory: { pokeball: 12, ultraball: 3, expShare: 100_000 },
      },
      expectedSaveVersion: 8259,
    });

    expect(status).toBe(400);
    expect(json.error).toBe("gain_implausible");
    // Nothing moved. The player's own bytes are still in their localStorage.
    expect(db.save().money).toBe(5_945);
    expect(db.user.saveVersion).toBe(8259);
    expect(db.user.saveAdoptSeq).toBe(0);

    const rows = logged("save_gain_implausible");
    expect(rows).toHaveLength(1);
    expect(rows[0].level).toBe("error");
    expect(rows[0].source).toBe("POST /api/saves");
    expect(rows[0].userId).toBe(db.user.id);
    expect(rows[0].username).toBe("koruem2");
    expect(rows[0].meta.enforced).toBe(true);
    expect(rows[0].meta.blind).toBe(false);
    expect(rows[0].meta.firstSave).toBe(false);
    expect(rows[0].meta.saveVersion).toBe(8259);
    // Elapsed is real wall-clock here (the fake row's saveUpdatedAt is ~4s
    // old), so the allowance is ≈$1,003,333 plus however long the test took —
    // pin the magnitude, not the millisecond.
    expect(rows[0].meta.moneyAllowance).toBeGreaterThan(1_003_000);
    expect(rows[0].meta.moneyAllowance).toBeLessThan(1_010_000);
    expect(rows[0].meta.violations.map((v: any) => `${v.field}:${v.rule}`)).toEqual(
      expect.arrayContaining([
        "money:rate", "money:cumulative",
        "inventory.expShare:rise", "inventory.expShare:ceiling",
        "inventory.restricted:cumulative",
      ]),
    );
    // The BODY carries only the enforceable ones, so a triage reader is not
    // told a detection-only rule refused their save.
    expect(json.violations.every((v: any) => v.enforce === true)).toBe(true);
  });

  it("an ordinary grind upload is accepted and logs nothing at all", async () => {
    const { status } = await post({
      saveData: { ...koruem2Prior(), money: 8_175 },
      expectedSaveVersion: 8259,
    });
    expect(status).toBe(200);
    expect(db.save().money).toBe(8_175);
    expect(h.recordError).not.toHaveBeenCalled();
  });

  it("catches a BLIND write too — 'omit the version' is not a bypass", async () => {
    // 2c only looks at what an upload DESTROYS; inflated money ADDS, so
    // destructiveLosses waves it through and only this guard sees it.
    const { status } = await post({
      saveData: { ...koruem2Prior(), money: 90_000_000 },
    });
    expect(status).toBe(400);
    expect(db.save().money).toBe(5_945);
    const rows = logged("save_gain_implausible");
    expect(rows).toHaveLength(1);
    expect(rows[0].meta.blind).toBe(true);
  });

  it("a first-ever save carrying MAX_MONEY is RECORDED — it used to be invisible", async () => {
    // routes/saves.ts gated steps 2b/2c/2d together on `existing?.saveData`, so
    // the guard did not run at all when there was no stored prior. Measured
    // through this handler before the fix: 200 OK, every value stored verbatim,
    // zero rows. Registration is open, so that was the cheapest path to
    // arbitrary money and it needed no drip at all.
    db = new FakeDb(null, 0, 0);
    h.setDb(db);
    resetGainBudgets();
    const { status } = await post({
      saveData: {
        money: 999_999_999,
        victoryTokens: 999_999,
        inventory: { masterball: 999_999, expShare: 999_999 },
        party: [], box: [],
      },
      expectedSaveVersion: 0,
    });
    // DETECTION, not refusal: a first upload legitimately carries an established
    // localStorage save, and there is nothing to compare it against.
    expect(status).toBe(200);
    const rows = logged("save_gain_implausible");
    expect(rows).toHaveLength(1);
    expect(rows[0].level).toBe("warn");
    expect(rows[0].meta.enforced).toBe(false);
    expect(rows[0].meta.firstSave).toBe(true);
    expect(rows[0].meta.violations.map((v: any) => `${v.field}:${v.rule}`)).toEqual(
      expect.arrayContaining([
        "money:rate", "money:cumulative",
        "victoryTokens:rise", "victoryTokens:ceiling",
        "inventory.expShare:rise", "inventory.expShare:ceiling",
        "inventory.masterball:rise", "inventory.masterball:ceiling",
        "inventory.restricted:cumulative",
      ]),
    );
    expect(rows[0].meta.violations.every((v: any) => v.enforce === false)).toBe(true);
  });

  it("an ORDINARY first save — a brand-new account's $3,000 — logs nothing", async () => {
    db = new FakeDb(null, 0, 0);
    h.setDb(db);
    resetGainBudgets();
    const { status } = await post({
      saveData: { money: 3_000, inventory: { pokeball: 5 }, party: [], box: [] },
      expectedSaveVersion: 0,
    });
    expect(status).toBe(200);
    expect(h.recordError).not.toHaveBeenCalled();
  });

  it("an unparseable stored blob is never REFUSED (migration / corruption path)", async () => {
    db.user.saveData = "{not json";
    const { status } = await post({
      saveData: { ...koruem2Prior(), money: 100_000_000 },
      expectedSaveVersion: 8259,
    });
    // Accepted — the corruption path must not start refusing saves — but it is
    // no longer silent, and it is treated exactly like a first-ever save because
    // that is what it is: there is nothing to compare against.
    expect(status).toBe(200);
    expect(db.save().money).toBe(100_000_000);
    const rows = logged("save_gain_implausible");
    expect(rows).toHaveLength(1);
    expect(rows[0].meta.enforced).toBe(false);
    expect(rows[0].meta.firstSave).toBe(true);
  });

  it.each([
    ["a JSON array", "[1,2,3]"],
    ["a bare scalar", "42"],
    ["a JSON string", "\"nope\""],
  ])("a stored blob that is %s is detection-only, not a refusal", async (_label, stored) => {
    // Reported as an asymmetry with 2b/2c, which skip shapes they cannot read.
    // Unreachable in production — validateSave will not store a non-object
    // `inventory` or a non-numeric `money`, and all 2,309 saves parse — but the
    // guard must not be the one thing that refuses a row it cannot read.
    db.user.saveData = stored;
    const { status } = await post({
      saveData: { ...koruem2Prior(), money: 100_000_000 },
      expectedSaveVersion: 8259,
    });
    expect(status).toBe(200);
    expect(db.save().money).toBe(100_000_000);
    expect(logged("save_gain_implausible").every((r: any) => r.meta.enforced === false)).toBe(true);
  });

  it("a stored blob with a DEGENERATE money field does not flag the next ordinary upload", async () => {
    // balance() reads absent-or-broken as 0, which is right for an ABSENT key
    // (deleting `money` then uploading $500M must not be a two-step bypass) and
    // wrong for a present-but-degenerate one: the string "5000" used to read as
    // 0 and charge the account $5,000,000 it never gained.
    db.user.saveData = JSON.stringify({ ...koruem2Prior(), money: "5000" });
    const { status } = await post({
      saveData: { ...koruem2Prior(), money: 5_000_000 },
      expectedSaveVersion: 8259,
    });
    expect(status).toBe(200);
    expect(logged("save_gain_implausible")).toHaveLength(0);
  });

  it("an ABSENT money key still reads as 0 — the two-step bypass stays closed", async () => {
    const { money: _drop, ...noMoney } = koruem2Prior();
    db.user.saveData = JSON.stringify(noMoney);
    const { status } = await post({
      saveData: { ...koruem2Prior(), money: 500_000_000 },
      expectedSaveVersion: 8259,
    });
    expect(status).toBe(400);
    expect(db.save().money).toBeUndefined();
  });

  it("a clock skew that makes elapsed negative neither throws nor flags a normal upload", async () => {
    db.user.saveUpdatedAt = new Date(Date.now() + 6 * HOUR); // future stamp
    const { status } = await post({
      saveData: { ...koruem2Prior(), money: 905_945 }, // +$900,000, under the burst floor
      expectedSaveVersion: 8259,
    });
    expect(status).toBe(200);
    expect(db.save().money).toBe(905_945);
    expect(h.recordError).not.toHaveBeenCalled();
  });

  it("Part C: an accepted-but-notable gain is recorded separately and refuses nothing", async () => {
    db.user.saveUpdatedAt = new Date(Date.now() - 6 * HOUR);
    const { status } = await post({
      saveData: { ...koruem2Prior(), money: 2_005_945 }, // +$2M: over burst, under a 6h allowance
      expectedSaveVersion: 8259,
    });
    expect(status).toBe(200);
    expect(db.save().money).toBe(2_005_945);
    expect(logged("save_gain_implausible")).toHaveLength(0);
    const rows = logged("save_gain_elapsed_allowance");
    expect(rows).toHaveLength(1);
    expect(rows[0].meta.notable[0]).toMatchObject({ field: "money", delta: 2_000_000 });
    expect(rows[0].meta.moneyAllowance).toBe(19_000_000);
  });
});

describe("POST /api/saves + gain guard: the server's own payments are INVISIBLE to it", () => {
  // The property placement buys, and the obvious way to get this wrong. The
  // fold runs inside commitSave, strictly AFTER the comparison, so a
  // PendingGrant cannot appear in `next` when the guard evaluates.
  it("a $250,000 mass-gift fold lands, and the guard does not see it", async () => {
    db.addGrant("g1", [{ kind: "money", amount: 250_000 }]);
    const { status, json } = await post({
      saveData: { ...koruem2Prior(), money: 6_000 },
      expectedSaveVersion: 8259,
      grantAck: 1,
    });
    expect(status).toBe(200);
    expect(json.grantsApplied).toEqual([{ kind: "money", amount: 250_000 }]);
    expect(db.save().money).toBe(256_000);
    expect(db.user.saveAdoptSeq).toBe(1); // server wrote bytes → adopt bump
    expect(db.grants[0].deliveredAt).not.toBeNull();
    expect(h.recordError).not.toHaveBeenCalled();
  });

  it("a grant far LARGER than the entire allowance still lands unflagged", async () => {
    // $50,000,000 is 50× the $1,003,333 this upload was allowed to gain. If
    // the guard ran after the fold — or compared against the STORED bytes
    // instead of the client's — this is the row that would be refused, and
    // the server would be refusing its own payment.
    db.addGrant("gBig", [{ kind: "money", amount: 50_000_000 }]);
    const { status, json } = await post({
      saveData: { ...koruem2Prior(), money: 6_000 },
      expectedSaveVersion: 8259,
      grantAck: 1,
    });
    expect(status).toBe(200);
    expect(json.grantsApplied).toEqual([{ kind: "money", amount: 50_000_000 }]);
    expect(db.save().money).toBe(50_006_000);
    expect(logged("save_gain_implausible")).toHaveLength(0);
    expect(logged("save_gain_elapsed_allowance")).toHaveLength(0);
  });

  it("an ITEM grant past the reward-only ceiling still lands unflagged", async () => {
    // 5,000 Master Balls is 50× ITEM_STACK_RESTRICTED. The operator's own
    // gift must not be refused by the anti-cheat.
    db.addGrant("gItem", [{ kind: "item", itemId: "masterball", quantity: 5_000 }]);
    const { status } = await post({
      saveData: koruem2Prior(),
      expectedSaveVersion: 8259,
      grantAck: 1,
    });
    expect(status).toBe(200);
    expect((db.save().inventory as any).masterball).toBe(5_000);
    expect(h.recordError).not.toHaveBeenCalled();
  });

  it("and the client's NEXT upload, echoing the folded prize back, is a delta of 0", async () => {
    // The other half of "invisible": once the fold has committed, the prize is
    // in `prior`, so re-uploading it is not a gain. Without this the guard
    // would flag the very next POST of every prize it just paid.
    db.addGrant("g1", [{ kind: "money", amount: 250_000 }]);
    await post({ saveData: { ...koruem2Prior(), money: 6_000 }, expectedSaveVersion: 8259, grantAck: 1 });
    h.recordError.mockClear();

    const echo = await post({
      saveData: { ...koruem2Prior(), money: 256_000 },
      expectedSaveVersion: 8260,
      grantAck: 1,
    });
    expect(echo.status).toBe(200);
    expect(h.recordError).not.toHaveBeenCalled();
  });
});

describe("POST /api/saves + gain guard: what enforcement must NOT break", () => {
  // These four used to live behind a re-import that forced ENFORCE_GAIN_GUARD
  // true. Enforcement is now the shipped default, so they run against the real
  // route with nothing mocked but the database — which is the only version of
  // this test that proves anything.
  it("the $50M grant fold STILL lands — the placement, not the flag, is what protects it", async () => {
    db.addGrant("gBig", [{ kind: "money", amount: 50_000_000 }]);
    const { status } = await post({
      saveData: { ...koruem2Prior(), money: 6_000 },
      expectedSaveVersion: 8259,
      grantAck: 1,
    });
    expect(status).toBe(200);
    expect(db.save().money).toBe(50_006_000);
    // 25× the cumulative capacity, and it did not even charge the budget: the
    // fold happens inside commitSave, strictly after the comparison.
    expect(50_000_000 / MONEY_BUDGET_CAPACITY).toBe(25);
    expect(logged("save_gain_implausible")).toHaveLength(0);
  });

  it("a whale pressing the mart's Max button still gets a 200", async () => {
    // The measured false positive, through the real handler. ma62087's real
    // $29,578,440 buys 295,784 Honey in one dispatch — 11.8× the ceiling and
    // 29.6× the per-upload rise limit, and still inside validateSave's
    // MAX_INVENTORY_STACK so the save is storable. Before the purchase was
    // treated as a receipt this was a 400, and a 400 makes the shipping client
    // stop uploading for the rest of the session.
    const wallet = 29_578_440;
    db.user.saveData = JSON.stringify({ ...koruem2Prior(), money: wallet });
    const qty = Math.floor(wallet / 100);
    expect(qty).toBeGreaterThan(ITEM_STACK_PURCHASABLE);
    const { status } = await post({
      saveData: {
        ...koruem2Prior(),
        money: wallet - qty * 100,
        inventory: { pokeball: 12, ultraball: 3, honey: qty },
      },
      expectedSaveVersion: 8259,
    });
    expect(status).toBe(200);
    expect(db.save().inventory.honey).toBe(qty);
    expect(logged("save_gain_implausible")).toHaveLength(0);
  });

  it("the $112.6M wallet's Max click is CLAMPED and stored, not 400'd", async () => {
    // Reported as pre-existing and out of the guard's scope, and it is — but it
    // is the same "wallet × Max button" shape, it lands on the same session-fatal
    // 400, and it would have been read as the gain guard's fault. tokyofuck's real
    // $113,046,237 buys 1,130,462 Honey, which is over validateSave's
    // MAX_INVENTORY_STACK; sanitizeSave now clamps the stack DOWN instead of
    // rejecting the whole save. Clamping a quantity down can never be a cheat.
    const wallet = 113_046_237;
    db.user.saveData = JSON.stringify({ ...koruem2Prior(), money: wallet });
    const qty = Math.floor(wallet / 100);
    expect(qty).toBeGreaterThan(999_999);
    const { status } = await post({
      saveData: {
        ...koruem2Prior(),
        money: wallet - qty * 100,
        inventory: { pokeball: 12, ultraball: 3, honey: qty },
      },
      expectedSaveVersion: 8259,
    });
    expect(status).toBe(200);
    expect(db.save().inventory.honey).toBe(999_999);
    expect(logged("save_gain_implausible")).toHaveLength(0);
  });

  it("the stream bot's configured auto-buy of 9,999 balls in ONE dispatch is accepted", async () => {
    // lib/streamSession.ts clamps autoBuyBalls.restockTo to min(9999, …) and
    // game/src/hooks/useBattleLoop.ts dispatches the whole quantity as one
    // BUY_ITEM, which sits ONE UNIT under ITEM_RISE_LIMIT. It passes because it
    // is PAID FOR, not because of that margin: 9,999 balls at the $100 floor
    // price is $999,900 of receipt.
    const wallet = 113_046_237;
    db.user.saveData = JSON.stringify({ ...koruem2Prior(), money: wallet, inventory: { pokeball: 0 } });
    const { status } = await post({
      saveData: {
        ...koruem2Prior(),
        money: wallet - 9_999 * 200,
        inventory: { pokeball: 9_999 },
      },
      expectedSaveVersion: 8259,
    });
    expect(status).toBe(200);
    expect(db.save().inventory.pokeball).toBe(9_999);
    expect(logged("save_gain_implausible")).toHaveLength(0);
  });

  it("mangetsu's real single-upload offline reconcile (+$118,322) is still accepted", async () => {
    // The largest legitimate single-upload money gain in the entire corpus,
    // measured exactly (its snapshot pair advanced saveVersion by 1). 17× under
    // the cumulative capacity.
    db.user.saveUpdatedAt = new Date(Date.now() - 8.8 * HOUR);
    const { status } = await post({
      saveData: { ...koruem2Prior(), money: 5_945 + 118_322 },
      expectedSaveVersion: 8259,
    });
    expect(status).toBe(200);
    expect(db.save().money).toBe(124_267);
    expect(h.recordError).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// PART 3 — the CUMULATIVE budget: the drip, and the account-level rate
// ─────────────────────────────────────────────────────────────────────
// The hole PART 1's rules cannot see. MONEY_BURST is a per-upload step cap and
// `elapsedMs` restarts at every accepted write, so the rule is memoryless and
// 30 uploads/minute × any cap C is 30C/minute. These tests are written as the
// REPRODUCTION FIRST: each one states the number the old rule produced.

describe("saveGainGuard: the money drip — a per-upload cap is not a rate", () => {
  const GAP = 2_000; // saveLimiter: 30 tokens / 60s → one upload every 2s

  beforeEach(() => resetGainBudgets());

  it("REPRO, still true of the pure rule: $1,000,000 per upload is silent forever", () => {
    // $3,000 → MAX_MONEY in 1,000 uploads = 33.3 minutes of wall clock, with no
    // violation and no `notable` row at any elapsed the route can produce. This
    // is why the pure money rule is detection-only now.
    let money = 3_000, uploads = 0, violations = 0, notes = 0;
    while (money < 999_999_999 && uploads < 1_100) {
      const v = evaluateGain({ money }, { money: money + MONEY_BURST }, GAP);
      violations += v.violations.length;
      notes += v.notable.length;
      money += MONEY_BURST;
      uploads++;
    }
    expect(uploads).toBe(1_000);
    expect(money).toBeGreaterThan(999_999_999);
    expect(violations).toBe(0);
    expect(notes).toBe(0);
    // Exactly MONEY_BURST is the blind spot: a violation needs `>` allowance and
    // a note needs `>` burst, so the one value that is neither is $1,000,000.
    for (const ms of [0, 1_000, GAP, 60_000, HOUR]) {
      const v = evaluateGain({ money: 0 }, { money: MONEY_BURST }, ms);
      expect(v.violations).toEqual([]);
      expect(v.notable).toEqual([]);
    }
    expect(evaluateGain({ money: 0 }, { money: MONEY_BURST + 1 }, HOUR).notable).toHaveLength(1);
  });

  it("the same ramp against the ACCOUNT is refused at the third upload", () => {
    let money = 3_000, now = 1_700_000_000_000, accepted = 0, refused = 0;
    for (let i = 0; i < 60; i++) {
      const v = evaluateGainForAccount("drip", { money }, { money: money + MONEY_BURST }, GAP, { nowMs: now });
      if (shouldRefuse(v)) { refused++; } else { money += MONEY_BURST; accepted++; }
      now += GAP;
    }
    // Capacity is $2,000,000, so exactly two $1M uploads fit before the budget
    // is empty; after that only the refill lets anything through, and $3M/h over
    // 2s is $1,667.
    expect(accepted).toBe(2);
    expect(refused).toBe(58);
    expect(money).toBe(2_003_000);
  });

  it("the reachable ceiling is capacity ONCE plus the refill, not 30 × the cap per minute", () => {
    // The bound this replaces: 30 uploads/min × $1,000,000 = $1,800,000,000/h.
    let money = 3_000, now = 1_700_000_000_000;
    const HOURS = 4;
    for (let i = 0; i < (HOURS * 3_600_000) / GAP; i++) {
      const v = evaluateGainForAccount("ceil", { money }, { money: money + MONEY_BURST }, GAP, { nowMs: now });
      if (!shouldRefuse(v)) money += MONEY_BURST;
      now += GAP;
    }
    const gained = money - 3_000;
    const bound = MONEY_BUDGET_CAPACITY + MONEY_BUDGET_REFILL_PER_HOUR * HOURS;
    expect(gained).toBeLessThanOrEqual(bound);
    expect(gained).toBeGreaterThanOrEqual(bound - MONEY_BURST); // it really does use it all
    expect(gained / HOURS).toBeLessThan(3_500_000);
    expect(1_800_000_000 / (gained / HOURS)).toBeGreaterThan(500); // >=500x tighter
  });

  it("a drip UNDER the refill is accepted — and is detected anyway", () => {
    // The honest residual of any token bucket: $1,000/upload at 30/min is
    // $1.8M/h, under the $3M/h refill, so no rule can refuse it without costing
    // false-positive margin. MONEY_DETECT_PER_HOUR is the second, lower line
    // that only ever writes a row.
    let money = 3_000, now = 1_700_000_000_000, refused = 0, noted = 0;
    for (let i = 0; i < 1_800; i++) {
      const v = evaluateGainForAccount("slow", { money }, { money: money + 1_000 }, GAP, { nowMs: now });
      if (shouldRefuse(v)) refused++; else money += 1_000;
      if (v.notable.some((n) => n.field === "money.hourly")) noted++;
      now += GAP;
    }
    expect(refused).toBe(0);
    // $1,000 x 1,500 uploads is where the rolling hour crosses $1,500,000.
    expect(noted).toBe(300);
  });

  it("koruem2's own per-upload average, ramped, is refused after a handful of uploads", () => {
    // $232,552/upload x 430 uploads = the real $99,997,295. Under MONEY_BURST,
    // so the pure rule never sees it; the budget runs out.
    let money = 5_945, now = 1_700_000_000_000, accepted = 0;
    for (let i = 0; i < 430; i++) {
      const v = evaluateGainForAccount("koruem2ramp", { money }, { money: money + 232_552 }, 4_000, { nowMs: now });
      if (!shouldRefuse(v)) { money += 232_552; accepted++; }
      now += 4_000;
    }
    expect(accepted).toBeLessThan(20);
    expect(money).toBeLessThan(5_000_000);
  });
});

describe("saveGainGuard: the charge is idempotent against a write that never landed", () => {
  // This runs BEFORE the write, and the write can still fail (the CAS in
  // commitSave, a grant race, a 409). A running sum would charge a legitimate
  // client twice for its own retry; a high-water mark against an anchor does not.
  beforeEach(() => resetGainBudgets());

  it("three retries of identical bytes cost one charge", () => {
    const prior = { money: 1_000 };
    const next = { money: 1_900_000 };
    // Same millisecond, so no refill can confuse the arithmetic: a retry inside
    // one tick is the exact shape a lost compare-and-swap produces.
    for (let i = 0; i < 3; i++) {
      expect(shouldRefuse(evaluateGainForAccount("r", prior, next, 2_000, { nowMs: 1_000 }))).toBe(false);
    }
    // $1,899,000 charged once against a $2,000,000 capacity.
    expect(Math.round(peekGainBudget("r")!.money.tokens)).toBe(101_000);
  });

  it("a retry that asks for MORE is charged only the increment", () => {
    const prior = { money: 1_000 };
    expect(shouldRefuse(evaluateGainForAccount("r2", prior, { money: 1_900_000 }, 2_000, { nowMs: 1_000 }))).toBe(false);
    expect(shouldRefuse(evaluateGainForAccount("r2", prior, { money: 2_000_000 }, 2_000, { nowMs: 1_000 }))).toBe(false);
    expect(Math.round(peekGainBudget("r2")!.money.tokens)).toBe(1_000);
    // …and the next increment does not fit.
    expect(shouldRefuse(evaluateGainForAccount("r2", prior, { money: 5_000_000 }, 2_000, { nowMs: 1_000 }))).toBe(true);
  });

  it("once the write LANDS, the bucket re-anchors and does not re-charge the same money", () => {
    expect(shouldRefuse(evaluateGainForAccount("r3", { money: 1_000 }, { money: 1_500_000 }, 2_000, { nowMs: 1_000 }))).toBe(false);
    const after = Math.round(peekGainBudget("r3")!.money.tokens);
    // The stored value is now 1,500,000; the next upload compares against it.
    expect(shouldRefuse(evaluateGainForAccount("r3", { money: 1_500_000 }, { money: 1_500_000 }, 2_000, { nowMs: 1_000 }))).toBe(false);
    expect(Math.round(peekGainBudget("r3")!.money.tokens)).toBe(after);
  });

  it("spending money is free and never refunds the budget", () => {
    expect(shouldRefuse(evaluateGainForAccount("r4", { money: 5_000_000 }, { money: 10 }, 2_000, { nowMs: 1_000 }))).toBe(false);
    expect(Math.round(peekGainBudget("r4")!.money.tokens)).toBe(MONEY_BUDGET_CAPACITY);
    // Earning it back is a gain like any other.
    expect(shouldRefuse(evaluateGainForAccount("r4", { money: 10 }, { money: 5_000_000 }, 2_000, { nowMs: 1_000 }))).toBe(true);
  });

  it("the tracked-account map is bounded and per-account state is isolated", () => {
    for (let i = 0; i < 500; i++) {
      evaluateGainForAccount(`acct${i}`, { money: 1 }, { money: 2 }, 1_000, { nowMs: 1_000 });
    }
    expect(gainBudgetSize()).toBe(500);
    // One account draining its budget cannot refuse another's upload.
    for (let i = 0; i < 5; i++) {
      evaluateGainForAccount("acct0", { money: 1 }, { money: 9_000_000 }, 1_000, { nowMs: 1_000 + i });
    }
    expect(shouldRefuse(evaluateGainForAccount("acct1", { money: 1 }, { money: 1_500_000 }, 1_000, { nowMs: 1_000 }))).toBe(false);
  });
});

describe("saveGainGuard: the restricted-item budget", () => {
  beforeEach(() => resetGainBudgets());

  it("a +4 silverbottlecap drop every 30 minutes — the real rate — never trips it", () => {
    let held = 0, now = 1_700_000_000_000, refused = 0;
    for (let i = 0; i < 40; i++) {
      const v = evaluateGainForAccount(
        "caps",
        { inventory: { silverbottlecap: held } },
        { inventory: { silverbottlecap: held + 4 } },
        30 * MIN,
        { nowMs: now },
      );
      if (shouldRefuse(v)) refused++; else held += 4;
      now += 30 * MIN;
    }
    expect(refused).toBe(0);
    expect(held).toBe(160); // past the OLD ceiling of 100, which is the point
  });

  it("a +25/upload drip at the route's own cadence is bounded by the budget, not the ceiling", () => {
    // Before this, restricted keys shared ITEM_RISE_LIMIT (10,000) and rested on
    // the absolute ceiling alone — so +25 every 2 seconds was free up to it.
    let held = 0, now = 1_700_000_000_000, accepted = 0;
    for (let i = 0; i < 600; i++) {
      const v = evaluateGainForAccount(
        "dripcaps",
        { inventory: { expShare: held } },
        { inventory: { expShare: held + RESTRICTED_ITEM_RISE_LIMIT } },
        2_000,
        { nowMs: now },
      );
      if (!shouldRefuse(v)) { held += RESTRICTED_ITEM_RISE_LIMIT; accepted++; }
      now += 2_000;
    }
    // 20 minutes of dripping at 30 uploads/minute: capacity 25 plus 20 min of
    // refill at 25/h.
    expect(held).toBeLessThanOrEqual(RESTRICTED_BUDGET_CAPACITY + RESTRICTED_BUDGET_REFILL_PER_HOUR);
    expect(accepted).toBeLessThan(3);
  });

  it("restrictedUnits sums the class, and only the class", () => {
    expect(restrictedUnits({ inventory: { masterball: 2, expShare: 3, pokeball: 9_999 } })).toBe(5);
    expect(restrictedUnits({ inventory: {} })).toBe(0);
    expect(restrictedUnits(null)).toBe(0);
    expect(restrictedUnits({ inventory: [1, 2] })).toBe(0);
  });
});

describe("POST /api/saves: the log throttle, and the auction winner", () => {
  it("a refused account is refused every time but logged once per cooldown", async () => {
    const body = {
      saveData: { ...koruem2Prior(), money: 100_000_000, inventory: { pokeball: 12, expShare: 100_000 } },
      expectedSaveVersion: 8259,
    };
    for (let i = 0; i < 12; i++) {
      const { status } = await post(body);
      expect(status).toBe(400);
    }
    // 12 refusals, one row. koruem2 made 430 uploads in 30 minutes; without this
    // that is 430 identical ErrorLog rows and a drowned alert fingerprint.
    expect(logged("save_gain_implausible")).toHaveLength(1);
    expect(GAIN_LOG_COOLDOWN_MS).toBe(5 * MIN);
  });

  it("a NEW violation shape from the same account is never suppressed", async () => {
    await post({
      saveData: { ...koruem2Prior(), money: 100_000_000 },
      expectedSaveVersion: 8259,
    });
    expect(logged("save_gain_implausible")).toHaveLength(1);
    // Same account, different shape: the item rules instead of the money one.
    await post({
      saveData: { ...koruem2Prior(), inventory: { pokeball: 12, expShare: 100_000 } },
      expectedSaveVersion: 8259,
    });
    expect(logged("save_gain_implausible")).toHaveLength(2);
  });

  it("the auction winner's un-adopted BLIND upload is refused by 2c, and 2d never runs", async () => {
    // Both reviews called this a confirmed false positive of the gain guard, and
    // against the pure function it is: the delta equals the bid. Through the real
    // route it cannot reach the guard. auctionSettlement.ts deducts the bid AND
    // appends the won Pokémon in the SAME write, so a client that has not adopted
    // is missing that mon, and step 2c refuses a blind upload that drops one.
    //
    // Verified against all eight of the largest real settled auctions using the
    // winners' actual stored blobs (dwellbreathe $10,000,000 down to
    // stratus_varius $1,500,002): every one answers 400 versionless_regression
    // with zero gain-guard rows. This is that shape, at dwellbreathe's numbers.
    const bid = 10_000_000;
    const wonMon = { id: "t827", speciesKey: "mew", level: 70, maxHp: 200, currentHp: 200, totalExp: 1, attack: 100, defense: 100, spAttack: 100, spDefense: 100, speed: 100 };
    const mine = { id: "m1", speciesKey: "pidgey", level: 5, maxHp: 20, currentHp: 20, totalExp: 1, attack: 10, defense: 10, spAttack: 10, spDefense: 10, speed: 10 };
    // Post-settlement: the bid is gone from the wallet, the mon is in the box.
    db.user.saveData = JSON.stringify({
      ...koruem2Prior(), money: 31_988_721, party: [mine], box: [wonMon],
    });
    const { status, json } = await post({
      // The winner's un-adopted bytes: pre-settlement money, and NO reference to
      // the won mon anywhere (it entered this save only via settlement).
      saveData: { ...koruem2Prior(), money: 31_988_721 + bid, party: [mine], box: [] },
    });
    expect(status).toBe(400);
    expect(json.error).toBe("versionless_regression");
    expect(json.losses.map((l: any) => l.field)).toContain("pokemon");
    // 2d never ran, so nothing about this was attributed to the gain guard.
    expect(logged("save_gain_implausible")).toHaveLength(0);
    expect(logged("save_gain_elapsed_allowance")).toHaveLength(0);
  });

  it("a rejecting recordError cannot 500 the save and does not escape as an unhandledRejection", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown) => seen.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      h.recordError.mockImplementation(async () => { throw new Error("errorlog is down"); });
      const { status } = await post({
        saveData: { ...koruem2Prior(), money: 100_000_000 },
        expectedSaveVersion: 8259,
      });
      expect(status).toBe(400);
      // Give the microtask queue a turn to surface a rejection if one escaped.
      await new Promise((r) => setTimeout(r, 20));
      expect(seen).toEqual([]);
    } finally {
      h.recordError.mockImplementation(async () => {});
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
