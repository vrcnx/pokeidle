#!/usr/bin/env node
/**
 * Generate the Hoenn location backgrounds and trainer portraits.
 *
 *   node scripts/gen-hoenn-art.mjs            # everything still missing
 *   node scripts/gen-hoenn-art.mjs route101   # just these
 *
 * ── WHAT THE GAME EXPECTS ────────────────────────────────────────────────
 * components/AppBackground.tsx and the battle scene both resolve
 * `/backgrounds/<locationId>.webp` and fall back to a biome default on 404.
 * So every file here is named for a location id, and a missing one degrades
 * to "generic route" rather than to a broken image — which is why this script
 * can be run in pieces and re-run for the ones that came out badly.
 *
 * 1536x1024 WebP, matching the existing Kanto and Johto art exactly. Nano
 * Banana emits PNG at 3:2; sharp does the resize and the encode.
 *
 * ── IDEMPOTENT BY DEFAULT ────────────────────────────────────────────────
 * Anything already on disk is skipped. Seventy-five images is over an hour of
 * generation and about as many API calls, and a script that redoes finished
 * work every time it is interrupted is a script nobody can afford to
 * interrupt. Delete a file to regenerate it.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import sharp from "sharp";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "backgrounds");
const TOKEN = readFileSync("C:/Users/phoen/.claude/skills/generate-image/.token", "utf8").trim();
const MODEL = "https://api.replicate.com/v1/models/google/nano-banana-pro/predictions";

/**
 * The house style, appended to every location prompt.
 *
 * Lifted from what the existing art actually looks like rather than from a
 * description of it: a bright anime illustration, landmark in the middle
 * distance, and a FLAT EMPTY FOREGROUND. That last part is not decoration —
 * the battle scene stands two Pokemon on the bottom third of this image, so a
 * busy foreground puts scenery through their feet.
 */
const STYLE =
  "Pokemon anime battle background illustration, bright saturated cel-shaded anime art style, " +
  "clean crisp linework, vivid blue sky with fluffy clouds, the landmark in the middle distance, " +
  "a FLAT EMPTY patch of open ground across the whole bottom third for characters to stand on, " +
  "no people, no characters, no text, no logos, no UI, no watermark, wide establishing shot";

/** Portraits are a different shot entirely and get their own suffix. */
const PORTRAIT_STYLE =
  "Pokemon anime character portrait, bright cel-shaded anime art style, clean crisp linework, " +
  "upper body, confident pose, simple softly blurred background, no text, no logos, no watermark";

