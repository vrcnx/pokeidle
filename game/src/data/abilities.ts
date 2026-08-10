import { gen3Abilities } from "./gen3/abilities";
import { gen3AbilityInfo } from "./gen3/abilityInfo";
// Ability metadata and per-species ability lists for the 151 Gen 1 dex.
//
// Two exports:
//   abilityInfo[id]      — display name + description (for the UI)
//   speciesAbilities[k]  — { primary: string[]; hidden?: string }
//
// `primary` is an array because most species have multiple non-hidden
// abilities to roll between. Hidden abilities exist only on a small set
// in this game and are not currently rolled at creation (kept in the
// data so we can switch them on later).

export interface AbilityInfo {
  name: string;
  description: string;
}

export const abilityInfo: Record<string, AbilityInfo> = {
  // Gen 3's own abilities, generated. Spread first so anything hand-written
  // below wins — without these twenty rows a Shiftry's Wind Rider renders as a
  // blank chip: the Pokemon HAS the ability and the player is shown nothing
  // where a name and a sentence belong.
  ...gen3AbilityInfo,

  // Phase 1 — fully wired into the battle resolver:
  levitate:    { name: "Levitate",    description: "Immune to Ground-type moves." },
  sturdy:      { name: "Sturdy",      description: "Cannot be one-shot from full HP." },
  intimidate:  { name: "Intimidate",  description: "Lowers the foe's Attack on switch-in." },
  flashFire:   { name: "Flash Fire",  description: "Immune to Fire moves; powers up own Fire moves when hit." },

  // Phase 2+ — listed for UI completeness; effects not yet implemented.
  overgrow:        { name: "Overgrow",        description: "Powers up Grass moves at low HP." },
  blaze:           { name: "Blaze",           description: "Powers up Fire moves at low HP." },
  torrent:         { name: "Torrent",         description: "Powers up Water moves at low HP." },
  swarm:           { name: "Swarm",           description: "Powers up Bug moves at low HP." },
  shieldDust:      { name: "Shield Dust",     description: "Blocks added effects of attacks." },
  shedSkin:        { name: "Shed Skin",       description: "Has a chance to cure status conditions." },
  compoundEyes:    { name: "Compound Eyes",   description: "Increases move accuracy." },
  tintedLens:      { name: "Tinted Lens",     description: "Doubles damage of not-very-effective moves." },
  runAway:         { name: "Run Away",        description: "Always flees from wild battles." },
  keenEye:         { name: "Keen Eye",        description: "Accuracy can't be lowered." },
  tangledFeet:     { name: "Tangled Feet",    description: "Raises evasion when confused." },
  bigPecks:        { name: "Big Pecks",       description: "Defense can't be lowered." },
  guts:            { name: "Guts",            description: "Boosts Attack when statused." },
  hustle:          { name: "Hustle",          description: "Boosts Attack at the cost of accuracy." },
  static:          { name: "Static",          description: "May paralyze on contact." },
  lightningRod:    { name: "Lightning Rod",   description: "Draws in Electric moves and absorbs them." },
  sandVeil:        { name: "Sand Veil",       description: "Boosts evasion in a sandstorm." },
  poisonPoint:     { name: "Poison Point",    description: "May poison on contact." },
  rivalry:         { name: "Rivalry",         description: "Stronger against same-gender foes." },
  sheerForce:      { name: "Sheer Force",     description: "Drops added effects to power up moves." },
  cuteCharm:       { name: "Cute Charm",      description: "May infatuate on contact." },
  magicGuard:      { name: "Magic Guard",     description: "Only takes direct attack damage." },
  competitive:     { name: "Competitive",     description: "Boosts Sp.Atk when stats are lowered." },
  innerFocus:      { name: "Inner Focus",     description: "Prevents flinching." },
  infiltrator:     { name: "Infiltrator",     description: "Bypasses screens and substitutes." },
  chlorophyll:     { name: "Chlorophyll",     description: "Doubles Speed in sunshine." },
  effectSpore:     { name: "Effect Spore",    description: "May inflict status on contact." },
  drySkin:         { name: "Dry Skin",        description: "Heals from Water; weak to Fire." },
  pickup:          { name: "Pickup",          description: "Sometimes picks up items after battle." },
  technician:      { name: "Technician",      description: "Boosts low-power moves." },
  unnerve:         { name: "Unnerve",         description: "Foes can't eat held berries." },
  limber:          { name: "Limber",          description: "Cannot be paralyzed." },
  cloudNine:       { name: "Cloud Nine",      description: "Negates weather effects." },
  swiftSwim:       { name: "Swift Swim",      description: "Doubles Speed in rain." },
  damp:            { name: "Damp",            description: "Prevents Self-Destruct and Explosion." },
  vitalSpirit:     { name: "Vital Spirit",    description: "Cannot fall asleep." },
  angerPoint:      { name: "Anger Point",     description: "Maximizes Attack when crit." },
  defiant:         { name: "Defiant",         description: "Boosts Attack when stats are lowered." },
  justified:       { name: "Justified",       description: "Boosts Attack when hit by Dark moves." },
  waterAbsorb:     { name: "Water Absorb",    description: "Heals from Water moves." },
  voltAbsorb:      { name: "Volt Absorb",     description: "Heals from Electric moves." },
  synchronize:     { name: "Synchronize",     description: "Passes status to the attacker." },
  noGuard:         { name: "No Guard",        description: "All moves never miss." },
  steadfast:       { name: "Steadfast",       description: "Boosts Speed when flinched." },
  gluttony:        { name: "Gluttony",        description: "Eats berries earlier than usual." },
  clearBody:       { name: "Clear Body",      description: "Stats can't be lowered by foes." },
  liquidOoze:      { name: "Liquid Ooze",     description: "Drain moves hurt the user." },
  healer:          { name: "Healer",          description: "Sometimes heals an ally's status." },
  rainDish:        { name: "Rain Dish",       description: "Heals in rain." },
  rockHead:        { name: "Rock Head",       description: "No recoil damage." },
  flameBody:       { name: "Flame Body",      description: "May burn on contact." },
  oblivious:       { name: "Oblivious",       description: "Immune to attraction and taunting." },
  ownTempo:        { name: "Own Tempo",       description: "Cannot be confused." },
  regenerator:     { name: "Regenerator",     description: "Heals on switch-out." },
  magnetPull:      { name: "Magnet Pull",     description: "Traps Steel-type foes." },
  analytic:        { name: "Analytic",        description: "Boosts power when moving last." },
  thickFat:        { name: "Thick Fat",       description: "Halves Fire and Ice damage." },
  hydration:       { name: "Hydration",       description: "Cures status in rain." },
  iceBody:         { name: "Ice Body",        description: "Heals in hail." },
  stench:          { name: "Stench",          description: "May cause flinching." },
  stickyHold:      { name: "Sticky Hold",     description: "Held items can't be removed." },
  poisonTouch:     { name: "Poison Touch",    description: "May poison on contact." },
  shellArmor:      { name: "Shell Armor",     description: "Cannot be hit by critical hits." },
  skillLink:       { name: "Skill Link",      description: "Multi-strike moves always hit max." },
  overcoat:        { name: "Overcoat",        description: "Immune to weather and powders." },
  cursedBody:      { name: "Cursed Body",     description: "May disable the foe's move on contact." },
  weakArmor:       { name: "Weak Armor",      description: "Hits lower Defense, raise Speed." },
  insomnia:        { name: "Insomnia",        description: "Cannot fall asleep." },
  forewarn:        { name: "Forewarn",        description: "Reveals the foe's strongest move." },
  hyperCutter:     { name: "Hyper Cutter",    description: "Attack can't be lowered." },
  soundproof:      { name: "Soundproof",      description: "Immune to sound-based moves." },
  aftermath:       { name: "Aftermath",       description: "Damages attacker on faint by contact." },
  harvest:         { name: "Harvest",         description: "May restore eaten berries." },
  battleArmor:     { name: "Battle Armor",    description: "Cannot be hit by critical hits." },
  reckless:        { name: "Reckless",        description: "Boosts power of recoil moves." },
  unburden:        { name: "Unburden",        description: "Doubles Speed when item is consumed." },
  ironFist:        { name: "Iron Fist",       description: "Boosts punching moves." },
  earlyBird:       { name: "Early Bird",      description: "Wakes up faster from sleep." },
  scrappy:         { name: "Scrappy",         description: "Hits Ghost-types with Normal/Fighting." },
  waterVeil:       { name: "Water Veil",      description: "Cannot be burned." },
  illuminate:      { name: "Illuminate",      description: "Raises encounter rate." },
  naturalCure:     { name: "Natural Cure",    description: "Cures status on switch-out." },
  filter:          { name: "Filter",          description: "Reduces super-effective damage." },
  moldBreaker:     { name: "Mold Breaker",    description: "Bypasses defensive abilities." },
  moxie:           { name: "Moxie",           description: "Boosts Attack on KO." },
  rattled:         { name: "Rattled",         description: "Boosts Speed when hit by Bug/Dark/Ghost." },
  immunity:        { name: "Immunity",        description: "Cannot be poisoned." },
  pressure:        { name: "Pressure",        description: "Foe loses extra PP." },
  snowCloak:       { name: "Snow Cloak",      description: "Boosts evasion in hail." },
  marvelScale:     { name: "Marvel Scale",    description: "Boosts Defense when statused." },
  multiscale:      { name: "Multiscale",      description: "Halves damage at full HP." },
  trace:           { name: "Trace",           description: "Copies the foe's ability." },
  download:        { name: "Download",        description: "Boosts the better attacking stat." },
  adaptability:    { name: "Adaptability",    description: "STAB becomes 2x instead of 1.5x." },
  anticipation:    { name: "Anticipation",    description: "Senses dangerous foe moves." },
  arenaTrap:       { name: "Arena Trap",      description: "Prevents foes from fleeing." },
  sandRush:        { name: "Sand Rush",       description: "Doubles Speed in a sandstorm." },
  sandForce:       { name: "Sand Force",      description: "Boosts Rock/Ground/Steel in sand." },
  drought:         { name: "Drought",          description: "Summons harsh sunlight on switch-in." },
  drizzle:         { name: "Drizzle",          description: "Summons rain on switch-in." },
  sandStream:      { name: "Sand Stream",      description: "Summons a sandstorm on switch-in." },
  // Johto (Gen 2) additions not already covered by later-gen entries

  contrary:      { name: "Contrary",      description: "Reverses stat-change direction." },
  friendGuard:   { name: "Friend Guard",  description: "Reduces damage to allies in doubles." },
  frisk:         { name: "Frisk",         description: "Reveals the foe's held item on switch-in." },
  honeyGather:   { name: "Honey Gather",  description: "May find Honey after a battle." },
  hugePower:     { name: "Huge Power",    description: "Doubles Attack." },
  leafGuard:     { name: "Leaf Guard",    description: "Blocks status conditions in sunshine." },
  lightMetal:    { name: "Light Metal",   description: "Halves weight." },
  magicBounce:   { name: "Magic Bounce",  description: "Reflects status moves back at the user." },
  magmaArmor:    { name: "Magma Armor",   description: "Cannot be frozen." },
  moody:         { name: "Moody",         description: "Raises one stat and lowers another each turn." },
  pickpocket:    { name: "Pickpocket",    description: "Steals the item of a foe that makes contact." },
  plus:          { name: "Plus",          description: "Boosts Sp. Atk when Minus is on the field." },
  prankster:     { name: "Prankster",     description: "Status moves gain priority." },
  quickFeet:     { name: "Quick Feet",    description: "Boosts Speed while afflicted with status." },
  sapSipper:     { name: "Sap Sipper",    description: "Immune to Grass moves; raises Attack instead." },
  sereneGrace:   { name: "Serene Grace",  description: "Doubles the chance of secondary move effects." },
  shadowTag:     { name: "Shadow Tag",    description: "Prevents the foe from switching out." },
  sniper:        { name: "Sniper",        description: "Powers up critical hits further." },
  solarPower:    { name: "Solar Power",   description: "Boosts Sp. Atk in sunshine, but loses HP each turn." },
  speedBoost:    { name: "Speed Boost",   description: "Raises Speed every turn." },
  suctionCups:   { name: "Suction Cups",  description: "Cannot be forced to switch out." },
  superLuck:     { name: "Super Luck",    description: "Raises the critical-hit ratio." },
  telepathy:     { name: "Telepathy",     description: "Avoids damage from ally moves in doubles." },
  unaware:       { name: "Unaware",       description: "Ignores the foe's stat changes when attacking or defending." },
};

