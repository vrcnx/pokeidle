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

// ─── REVISION 2 · Team Preview was turned on ────────────────────────────
//
// Five of the six moved, and the header above says the diff belongs in the same
// review as the edit. It is this note.
//
// WHAT CHANGED IN THE PRODUCT. `simFormatId(false)` became `simFormatId(true)`:
// Custom Game's Team Preview phase is live, so the first |request| every side
// receives is `{"teamPreview":true}` with no `active` and no moves, and nothing
// reaches turn 1 until both sides answer it. src/pvp.ts arms a 20-second
// auto-lock inside startBattle so the phase can never stall a battle.
//
// WHY EVERY DRIVER HAD TO MOVE. `applyChoice(room, "uA", "move 1")` immediately
// after startBattle used to be correct and is not any more — the simulator
// answers it with `|error|[Invalid choice] Can't move: You need a teampreview
// response` and the battle stays in the phase. Worse for a ratchet's purposes:
// applyChoice still returns `{ok:true}` for that write, because the refusal is
// asynchronous, so the affected files would have kept PASSING while measuring
// choices the simulator threw away. Every edit below is a driver answering the
// phase, and tests/pvpForfeitBounds.test.ts additionally asserts the phase was
// really entered and really left so that vacuity is not available again.
//
// THE ONE BEHAVIOURAL ASSERTION THAT WAS INVERTED, and it is the one worth
// reading the diff for: pvpRejoinLeak.test.ts and pvpBot.test.ts asserted that
// the SPECIES of an opponent's Pokemon which had never taken the field was
// absent from a rejoin snapshot. Team Preview publishes all six species to both
// players before turn 1 — that IS the phase — so the claim is now false by
// design and keeping it would only have measured whether the feature failed to
// happen. Both were inverted to assert the species is PRESENT, and the private
// half (nickname, held item, ability, moves, EV/IV spread, the opponent's own
// |request| payload, and the `|poke|…|item` held-item marker) is asserted
// ABSENT by name. That is strictly stronger than what they said before: the old
// blanket negative was satisfied for free by a disabled phase, and the new pair
// is not.
//
// NOTHING WAS WEAKENED, and the counts below are the evidence rather than the
// claim: `its` and `describes` are UNCHANGED for all five (23/5, 5/2, 10/5,
// 10/4, 51/16), and every one of the five grew. No test was deleted, skipped or
// softened — the "no disabled, exclusive or soft assertions" case further down
// still runs over all six.
//
// pvpSocketE2E.test.ts is untouched and its hash is unmoved: it asserts the
// TRANSPORT contract (a battle:choose is acked, a room stays "active", a player
// is never locked out), none of which depends on which phase the simulator is
// in. It was green through the whole change.
//
// ─── REVISION 3 · the optimistic ack was closed, and it caught this file ──
//
// REVISION 2's last paragraph, immediately above, is the thing this revision
// disproves — and it disproves it in the most useful possible way, so it is
// left standing rather than edited out.
//
// It said pvpSocketE2E.test.ts was green through the Team Preview change and
// therefore unaffected. It WAS green. It was green because of the defect
// REVISION 2 itself described two paragraphs earlier: applyChoice returned
// `{ok: true}` for a `move` written during the phase, because the simulator's
// refusal is asynchronous. Two tests in that file assert exactly `{ok: true}`
// for a `move 1` sent moments after `battle:start` — so they were measuring a
// choice the simulator discarded, and the transport contract they claim to pin
// ("a player is never locked out") was never actually exercised.
//
// src/pvp.ts's choiceFitsPhase now refuses an off-phase choice SYNCHRONOUSLY,
// from the request the server already holds, so those two acks turned into
// `{ok: false, error: "team preview: pick a lead first"}` and the file went red
// — which is the ratchet doing its job in the direction it was built for.
//
// WHAT CHANGED IN THE FILE, and nothing else did:
//   * a `leavePreview(A, B, battleId)` helper, which answers the phase for both
//     seats over the REAL socket (`battle:choose` with `default`, the same
//     string the server's own auto-lock writes) and returns once both requests
//     are turn-1 requests;
//   * one call to it in "E2E reconnect probe limiter", before the closing
//     `move 1`;
//   * one call to it in "E2E choose during grace", before A disconnects — the
//     seat has to lock its lead while it still has a socket, or the battle
//     would be sitting on the 20-second auto-lock and the test would be about
//     the phase rather than about the grace window;
//   * one import of isTeamPreviewRequest.
//
// NOTHING WAS WEAKENED. `its` 25 and `describes` 10 are both UNCHANGED, no
// assertion was deleted or relaxed, and the two `toEqual({ok: true})` claims are
// still there — they are now true of a real turn-1 move instead of being
// vacuously satisfied by a discarded one. The file grew by 2,303 characters,
// all of them the helper and its comment.
const BASELINE: Baseline[] = [
  { file: "pvpReconnect.test.ts",        sha256: "fbfa41b82346ddfdd7180e54d4f8e67b639ea07b921d1b48ea0d2ca094ea9765", chars: 33952, its: 23, describes: 5 },
  { file: "pvpRejoinLeak.test.ts",       sha256: "ae0e51a6b4906f4e705f9bfc5520315035b4e3d7b5fe99d4017916084a05699b", chars: 24036, its: 5,  describes: 2 },
  { file: "pvpOutcomeIntegrity.test.ts", sha256: "47738c560621ab6b6d7acd3d656dc0037e90836604c4c687a650f3d9f12af964", chars: 24658, its: 10, describes: 5 },
  { file: "pvpForfeitBounds.test.ts",    sha256: "04b1f85f9270fe0644974c4f6127348d45ae6c9179d0f4f224f8ca913bcc90e4", chars: 19533, its: 10, describes: 4 },
  { file: "pvpBot.test.ts",              sha256: "f1bcb589e9bfac49702aad858b053280384514a681d29952455cf9a403efc471", chars: 76026, its: 51, describes: 16 },
  { file: "pvpSocketE2E.test.ts",        sha256: "d180e40314a834edfc19d31f3daa3a1001050251b9240e06e4f8d2185ad7f7c0", chars: 43440, its: 25, describes: 10 },
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
