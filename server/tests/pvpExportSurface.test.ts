// Everything that imports src/pvp.ts by name must still find it there.
//
// ─── The hole this closes ─────────────────────────────────────────────────
//
// src/pvp.ts was rebuilt from scratch after its uncommitted state was lost, and
// the evidence offered that nothing had been dropped was "tsc --noEmit is clean
// and the suite is green". Neither statement covers the tests, and that was
// measured on this repo:
//
//   1. tsconfig.json is the production build (`include: ["src/**/*"]`). Before
//      tsconfig.test.json existed:
//          npx tsc --noEmit --listFiles | grep -c server.tests   →  0
//          npx tsc --noEmit --listFiles | grep -c server.src     →  58
//      so no test file was typechecked at all.
//
//   2. vitest cannot cover the gap either, because Vite's SSR transform rewrites
//      `import { foo } from "../src/pvp.js"` into a property read on the module
//      namespace. Executed, same file, two pipelines:
//          vite-node (what vitest uses):
//              import { startBattle, thisExportDoesNotExist } from ".../pvp.ts"
//              → startBattle: function, thisExportDoesNotExist: undefined,
//                module LINKED WITH NO ERROR
//          real Node ESM (tsx), identical source:
//              → SyntaxError: The requested module does not provide an export
//                named 'thisExportDoesNotExist'
//
// So a dropped export reaches a test as `undefined` and only fails if some test
// happens to CALL it — a `typeof x === "function"` guard, an optional call, or a
// name used solely in a `deps` object literal would sail straight through. For a
// module with 44 value exports and 10 exported types consumed by src/socket.ts,
// lib/tournamentRunner.ts, routes/admin.ts and seven test files, "green" was not
// the same as "complete".
//
// This file is the link step the toolchain does not perform: it reads every
// importer's own import statements as the specification, and checks each name
// against the real module namespace. It runs inside the ordinary suite, because
// a test run must not depend on somebody having run tsc.
//
// It also pins the two pieces of configuration that close the type half
// (tsconfig.test.json, and `npm run typecheck` running it), so the ratchet
// cannot be silently removed while this file keeps passing.

import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const db = vi.hoisted(() => ({
  prisma: {
    pvpMatch: { create: vi.fn(async () => ({})) },
    playerRating: { upsert: vi.fn(async () => ({ rating: 1000, peakRating: 1000 })), update: vi.fn(async () => ({})) },
    $transaction: vi.fn(async () => ({})),
    $executeRaw: vi.fn(async () => 1),
  },
}));
vi.mock("../src/db.js", () => ({ prisma: db.prisma }));

import * as pvp from "../src/pvp.js";

const ROOT = process.cwd();

// ── Collecting the specification ──────────────────────────────────────────

interface Requested {
  /** Where the import statement is, for the failure message. */
  from: string;
  /** Names imported as VALUES — these must exist in the namespace. */
  values: string[];
  /** Names imported as types (`import type {}` or an inline `type X`). */
  types: string[];
}

/** Every named import of `./pvp.js` / `../src/pvp.js` in one file.
 *
 *  Comments are stripped first: files in this repo document the protocol in
 *  prose, and this very file quotes an import statement in its own header —
 *  which the first run of this test duly reported as a missing export named
 *  `foo`. Funny, but it means a commented-out or quoted import must not count. */
function requestedFrom(file: string): Requested | null {
  const src = fs.readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const re = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']([^"']*\/pvp\.js)["']/g;
  const values: string[] = [];
  const types: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const wholeBlockIsTypes = Boolean(m[1]);
    for (const raw of m[2].split(",")) {
      const entry = raw.trim();
      if (!entry) continue;
      const isType = wholeBlockIsTypes || /^type\s/.test(entry);
      // `foo as bar` imports `foo`; `type Foo as Bar` likewise.
      const name = entry.replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      (isType ? types : values).push(name);
    }
  }
  if (values.length === 0 && types.length === 0) return null;
  return { from: path.relative(ROOT, file), values, types };
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(p, out); }
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const importers = [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "tests"))]
  .filter((f) => path.resolve(f) !== path.resolve(ROOT, "src", "pvp.ts"))
  .map(requestedFrom)
  .filter((r): r is Requested => r !== null)
  .sort((a, b) => a.from.localeCompare(b.from));