export interface SpeciesAbilities {
  primary: string[];
  hidden?: string;
}

// Canonical ability assignments for the 151 Gen 1 species. `primary` is
// the rollable pool at creation; `hidden` exists for future use but is
// not currently rolled.
export const speciesAbilities: Record<string, SpeciesAbilities> = {
  // Gen 3, generated. Spread FIRST so the hand-written entries below win any
  // collision — the ten Hoenn legendaries were already here for raids, and the
  // generator reproduces them identically, but "generated data never silently
  // replaces something a person wrote" is the rule worth having rather than a
  // fact about today's diff.
  //
  // See scripts/gen-gen3.mjs. Regenerate; do not edit src/data/gen3/*.
  ...gen3Abilities,
  bulbasaur:   { primary: ["overgrow"], hidden: "chlorophyll" },
  ivysaur:     { primary: ["overgrow"], hidden: "chlorophyll" },
  venusaur:    { primary: ["overgrow"], hidden: "chlorophyll" },
  charmander:  { primary: ["blaze"] },
  charmeleon:  { primary: ["blaze"] },
  charizard:   { primary: ["blaze"] },
  squirtle:    { primary: ["torrent"], hidden: "rainDish" },
  wartortle:   { primary: ["torrent"], hidden: "rainDish" },
  blastoise:   { primary: ["torrent"], hidden: "rainDish" },
  caterpie:    { primary: ["shieldDust"], hidden: "runAway" },
  metapod:     { primary: ["shedSkin"] },
  butterfree:  { primary: ["compoundEyes"], hidden: "tintedLens" },
  weedle:      { primary: ["shieldDust"], hidden: "runAway" },
  kakuna:      { primary: ["shedSkin"] },
  beedrill:    { primary: ["swarm"] },
  pidgey:      { primary: ["keenEye", "tangledFeet"], hidden: "bigPecks" },
  pidgeotto:   { primary: ["keenEye", "tangledFeet"], hidden: "bigPecks" },
  pidgeot:     { primary: ["keenEye", "tangledFeet"], hidden: "bigPecks" },
  rattata:     { primary: ["runAway", "guts"], hidden: "hustle" },
  raticate:    { primary: ["runAway", "guts"], hidden: "hustle" },
  spearow:     { primary: ["keenEye"] },
  fearow:      { primary: ["keenEye"] },
  ekans:       { primary: ["intimidate", "shedSkin"], hidden: "unnerve" },
  arbok:       { primary: ["intimidate", "shedSkin"], hidden: "unnerve" },
  pikachu:     { primary: ["static"], hidden: "lightningRod" },
  raichu:      { primary: ["static"], hidden: "lightningRod" },
  sandshrew:   { primary: ["sandVeil"], hidden: "sandRush" },
  sandslash:   { primary: ["sandVeil"], hidden: "sandRush" },
  nidoranF:    { primary: ["poisonPoint", "rivalry"], hidden: "hustle" },
  nidorina:    { primary: ["poisonPoint", "rivalry"], hidden: "hustle" },
  nidoqueen:   { primary: ["poisonPoint", "rivalry"], hidden: "sheerForce" },
  nidoranM:    { primary: ["poisonPoint", "rivalry"], hidden: "hustle" },
  nidorino:    { primary: ["poisonPoint", "rivalry"], hidden: "hustle" },
  nidoking:    { primary: ["poisonPoint", "rivalry"], hidden: "sheerForce" },
  clefairy:    { primary: ["cuteCharm", "magicGuard"] },
  clefable:    { primary: ["cuteCharm", "magicGuard"] },
  vulpix:      { primary: ["flashFire"], hidden: "drought" },
  ninetales:   { primary: ["flashFire"], hidden: "drought" },
  jigglypuff:  { primary: ["cuteCharm", "competitive"] },
  wigglytuff:  { primary: ["cuteCharm", "competitive"] },
  zubat:       { primary: ["innerFocus"], hidden: "infiltrator" },
  golbat:      { primary: ["innerFocus"], hidden: "infiltrator" },
  oddish:      { primary: ["chlorophyll"] },
  gloom:       { primary: ["chlorophyll"] },
  vileplume:   { primary: ["chlorophyll"], hidden: "effectSpore" },
  paras:       { primary: ["effectSpore", "drySkin"] },
  parasect:    { primary: ["effectSpore", "drySkin"] },
  venonat:     { primary: ["compoundEyes", "tintedLens"], hidden: "runAway" },
  venomoth:    { primary: ["shieldDust", "tintedLens"] },
  diglett:     { primary: ["sandVeil", "arenaTrap"], hidden: "sandForce" },
  dugtrio:     { primary: ["sandVeil", "arenaTrap"], hidden: "sandForce" },
  meowth:      { primary: ["pickup", "technician"], hidden: "unnerve" },
  persian:     { primary: ["limber", "technician"], hidden: "unnerve" },
  psyduck:     { primary: ["damp", "cloudNine"], hidden: "swiftSwim" },
  golduck:     { primary: ["damp", "cloudNine"], hidden: "swiftSwim" },
  mankey:      { primary: ["vitalSpirit", "angerPoint"], hidden: "defiant" },
  primeape:    { primary: ["vitalSpirit", "angerPoint"], hidden: "defiant" },
  growlithe:   { primary: ["intimidate", "flashFire"], hidden: "justified" },
  arcanine:    { primary: ["intimidate", "flashFire"], hidden: "justified" },
  poliwag:     { primary: ["waterAbsorb", "damp"], hidden: "swiftSwim" },
  poliwhirl:   { primary: ["waterAbsorb", "damp"], hidden: "swiftSwim" },
  poliwrath:   { primary: ["waterAbsorb", "damp"], hidden: "swiftSwim" },
  abra:        { primary: ["synchronize", "innerFocus"], hidden: "magicGuard" },
  kadabra:     { primary: ["synchronize", "innerFocus"], hidden: "magicGuard" },
  alakazam:    { primary: ["synchronize", "innerFocus"], hidden: "magicGuard" },
  machop:      { primary: ["guts", "noGuard"], hidden: "steadfast" },
  machoke:     { primary: ["guts", "noGuard"], hidden: "steadfast" },
  machamp:     { primary: ["guts", "noGuard"], hidden: "steadfast" },
  bellsprout:  { primary: ["chlorophyll"], hidden: "gluttony" },
  weepinbell:  { primary: ["chlorophyll"], hidden: "gluttony" },
  victreebel:  { primary: ["chlorophyll"], hidden: "gluttony" },
  tentacool:   { primary: ["clearBody", "liquidOoze"], hidden: "rainDish" },
  tentacruel:  { primary: ["clearBody", "liquidOoze"], hidden: "rainDish" },
  geodude:     { primary: ["rockHead", "sturdy"], hidden: "sandVeil" },
  graveler:    { primary: ["rockHead", "sturdy"], hidden: "sandVeil" },
  golem:       { primary: ["rockHead", "sturdy"], hidden: "sandVeil" },
  ponyta:      { primary: ["runAway", "flashFire"], hidden: "flameBody" },
  rapidash:    { primary: ["runAway", "flashFire"], hidden: "flameBody" },
  slowpoke:    { primary: ["oblivious", "ownTempo"], hidden: "regenerator" },
  slowbro:     { primary: ["oblivious", "ownTempo"], hidden: "regenerator" },
  magnemite:   { primary: ["magnetPull", "sturdy"], hidden: "analytic" },
  magneton:    { primary: ["magnetPull", "sturdy"], hidden: "analytic" },
  farfetchd:   { primary: ["keenEye", "innerFocus"], hidden: "defiant" },
  doduo:       { primary: ["runAway", "earlyBird"], hidden: "tangledFeet" },
  dodrio:      { primary: ["runAway", "earlyBird"], hidden: "tangledFeet" },
  seel:        { primary: ["thickFat", "hydration"], hidden: "iceBody" },
  dewgong:     { primary: ["thickFat", "hydration"], hidden: "iceBody" },
  grimer:      { primary: ["stench", "stickyHold"], hidden: "poisonTouch" },
  muk:         { primary: ["stench", "stickyHold"], hidden: "poisonTouch" },
  shellder:    { primary: ["shellArmor", "skillLink"], hidden: "overcoat" },
  cloyster:    { primary: ["shellArmor", "skillLink"], hidden: "overcoat" },
  gastly:      { primary: ["levitate"] },
  haunter:     { primary: ["levitate"] },
  // Gengar gets Cursed Body (post-Gen-7 canonical). Gastly/Haunter still
  // have Levitate. If you want pre-Gen-7 Gengar Levitate, swap here.
  gengar:      { primary: ["cursedBody"] },
  onix:        { primary: ["rockHead", "sturdy"], hidden: "weakArmor" },
  drowzee:     { primary: ["insomnia", "forewarn"], hidden: "innerFocus" },
  hypno:       { primary: ["insomnia", "forewarn"], hidden: "innerFocus" },
  krabby:      { primary: ["hyperCutter", "shellArmor"], hidden: "sheerForce" },
  kingler:     { primary: ["hyperCutter", "shellArmor"], hidden: "sheerForce" },
  voltorb:     { primary: ["soundproof", "static"], hidden: "aftermath" },
  electrode:   { primary: ["soundproof", "static"], hidden: "aftermath" },
  exeggcute:   { primary: ["chlorophyll"], hidden: "harvest" },
  exeggutor:   { primary: ["chlorophyll"], hidden: "harvest" },
  cubone:      { primary: ["rockHead", "lightningRod"], hidden: "battleArmor" },
  marowak:     { primary: ["rockHead", "lightningRod"], hidden: "battleArmor" },
  hitmonlee:   { primary: ["limber", "reckless"], hidden: "unburden" },
  hitmonchan:  { primary: ["keenEye", "ironFist"], hidden: "innerFocus" },
  lickitung:   { primary: ["ownTempo", "oblivious"], hidden: "cloudNine" },
  koffing:     { primary: ["levitate"] },
  weezing:     { primary: ["levitate"] },
  rhyhorn:     { primary: ["lightningRod", "rockHead"], hidden: "reckless" },
  rhydon:      { primary: ["lightningRod", "rockHead"], hidden: "reckless" },
  chansey:     { primary: ["naturalCure"], hidden: "healer" },
  tangela:     { primary: ["chlorophyll"], hidden: "regenerator" },
  kangaskhan:  { primary: ["earlyBird", "scrappy"], hidden: "innerFocus" },
  horsea:      { primary: ["swiftSwim"], hidden: "damp" },
  seadra:      { primary: ["poisonPoint"], hidden: "damp" },
  goldeen:     { primary: ["swiftSwim", "waterVeil"], hidden: "lightningRod" },
  seaking:     { primary: ["swiftSwim", "waterVeil"], hidden: "lightningRod" },
  staryu:      { primary: ["illuminate", "naturalCure"], hidden: "analytic" },
  starmie:     { primary: ["illuminate", "naturalCure"], hidden: "analytic" },
  mrMime:      { primary: ["soundproof", "filter"], hidden: "technician" },
  scyther:     { primary: ["swarm", "technician"], hidden: "steadfast" },
  jynx:        { primary: ["oblivious", "forewarn"], hidden: "drySkin" },
  electabuzz:  { primary: ["static"], hidden: "vitalSpirit" },
  magmar:      { primary: ["flameBody"], hidden: "vitalSpirit" },
  pinsir:      { primary: ["hyperCutter", "moldBreaker"], hidden: "moxie" },
  tauros:      { primary: ["intimidate", "angerPoint"], hidden: "sheerForce" },
  magikarp:    { primary: ["swiftSwim"], hidden: "rattled" },
  gyarados:    { primary: ["intimidate"], hidden: "moxie" },
  lapras:      { primary: ["waterAbsorb", "shellArmor"], hidden: "hydration" },
  ditto:       { primary: ["limber"] },
  eevee:       { primary: ["runAway", "adaptability"], hidden: "anticipation" },
  vaporeon:    { primary: ["waterAbsorb"], hidden: "hydration" },
  jolteon:     { primary: ["voltAbsorb"] },
  flareon:     { primary: ["flashFire"] },
  porygon:     { primary: ["trace", "download"], hidden: "analytic" },
  omanyte:     { primary: ["swiftSwim", "shellArmor"], hidden: "weakArmor" },
  omastar:     { primary: ["swiftSwim", "shellArmor"], hidden: "weakArmor" },
  kabuto:      { primary: ["swiftSwim", "battleArmor"], hidden: "weakArmor" },
  kabutops:    { primary: ["swiftSwim", "battleArmor"], hidden: "weakArmor" },
  aerodactyl:  { primary: ["rockHead", "pressure"], hidden: "unnerve" },
  snorlax:     { primary: ["immunity", "thickFat"], hidden: "gluttony" },
  articuno:    { primary: ["pressure"], hidden: "snowCloak" },
  zapdos:      { primary: ["pressure"], hidden: "static" },
  moltres:     { primary: ["pressure"], hidden: "flameBody" },
  dratini:     { primary: ["shedSkin"], hidden: "marvelScale" },
  dragonair:   { primary: ["shedSkin"], hidden: "marvelScale" },
  dragonite:   { primary: ["innerFocus"], hidden: "multiscale" },
  mewtwo:      { primary: ["pressure"], hidden: "unnerve" },
  mew:         { primary: ["synchronize"] },
  // Gen 2 legendaries / mythicals
  raikou:      { primary: ["pressure"], hidden: "innerFocus" },
  entei:       { primary: ["pressure"], hidden: "innerFocus" },
  suicune:     { primary: ["pressure"], hidden: "innerFocus" },
  lugia:       { primary: ["pressure"], hidden: "multiscale" },
  hoOh:        { primary: ["pressure"], hidden: "regenerator" },
  celebi:      { primary: ["naturalCure"] },

    // Johto (Gen 2) — dex 152-251

  chikorita: { primary: ["overgrow"], hidden: "leafGuard" },
  bayleef: { primary: ["overgrow"], hidden: "leafGuard" },
  meganium: { primary: ["overgrow"], hidden: "leafGuard" },
  cyndaquil: { primary: ["blaze"], hidden: "flashFire" },
  quilava: { primary: ["blaze"], hidden: "flashFire" },
  typhlosion: { primary: ["blaze"], hidden: "flashFire" },
  totodile: { primary: ["torrent"], hidden: "sheerForce" },
  croconaw: { primary: ["torrent"], hidden: "sheerForce" },
  feraligatr: { primary: ["torrent"], hidden: "sheerForce" },
  sentret: { primary: ["runAway", "keenEye"], hidden: "frisk" },
  furret: { primary: ["runAway", "keenEye"], hidden: "frisk" },
  hoothoot: { primary: ["insomnia", "keenEye"], hidden: "tintedLens" },
  noctowl: { primary: ["insomnia", "keenEye"], hidden: "tintedLens" },
  ledyba: { primary: ["swarm", "earlyBird"], hidden: "rattled" },
  ledian: { primary: ["swarm", "earlyBird"], hidden: "ironFist" },
  spinarak: { primary: ["swarm", "insomnia"], hidden: "sniper" },
  ariados: { primary: ["swarm", "insomnia"], hidden: "sniper" },
  crobat: { primary: ["innerFocus"], hidden: "infiltrator" },
  chinchou: { primary: ["voltAbsorb", "illuminate"], hidden: "waterAbsorb" },
  lanturn: { primary: ["voltAbsorb", "illuminate"], hidden: "waterAbsorb" },
  pichu: { primary: ["static"], hidden: "lightningRod" },
  cleffa: { primary: ["cuteCharm", "magicGuard"], hidden: "friendGuard" },
  igglybuff: { primary: ["cuteCharm", "competitive"], hidden: "friendGuard" },
  togepi: { primary: ["hustle", "sereneGrace"], hidden: "superLuck" },
  togetic: { primary: ["hustle", "sereneGrace"], hidden: "superLuck" },
  natu: { primary: ["synchronize", "earlyBird"], hidden: "magicBounce" },
  xatu: { primary: ["synchronize", "earlyBird"], hidden: "magicBounce" },
  mareep: { primary: ["static"], hidden: "plus" },
  flaaffy: { primary: ["static"], hidden: "plus" },
  ampharos: { primary: ["static"], hidden: "plus" },
  bellossom: { primary: ["chlorophyll"], hidden: "healer" },
  marill: { primary: ["thickFat", "hugePower"], hidden: "sapSipper" },
  azumarill: { primary: ["thickFat", "hugePower"], hidden: "sapSipper" },
  sudowoodo: { primary: ["sturdy", "rockHead"], hidden: "rattled" },
  politoed: { primary: ["waterAbsorb", "damp"], hidden: "drizzle" },
  hoppip: { primary: ["chlorophyll", "leafGuard"], hidden: "infiltrator" },
  skiploom: { primary: ["chlorophyll", "leafGuard"], hidden: "infiltrator" },
  jumpluff: { primary: ["chlorophyll", "leafGuard"], hidden: "infiltrator" },
  aipom: { primary: ["runAway", "pickup"], hidden: "skillLink" },
  sunkern: { primary: ["chlorophyll", "solarPower"], hidden: "earlyBird" },
  sunflora: { primary: ["chlorophyll", "solarPower"], hidden: "earlyBird" },
  yanma: { primary: ["speedBoost", "compoundEyes"], hidden: "frisk" },
  wooper: { primary: ["damp", "waterAbsorb"], hidden: "unaware" },
  quagsire: { primary: ["damp", "waterAbsorb"], hidden: "unaware" },
  espeon: { primary: ["synchronize"], hidden: "magicBounce" },
  umbreon: { primary: ["synchronize"], hidden: "innerFocus" },
  murkrow: { primary: ["insomnia", "superLuck"], hidden: "prankster" },
  slowking: { primary: ["oblivious", "ownTempo"], hidden: "regenerator" },
  misdreavus: { primary: ["levitate"] },
  unown: { primary: ["levitate"] },
  wobbuffet: { primary: ["shadowTag"], hidden: "telepathy" },
  girafarig: { primary: ["innerFocus", "earlyBird"], hidden: "sapSipper" },
  pineco: { primary: ["sturdy"], hidden: "overcoat" },
  forretress: { primary: ["sturdy"], hidden: "overcoat" },
  dunsparce: { primary: ["sereneGrace", "runAway"], hidden: "rattled" },
  gligar: { primary: ["hyperCutter", "sandVeil"], hidden: "immunity" },
  steelix: { primary: ["rockHead", "sturdy"], hidden: "sheerForce" },
  snubbull: { primary: ["intimidate", "runAway"], hidden: "rattled" },
  granbull: { primary: ["intimidate", "quickFeet"], hidden: "rattled" },
  qwilfish: { primary: ["poisonPoint", "swiftSwim"], hidden: "intimidate" },
  scizor: { primary: ["swarm", "technician"], hidden: "lightMetal" },
  shuckle: { primary: ["sturdy", "gluttony"], hidden: "contrary" },
  heracross: { primary: ["swarm", "guts"], hidden: "moxie" },
  sneasel: { primary: ["innerFocus", "keenEye"], hidden: "pickpocket" },
  teddiursa: { primary: ["pickup", "quickFeet"], hidden: "honeyGather" },
  ursaring: { primary: ["guts", "quickFeet"], hidden: "unnerve" },
  slugma: { primary: ["magmaArmor", "flameBody"], hidden: "weakArmor" },
  magcargo: { primary: ["magmaArmor", "flameBody"], hidden: "weakArmor" },
  swinub: { primary: ["oblivious", "snowCloak"], hidden: "thickFat" },
  piloswine: { primary: ["oblivious", "snowCloak"], hidden: "thickFat" },
  corsola: { primary: ["hustle", "naturalCure"], hidden: "regenerator" },
  remoraid: { primary: ["hustle", "sniper"], hidden: "moody" },
  octillery: { primary: ["suctionCups", "sniper"], hidden: "moody" },
  delibird: { primary: ["vitalSpirit", "hustle"], hidden: "insomnia" },
  mantine: { primary: ["swiftSwim", "waterAbsorb"], hidden: "waterVeil" },
  skarmory: { primary: ["keenEye", "sturdy"], hidden: "weakArmor" },
  houndour: { primary: ["earlyBird", "flashFire"], hidden: "unnerve" },
  houndoom: { primary: ["earlyBird", "flashFire"], hidden: "unnerve" },
  kingdra: { primary: ["swiftSwim", "sniper"], hidden: "damp" },
  phanpy: { primary: ["pickup"], hidden: "sandVeil" },
  donphan: { primary: ["sturdy"], hidden: "sandVeil" },
  porygon2: { primary: ["trace", "download"], hidden: "analytic" },
  stantler: { primary: ["intimidate", "frisk"], hidden: "sapSipper" },
  smeargle: { primary: ["ownTempo", "technician"], hidden: "moody" },
  tyrogue: { primary: ["guts", "steadfast"], hidden: "vitalSpirit" },
  hitmontop: { primary: ["intimidate", "technician"], hidden: "steadfast" },
  smoochum: { primary: ["oblivious", "forewarn"], hidden: "hydration" },
  elekid: { primary: ["static"], hidden: "vitalSpirit" },
  magby: { primary: ["flameBody"], hidden: "vitalSpirit" },
  miltank: { primary: ["thickFat", "scrappy"], hidden: "sapSipper" },
  blissey: { primary: ["naturalCure", "sereneGrace"], hidden: "healer" },
  larvitar: { primary: ["guts"], hidden: "sandVeil" },
  pupitar: { primary: ["shedSkin"] },
  tyranitar: { primary: ["sandStream"], hidden: "unnerve" },

  // Gen 3 legendaries / mythicals
  regirock:    { primary: ["clearBody"], hidden: "sturdy" },
  regice:      { primary: ["clearBody"], hidden: "iceBody" },
  registeel:   { primary: ["clearBody"], hidden: "thickFat" },
  latias:      { primary: ["levitate"] },
  latios:      { primary: ["levitate"] },
  kyogre:      { primary: ["drizzle"] },
  groudon:     { primary: ["drought"] },
  rayquaza:    { primary: ["pressure"] },
  jirachi:     { primary: ["pressure"] },
  deoxys:      { primary: ["pressure"] },
  // Gen 4 legendaries / mythicals
  uxie:        { primary: ["levitate"] },
  mesprit:     { primary: ["levitate"] },
  azelf:       { primary: ["levitate"] },
  dialga:      { primary: ["pressure"] },
  palkia:      { primary: ["pressure"] },
  heatran:     { primary: ["flashFire"], hidden: "flameBody" },
  regigigas:   { primary: ["pressure"] },
  giratina:    { primary: ["pressure"], hidden: "levitate" },
  cresselia:   { primary: ["levitate"] },
  phione:      { primary: ["hydration"] },
  manaphy:     { primary: ["hydration"] },
  darkrai:     { primary: ["pressure"] },
  shaymin:     { primary: ["naturalCure"] },
  arceus:      { primary: ["pressure"] },
  // Gen 5 legendaries / mythicals
  victini:     { primary: ["pressure"] },
  cobalion:    { primary: ["justified"] },
  terrakion:   { primary: ["justified"] },
  virizion:    { primary: ["justified"] },
  tornadus:    { primary: ["pressure"], hidden: "regenerator" },
  thundurus:   { primary: ["pressure"], hidden: "voltAbsorb" },
  reshiram:    { primary: ["pressure"] },
  zekrom:      { primary: ["pressure"] },
  landorus:    { primary: ["pressure"], hidden: "intimidate" },
  kyurem:      { primary: ["pressure"] },
  keldeo:      { primary: ["justified"] },
  meloetta:    { primary: ["pressure"] },
  genesect:    { primary: ["download"] },
  // Gen 6 legendaries / mythicals
  // Gen 7 legendaries / mythicals / Ultra Beasts
  // Gen 8 legendaries / mythicals
  // Gen 9 legendaries / mythicals
};

