// Unified item catalog. Aggregates the existing pokeballs/consumables/stones
// data with all the missing Gen 1 items so the Bag and Mart can show a
// proper inventory. Items flagged `implemented: false` show in the catalog
// (with sprite + name + description) but can't be used yet — that's where
// Phase 2+ mechanics will plug in.

export type ItemCategory =
  | "pokeball"
  | "medicine"
  | "status"
  | "battle"
  | "berry"
  | "held"
  | "stone"
  | "treasure"
  | "tm"
  | "hm"
  | "key"
  | "utility";

export interface CatalogItem {
  id: string;
  name: string;
  description: string;
  category: ItemCategory;
  buyPrice: number | null; // null = not for sale at standard marts
  sellPrice?: number;
  spriteOverride?: string; // override for itemSpriteUrl mapping (kebab-case)
  implemented?: boolean;   // false → catalog-only, no in-game effect yet
}

const items: CatalogItem[] = [
  // ── Pokeballs ────────────────────────────────────────────────────────────
  { id: "pokeball",   name: "Poké Ball",   description: "A device for catching wild Pokémon. Standard catch rate.", category: "pokeball", buyPrice: 200, sellPrice: 100, implemented: true },
  { id: "greatball",  name: "Great Ball",  description: "A high-performance ball with a higher success rate than a Poké Ball.", category: "pokeball", buyPrice: 600, sellPrice: 300, implemented: true },
  { id: "ultraball",  name: "Ultra Ball",  description: "An ultra-performance ball that catches Pokémon more reliably.", category: "pokeball", buyPrice: 1200, sellPrice: 600, implemented: true },
  { id: "masterball", name: "Master Ball", description: "The best Ball with the ultimate level of performance. It catches any Pokémon without fail.", category: "pokeball", buyPrice: null, sellPrice: 0, implemented: true },

  // Medicine + status-cure items intentionally omitted. The game auto-heals
  // (dock Heal button, white-out, defensive useBattleLoop), and we don't
  // model status conditions on the player's side, so consumable healers
  // would just be money sinks with no mechanic. If status conditions land
  // later, restore the Medicine and Status Cures categories from git.

  // Battle items (X-series) and berries omitted — neither status conditions
  // nor mid-battle stat-stage items are modeled, so they'd be money sinks.

  // ── Held items (only the ones with real mechanics) ───────────────────────
  { id: "expShare",   name: "Exp. Share",  description: "Activates a 300-battle buff that shares 25% EXP with every non-fainted party member. Sold at the Celadon Dept. Store.", category: "held", buyPrice: 20000, sellPrice: 0, spriteOverride: "exp-share", implemented: true },
  { id: "shinycharm", name: "Shiny Charm", description: "Doubles shiny encounter rate. Earned automatically by completing the Pokédex.", category: "held", buyPrice: null, sellPrice: 0, spriteOverride: "shiny-charm", implemented: true },

  // Battle held items — equippable on individual Pokémon via the Pokémon Detail modal.
  { id: "leftovers",      name: "Leftovers",       description: "Restores 1/16 max HP each turn while held.", category: "held", buyPrice: 4000, sellPrice: 2000, spriteOverride: "leftovers", implemented: true },
  { id: "lifeorb",        name: "Life Orb",        description: "Boosts attack damage by 30%, but the holder loses 10% HP per attack.", category: "held", buyPrice: 5000, sellPrice: 2500, spriteOverride: "life-orb", implemented: true },
  { id: "focussash",      name: "Focus Sash",      description: "If at full HP, the holder survives a one-shot KO with 1 HP. Consumed on use.", category: "held", buyPrice: 4000, sellPrice: 2000, spriteOverride: "focus-sash", implemented: true },
  // Type-boost plates / stones / orbs — flat 20% boost to matching-type moves.
  { id: "charcoal",       name: "Charcoal",        description: "A held item that boosts Fire-type moves by 20%.", category: "held", buyPrice: 2000, sellPrice: 1000, implemented: true },
  { id: "mysticwater",    name: "Mystic Water",    description: "A held item that boosts Water-type moves by 20%.", category: "held", buyPrice: 2000, sellPrice: 1000, spriteOverride: "mystic-water", implemented: true },
  { id: "magnet",         name: "Magnet",          description: "A held item that boosts Electric-type moves by 20%.", category: "held", buyPrice: 2000, sellPrice: 1000, implemented: true },
  { id: "miracleseed",    name: "Miracle Seed",    description: "A held item that boosts Grass-type moves by 20%.", category: "held", buyPrice: 2000, sellPrice: 1000, spriteOverride: "miracle-seed", implemented: true },
  { id: "nevermeltice",   name: "Never-Melt Ice",  description: "A held item that boosts Ice-type moves by 20%.", category: "held", buyPrice: 2000, sellPrice: 1000, spriteOverride: "never-melt-ice", implemented: true },
  { id: "blackbelt",      name: "Black Belt",      description: "A held item that boosts Fighting-type moves by 20%.", category: "held", buyPrice: 2000, sellPrice: 1000, spriteOverride: "black-belt", implemented: true },
  { id: "poisonbarb",     name: "Poison Barb",     description: "A held item that boosts Poison-type moves by 20%.", category: "held", buyPrice: 2000, sellPrice: 1000, spriteOverride: "poison-barb", implemented: true },
  { id: "softsand",       name: "Soft Sand",       description: "A held item that boosts Ground-type moves by 20%.", category: "held", buyPrice: 2000, sellPrice: 1000, spriteOverride: "soft-sand", implemented: true },
  { id: "sharpbeak",      name: "Sharp Beak",      description: "A held item that boosts Flying-type moves by 20%.", category: "held", buyPrice: 2000, sellPrice: 1000, spriteOverride: "sharp-beak", implemented: true },
  { id: "twistedspoon",   name: "Twisted Spoon",   description: "A held item that boosts Psychic-type moves by 20%.", category: "held", buyPrice: 2000, sellPrice: 1000, spriteOverride: "twisted-spoon", implemented: true },
  { id: "silverpowder",   name: "Silver Powder",   description: "A held item that boosts Bug-type moves by 20%.", category: "held", buyPrice: 2000, sellPrice: 1000, spriteOverride: "silver-powder", implemented: true },
  { id: "hardstone",      name: "Hard Stone",      description: "A held item that boosts Rock-type moves by 20%.", category: "held", buyPrice: 2000, sellPrice: 1000, spriteOverride: "hard-stone", implemented: true },
  { id: "spelltag",       name: "Spell Tag",       description: "A held item that boosts Ghost-type moves by 20%.", category: "held", buyPrice: 2000, sellPrice: 1000, spriteOverride: "spell-tag", implemented: true },
  { id: "dragonfang",     name: "Dragon Fang",     description: "A held item that boosts Dragon-type moves by 20%.", category: "held", buyPrice: 2000, sellPrice: 1000, spriteOverride: "dragon-fang", implemented: true },
  { id: "blackglasses",   name: "Black Glasses",   description: "A held item that boosts Dark-type moves by 20%.", category: "held", buyPrice: 2000, sellPrice: 1000, spriteOverride: "black-glasses", implemented: true },
  { id: "silkscarf",      name: "Silk Scarf",      description: "A held item that boosts Normal-type moves by 20%.", category: "held", buyPrice: 2000, sellPrice: 1000, spriteOverride: "silk-scarf", implemented: true },

  // ── Battle berries (held, auto-consumed in battle) ──────────────────────
  // Status-cure berries cure their matching status as soon as it lands;
  // HP-restore berries trigger at end-of-turn when the holder is at or
  // below half HP. All are single-use — consumed on trigger.
  { id: "lumberry",    name: "Lum Berry",    description: "Held item: cures any major status condition. Consumed on use.", category: "held", buyPrice: 3000, sellPrice: 1500, spriteOverride: "lum-berry", implemented: true },
  { id: "cheriberry",  name: "Cheri Berry",  description: "Held item: cures paralysis. Consumed on use.", category: "held", buyPrice: 1000, sellPrice: 500, spriteOverride: "cheri-berry", implemented: true },
  { id: "chestoberry", name: "Chesto Berry", description: "Held item: wakes the holder from sleep. Consumed on use.", category: "held", buyPrice: 1000, sellPrice: 500, spriteOverride: "chesto-berry", implemented: true },
  { id: "pechaberry",  name: "Pecha Berry",  description: "Held item: cures poison (regular or toxic). Consumed on use.", category: "held", buyPrice: 1000, sellPrice: 500, spriteOverride: "pecha-berry", implemented: true },
  { id: "rawstberry",  name: "Rawst Berry",  description: "Held item: cures burn. Consumed on use.", category: "held", buyPrice: 1000, sellPrice: 500, spriteOverride: "rawst-berry", implemented: true },
  { id: "aspearberry", name: "Aspear Berry", description: "Held item: thaws the holder from freeze. Consumed on use.", category: "held", buyPrice: 1000, sellPrice: 500, spriteOverride: "aspear-berry", implemented: true },
  { id: "persimberry", name: "Persim Berry", description: "Held item: cures confusion. Consumed on use.", category: "held", buyPrice: 1000, sellPrice: 500, spriteOverride: "persim-berry", implemented: true },
  { id: "sitrusberry", name: "Sitrus Berry", description: "Held item: restores 1/4 max HP when the holder drops to or below half HP. Consumed on use.", category: "held", buyPrice: 2000, sellPrice: 1000, spriteOverride: "sitrus-berry", implemented: true },
  { id: "oranberry",   name: "Oran Berry",   description: "Held item: restores 10 HP when the holder drops to or below half HP. Consumed on use.", category: "held", buyPrice: 500,  sellPrice: 250,  spriteOverride: "oran-berry", implemented: true },

  // ── Trade-evolution catalysts (held; consumed when the holder is
  //    traded into its matching evolution) ─────────────────────────────
  { id: "metalcoat",     name: "Metal Coat",     description: "A held item that triggers an evolution when its holder is traded. (Onix → Steelix, Scyther → Scizor)", category: "held", buyPrice: null, sellPrice: 1050, spriteOverride: "metal-coat", implemented: true },
  { id: "kingsrock",     name: "King's Rock",    description: "A held item that triggers an evolution when its holder is traded. (Slowpoke → Slowking, Poliwhirl → Politoed)", category: "held", buyPrice: null, sellPrice: 1050, spriteOverride: "kings-rock", implemented: true },
  { id: "dragonscale",   name: "Dragon Scale",   description: "A held item that triggers an evolution when its holder is traded. (Seadra → Kingdra)", category: "held", buyPrice: null, sellPrice: 2100, spriteOverride: "dragon-scale", implemented: true },
  { id: "upgrade",       name: "Up-Grade",       description: "A held item that triggers an evolution when its holder is traded. (Porygon → Porygon2)", category: "held", buyPrice: null, sellPrice: 1050, spriteOverride: "up-grade", implemented: true },
  { id: "dubiousdisc",   name: "Dubious Disc",   description: "A held item that triggers an evolution when its holder is traded. (Porygon2 → Porygon-Z)", category: "held", buyPrice: null, sellPrice: 1050, spriteOverride: "dubious-disc", implemented: true },
  { id: "protector",     name: "Protector",      description: "A held item that triggers an evolution when its holder is traded. (Rhydon → Rhyperior)", category: "held", buyPrice: null, sellPrice: 1050, spriteOverride: "protector", implemented: true },
  { id: "electirizer",   name: "Electirizer",    description: "A held item that triggers an evolution when its holder is traded. (Electabuzz → Electivire)", category: "held", buyPrice: null, sellPrice: 1050, spriteOverride: "electirizer", implemented: true },
  { id: "magmarizer",    name: "Magmarizer",     description: "A held item that triggers an evolution when its holder is traded. (Magmar → Magmortar)", category: "held", buyPrice: null, sellPrice: 1050, spriteOverride: "magmarizer", implemented: true },
  // Link Cable — a consumable bought from the Celadon Dept. Store
  // that triggers a SOLO trade-evolution on a chosen party Pokémon.
  // Honours the trade+item entries too: using a Link Cable on Onix
  // requires it to be holding a Metal Coat, and the catalyst is
  // consumed alongside the cable.
  { id: "linkcable",     name: "Link Cable",     description: "A handcrafted cable that mimics a peer-to-peer trade. Use on a Pokémon that evolves by trade to trigger its evolution. Consumed on use.", category: "utility", buyPrice: 9800, sellPrice: 4900, spriteOverride: "link-cable", implemented: true },

  // ── Evolution Stones (luxury items — extremely expensive) ────────────────
  { id: "firestone",    name: "Fire Stone",    description: "A rare stone that radiates heat. Evolves certain Pokémon.", category: "stone", buyPrice: 100000, sellPrice: 50000, spriteOverride: "fire-stone", implemented: true },
  { id: "waterstone",   name: "Water Stone",   description: "A rare stone with a blue, watery appearance. Evolves certain Pokémon.", category: "stone", buyPrice: 100000, sellPrice: 50000, spriteOverride: "water-stone", implemented: true },
  { id: "thunderstone", name: "Thunder Stone", description: "A rare stone that gives off a faint shock. Evolves certain Pokémon.", category: "stone", buyPrice: 100000, sellPrice: 50000, spriteOverride: "thunder-stone", implemented: true },
  { id: "leafstone",    name: "Leaf Stone",    description: "A rare stone with a leaf pattern. Evolves certain Pokémon.", category: "stone", buyPrice: 100000, sellPrice: 50000, spriteOverride: "leaf-stone", implemented: true },
  { id: "moonstone",    name: "Moon Stone",    description: "A mysterious stone that resembles the Moon. Available from the Elite Four Reward Shop.", category: "stone", buyPrice: null, sellPrice: 60000, spriteOverride: "moon-stone", implemented: true },
  { id: "sunstone",     name: "Sun Stone",     description: "A radiant stone that captures sunlight. Available from the Elite Four Reward Shop.", category: "stone", buyPrice: null, sellPrice: 60000, spriteOverride: "sun-stone", implemented: true },

  // ── Treasure (sellable) ──────────────────────────────────────────────────
  { id: "nugget",     name: "Nugget",      description: "A nugget of pure gold. Sells for a high price.", category: "treasure", buyPrice: null, sellPrice: 5000 },
  { id: "bignugget",  name: "Big Nugget",  description: "A big nugget of pure gold. Sells for a very high price.", category: "treasure", buyPrice: null, sellPrice: 20000, spriteOverride: "big-nugget" },
  { id: "pearl",      name: "Pearl",       description: "A pretty pearl. Sells for a fair price.", category: "treasure", buyPrice: null, sellPrice: 1400 },
  { id: "bigpearl",   name: "Big Pearl",   description: "A large, lustrous pearl. Sells for a high price.", category: "treasure", buyPrice: null, sellPrice: 7500, spriteOverride: "big-pearl" },
  { id: "stardust",   name: "Stardust",    description: "Lovely red sand. Sells for a price.", category: "treasure", buyPrice: null, sellPrice: 2000 },
  { id: "starpiece",  name: "Star Piece",  description: "A piece of a beautiful gem. Sells for a high price.", category: "treasure", buyPrice: null, sellPrice: 4900, spriteOverride: "star-piece" },

  // ── Utility (existing repel/honey live here) ─────────────────────────────
  { id: "repel",      name: "Repel",       description: "Halves a wild Pokémon's encounter weight on the current route for 500 battles.", category: "utility", buyPrice: 350, sellPrice: 175, implemented: true },
  { id: "superrepel", name: "Super Repel", description: "Halves wild encounters for 1000 battles.", category: "utility", buyPrice: 500, sellPrice: 250, spriteOverride: "super-repel" },
  { id: "maxrepel",   name: "Max Repel",   description: "Halves wild encounters for 2000 battles.", category: "utility", buyPrice: 700, sellPrice: 350, spriteOverride: "max-repel" },
  { id: "honey",      name: "Honey",       description: "Doubles a wild Pokémon's encounter weight on the current route for 500 battles.", category: "utility", buyPrice: 100, sellPrice: 50, implemented: true },

  // ── HMs (display-only) ───────────────────────────────────────────────────
  { id: "hm01",  name: "HM01 Cut",        description: "Slashes through obstacles. (Catalog only)", category: "hm", buyPrice: null, sellPrice: 0 },
  { id: "hm02",  name: "HM02 Fly",        description: "Returns the user to the last Poké Center visited. (Catalog only)", category: "hm", buyPrice: null, sellPrice: 0 },
  { id: "hm03",  name: "HM03 Surf",       description: "Travel across water. (Catalog only)", category: "hm", buyPrice: null, sellPrice: 0 },
  { id: "hm04",  name: "HM04 Strength",   description: "Move heavy boulders. (Catalog only)", category: "hm", buyPrice: null, sellPrice: 0 },
  { id: "hm05",  name: "HM05 Flash",      description: "Lights up dark caves. (Catalog only)", category: "hm", buyPrice: null, sellPrice: 0 },

  // ── Key items (display-only) ─────────────────────────────────────────────
  { id: "bicycle",     name: "Bicycle",     description: "A folding bicycle. (Catalog only)", category: "key", buyPrice: null, sellPrice: 0 },
  { id: "oldrod",      name: "Old Rod",     description: "An old, worn fishing rod. (Catalog only)", category: "key", buyPrice: null, sellPrice: 0, spriteOverride: "old-rod" },
  { id: "goodrod",     name: "Good Rod",    description: "A standard fishing rod. (Catalog only)", category: "key", buyPrice: null, sellPrice: 0, spriteOverride: "good-rod" },
  { id: "superrod",    name: "Super Rod",   description: "An awesome fishing rod. (Catalog only)", category: "key", buyPrice: null, sellPrice: 0, spriteOverride: "super-rod" },
  { id: "itemfinder",  name: "Itemfinder",  description: "Detects nearby hidden items. (Catalog only)", category: "key", buyPrice: null, sellPrice: 0, spriteOverride: "dowsing-machine" },
  { id: "pokeflute",   name: "Poké Flute",  description: "Wakes Pokémon from sleep. (Catalog only)", category: "key", buyPrice: null, sellPrice: 0, spriteOverride: "poke-flute" },
];

