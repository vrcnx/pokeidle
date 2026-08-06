// Route Mastery — the idle loop's reward track.
//
// Everything that pays out in this game is attached to something you do once:
// a badge, the Elite Four, the daily. The thing players actually spend their
// hours on — grinding wild battles on a route — paid nothing but EXP and
// money, and by the mid-game money is meaningless (a real save is sitting on
// $209,000,000). Achievements look like the answer and are not: they are pure
// predicates that deliberately grant nothing.
//
// What is pinned here is the part that can leak value. A claim is a PAYOUT,
// so the two ways to be paid twice — claiming the same tier again, and a save
// merge resurrecting a spent claim — are the tests that matter.

import { describe, expect, it } from "vitest";
import { reducer } from "../src/state/reducer";
import { mergeCloudAdvance } from "../src/state/saveReconcile";
import {
  MASTERY_TIERS, claimable, earnedLevel, isMasterable, masteryKey, nextTier, winsOn,
} from "../src/data/routeMastery";
import { mergedRoutes } from "../src/data/regions";
import { makeState } from "./helpers";

/** A route that genuinely exists and is masterable, so the tests are not
 *  asserting against an id the data does not have. */
const ROUTE = Object.keys(mergedRoutes).find(isMasterable)!;
const TOWN = Object.keys(mergedRoutes).find((id) => mergedRoutes[id].type === "town");

const withWins = (wins: number, over = {}) =>
  makeState({ battlesWonByLocation: { [ROUTE]: wins }, claimedMastery: [], ...over });

describe("what counts as progress", () => {
  it("reads the win counter the reducer has always kept", () => {
    // The whole design rests on this: no new counter, and every existing save
    // already has years of progress banked, so a returning player finds
    // milestones waiting rather than a track that starts at zero.
    expect(winsOn(withWins(137), ROUTE)).toBe(137);
  });

  it("earns nothing before the first threshold", () => {
    expect(earnedLevel(MASTERY_TIERS[0].wins - 1)).toBe(0);
    expect(earnedLevel(MASTERY_TIERS[0].wins)).toBe(1);
  });

  it("earns every tier passed, not just the newest", () => {
    // A player who arrives with thousands of wins banked should be handed the
    // whole ladder, not only the top rung.
    const top = MASTERY_TIERS[MASTERY_TIERS.length - 1];
    expect(earnedLevel(top.wins)).toBe(top.level);
    expect(claimable(withWins(top.wins))).toHaveLength(MASTERY_TIERS.length);
  });

  it("stops offering a next tier once a route is finished", () => {
    expect(nextTier(0)).toBeTruthy();
    expect(nextTier(MASTERY_TIERS[MASTERY_TIERS.length - 1].wins)).toBeNull();
  });

  it("excludes towns, whose battles are a fixed roster of rematches", () => {
    if (!TOWN) return;
    expect(isMasterable(TOWN)).toBe(false);
    const s = makeState({ battlesWonByLocation: { [TOWN]: 99_999 }, claimedMastery: [] });
    expect(claimable(s)).toEqual([]);
  });

  it("ignores a location the route table has never heard of", () => {
    const s = makeState({ battlesWonByLocation: { nowhere: 99_999 }, claimedMastery: [] });
    expect(claimable(s)).toEqual([]);
  });
});

