import type { EvolutionTrigger } from "../types";

export const evolutions: Record<string, EvolutionTrigger[]> = {
    bulbasaur: [{ into: "ivysaur", level: 16 }],
    ivysaur: [{ into: "venusaur", level: 32 }],
    charmander: [{ into: "charmeleon", level: 16 }],
    charmeleon: [{ into: "charizard", level: 36 }],
    squirtle: [{ into: "wartortle", level: 16 }],
    wartortle: [{ into: "blastoise", level: 36 }],
    caterpie: [{ into: "metapod", level: 7 }],
    metapod: [{ into: "butterfree", level: 10 }],
    weedle: [{ into: "kakuna", level: 7 }],
    kakuna: [{ into: "beedrill", level: 10 }],
    pidgey: [{ into: "pidgeotto", level: 18 }],
    pidgeotto: [{ into: "pidgeot", level: 36 }],
    spearow: [{ into: "fearow", level: 20 }],
    doduo: [{ into: "dodrio", level: 31 }],
    ekans: [{ into: "arbok", level: 22 }],
    nidoranF: [{ into: "nidorina", level: 16 }],
    nidoranM: [{ into: "nidorino", level: 16 }],
    zubat: [{ into: "golbat", level: 22 }],
    // Golbat→Crobat and Chansey→Blissey are happiness evolutions in canon; with
    // no happiness mechanic, gate them on a level so they're actually obtainable.
    golbat: [{ into: "crobat", level: 40 }],
    chansey: [{ into: "blissey", level: 45 }],
    grimer: [{ into: "muk", level: 38 }],
    koffing: [{ into: "weezing", level: 35 }],
    oddish: [{ into: "gloom", level: 21 }],
    bellsprout: [{ into: "weepinbell", level: 21 }],
    mankey: [{ into: "primeape", level: 28 }],
    machop: [{ into: "machoke", level: 28 }],
    abra: [{ into: "kadabra", level: 16 }],
    drowzee: [{ into: "hypno", level: 26 }],
    diglett: [{ into: "dugtrio", level: 26 }],
    cubone: [{ into: "marowak", level: 28 }],
    sandshrew: [{ into: "sandslash", level: 22 }],
    geodude: [{ into: "graveler", level: 25 }],
    rhyhorn: [{ into: "rhydon", level: 42 }],
    psyduck: [{ into: "golduck", level: 33 }],
    tentacool: [{ into: "tentacruel", level: 30 }],
    poliwag: [{ into: "poliwhirl", level: 25 }],
    horsea: [{ into: "seadra", level: 32 }],
    goldeen: [{ into: "seaking", level: 33 }],
    krabby: [{ into: "kingler", level: 28 }],
    seel: [{ into: "dewgong", level: 34 }],
    slowpoke: [
      { into: "slowbro", level: 37 },
      { into: "slowking", trade: true, item: "kingsrock" },
    ],
    magikarp: [{ into: "gyarados", level: 20 }],
    rattata: [{ into: "raticate", level: 20 }],
    meowth: [{ into: "persian", level: 28 }],
    ponyta: [{ into: "rapidash", level: 40 }],
    voltorb: [{ into: "electrode", level: 30 }],
    magnemite: [{ into: "magneton", level: 30 }],
    gastly: [{ into: "haunter", level: 25 }],
    paras: [{ into: "parasect", level: 24 }],
    venonat: [{ into: "venomoth", level: 31 }],
    omanyte: [{ into: "omastar", level: 40 }],
    kabuto: [{ into: "kabutops", level: 40 }],
    dratini: [{ into: "dragonair", level: 30 }],
    dragonair: [{ into: "dragonite", level: 55 }],
    pikachu: [{ into: "raichu", item: "thunderstone" }],
    nidorina: [{ into: "nidoqueen", item: "moonstone" }],
    nidorino: [{ into: "nidoking", item: "moonstone" }],
    clefairy: [{ into: "clefable", item: "moonstone" }],
    jigglypuff: [{ into: "wigglytuff", item: "moonstone" }],
    vulpix: [{ into: "ninetales", item: "firestone" }],
    growlithe: [{ into: "arcanine", item: "firestone" }],
    gloom: [
      { into: "vileplume", item: "leafstone" },
      { into: "bellossom", item: "sunstone" },
    ],
    weepinbell: [{ into: "victreebel", item: "leafstone" }],
    poliwhirl: [
      { into: "poliwrath", item: "waterstone" },
      { into: "politoed",  trade: true, item: "kingsrock" },
    ],
    shellder: [{ into: "cloyster", item: "waterstone" }],
    exeggcute: [{ into: "exeggutor", item: "leafstone" }],
    staryu: [{ into: "starmie", item: "waterstone" }],
    eevee: [
      { into: "vaporeon", item: "waterstone" },
      { into: "jolteon", item: "thunderstone" },
      { into: "flareon", item: "firestone" },
      // Espeon/Umbreon are happiness (day/night) evolutions in canon, which
      // this game has no mechanic for. Map them to the thematically-matching
      // stones instead — Espeon is the Sun Pokémon, Umbreon the Moon Pokémon —
      // so they're obtainable and self-explanatory via the Bag "Evolves:" hint.
      { into: "espeon", item: "sunstone" },
      { into: "umbreon", item: "moonstone" },
    ],
    // Trade-only evolutions. Trigger fires after a successful trade
    // with another player — there's no item/level path to these
    // species, so getting Alakazam/Machamp/Golem/Gengar requires
    // multiplayer interaction.
    kadabra:  [{ into: "alakazam", trade: true }],
    machoke:  [{ into: "machamp",  trade: true }],
    graveler: [{ into: "golem",    trade: true }],
    haunter:  [{ into: "gengar",   trade: true }],

    // ── Trade+item evolutions (Gen 4+, still canonical in Gen 5) ─────
    // The mon must be traded while holding the named item; on receipt
    // it evolves into the listed species and the held catalyst is
    // consumed (see TRADE_COMPLETE reducer). Slowpoke / Poliwhirl
    // join their existing entries above to avoid duplicate keys.
    onix:        [{ into: "steelix",   trade: true, item: "metalcoat" }],
    scyther:     [{ into: "scizor",    trade: true, item: "metalcoat" }],
    porygon:     [{ into: "porygon2",  trade: true, item: "upgrade" }],
    seadra:      [{ into: "kingdra",   trade: true, item: "dragonscale" }],
    // NOTE: porygon2→porygonZ, rhydon→rhyperior, electabuzz→electivire and
    // magmar→magmortar are intentionally omitted — those Gen-4 species aren't
    // in the Pokédex yet, so offering the evolution crashed on their missing
    // stats. Re-add here (and their catalysts to the shops) once the species
    // exist in data/pokemon.ts.

    // Johto (Gen 2) additions

    chikorita: [{ into: "bayleef", level: 16 }],
    bayleef: [{ into: "meganium", level: 32 }],
    cyndaquil: [{ into: "quilava", level: 14 }],
    quilava: [{ into: "typhlosion", level: 36 }],
    totodile: [{ into: "croconaw", level: 18 }],
    croconaw: [{ into: "feraligatr", level: 30 }],
    sentret: [{ into: "furret", level: 15 }],
    hoothoot: [{ into: "noctowl", level: 20 }],
    ledyba: [{ into: "ledian", level: 18 }],
    spinarak: [{ into: "ariados", level: 22 }],
    chinchou: [{ into: "lanturn", level: 27 }],
    pichu: [{ into: "pikachu", level: 15 }],
    cleffa: [{ into: "clefairy", level: 15 }],
    igglybuff: [{ into: "jigglypuff", level: 15 }],
    togepi: [{ into: "togetic", level: 20 }],
    natu: [{ into: "xatu", level: 25 }],
    mareep: [{ into: "flaaffy", level: 15 }],
    flaaffy: [{ into: "ampharos", level: 30 }],
    marill: [{ into: "azumarill", level: 18 }],
    hoppip: [{ into: "skiploom", level: 18 }],
    skiploom: [{ into: "jumpluff", level: 27 }],
    sunkern: [{ into: "sunflora", item: "sunstone" }],
    wooper: [{ into: "quagsire", level: 20 }],
    pineco: [{ into: "forretress", level: 31 }],
    snubbull: [{ into: "granbull", level: 23 }],
    teddiursa: [{ into: "ursaring", level: 30 }],
    slugma: [{ into: "magcargo", level: 38 }],
    swinub: [{ into: "piloswine", level: 33 }],
    remoraid: [{ into: "octillery", level: 25 }],
    houndour: [{ into: "houndoom", level: 24 }],
    phanpy: [{ into: "donphan", level: 25 }],
    // Tyrogue's canonical three-way split, decided at Lv 20 by the Pokémon's
    // OWN Attack vs Defense. This used to be flattened to `hitmontop` alone,
    // which silently deleted two thirds of the line: no Tyrogue could ever
    // become a Hitmonlee or a Hitmonchan. gt/lt/eq partition every possible
    // stat pair, so exactly one branch always fires — an individual can never
    // end up with no evolution, and all three targets stay reachable.
    //
    // Tyrogue's base Attack and Defense are both 35, so ties (the Hitmontop
    // branch) are common rather than a lottery — and Hitmontop needs that,
    // because unlike Hitmonlee/Hitmonchan (wild in Rock Tunnel) this line is
    // its only source in the game. The detail modal prints the live comparison
    // next to each branch so the outcome is visible before evolving, and EV
    // training / EV berries move the numbers if a player wants a different one.
    tyrogue: [
      { into: "hitmonlee",  level: 20, when: { compare: ["attack", "defense"], op: "gt" } },
      { into: "hitmonchan", level: 20, when: { compare: ["attack", "defense"], op: "lt" } },
      { into: "hitmontop",  level: 20, when: { compare: ["attack", "defense"], op: "eq" } },
    ],
    smoochum: [{ into: "jynx", level: 30 }],
    elekid: [{ into: "electabuzz", level: 30 }],
    magby: [{ into: "magmar", level: 30 }],
    larvitar: [{ into: "pupitar", level: 30 }],
    pupitar: [{ into: "tyranitar", level: 55 }],
};

// Reverse lookup: which species does this evolution stone evolve? Powers the
// Bag's item-first "use a stone" flow and the "Evolves: …" hint. Excludes
// trade+item catalysts (Metal Coat, King's Rock, …) via the `!("trade" in t)`
// guard so only true held-stone evolutions match.
export function stoneTargets(stoneId: string): string[] {
  const out: string[] = [];
  for (const [from, triggers] of Object.entries(evolutions)) {
    for (const t of triggers) {
      if ("item" in t && !("trade" in t) && t.item === stoneId) {
        out.push(from);
        break;
      }
    }
  }
  return out;
}