// ── Locations ────────────────────────────────────────────────────────────
const PLACES = {
  littlerootTown: "a tiny quiet town of two red-roofed houses and a small research lab, wide open sky, surrounded by green fields",
  route101: "a short grassy path between two towns, tall wild grass either side, wildflowers, low hedges",
  oldaleTown: "a very small farming town, a handful of houses and a Pokemon Mart, ploughed fields behind",
  route103: "a windy grassy shoreline on a low cliff above a bright blue sea, scattered trees bent by the wind",
  route102: "a green country lane with flower beds and shallow puddles, birch trees, a wooden fence",
  petalburgCity: "a calm leafy city of low houses divided by narrow water channels and small wooden bridges",
  route104: "a coastal sandy road with pale beach on one side and a dense green wood on the other, sea breeze",
  petalburgWoods: "the inside of a dense damp green forest, thick canopy overhead, shafts of light, mossy logs",
  rustboroCity: "a city of grey stone buildings with tall windows and a large corporate headquarters, quarried cliffs behind",
  route116: "a dusty dry road below sandstone cliffs, leading to a dark tunnel mouth in the rock face",
  rusturfTunnel: "the inside of an unfinished rock tunnel, rough stone walls, wooden support beams, dim lantern light",
  route115: "a windswept clifftop shore with crashing waves far below, sparse grass and rocky outcrops",
  route105: "open blue sea with scattered dark rocks breaking the surface, distant hazy coastline",
  route106: "rough open sea with white-capped waves, a tall cliff and a cave mouth on the far shore",
  dewfordTown: "a small island fishing town of wooden houses on stilts, boats, nets drying, pale sand beach",
  graniteCave: "the inside of a pale granite cave, layered rock strata, glittering crystals in the dark depths",
  route107: "warm shallow turquoise sea over pale sand, gentle waves, a coral shelf visible below",
  route108: "deep blue open ocean, the rusted superstructure of a wrecked ship on the horizon",
  route109: "a busy sandy beach with beach umbrellas and calm sea, a port city visible along the shore",
  slateportCity: "a busy port city with market stalls, shipyard cranes, moored boats and a lighthouse",
  route110: "a long coastal road running beneath an elevated cycling track, sea on one side, pylons",
  mauvilleCity: "a bright modern city on a flat grid, neon game corner sign, wide clean streets",
  route117: "a gentle green meadow with a small day care cottage, long grass and wildflowers",
  verdanturfTown: "a clean bright town of white cottages on a plateau, a huge volcano looming on the horizon",
  route111: "a harsh sandy desert with a low sandstorm blowing, dry rocks and cacti, hazy sun",
  route112: "a volcanic slope of black grit and dark ash, warm orange glow from the mountain above",
  fieryPath: "the inside of a volcanic tunnel, glowing orange cracks in the black rock, steam vents",
  route113: "a road buried deep in soft grey volcanic ash, ash falling like snow, bare trees",
  fallarborTown: "a small farming town covered in a fine layer of grey ash, fields, a volcano on the horizon",
  route114: "a rocky descent past boulders and a stone carver's hut, a waterfall in the distance",
  meteorFalls: "a vast cavern with tall waterfalls falling into a glowing blue underground lake, pale light from above",
  jaggedPass: "a steep switchback mountain trail on a volcanic flank, loose scree, wind, a wide view below",
  lavaridgeTown: "a hot spring town built on a mountainside, steam rising from stone pools, cracked tile roofs",
  route118: "a wide slow river mouth meeting the sea, reeds, anglers' jetties, low green hills",
  route119: "a humid green corridor of very tall grass between steep wooded banks, light rain, a river",
  fortreeCity: "a city of wooden treehouses built high in an enormous forest canopy, rope bridges between them",
  route120: "a misty forest of shallow ponds and stepping stones, ferns, soft grey light",
  route121: "open rolling grassland sloping down toward a distant harbour city and the sea",
  lilycoveCity: "a large harbour city with a department store, a curving bay, ships at anchor",
  route122: "choppy grey-blue sea at the foot of a dark forested mountain, still and quiet",
  mtPyre: "a misty graveyard mountain of weathered stone markers and hanging wind chimes, tall pines",
  route123: "a long terraced hillside of berry patches and flower beds above the southern coast",
  route124: "wide open eastern sea, brilliant blue, the shadow of a sunken village visible below the surface",
  mossdeepCity: "an island city of white sand and modern white buildings, two large satellite dishes on a hill",
  route125: "rocky coastal water with jagged black rocks and a strong current, grey sky",
  shoalCave: "the inside of a tidal sea cave, wet dark rock, shallow pools, glittering ice at the back",
  route126: "deep blue open water above a huge submerged crater, the rim just visible below",
  sootopolisCity: "a white city built in tiers inside a dormant volcanic crater, a still lagoon at the centre",
  caveOfOrigin: "the inside of a deep, ancient, silent cave, smooth dark stone, faint blue light from far below",
  route127: "open deep sea under a wide sky, no land in any direction, long swells",
  route128: "very deep dark blue ocean water, storm light on the horizon",
  seafloorCavern: "the inside of an underwater cavern, dark wet rock, shafts of filtered blue light from above",
  route129: "rough southern sea with huge swells, the back of something enormous breaking the surface",
  route130: "flat empty calm sea under a huge sky, a faint mirage of an island on the horizon",
  route131: "calm blue water in the shelter of a tall crumbling stone tower on a small island",
  pacifidlogTown: "a town of wooden houses built on log rafts floating on the sea, joined by plank walkways",
  skyPillar: "the top of an ancient crumbling stone tower rising far above the clouds, broken floors",
  route132: "a broken chain of tiny rocky islets in shallow turquoise water",
  route133: "deep open ocean with a strong current, whitecaps, empty horizon",
  route134: "a fast open-sea current pulling west, churning water, spray",
  everGrandeCity: "a huge cliff of tiered waterfalls and flowers with a grand league building at the summit",
  victoryRoadHoenn: "the inside of a huge final cave, vaulted rock ceiling, boulders, a distant bright exit",
};

