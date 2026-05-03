// Backwards-compatible barrel. Elite Four entries now live per-region
// under `data/regions/<id>/eliteFour.ts`. Champion is the default
// region's champion (currently Kanto's). `rewardShopCatalog` is global
// economy data, not region-specific, so it's re-exported from the
// Kanto file for now — move it to its own data file if it ever needs to.
export { mergedEliteFour as eliteFour } from "./regions";
export { champion, rewardShopCatalog } from "./regions/kanto/eliteFour";
