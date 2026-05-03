// Backwards-compatible barrel. Trainer encounter tables now live
// per-region under `data/regions/<id>/trainerEncounters.ts`.
export { mergedTrainerEncounters as trainerEncounters } from "./regions";