// ── Portraits ────────────────────────────────────────────────────────────
const PEOPLE = {
  gym_roxanne: "a calm studious teenage girl in a school uniform with long dark brown hair in twin loops, rock-type gym leader, standing in a quarry",
  gym_brawly: "a cheerful athletic young man with messy blue hair, tanned, surfer, fighting-type gym leader, on a beach",
  gym_wattson: "a jolly stout old man with a huge white beard and moustache, laughing, electric-type gym leader, in a bright generator room",
  gym_flannery: "a determined young woman with long spiky red hair, fire-type gym leader, standing before a volcanic hot spring",
  gym_norman: "a stern composed adult man in a dark red shirt, short brown hair, normal-type gym leader, in a wooden dojo",
  gym_winona: "a graceful young woman with long teal hair in a flowing purple flight outfit, flying-type gym leader, high in a treetop city",
  gym_tateAndLiza: "twin siblings, a boy and a girl with matching orange hair, psychic-type gym leaders, floating in a starry observatory",
  gym_wallace: "an elegant refined man with teal hair in an ornate white and blue cape, water-type gym leader, before a still lagoon",
  e4_sidney: "a rough grinning man with spiky red hair and a dark jacket, dark-type elite four, in a shadowy hall",
  e4_phoebe: "a cheerful young woman in a yellow hibiscus outfit with dark hair, ghost-type elite four, in a misty hall of spirits",
  e4_glacia: "a poised older woman with long pale blonde hair in a purple dress, ice-type elite four, in a hall of ice",
  e4_drake: "a weathered old sea captain with grey hair and beard in a naval coat, dragon-type elite four, in a hall of dragons",
  champion_steven: "a calm silver-haired young man in a smart black suit holding a rare stone, steel-type champion, in a grand crystal hall",
};

// ── Runner ───────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(url, init) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, init);
    if (r.ok) return r.json();
    // 429 and 5xx are worth waiting out; a 4xx is our own mistake and is not.
    if (r.status !== 429 && r.status < 500) throw new Error(`${r.status} ${await r.text()}`);
    await sleep(4000 * (attempt + 1));
  }
  throw new Error(`gave up on ${url}`);
}

async function generate(name, prompt, aspect) {
  const dest = join(OUT, `${name}.webp`);
  if (existsSync(dest)) return "skip";

  let pred = await api(MODEL, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Prefer: "wait" },
    body: JSON.stringify({
      input: { prompt, aspect_ratio: aspect, resolution: "2K", output_format: "png" },
    }),
  });

  const deadline = Date.now() + 5 * 60_000;
  while (!["succeeded", "failed", "canceled"].includes(pred.status)) {
    if (Date.now() > deadline) throw new Error(`${name}: timed out in ${pred.status}`);
    await sleep(4000);
    pred = await api(`https://api.replicate.com/v1/predictions/${pred.id}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  }
  if (pred.status !== "succeeded") throw new Error(`${name}: ${pred.error ?? pred.status}`);

  const url = Array.isArray(pred.output) ? pred.output[0] : pred.output;
  const png = Buffer.from(await (await fetch(url)).arrayBuffer());
  // 1536x1024 to match every existing background exactly. `cover` rather than
  // `contain` so a slightly-off aspect crops instead of letterboxing — a black
  // bar across a battle background is far more visible than a lost 2% of sky.
  const [w, h] = aspect === "3:2" ? [1536, 1024] : [1024, 1024];
  await sharp(png).resize(w, h, { fit: "cover" }).webp({ quality: 82 }).toFile(dest);
  return "made";
}

const only = process.argv.slice(2);
const jobs = [
  ...Object.entries(PLACES).map(([n, p]) => [n, `${p}. ${STYLE}`, "3:2"]),
  ...Object.entries(PEOPLE).map(([n, p]) => [n, `${p}. ${PORTRAIT_STYLE}`, "1:1"]),
].filter(([n]) => !only.length || only.includes(n));

mkdirSync(OUT, { recursive: true });
console.log(`${jobs.length} candidates`);

// Six at a time. Enough to keep the queue busy without collecting 429s, and
// small enough that an interruption loses six images rather than seventy-five.
const CONCURRENCY = 6;
let made = 0, skipped = 0;
const failed = [];
const queue = [...jobs];

await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length) {
    const [name, prompt, aspect] = queue.shift();
    try {
      const r = await generate(name, prompt, aspect);
      if (r === "skip") { skipped++; continue; }
      made++;
      console.log(`  ${made + skipped}/${jobs.length}  ${name}`);
    } catch (e) {
      failed.push(`${name}: ${String(e.message ?? e).slice(0, 120)}`);
    }
  }
}));

console.log(`\nmade ${made}, already had ${skipped}, failed ${failed.length}`);
failed.forEach((f) => console.log("  " + f));
if (failed.length) {
  writeFileSync(join(ROOT, ".hoenn-art-failed.txt"), failed.join("\n"), "utf8");
  console.log("\nre-run with the names above to retry just those.");
}
