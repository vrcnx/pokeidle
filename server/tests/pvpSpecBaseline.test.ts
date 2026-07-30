// A content baseline for the six PvP spec files, because git does not have one.
//
// ─── Why a hash pin, of all things ────────────────────────────────────────
//
// src/pvp.ts was rebuilt after ~600 lines of uncommitted work were destroyed by
// a mistaken `git checkout --` on that path. The rebuild was driven by two
// survivors: src/socket.ts (the API contract) and six test files that encode the
// required behaviour —
//
//     tests/pvpReconnect.test.ts        tests/pvpRejoinLeak.test.ts
//     tests/pvpOutcomeIntegrity.test.ts tests/pvpForfeitBounds.test.ts
//     tests/pvpBot.test.ts              tests/pvpSocketE2E.test.ts
//
// The standing rule for that rebuild is that a spec file may not be weakened,
// skipped, rewritten or deleted to make the implementation pass. The obvious way
// to verify that rule is `git diff`, and it does not work: NONE of the six is
// tracked. Executed at the time:
//
//     git cat-file -e HEAD:server/tests/pvpReconnect.test.ts
//         → "exists on disk, but not in HEAD"   (same for all six)
//     git log --all -- server/tests/pvpBot.test.ts        → empty
//     git stash list                                      → empty
//
// So there is no baseline to diff against, and "no spec test was weakened" was
// unverifiable by git alone — it rested on transcript archaeology and on file
// mtimes. Four of the six could be replayed byte-exactly from the session
// transcripts; pvpBot.test.ts and pvpSocketE2E.test.ts could not, because their
// recorded edit history is incomplete.
//
// This file is the substitute baseline, and unlike mtimes it survives a copy, a
// zip, a fresh clone and a reformat. The hashes below are the content as it stood
// at the end of the rebuild — which is, for pvpOutcomeIntegrity.test.ts, 21,973
// normalised characters, the exact length the transcript replay reproduced.
//
// ─── If this test fails ───────────────────────────────────────────────────
//
// It is not a bug in this file. Either
//
//   (a) a spec file was edited, in which case the diff belongs in the same
//       review as the edit: say what changed, why the behaviour it asserted is
//       no longer required, and update the hash in the SAME commit; or
//   (b) a spec file was edited by accident, which is the whole point.
//
// Update a hash with:
//     node -e "const fs=require('fs'),c=require('crypto');\
//       const s=fs.readFileSync('tests/<file>.test.ts','utf8').replace(/\r\n/g,'\n');\
//       console.log(c.createHash('sha256').update(s,'utf8').digest('hex'), s.length)"
//
// Line endings are normalised to \n before hashing: the files are CRLF on disk
// here, and a checkout with different EOL settings must not read as tampering.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

interface Baseline {
  file: string;
  sha256: string;
  /** Characters after \r\n → \n normalisation. Redundant with the hash, but it
   *  turns "the hash changed" into "the file grew by 300 characters", which is
   *  the first thing anybody wants to know. */
  chars: number;
  /** Source-level `it(` declarations — a deleted test is otherwise just a
   *  smaller file. */
  its: number;
  describes: number;
}

const BASELINE: Baseline[] = [
  { file: "pvpReconnect.test.ts",        sha256: "51e0d3b13e30c05e59e06153544b839da6d5dee42a7eec98e7158723cca713c2", chars: 33166, its: 23, describes: 5 },
  { file: "pvpRejoinLeak.test.ts",       sha256: "c0d528e0b14f6730e6a395c19d432f1443036ca344737dca5ec9efab56d8de12", chars: 20905, its: 5,  describes: 2 },
  { file: "pvpOutcomeIntegrity.test.ts", sha256: "10f05440c4f76c1188388f8ce0af7ccc2f56f6d8e9bd0b5e8c857e868a359d9c", chars: 21973, its: 10, describes: 5 },
  { file: "pvpForfeitBounds.test.ts",    sha256: "47bbffd593a3c7d135f1500f9ae2a44039e9a16d452b3fcfc0d782083f9a48c5", chars: 18294, its: 10, describes: 4 },
  { file: "pvpBot.test.ts",              sha256: "2ed8211adc2d561f02c7acaf773e186cf6fa9a533475e332f6dd33536293eddb", chars: 71567, its: 51, describes: 16 },
  { file: "pvpSocketE2E.test.ts",        sha256: "aa1eec7b28c1dc6528e6fb5beaff642bf629d2952f246742b48735592fc3fd45", chars: 41137, its: 25, describes: 10 },
];

const TESTS = path.join(process.cwd(), "tests");
const normalised = (file: string) =>
  fs.readFileSync(path.join(TESTS, file), "utf8").replace(/\r\n/g, "\n");
const sha256 = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

describe("the six PvP spec files are the ones the rebuild was verified against", () => {
  it.each(BASELINE.map((b) => [b.file, b] as const))("%s is byte-identical", (_name, b) => {
    const src = normalised(b.file);
    expect(src.length, `${b.file} changed length`).toBe(b.chars);
    expect(
      sha256(src),
      `${b.file} has been modified. If that was deliberate, review the diff and update the hash in BASELINE — see the header of this file.`,
    ).toBe(b.sha256);
    expect((src.match(/^\s*it(\.each)?\(/gm) ?? []).length, `${b.file} test count changed`).toBe(b.its);
    expect((src.match(/^\s*describe\(/gm) ?? []).length, `${b.file} describe count changed`).toBe(b.describes);
  });

  it("covers all six and nothing else claims to be one", () => {
    expect(BASELINE).toHaveLength(6);
    for (const b of BASELINE) expect(fs.existsSync(path.join(TESTS, b.file))).toBe(true);
    // The hashes must be distinct: a copy-paste error that pointed two entries
    // at the same digest would silently stop guarding one of the files.
    expect(new Set(BASELINE.map((b) => b.sha256)).size).toBe(6);
    // Positive control: the comparison is sensitive to a single character, so a
    // green run above is evidence and not an artefact of the normalisation step
    // flattening everything to the same string.
    const [first] = BASELINE;
    expect(sha256(`${normalised(first.file)} `)).not.toBe(first.sha256);
    expect(sha256(normalised(first.file).replace("describe(", "describe (")))
      .not.toBe(first.sha256);
  });

  it("contains no disabled, exclusive or soft assertions", () => {
    // The cheapest way to "make the suite pass" is to disable the test that
    // says otherwise, and it leaves the file looking fully populated. Checked
    // separately from the hash so the failure message says WHY rather than just
    // "the hash moved".
    for (const b of BASELINE) {
      const src = normalised(b.file);
      for (const marker of [
        /\bit\.skip\(/, /\bit\.only\(/, /\bit\.todo\(/, /\bit\.fails\(/,
        /\bdescribe\.skip\(/, /\bdescribe\.only\(/, /\bdescribe\.todo\(/,
        /\bxit\(/, /\bxdescribe\(/, /\bexpect\.soft\(/,
      ]) {
        expect(marker.test(src), `${b.file} contains ${marker.source}`).toBe(false);
      }
    }
  });

  it("records why a hash pin is used instead of git", () => {
    // The reason is load-bearing: if the six ever become tracked, `git diff` is
    // strictly better than this file and this file should go. Until then the
    // absence of a baseline is the thing being worked around, so it is asserted
    // rather than left as a comment somebody may not believe.
    const self = fs.readFileSync(path.join(TESTS, "pvpSpecBaseline.test.ts"), "utf8");
    expect(self).toContain("NONE of the six is tracked");
  });
});
