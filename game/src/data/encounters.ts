// Backwards-compatible barrel. Wild encounter tables now live in
// `data/regions/<id>/encounters.ts`. Existing imports keep working.
export { mergedEncounters as encounters } from "./regions";
