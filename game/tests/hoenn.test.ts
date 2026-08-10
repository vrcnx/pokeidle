// Hoenn: is it actually walkable, and does anything in it collide?
//
// A region is 62 locations chained by unlock gates, and the failure mode is
// not a crash — it is a place nobody can reach. If one gate names a location
// id that does not exist, everything past it is dead and the game looks fine.
// Nobody notices until a player asks why Route 119 never opens.
//
// So these assert the properties a human cannot eyeball across 62 entries:
// the chain resolves, the graph is symmetric, the ids are unique across every
// region, and every species that can be encountered actually exists.

import { describe, expect, it } from "vitest";
import { regions, mergedRoutes } from "../src/data/regions";
import { hoenn } from "../src/data/regions/hoenn";
import { kanto } from "../src/data/regions/kanto";
import { johto } from "../src/data/regions/johto";
import { pokemonTable } from "../src/data/pokemon";
import { LEGACY_REGIONS } from "../src/utils/regionJourney";

const ids = Object.keys(hoenn.routes);

describe("the region is reachable end to end", () => {
  it("gates every location on one that exists", () => {
    const dangling: string[] = [];
    for (const [id, r] of Object.entries(hoenn.routes)) {
      for (const b of r.unlock.battlesAtLocation ?? []) {
        if (!mergedRoutes[b.locationId]) dangling.push(`${id} waits on ${b.locationId}`);
      }
    }
    expect(dangling).toEqual([]);
  });

  it("starts at a location whose gate is the Johto Champion", () => {
    // Littleroot carries the ACTUAL gate; `unlockCondition` on the region only
    // documents it. If this ever drifts, Hoenn is either unreachable or open
    // from the first minute of the game.
    expect(hoenn.startingLocation).toBe("littlerootTown");
    expect(hoenn.routes.littlerootTown.unlock.championDefeated).toBe(true);
    expect(hoenn.unlockCondition?.championDefeatedIn).toBe("johto");
  });

  it("can be walked from Littleroot to Victory Road following the gates", () => {
    // The chain, followed for real. A break anywhere leaves the tail
    // unreachable, and this is the only way to find out short of playing it.
    const open = new Set<string>(["littlerootTown"]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [id, r] of Object.entries(hoenn.routes)) {
        if (open.has(id)) continue;
        const gates = r.unlock.battlesAtLocation ?? [];
        if (gates.length && gates.every((g) => open.has(g.locationId))) {
          open.add(id);
          grew = true;
        }
      }
    }
    const unreachable = ids.filter((id) => !open.has(id));
    expect(unreachable).toEqual([]);
  });

  it("gives every gated town a way to earn the battles it is gated on", () => {
    // Towns have NO wild encounters, so their only source of battles-won is a
    // trainer roster. A town with neither is a hard stop: the next location
    // waits on battles that cannot happen there.
    const stuck: string[] = [];
    for (const [id, r] of Object.entries(hoenn.routes)) {
      const gatedOn = (r.unlock.battlesAtLocation ?? []).map((g) => g.locationId);
      for (const dep of gatedOn) {
        const hasWild = !!hoenn.encounters[dep]?.encounters.length;
        const hasTrainers = !!hoenn.trainerEncounters[dep]?.length;
        if (!hasWild && !hasTrainers) stuck.push(`${id} waits on ${dep}, which has no battles`);
      }
    }
    expect(stuck).toEqual([]);
  });
});

describe("the map holds together", () => {
  it("connects only to locations that exist", () => {
    const bad: string[] = [];
    for (const [id, r] of Object.entries(hoenn.routes)) {
      for (const c of r.connections) if (!mergedRoutes[c]) bad.push(`${id} -> ${c}`);
    }
    expect(bad).toEqual([]);
  });

  it("keeps connections mutual", () => {
    // A one-way link draws an arrow the player cannot walk back along.
    const oneWay: string[] = [];
    for (const [id, r] of Object.entries(hoenn.routes)) {
      for (const c of r.connections) {
        if (!hoenn.routes[c]) continue; // cross-region links are not our business
        if (!hoenn.routes[c].connections.includes(id)) oneWay.push(`${id} -> ${c}`);
      }
    }
    expect(oneWay).toEqual([]);
  });

  it("takes unlockOrder slots nobody else is using", () => {
    // Two regions sharing a slot means the route list sorts unstably, and the
    // "next place to go" hint points somewhere arbitrary.
    const others = new Set(
      [...Object.values(kanto.routes), ...Object.values(johto.routes)].map((r) => r.unlockOrder),
    );
    const clashes = Object.values(hoenn.routes)
      .filter((r) => others.has(r.unlockOrder))
      .map((r) => r.id);
    expect(clashes).toEqual([]);
  });

  it("does not reuse a location id from another region", () => {
    const others = new Set([...Object.keys(kanto.routes), ...Object.keys(johto.routes)]);
    expect(ids.filter((id) => others.has(id))).toEqual([]);
  });
});