describe("claiming pays exactly once", () => {
  const tier1 = MASTERY_TIERS[0];
  const key = masteryKey(ROUTE, tier1.level);

  it("pays the reward and records the claim", () => {
    const before = withWins(tier1.wins);
    const after = reducer(before, { type: "CLAIM_MASTERY", payload: { key } });
    expect(after.claimedMastery).toContain(key);
    if (tier1.reward.kind === "item") {
      expect(after.inventory[tier1.reward.itemId] ?? 0)
        .toBe((before.inventory[tier1.reward.itemId] ?? 0) + tier1.reward.quantity);
    } else {
      expect(after.victoryTokens).toBe(before.victoryTokens + tier1.reward.amount);
    }
  });

  it("REFUSES the same key twice", () => {
    // The button is rendered from the same list, so a stale render — a claim
    // that landed in another tab, a double tap before re-render — would
    // otherwise pay again.
    const once = reducer(withWins(tier1.wins), { type: "CLAIM_MASTERY", payload: { key } });
    const twice = reducer(once, { type: "CLAIM_MASTERY", payload: { key } });
    expect(twice).toBe(once);
  });

  it("REFUSES a tier that has not been earned", () => {
    // The payload names a payout, so it is re-derived from state rather than
    // trusted. A forged key must buy nothing.
    const s = withWins(0);
    const after = reducer(s, { type: "CLAIM_MASTERY", payload: { key } });
    expect(after).toBe(s);
  });

  it("REFUSES a key for a route that cannot be mastered", () => {
    if (!TOWN) return;
    const s = makeState({ battlesWonByLocation: { [TOWN]: 99_999 }, claimedMastery: [] });
    const after = reducer(s, { type: "CLAIM_MASTERY", payload: { key: masteryKey(TOWN, 1) } });
    expect(after).toBe(s);
  });

  it("drops a claimed tier out of the offer list", () => {
    const s = reducer(withWins(tier1.wins), { type: "CLAIM_MASTERY", payload: { key } });
    expect(claimable(s).map((c) => c.key)).not.toContain(key);
  });

  it("pays Victory Tokens as tokens, not as a phantom inventory item", () => {
    // Tokens are a number on GameState with their own spend path. Writing
    // them as `inventory.victoryToken` would put a key the item catalog has
    // never heard of into the bag, where nothing renders and nothing spends.
    const top = MASTERY_TIERS[MASTERY_TIERS.length - 1];
    if (top.reward.kind !== "tokens") return;
    const s = withWins(top.wins);
    const after = reducer(s, { type: "CLAIM_MASTERY", payload: { key: masteryKey(ROUTE, top.level) } });
    expect(after.victoryTokens).toBe(s.victoryTokens + top.reward.amount);
    expect(after.inventory.victoryToken).toBeUndefined();
  });
});

describe("a save merge cannot resurrect a spent claim", () => {
  it("unions claimedMastery from both lineages", () => {
    // THE leak. party/box/money are taken whole from ONE lineage, so if this
    // list travelled with them, a tier claimed on the copy that loses would
    // become claimable again and pay a second time. It is monotonic, exactly
    // like claimedRegionStarters.
    const local = {
      playerPokemon: { id: "p", speciesKey: "bulbasaur" },
      party: [], box: [], money: 0, inventory: {},
      claimedMastery: ["route1:1"],
      wildBattlesWon: 1, trainerBattlesWon: 0,
    };
    const cloud = { ...local, claimedMastery: ["route2:1"], wildBattlesWon: 99 };
    const merged = mergeCloudAdvance(local, cloud);
    expect([...merged.claimedMastery].sort()).toEqual(["route1:1", "route2:1"]);
  });

  it("keeps a claim the LOSING lineage made", () => {
    const local = {
      playerPokemon: { id: "p", speciesKey: "bulbasaur" },
      party: [], box: [], money: 0, inventory: {},
      claimedMastery: ["route1:1"], wildBattlesWon: 1, trainerBattlesWon: 0,
    };
    const cloud = { ...local, claimedMastery: [], wildBattlesWon: 500 };
    // Cloud wins the spendable state; the local claim must still survive.
    expect(mergeCloudAdvance(local, cloud).claimedMastery).toContain("route1:1");
  });
});

describe("the tiers themselves", () => {
  it("rises in wins and never repeats a level", () => {
    for (let i = 1; i < MASTERY_TIERS.length; i++) {
      expect(MASTERY_TIERS[i].wins).toBeGreaterThan(MASTERY_TIERS[i - 1].wins);
      expect(MASTERY_TIERS[i].level).toBe(MASTERY_TIERS[i - 1].level + 1);
    }
  });

  it("never pays money", () => {
    // Deliberate. Money is the one resource an established player cannot use,
    // so paying in it would make the whole track read as nothing.
    for (const tier of MASTERY_TIERS) {
      expect(tier.reward.kind === "item" || tier.reward.kind === "tokens").toBe(true);
    }
  });

  it("puts the first tier inside a single session", () => {
    // A track whose first reward is a week away is a track nobody discovers.
    expect(MASTERY_TIERS[0].wins).toBeLessThanOrEqual(100);
  });
});