// Helper for the few species keys that might appear with alternate
// casings or punctuation in legacy data (Mr. Mime, Farfetch'd, Nidoran).
const KEY_ALIASES: Record<string, string> = {
  "mr-mime":   "mrMime",
  "mrmime":    "mrMime",
  "farfetch'd": "farfetchd",
  "nidoran-f": "nidoranF",
  "nidoran-m": "nidoranM",
};

export function abilitiesFor(speciesKey: string): SpeciesAbilities | undefined {
  return speciesAbilities[speciesKey] ?? speciesAbilities[KEY_ALIASES[speciesKey] ?? ""];
}

/**
 * Which SLOT an ability occupies for a species, or null if it is not one of
 * that species' abilities at all.
 *
 * "hidden" is its own slot rather than an index, because the hidden ability is
 * a different KIND of slot in the real games — it is not simply the last one
 * in the list, and a species can have two primaries and a hidden.
 */
export function abilitySlotOf(
  speciesKey: string,
  ability: string | undefined,
): { kind: "primary"; index: number } | { kind: "hidden" } | null {
  if (!ability) return null;
  const entry = abilitiesFor(speciesKey);
  if (!entry) return null;
  if (entry.hidden && entry.hidden === ability) return { kind: "hidden" };
  const i = entry.primary.indexOf(ability);
  return i >= 0 ? { kind: "primary", index: i } : null;
}

