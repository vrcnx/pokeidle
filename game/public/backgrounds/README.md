# Battle Backgrounds

Each background renders behind the active battle scene. Files are picked
by `BattleScene.tsx`:

```ts
// 1. Try the per-location PNG (matches the location id, exactly)
const locationBg = `/backgrounds/${state.currentLocation}.webp`;

// 2. If that 404s, fall back to the type-level PNG below
const BG_BY_TYPE = {
  town:        "/backgrounds/town.webp",
  cave:        "/backgrounds/cave.webp",
  victoryRoad: "/backgrounds/mountain.webp",
  raid:        "/backgrounds/town_port.webp",
  route:       "/backgrounds/grassland.webp",
};
```

So **the filename is the canonical location id from `routes.ts`**, plus 5
type-level fallbacks. Replace any file with your own image (same name)
and it'll show up automatically. Recommended size: **1280 × 720** (16:9).

---

## Type-level fallbacks (used if a location-specific file is missing)

| File              | Used for                                        |
|-------------------|-------------------------------------------------|
| `town.webp`        | All towns/cities                                |
| `cave.webp`        | All caves                                       |
| `mountain.webp`    | Victory Road type                               |
| `town_port.webp`   | Raid Island                                     |
| `grassland.webp`   | All numbered routes                             |

## Cities

| File                | Location          |
|---------------------|-------------------|
| `palletTown.webp`    | Pallet Town       |
| `viridianCity.webp`  | Viridian City     |
| `pewterCity.webp`    | Pewter City       |
| `ceruleanCity.webp`  | Cerulean City     |
| `vermilionCity.webp` | Vermilion City    |
| `saffronCity.webp`   | Saffron City      |
| `celadonCity.webp`   | Celadon City      |
| `lavenderTown.webp`  | Lavender Town     |
| `fuchsiaCity.webp`   | Fuchsia City      |
| `cinnabarIsland.webp`| Cinnabar Island   |
| `indigoPlat.webp`    | Indigo Plateau    |

## Numbered Routes

| File          | Location  |
|---------------|-----------|
| `route1.webp`  | Route 1   |
| `route2.webp`  | Route 2   |
| `route3.webp`  | Route 3   |
| `route4.webp`  | Route 4   |
| `route5.webp`  | Route 5   |
| `route6.webp`  | Route 6   |
| `route7.webp`  | Route 7   |
| `route8.webp`  | Route 8   |
| `route9.webp`  | Route 9   |
| `route10.webp` | Route 10  |
| `route11.webp` | Route 11  |
| `route12.webp` | Route 12  |
| `route13.webp` | Route 13  |
| `route14.webp` | Route 14  |
| `route15.webp` | Route 15  |
| `route16.webp` | Route 16  |
| `route17.webp` | Route 17  |
| `route18.webp` | Route 18  |
| `route19.webp` | Route 19  |
| `route20.webp` | Route 20  |
| `route21.webp` | Route 21  |
| `route22.webp` | Route 22  |
| `route23.webp` | Route 23  |
| `route24.webp` | Route 24  |
| `route25.webp` | Route 25  |

## Caves & Special Areas

| File                  | Location          |
|-----------------------|-------------------|
| `viridianForest.webp`  | Viridian Forest   |
| `mtMoon.webp`          | Mt. Moon          |
| `rockTunnel.webp`      | Rock Tunnel       |
| `powerPlant.webp`      | Power Plant       |
| `pokemonTower.webp`    | Pokémon Tower     |
| `diglettsCave.webp`    | Diglett's Cave    |
| `safariZone.webp`      | Safari Zone       |
| `seafoamIslands.webp`  | Seafoam Islands   |
| `pokemonMansion.webp`  | Pokémon Mansion   |

## Endgame

| File                | Location       |
|---------------------|----------------|
| `victoryRoad.webp`   | Victory Road   |
| `ceruleanCave.webp`  | Cerulean Cave  |

## Missing (uses type fallback)

`Raid Island` has no dedicated `raidIsland.webp` — it falls back to
`town_port.webp`. Add `raidIsland.webp` to override.

---

**Total**: 52 files = 5 type fallbacks + 11 cities + 25 routes + 9 special + 2 endgame.