/** The check itself, factored out so the positive control below runs exactly
 *  the same code against a deliberately-wrong specification. */
function missingValues(req: Requested, ns: Record<string, unknown>): string[] {
  return req.values.filter((n) => !(n in ns) || typeof ns[n] === "undefined");
}

const ns = pvp as unknown as Record<string, unknown>;
const pvpSource = fs.readFileSync(path.join(ROOT, "src", "pvp.ts"), "utf8");

// ══ 1 · the parse found the real importers ════════════════════════════════

describe("the import specification was actually read", () => {
  it("found socket.ts and the other production consumers", () => {
    const files = importers.map((r) => r.from.replace(/\\/g, "/"));
    // socket.ts is the API contract: it is the file that survived the incident
    // and it is what the rebuild was reconstructed against.
    expect(files).toContain("src/socket.ts");
    expect(files).toContain("src/lib/tournamentRunner.ts");
    expect(files).toContain("src/routes/admin.ts");
    // …and the six spec test files, which are the executable specification.
    for (const spec of [
      "tests/pvpReconnect.test.ts", "tests/pvpRejoinLeak.test.ts",
      "tests/pvpOutcomeIntegrity.test.ts", "tests/pvpForfeitBounds.test.ts",
      "tests/pvpBot.test.ts", "tests/pvpSocketE2E.test.ts",
    ]) expect(files).toContain(spec);
    // A parse that silently yielded nothing would make section 2 vacuous.
    expect(importers.length).toBeGreaterThanOrEqual(9);
  });

  it("reads the namespace it is checking against", () => {
    // 44 runtime value exports at the time of writing. Asserted as a floor
    // rather than an equality: adding an export is normal, losing one is not.
    const valueExports = Object.keys(ns).filter((k) => typeof ns[k] !== "undefined");
    expect(valueExports.length).toBeGreaterThanOrEqual(44);
    expect(valueExports).toContain("startBattle");
    expect(valueExports).toContain("resolveRejoin");
  });
});

// ══ 2 · every requested name resolves ════════════════════════════════════

describe("every name any importer asks src/pvp.ts for exists", () => {
  it.each(importers.map((r) => [r.from, r] as const))(
    "%s",
    (_from, req) => {
      const missing = missingValues(req, ns);
      expect(
        missing,
        `${req.from} imports ${missing.join(", ")} from pvp.ts, and pvp.ts does not export it. ` +
        "Under Vite's SSR transform this arrives as undefined instead of failing to link.",
      ).toEqual([]);

      // Types cannot be checked at runtime — they are erased — so they are
      // checked against the source's export declarations instead. `npm run
      // typecheck` covers them properly now (tsconfig.test.json); this is the
      // belt to that braces, and it is what catches an interface that was
      // renamed rather than dropped.
      const missingTypes = req.types.filter(
        (n) => !new RegExp(`export\\s+(interface|type|class|enum)\\s+${n}\\b`).test(pvpSource),
      );
      expect(
        missingTypes,
        `${req.from} imports type(s) ${missingTypes.join(", ")} that pvp.ts does not export`,
      ).toEqual([]);
    },
  );

  it("would notice a dropped export — the check is not vacuous", () => {
    // Positive control through the same function, with a specification that
    // names something pvp.ts has never exported. If this ever returns [], the
    // assertions above are measuring nothing.
    const bogus: Requested = {
      from: "positive-control",
      values: ["startBattle", "thisExportDoesNotExist"],
      types: [],
    };
    expect(missingValues(bogus, ns)).toEqual(["thisExportDoesNotExist"]);
  });

  it("counts the whole surface, so a rename cannot pass as a drop-plus-add", () => {
    // The names the incident's post-mortem listed as "must exist", verbatim
    // from the recovery brief, plus the ones the spec files drive directly.
    const brief = [
      "cancelQueueGrace", "startMatchmakingTicker", "stopMatchmakingTicker",
      "beginReconnectGrace", "beginDisconnectGrace", "endDisconnectGrace",
      "resolveRejoin", "resolveSync", "flushPvpPersists", "queuedUserIds",
    ];
    expect(brief.filter((n) => typeof ns[n] === "undefined")).toEqual([]);
    // GraceDeps was named in the same list and is a type, so it is checked in
    // the source rather than the namespace.
    expect(/export\s+interface\s+GraceDeps\b/.test(pvpSource)).toBe(true);
  });
});

