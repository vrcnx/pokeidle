# Battle Backgrounds

Each background renders behind the active battle scene. Files are picked
by `BattleScene.tsx`:

```ts
// 1. Try the per-location PNG (matches the location id, exactly)
const locationBg = `/backgrounds/${state.currentLocation}.png`;

// 2. If that 404s, fall back to the type-level PNG below
const BG_BY_TYPE = {
  town:        "/backgrounds/town.png",
  cave:        "/backgrounds/cave.png",
  victoryRoad: "/backgrounds/mountain.png",
  raid:        "/backgrounds/town_port.png",
  route:       "/backgrounds/grassland.png",
};
```

So **the filename is the canonical location id from `routes.ts`**, plus 5
type-level fallbacks. Replace any file with your own image (same name)
and it'll show up automatically. Recommended size: **1280 × 720** (16:9).

---

## Type-level fallbacks (used if a location-specific file is missing)

| File              | Used for                                        |
|-------------------|-------------------------------------------------|
| `town.png`        | All towns/cities                                |
| `cave.png`        | All caves                                       |
| `mountain.png`    | Victory Road type                               |
| `town_port.png`   | Raid Island                                     |
| `grassland.png`   | All numbered routes                             |

## Cities

| File                | Location          |
|---------------------|-------------------|
| `palletTown.png`    | Pallet Town       |
| `viridianCity.png`  | Viridian City     |
| `pewterCity.png`    | Pewter City       |
| `ceruleanCity.png`  | Cerulean City     |
| `vermilionCity.png` | Vermilion City    |
| `saffronCity.png`   | Saffron City      |
| `celadonCity.png`   | Celadon City      |
| `lavenderTown.png`  | Lavender Town     |
| `fuchsiaCity.png`   | Fuchsia City      |
| `cinnabarIsland.png`| Cinnabar Island   |
| `indigoPlat.png`    | Indigo Plateau    |

## Numbered Routes

| File          | Location  |
|---------------|-----------|
| `route1.png`  | Route 1   |
| `route2.png`  | Route 2   |
| `route3.png`  | Route 3   |
| `route4.png`  | Route 4   |
| `route5.png`  | Route 5   |
| `route6.png`  | Route 6   |
| `route7.png`  | Route 7   |
| `route8.png`  | Route 8   |
| `route9.png`  | Route 9   |
| `route10.png` | Route 10  |
| `route11.png` | Route 11  |
| `route12.png` | Route 12  |
| `route13.png` | Route 13  |
| `route14.png` | Route 14  |
| `route15.png` | Route 15  |
| `route16.png` | Route 16  |
| `route17.png` | Route 17  |
| `route18.png` | Route 18  |
| `route19.png` | Route 19  |
| `route20.png` | Route 20  |
| `route21.png` | Route 21  |
| `route22.png` | Route 22  |
| `route23.png` | Route 23  |
| `route24.png` | Route 24  |
| `route25.png` | Route 25  |

## Caves & Special Areas

| File                  | Location          |
|-----------------------|-------------------|
| `viridianForest.png`  | Viridian Forest   |
| `mtMoon.png`          | Mt. Moon          |
| `rockTunnel.png`      | Rock Tunnel       |
| `powerPlant.png`      | Power Plant       |
| `pokemonTower.png`    | Pokémon Tower     |
| `diglettsCave.png`    | Diglett's Cave    |
| `safariZone.png`      | Safari Zone       |
| `seafoamIslands.png`  | Seafoam Islands   |
| `pokemonMansion.png`  | Pokémon Mansion   |

## Endgame

| File                | Location       |
|---------------------|----------------|
| `victoryRoad.png`   | Victory Road   |
| `ceruleanCave.png`  | Cerulean Cave  |

## Missing (uses type fallback)

`Raid Island` has no dedicated `raidIsland.png` — it falls back to
`town_port.png`. Add `raidIsland.png` to override.

---

**Total**: 52 files = 5 type fallbacks + 11 cities + 25 routes + 9 special + 2 endgame.