/** Is this a legal ability for this species? */
export function isLegalAbility(speciesKey: string, ability: string | undefined): boolean {
  return abilitySlotOf(speciesKey, ability) !== null;
}

/**
 * The ability a Pokémon should have AFTER evolving.
 *
 * ══ EVOLUTION PRESERVES THE SLOT, NOT THE ABILITY ═══════════════════
 *
 * This is the rule the real games use and the one this game was missing: the
 * ability itself is a property of the SPECIES, and what carries across an
 * evolution is which slot you occupy. A Shed Skin Dratini is a slot-1 Dratini,
 * so it becomes a slot-1 Dragonite — which is Inner Focus. It does not stay
 * Shed Skin, because Dragonite does not have Shed Skin.
 *
 * COMPLETE_EVOLUTION used to spread `...old` and change only the species and
 * the stats, so the ability string came along verbatim and every fully-evolved
 * Pokémon in the game was walking around with its baby form's ability. Player
 * report from Gshow, using this exact line as the example.
 *
 * A hidden ability stays hidden — that is the whole point of the slot being
 * the thing that is preserved, and it is why "hidden" is modelled as its own
 * slot rather than as an index into `primary`.
 *
 * Falls back to the new species' first primary whenever the slot cannot be
 * carried over: the old ability was not legal for the old species (data drift,
 * or a mon created before this table existed), the new species has fewer
 * primaries than the old one, or the new species has no hidden ability to
 * inherit. Returning something legal always beats returning something that
 * cannot exist.
 */
