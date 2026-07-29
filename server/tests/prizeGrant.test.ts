// Pure fold logic of the pending-grant inbox. The exactly-once DELIVERY
// property (the deliveredAt CAS) is exercised end-to-end in
// savesRoute.test.ts; this file pins the fold arithmetic those tests rely on.
//
// prizeGrant.ts imports ../db.js and ../socket.js at module top — both are
// stubbed so nothing here can reach a database or a socket server.

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({ prisma: {} }));
vi.mock("../src/socket.js", () => ({ sendToUserGlobal: vi.fn() }));

import { foldPrizesIntoSave, foldOwedGrants, type OwedGrant } from "../src/lib/prizeGrant.js";
import type { Prize } from "../src/lib/giveaway.js";

const okValidate = () => ({ ok: true }) as const;

describe("foldPrizesIntoSave", () => {
  it("adds items/money and reports the applied DELTA at the ceiling", () => {
    const base = { money: 999_999_900, inventory: { masterball: 999_998 } };
    const prizes: Prize[] = [
      { kind: "money", amount: 500 },
      { kind: "item", itemId: "masterball", quantity: 5 },
    ];
    const { save, applied } = foldPrizesIntoSave(base, prizes, "g1");
    expect(save.money).toBe(999_999_999); // clamped
    expect((save.inventory as Record<string, number>).masterball).toBe(999_999);
    // Echo the delta that LANDED, not the nominal prize.
    expect(applied).toEqual([
      { kind: "money", amount: 99 },
      { kind: "item", itemId: "masterball", quantity: 1 },
    ]);
    // Pure — base untouched.
    expect(base.money).toBe(999_999_900);
    expect(base.inventory.masterball).toBe(999_998);
  });

  it("assigns a grant-derived id to a prize mon and dedupes on replay", () => {
    const mon = { speciesKey: "dratini", level: 10 };
    const prizes: Prize[] = [{ kind: "pokemon", label: "Dratini", mon }];
    const first = foldPrizesIntoSave({ box: [] }, prizes, "grantABC");
    const box1 = first.save.box as { id: string }[];
    expect(box1).toHaveLength(1);
    expect(box1[0].id).toMatch(/^pggrantABC_0$/);
    expect(first.applied[0]).toMatchObject({ kind: "pokemon", assignedId: "pggrantABC_0" });

    // Replaying the SAME grant onto a blob that already holds the mon must
    // not hand out a one-off prize twice.
    const second = foldPrizesIntoSave(first.save, prizes, "grantABC");
    expect((second.save.box as unknown[]).length).toBe(1);
  });

  it("stays inside the validator id charset/length bound", () => {
    const prizes: Prize[] = [{ kind: "pokemon", label: "x", mon: {} }];
    const { save } = foldPrizesIntoSave(
      { box: [] },
      prizes,
      "c" + "x".repeat(60) + "!!!weird$$chars",
    );
    const id = (save.box as { id: string }[])[0].id;
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
  });
});

describe("foldOwedGrants", () => {
  const grant = (id: string, prizes: Prize[], attempts = 0): OwedGrant => ({
    id, prizes, summary: "s", attempts,
  });

  it("claims every foldable grant and skips (defers) one that fails validation", () => {
    const owed = [
      grant("g1", [{ kind: "money", amount: 100 }]),
      grant("g2", [{ kind: "money", amount: 50 }], 3),
    ];
    // Reject any save whose money exceeds 120 — g1 folds, g2 would take the
    // running total to 170 and must be deferred WITHOUT killing g1.
    const validate = (s: Record<string, unknown>) =>
      (s.money as number) > 120
        ? ({ ok: false, reason: "too rich" } as const)
        : ({ ok: true } as const);
    const out = foldOwedGrants({ money: 0 }, owed, validate);
    expect(out.claimIds).toEqual(["g1"]);
    expect(out.save.money).toBe(100);
    expect(out.deferred).toEqual([{ id: "g2", reason: "too rich", attempts: 3 }]);
    expect(out.appliedPrizes).toEqual([{ kind: "money", amount: 100 }]);
  });

  it("claims an empty/corrupt prize list so it stops being retried forever, without writing bytes", () => {
    const incoming = { money: 5 };
    const out = foldOwedGrants(incoming, [grant("g0", [])], okValidate);
    expect(out.claimIds).toEqual(["g0"]);
    // Identity-preserved: the caller uses `save !== incoming` to decide
    // whether to bump saveAdoptSeq — an empty grant must NOT force every
    // session to adopt.
    expect(out.save).toBe(incoming);
    expect(out.appliedPrizes).toEqual([]);
  });

  it("returns the input object by identity when nothing is owed", () => {
    const incoming = { money: 1 };
    const out = foldOwedGrants(incoming, [], okValidate);
    expect(out.save).toBe(incoming);
    expect(out.claimIds).toEqual([]);
  });
});
