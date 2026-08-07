// The one message the chat box does not send.
//
// `/link` is the DISCORD bot's command, and players run it here because the
// Rewards card tells them to run it and this is the only text box in the
// game. Intercepting it shows them where it actually belongs.
//
// The asymmetry is the whole point of these tests. Missing a variant costs
// one player one confusing moment. SWALLOWING a real message is much worse:
// they watch it vanish with no explanation, and it looks like chat is broken.
// So every test below that asserts `false` matters more than the ones that
// assert `true`.

import { describe, expect, it } from "vitest";
import { isDiscordLinkCommand } from "../src/utils/chatCommands";

describe("catches somebody reaching for the Discord command", () => {
  it("matches the bare command", () => {
    expect(isDiscordLinkCommand("/link")).toBe(true);
  });

  it("forgives casing and stray whitespace, because those are typing", () => {
    for (const s of ["/LINK", "/Link", "  /link", "/link  ", "\t/link\n"]) {
      expect(isDiscordLinkCommand(s), s).toBe(true);
    }
  });
});

describe("never eats a real message", () => {
  it("leaves a question about linking alone", () => {
    // The message most likely to be destroyed by a sloppier rule, and the
    // one a player is most likely to be typing when they need an answer.
    for (const s of [
      "how do I /link?",
      "run /link in discord",
      "/link doesn't work for me",
      "did you /link yet",
    ]) {
      expect(isDiscordLinkCommand(s), s).toBe(false);
    }
  });

  it("does not prefix-match a different word", () => {
    for (const s of ["/linked", "/linking", "/links"]) {
      expect(isDiscordLinkCommand(s), s).toBe(false);
    }
  });

  it("does not take arguments", () => {
    // `/link ABC123` is someone pasting their code into the wrong box. It is
    // still not this command — and it must NOT be swallowed silently, because
    // that code is a secret they would then never learn they leaked.
    for (const s of ["/link ABC123", "/link me", "/link discord"]) {
      expect(isDiscordLinkCommand(s), s).toBe(false);
    }
  });

  it("ignores other slash commands entirely", () => {
    for (const s of ["/profile", "/help", "/", "//link", "link"]) {
      expect(isDiscordLinkCommand(s), s).toBe(false);
    }
  });
});
