// Where a bare openHub() lands.
//
// This is the hub's only real decision, and it is the one a player feels
// most: the difference between "the hub knows what I came for" and "the hub
// dumps me somewhere and makes me look". So it is pure, it lives outside the
// component, and it is tested against the states the badges can actually be
// in rather than eyeballed once.
//
// The rule, in priority order: something free waiting, then someone waiting
// to hear from you, then the neutral home. Never Settings — nobody opens a
// hub hoping for the audio sliders.

import { describe, expect, it } from "vitest";
import { pickLanding } from "../src/components/HubModal";

describe("pickLanding", () => {
  it("goes to Battle when nothing is waiting", () => {
    expect(pickLanding({})).toBe("pvp");
    expect(pickLanding({ rewards: 0, social: 0 })).toBe("pvp");
  });

  it("prefers a reward over everything else", () => {
    expect(pickLanding({ rewards: 1, social: 5 })).toBe("rewards");
  });

  // A friend request is a person waiting on you; it outranks the neutral
  // home but not a prize with a deadline on it.
  it("goes to Social for a pending request when there is no reward", () => {
    expect(pickLanding({ social: 3 })).toBe("social");
  });

  it("never lands on Settings while anything else is usable", () => {
    expect(pickLanding({})).not.toBe("settings");
    expect(pickLanding({ social: 2 })).not.toBe("settings");
    expect(pickLanding({ rewards: 9, social: 9 })).not.toBe("settings");
  });

  describe("disabled sections", () => {
    // Battle is disabled mid-battle. Landing a player on a pane they cannot
    // use — and that the rail is greying out behind them — is worse than
    // landing them anywhere else.
    it("skips the neutral home when it is unavailable", () => {
      expect(pickLanding({}, { pvp: "in a battle" })).not.toBe("pvp");
    });

    it("skips a badged section that is unavailable", () => {
      expect(pickLanding({ rewards: 2 }, { rewards: "off" })).not.toBe("rewards");
    });

    it("still finds somewhere when everything but Settings is out", () => {
      const at = pickLanding(
        { rewards: 1, social: 1 },
        { pvp: "x", rewards: "x", social: "x" },
      );
      expect(at).toBe("settings");
    });
  });
});
