// Backwards-compatible barrel. Gym leaders now live per-region under
// `data/regions/<id>/gymLeaders.ts`. The flat list re-exported here is
// the concatenation of every region's gym leaders, in registry order.
export { mergedGymLeaders as gymLeaders } from "./regions";