// TMs (50). Stored separately so they don't bloat the main list visually.
for (let i = 1; i <= 50; i++) {
  const id = `tm${String(i).padStart(2, "0")}`;
  items.push({
    id,
    name: `TM${String(i).padStart(2, "0")}`,
    description: "A Technical Machine that teaches a move to a compatible Pokémon. (Catalog only)",
    category: "tm",
    buyPrice: null,
    sellPrice: 0,
    spriteOverride: `tm-normal`,
  });
}

export const itemsCatalog: Record<string, CatalogItem> = Object.fromEntries(items.map((i) => [i.id, i]));

// Display order — used by the Bag tab to group the player's owned items.
// Removed categories (medicine/status/battle/berry) stay in the union for
// backwards-compat with old save inventories but aren't listed here, so
// the Bag never renders an empty header for them.
export const CATEGORY_ORDER: ItemCategory[] = [
  "pokeball",
  "held",
  "stone",
  "utility",
  "treasure",
  "tm",
  "hm",
  "key",
];

export const CATEGORY_LABELS: Record<ItemCategory, string> = {
  pokeball:  "Poké Balls",
  medicine:  "Medicine",
  status:    "Status Cures",
  battle:    "Battle Items",
  berry:     "Berries",
  held:      "Held Items",
  stone:     "Evolution Stones",
  utility:   "Utility",
  treasure:  "Treasures",
  tm:        "TMs",
  hm:        "HMs",
  key:       "Key Items",
};

export function getCatalogItem(id: string): CatalogItem | undefined {
  return itemsCatalog[id];
}

export function getCatalogCategory(id: string): ItemCategory {
  return itemsCatalog[id]?.category ?? "utility";
}
