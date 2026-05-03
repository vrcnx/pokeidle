import type { Stats } from "../types";

// Canonical Gen V EV yields per species. A defender's EVs grow by these
// amounts when it's defeated. Total EV cap is 510, per-stat cap 252.
// Source: Bulbapedia / PokeAPI tables for Black/White.
//
// Each entry lists only non-zero stats — `evYieldFor()` returns a full Stats
// object with zeros for unlisted ones.

type Yield = Partial<Stats>;

export const evYields: Record<string, Yield> = {
  // Starters
  bulbasaur:  { spAttack: 1 },
  ivysaur:    { spAttack: 1, spDefense: 1 },
  venusaur:   { spAttack: 2, spDefense: 1 },
  charmander: { speed: 1 },
  charmeleon: { spAttack: 1, speed: 1 },
  charizard:  { spAttack: 3 },
  squirtle:   { defense: 1 },
  wartortle:  { defense: 1, spDefense: 1 },
  blastoise:  { spDefense: 3 },

  // Bug
  caterpie:  { hp: 1 },
  metapod:   { defense: 2 },
  butterfree:{ spAttack: 2, spDefense: 1 },
  weedle:    { speed: 1 },
  kakuna:    { defense: 2 },
  beedrill:  { attack: 2, spDefense: 1 },

  // Birds
  pidgey:    { speed: 1 },
  pidgeotto: { speed: 2 },
  pidgeot:   { speed: 3 },
  spearow:   { speed: 1 },
  fearow:    { attack: 2, speed: 1 },
  zubat:     { speed: 1 },
  golbat:    { speed: 2 },

  // Rodents
  rattata:   { speed: 1 },
  raticate:  { attack: 1, speed: 1 },
  pikachu:   { speed: 2 },
  raichu:    { speed: 3 },

  // Sand
  sandshrew: { defense: 1 },
  sandslash: { defense: 2 },

  // Nidoran
  nidoranF:  { hp: 1 },
  nidorina:  { hp: 2 },
  nidoqueen: { attack: 3 },
  nidoranM:  { attack: 1 },
  nidorino:  { attack: 2 },
  nidoking:  { attack: 3 },

  // Clef / Vulp
  clefairy:  { hp: 2 },
  clefable:  { hp: 3 },
  vulpix:    { speed: 1 },
  ninetales: { spDefense: 1, speed: 1 },

  // Jiggly
  jigglypuff:{ hp: 2 },
  wigglytuff:{ hp: 3 },

  // Oddish
  oddish:    { spAttack: 1 },
  gloom:     { spAttack: 2 },
  vileplume: { spAttack: 3 },

  // Paras
  paras:     { attack: 1 },
  parasect:  { attack: 2, defense: 1 },

  // Venonat
  venonat:   { spDefense: 1 },
  venomoth:  { spAttack: 1, speed: 1 },

  // Diglett
  diglett:   { speed: 1 },
  dugtrio:   { speed: 2, attack: 1 },

  // Cat
  meowth:    { speed: 1 },
  persian:   { speed: 2 },

  // Psyduck
  psyduck:   { spAttack: 1 },
  golduck:   { spAttack: 2 },

  // Mankey
  mankey:    { attack: 1 },
  primeape:  { attack: 2 },

  // Dog
  growlithe: { attack: 1 },
  arcanine:  { attack: 2, speed: 1 },

  // Poliwag
  poliwag:   { speed: 1 },
  poliwhirl: { defense: 1, speed: 1 },
  poliwrath: { defense: 3 },

  // Abra line
  abra:      { spAttack: 1 },
  kadabra:   { spAttack: 2 },
  alakazam:  { spAttack: 3 },

  // Machop line
  machop:    { attack: 1 },
  machoke:   { attack: 2 },
  machamp:   { attack: 3 },

  // Bellsprout
  bellsprout:{ attack: 1 },
  weepinbell:{ attack: 2 },
  victreebel:{ attack: 3 },

  // Tentacool
  tentacool: { spDefense: 1 },
  tentacruel:{ spDefense: 2 },

  // Geodude
  geodude:   { defense: 1 },
  graveler:  { defense: 2 },
  golem:     { defense: 3 },

  // Ponyta
  ponyta:    { speed: 1 },
  rapidash:  { speed: 2 },

  // Slowpoke
  slowpoke:  { hp: 1 },
  slowbro:   { defense: 2 },

  // Magnemite
  magnemite: { spAttack: 1 },
  magneton:  { spAttack: 2 },

  // Misc
  farfetchd: { attack: 1 },
  doduo:     { attack: 1 },
  dodrio:    { attack: 2 },
  seel:      { spDefense: 1 },
  dewgong:   { spDefense: 2 },
  grimer:    { hp: 1 },
  muk:       { hp: 1, attack: 2 },
  shellder:  { defense: 1 },
  cloyster:  { defense: 2 },

  // Ghosts
  gastly:    { spAttack: 1 },
  haunter:   { spAttack: 2 },
  gengar:    { spAttack: 3 },

  // Onix
  onix:      { defense: 1 },

  // Drowzee
  drowzee:   { spDefense: 1 },
  hypno:     { spDefense: 2 },

  // Krabby
  krabby:    { attack: 1 },
  kingler:   { attack: 2 },

  // Voltorb
  voltorb:   { speed: 1 },
  electrode: { speed: 2 },

  // Egg
  exeggcute: { defense: 1 },
  exeggutor: { spAttack: 2 },

  // Cubone
  cubone:    { defense: 1 },
  marowak:   { defense: 2 },

  // Hitmons
  hitmonlee: { attack: 2 },
  hitmonchan:{ spDefense: 2 },

  // Tongue
  lickitung: { hp: 2 },

  // Koffing
  koffing:   { defense: 1 },
  weezing:   { defense: 2 },

  // Rhy
  rhyhorn:   { attack: 1 },
  rhydon:    { attack: 2 },

  // Egg lvl
  chansey:   { hp: 2 },

  // Tang
  tangela:   { spAttack: 1 },

  // Kang
  kangaskhan:{ hp: 2 },

  // Sea
  horsea:    { spAttack: 1 },
  seadra:    { spAttack: 2 },
  goldeen:   { attack: 1 },
  seaking:   { attack: 2 },
  staryu:    { speed: 1 },
  starmie:   { speed: 1, spAttack: 2 },

  // Misc
  mrMime:    { spAttack: 2 },
  scyther:   { attack: 1, speed: 1 },
  jynx:      { spAttack: 2 },
  electabuzz:{ speed: 2 },
  magmar:    { spAttack: 2 },
  pinsir:    { attack: 2 },
  tauros:    { attack: 1, speed: 1 },
  magikarp:  { speed: 1 },
  gyarados:  { attack: 2 },
  lapras:    { hp: 2 },
  ditto:     { hp: 1 },

  // Eevee + evos
  eevee:     { spDefense: 1 },
  vaporeon:  { hp: 2 },
  jolteon:   { speed: 2 },
  flareon:   { attack: 2 },

  // Misc late-game
  porygon:   { spAttack: 1 },
  omanyte:   { defense: 1 },
  omastar:   { defense: 2 },
  kabuto:    { defense: 1 },
  kabutops:  { attack: 2 },
  aerodactyl:{ speed: 2 },
  snorlax:   { hp: 2 },

  // Legendaries
  articuno:  { spDefense: 3 },
  zapdos:    { spAttack: 3 },
  moltres:   { spAttack: 3 },
  dratini:   { attack: 1 },
  dragonair: { attack: 2 },
  dragonite: { attack: 3 },
  mewtwo:    { spAttack: 3 },
  mew:       { hp: 3 },

  // Gen 2 legendaries / mythicals
  raikou:    { spAttack: 3 },
  entei:     { attack: 3 },
  suicune:   { defense: 3 },
  lugia:     { spDefense: 3 },
  hoOh:      { spDefense: 3 },
  celebi:    { hp: 3 },

  // Gen 3 legendaries / mythicals
  regirock:  { defense: 3 },
  regice:    { spDefense: 3 },
  registeel: { defense: 2, spDefense: 1 },
  latias:    { spDefense: 3 },
  latios:    { spAttack: 3 },
  kyogre:    { spAttack: 3 },
  groudon:   { attack: 3 },
  rayquaza:  { attack: 3 },
  jirachi:   { hp: 3 },
  deoxys:    { attack: 1, spAttack: 1, speed: 1 },

  // Gen 4 legendaries / mythicals
  uxie:      { defense: 2, spDefense: 1 },
  mesprit:   { hp: 3 },
  azelf:     { attack: 2, spAttack: 1 },
  dialga:    { spAttack: 3 },
  palkia:    { spAttack: 3 },
  heatran:   { spAttack: 3 },
  regigigas: { attack: 3 },
  giratina:  { hp: 3 },
  cresselia: { spDefense: 3 },
  phione:    { hp: 1 },
  manaphy:   { hp: 3 },
  darkrai:   { spAttack: 2, speed: 1 },
  shaymin:   { hp: 3 },
  arceus:    { hp: 3 },

  // Gen 5 legendaries / mythicals
  victini:   { hp: 3 },
  cobalion:  { defense: 3 },
  terrakion: { attack: 3 },
  virizion:  { spDefense: 3 },
  tornadus:  { attack: 3 },
  thundurus: { attack: 3 },
  reshiram:  { spAttack: 3 },
  zekrom:    { attack: 3 },
  landorus:  { attack: 3 },
  kyurem:    { attack: 1, spAttack: 2 },
  keldeo:    { spAttack: 3 },
  meloetta:  { hp: 1, spAttack: 1, spDefense: 1 },
  genesect:  { attack: 1, spAttack: 2 },

  // Gen 6 legendaries / mythicals

  // Gen 7 legendaries / mythicals / Ultra Beasts

  // Gen 8 legendaries / mythicals

  // Gen 9 legendaries / mythicals
};

export function evYieldFor(speciesKey: string): Stats {
  const y = evYields[speciesKey] ?? {};
  return {
    hp:        y.hp        ?? 0,
    attack:    y.attack    ?? 0,
    defense:   y.defense   ?? 0,
    spAttack:  y.spAttack  ?? 0,
    spDefense: y.spDefense ?? 0,
    speed:     y.speed     ?? 0,
  };
}

// Add yield to current EVs, capped 252 per stat and 510 total. Earlier stats
// are credited first when totalling against the cap.
export function applyEvYield(current: Stats, yld: Stats): Stats {
  const order: (keyof Stats)[] = [
    "hp", "attack", "defense", "spAttack", "spDefense", "speed",
  ];
  let total = order.reduce((s, k) => s + current[k], 0);
  const out: Stats = { ...current };
  for (const k of order) {
    if (total >= 510) break;
    if (out[k] >= 252) continue;
    const add = Math.min(yld[k], 252 - out[k], 510 - total);
    if (add <= 0) continue;
    out[k] += add;
    total += add;
  }
  return out;
}