describe("what lives there", () => {
  it("only spawns species this game has", () => {
    const missing: string[] = [];
    for (const [id, area] of Object.entries(hoenn.encounters)) {
      for (const e of area.encounters) {
        if (!pokemonTable[e.speciesKey]) missing.push(`${id}: ${e.speciesKey}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("only fields trainers, gym leaders and a champion made of real species", () => {
    const teams = [
      ...hoenn.gymLeaders.flatMap((g) => g.team),
      ...hoenn.eliteFour.flatMap((g) => g.team),
      ...(hoenn.champion?.team ?? []),
      ...Object.values(hoenn.trainerEncounters).flatMap((t) => t.flatMap((x) => x.team)),
    ];
    const missing = teams.filter((m) => !pokemonTable[m.speciesKey]).map((m) => m.speciesKey);
    expect([...new Set(missing)]).toEqual([]);
  });

  it("has eight badges, four Elite Four and a Champion", () => {
    expect(hoenn.gymLeaders).toHaveLength(8);
    expect(new Set(hoenn.gymLeaders.map((g) => g.badgeName)).size).toBe(8);
    expect(hoenn.eliteFour).toHaveLength(4);
    expect(hoenn.champion?.name).toBe("Steven");
  });

  it("climbs, and never dips below the Johto ceiling", () => {
    // Hoenn sits ABOVE Johto. If a gym here is weaker than Johto's last, the
    // region is a step down and the whole progression reads as broken.
    const johtoTop = Math.max(...johto.eliteFour.flatMap((g) => g.team.map((m) => m.level)));
    const aces = hoenn.gymLeaders.map((g) => Math.max(...g.team.map((m) => m.level)));
    expect(Math.min(...aces)).toBeGreaterThan(johtoTop - 10);
    // And the eight of them go up, not sideways.
    for (let i = 1; i < aces.length; i++) expect(aces[i], `gym ${i + 1}`).toBeGreaterThan(aces[i - 1]);
  });

  it("puts every gym in a town that exists here", () => {
    for (const g of [...hoenn.gymLeaders, ...hoenn.eliteFour, hoenn.champion!]) {
      expect(hoenn.routes[g.locationKey], g.name).toBeTruthy();
    }
  });

  it("gives no gym, Elite Four member or Champion an id another region already uses", () => {
    // Johto's Koga, Bruno and Lance needed a suffix for exactly this reason:
    // `defeatedEliteFour.includes(id)` would otherwise let one region's win
    // satisfy another's.
    const others = new Set(
      [kanto, johto].flatMap((r) => [...r.gymLeaders, ...r.eliteFour, ...(r.champion ? [r.champion] : [])])
        .map((g) => g.id),
    );
    const clashes = [...hoenn.gymLeaders, ...hoenn.eliteFour, hoenn.champion!]
      .filter((g) => others.has(g.id)).map((g) => g.id);
    expect(clashes).toEqual([]);
  });
});

describe("the journey rule still holds", () => {
  it("is NOT a legacy region", () => {
    // The entire mechanism for keeping new regions meaningful is that this
    // list stopped growing. Adding Hoenn would hand every existing box a free
    // pass in and undo it.
    expect(LEGACY_REGIONS.has("hoenn")).toBe(false);
  });

  it("is registered, so its data actually merges", () => {
    expect(regions.hoenn).toBeTruthy();
    expect(mergedRoutes.littlerootTown).toBeTruthy();
    expect(mergedRoutes.victoryRoadHoenn).toBeTruthy();
  });

  it("offers the three Hoenn starters, and this game has them", () => {
    expect(hoenn.starters).toEqual(["treecko", "torchic", "mudkip"]);
    for (const s of hoenn.starters) expect(pokemonTable[s], s).toBeTruthy();
  });
});
