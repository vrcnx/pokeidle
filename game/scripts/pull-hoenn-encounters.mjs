import { existsSync, readFileSync, writeFileSync } from "node:fs";
const CACHE = "./.hoenn-enc-cache.json";
const cache = JSON.parse(readFileSync(CACHE, "utf8"));
const get = async (u) => cache[u] ?? (cache[u] = await (await fetch(u)).json());
const region = await get("https://pokeapi.co/api/v2/region/3/");
const out = {};
for (const loc of region.locations) {
  const l = await get(loc.url);
  for (const a of l.areas) {
    const area = await get(a.url);
    for (const pe of area.pokemon_encounters) {
      const em = pe.version_details.find((v) => v.version.name === "emerald");
      if (!em) continue;
      for (const d of em.encounter_details) {
        const method = d.method.name; // walk, surf, old-rod, super-rod, rock-smash...
        ((out[l.name] ??= {})[method] ??= []).push({
          name: pe.pokemon.name, chance: d.chance, min: d.min_level, max: d.max_level,
        });
      }
    }
  }
}
writeFileSync(CACHE, JSON.stringify(cache), "utf8");
writeFileSync("./.hoenn-real-encounters.json", JSON.stringify(out), "utf8");
console.log("route-104 walk:", (out["hoenn-route-104"]?.walk ?? []).map(x=>x.name).join(", "));
console.log("route-104 methods:", Object.keys(out["hoenn-route-104"] ?? {}).join(", "));
console.log("meteor-falls walk:", (out["meteor-falls"]?.walk ?? []).map(x=>x.name).join(", "));