// ══ 3 · the same hole in the other direction: socket.ts's own surface ════

describe("every name a test asks src/socket.ts for exists too", () => {
  // socket.ts cannot be imported here — it constructs better-auth and a
  // socket.io Server at module scope, which is why pvpSocketE2E.test.ts mocks
  // half the world to do it. So this half is checked against the source's export
  // declarations. Weaker than a namespace read, but it catches the case that
  // actually happened during the rebuild: a name in an import list that the
  // module no longer declares. pvpSocketE2E.test.ts imports the real module and
  // gains no link-time guarantee from doing so, for the same SSR-transform
  // reason as pvp.ts.
  const socketSource = fs.readFileSync(path.join(ROOT, "src", "socket.ts"), "utf8");
  const declares = (name: string) => new RegExp(
    `export\\s+(async\\s+)?(function|const|let|class|interface|type|enum)\\s+${name}\\b`
    + `|export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`,
  ).test(socketSource);

  const socketImporters = walk(path.join(ROOT, "tests"))
    .map((f) => {
      const src = fs.readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      const names: string[] = [];
      const re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'][^"']*\/socket\.js["']/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        for (const raw of m[1].split(",")) {
          const n = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
          if (n) names.push(n);
        }
      }
      return names.length ? { from: path.relative(ROOT, f), names } : null;
    })
    .filter((r): r is { from: string; names: string[] } => r !== null);

  it("found the E2E file that drives the real socket module", () => {
    expect(socketImporters.map((r) => r.from.replace(/\\/g, "/")))
      .toContain("tests/pvpSocketE2E.test.ts");
  });

  it.each(socketImporters.map((r) => [r.from, r] as const))("%s", (_from, req) => {
    const missing = req.names.filter((n) => !declares(n));
    expect(missing, `${req.from} imports ${missing.join(", ")} from socket.ts, which does not export it`)
      .toEqual([]);
  });

  it("the declaration check is not vacuous", () => {
    expect(declares("thisExportDoesNotExist")).toBe(false);
    // A name socket.ts really does export, as the positive half.
    expect(req_sanity()).toBe(true);
    function req_sanity(): boolean {
      const anyName = socketImporters.flatMap((r) => r.names)[0];
      return anyName !== undefined && declares(anyName);
    }
  });
});

// ══ 4 · the type half of the gap stays closed ════════════════════════════

describe("the tests are typechecked", () => {
  it("has a test tsconfig that actually includes tests/", () => {
    const raw = fs.readFileSync(path.join(ROOT, "tsconfig.test.json"), "utf8");
    // Comments are legal in tsconfig and this one is heavily commented, so it is
    // read as text rather than JSON.parsed.
    expect(raw).toContain('"include": ["src/**/*", "tests/**/*"]');
    expect(raw).toContain('"noEmit": true');
  });

  it("runs it from npm run typecheck", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as
      { scripts: Record<string, string> };
    expect(pkg.scripts.typecheck).toContain("tsc -p tsconfig.test.json");
    // The src-only check must survive too: it is the one that covers the
    // production import graph, including the type-only imports in socket.ts.
    expect(pkg.scripts.typecheck).toContain("tsc --noEmit");
  });
});