export function evolvedAbility(
  fromSpeciesKey: string,
  toSpeciesKey: string,
  currentAbility: string | undefined,
): string | undefined {
  const to = abilitiesFor(toSpeciesKey);
  if (!to || to.primary.length === 0) return currentAbility;

  const slot = abilitySlotOf(fromSpeciesKey, currentAbility);
  if (slot?.kind === "hidden") return to.hidden ?? to.primary[0];
  if (slot?.kind === "primary") return to.primary[slot.index] ?? to.primary[0];
  return to.primary[0];
}

/**
 * Repair an ability that is not legal for the species holding it.
 *
 * Returns the ability unchanged when it is fine, so this is safe to run over
 * every Pokémon on every load. Only the ones that are actually wrong move.
 *
 * There is no slot to preserve here — by definition the current ability is not
 * in the species' list, so there is nothing to read a slot from. The first
 * primary is the only defensible answer.
 */
export function repairedAbility(
  speciesKey: string,
  ability: string | undefined,
): string | undefined {
  const entry = abilitiesFor(speciesKey);
  // Species with no ability data at all are left alone. Blanking an ability
  // because this table has not been filled in for a species would be a
  // regression dressed up as a fix.
  if (!entry || entry.primary.length === 0) return ability;
  if (isLegalAbility(speciesKey, ability)) return ability;
  return entry.primary[0];
}

// Picks a random ability from the species' primary list. Used at
// Pokémon creation time. If the species has no entry, returns null.
export function pickAbility(speciesKey: string): string | null {
  const entry = abilitiesFor(speciesKey);
  if (!entry || entry.primary.length === 0) return null;
  return entry.primary[Math.floor(Math.random() * entry.primary.length)];
}
