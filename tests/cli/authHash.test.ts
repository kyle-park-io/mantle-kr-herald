// tests/cli/authHash.test.ts
import { describe, it, expect } from "vitest";
import { interactiveAuthHash, MIN_PASSWORD_LENGTH } from "../../src/cli/authHash";

/**
 * `pnpm auth:hash` used to refuse an empty username outright — `Username must not be empty.` — even
 * though the username is not an input to the hash at all. `hashPassword(password)` takes one
 * argument and the salt is random, so the account name and the hash are independent: changing
 * `HERALD_AUTH_USERNAME` later leaves the hash valid. The prompt existed only so the tool could
 * print both `.env` lines at once, and on the Vercel path even that is redundant — `DEPLOY.md`
 * registers the username separately with `vercel env add --value`.
 *
 * So it is optional, and the prompt says so. These tests drive the flow through an injected `ask`,
 * which is why the flow lives in `authHash.ts` rather than in `auth-hash.ts` — that file runs on
 * import (top-level await), the same reason `prompt.ts` was extracted from it.
 */

/** Answers the prompts in order, and records what was asked. */
function scriptedAsk(answers: string[]) {
  const asked: string[] = [];
  let i = 0;
  const ask = async (question: string) => {
    asked.push(question);
    return answers[i++] ?? "";
  };
  return { ask, asked };
}

/** Stand-ins for scrypt: the real derivation is ~67MB of work and is covered by password.test.ts. */
const fakeHash = {
  hash: async (password: string) => `scrypt$fake$${password}`,
  verify: async (password: string, encoded: string) => encoded === `scrypt$fake$${password}`,
};

const GOOD = "correct-horse-battery";

describe("interactiveAuthHash", () => {
  it("prints both .env lines when a username is given", async () => {
    const { ask } = scriptedAsk(["mantle-kr", GOOD, GOOD]);
    const out = (await interactiveAuthHash(ask, fakeHash)).join("\n");

    expect(out).toContain("HERALD_AUTH_USERNAME=mantle-kr");
    expect(out).toContain(`HERALD_AUTH_PASSWORD_HASH=scrypt$fake$${GOOD}`);
  });

  // The behaviour Kyle asked for: an empty username is an answer, not an error.
  it("still produces the hash when the username is left blank", async () => {
    const { ask } = scriptedAsk(["", GOOD, GOOD]);
    const out = (await interactiveAuthHash(ask, fakeHash)).join("\n");

    expect(out).toContain(`HERALD_AUTH_PASSWORD_HASH=scrypt$fake$${GOOD}`);
    expect(out).not.toContain("HERALD_AUTH_USERNAME=");
  });

  it("says the username still has to be set somewhere when it was skipped", async () => {
    const { ask } = scriptedAsk(["   ", GOOD, GOOD]);
    const out = (await interactiveAuthHash(ask, fakeHash)).join("\n");

    // Whitespace is not a username.
    expect(out).not.toContain("HERALD_AUTH_USERNAME=");
    expect(out).toContain("HERALD_AUTH_USERNAME");
  });

  it("tells the operator the username prompt is optional", async () => {
    const { ask, asked } = scriptedAsk(["", GOOD, GOOD]);
    await interactiveAuthHash(ask, fakeHash);

    expect(asked[0]).toContain("선택");
  });

  it("hides the password prompts and not the username one", async () => {
    const hidden: boolean[] = [];
    const answers = ["mantle-kr", GOOD, GOOD];
    let i = 0;
    const ask = async (_q: string, isHidden = false) => {
      hidden.push(isHidden);
      return answers[i++];
    };
    await interactiveAuthHash(ask, fakeHash);

    expect(hidden).toEqual([false, true, true]);
  });

  it("refuses a password shorter than the minimum", async () => {
    const { ask } = scriptedAsk(["mantle-kr", "short", "short"]);
    await expect(interactiveAuthHash(ask, fakeHash)).rejects.toThrow(new RegExp(String(MIN_PASSWORD_LENGTH)));
  });

  it("refuses when the confirmation does not match", async () => {
    const { ask } = scriptedAsk(["mantle-kr", GOOD, `${GOOD}x`]);
    await expect(interactiveAuthHash(ask, fakeHash)).rejects.toThrow(/일치하지|match/i);
  });

  /**
   * The round trip is not ceremony: a hash that cannot verify its own password locks the team out of
   * a dashboard reachable from the internet, with nothing to explain why.
   */
  it("refuses to print a hash that cannot verify its own password", async () => {
    const { ask } = scriptedAsk(["mantle-kr", GOOD, GOOD]);
    const broken = { hash: fakeHash.hash, verify: async () => false };
    await expect(interactiveAuthHash(ask, broken)).rejects.toThrow(/verify/i);
  });

  it("derives a real, verifiable hash by default", async () => {
    const { ask } = scriptedAsk(["mantle-kr", GOOD, GOOD]);
    const out = (await interactiveAuthHash(ask)).join("\n");

    expect(out).toMatch(/HERALD_AUTH_PASSWORD_HASH=scrypt\$\d+\$\d+\$\d+\$[^$]+\$\S+/);
  });
});
