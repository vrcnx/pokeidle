// Backwards-compatible barrel. The actual route data lives in
// per-region folders under `data/regions/<id>/routes.ts`. Importers can
// keep using `import { routes } from "../data/routes"` and get a single
// flat dict that spans every registered region.
export { mergedRoutes as routes } from "./regions";
