// tests/cli/prompt.test.ts
import { describe, it, expect } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ask } from "../../src/cli/prompt";
import { REPO_ROOT } from "../../src/paths";

/**
 * Pins what the terminal actually *sees* while `pnpm auth:hash` asks for a password.
 *
 * The obvious way to hide typed input — silence readline's `_writeToOutput` hook and print the
 * prompt by hand — is broken in a way no assertion on the return value can catch: `_refreshLine()`
 * writes its cursor-home (`ESC[1G`) and clear-to-end-of-screen (`ESC[0J`) codes straight to
 * `output`, never through `_writeToOutput`, so readline's first render wipes the hand-written
 * prompt off the line. The password is still read correctly; the operator just stares at a blank
 * line with no idea the program is waiting for them.
 *
 * So these tests assert on the byte stream reaching the terminal, not on the answer alone: the
 * prompt must be there, the password must not, and nothing that erases the line may follow.
 */

function capture() {
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { output, text: () => chunks.join("") };
}

/** Any CSI sequence — `ESC[1G`, `ESC[0J`, … Every one of them can move or clear the prompt. */
const CSI = /\x1b\[/;

describe("ask", () => {
  it("leaves the hidden prompt on screen and the password off it", async () => {
    const input = new PassThrough();
    const { output, text } = capture();

    const answer = ask("비밀번호: ", { hidden: true, input, output });
    input.write("correcthorsebattery\n");

    expect(await answer).toBe("correcthorsebattery");
    expect(text()).toContain("비밀번호: ");
    expect(text()).not.toContain("correcthorsebattery");
    // The prompt is only useful if it survives: no cursor moves, no clears, nothing after it.
    expect(text()).not.toMatch(CSI);
  });

  it("echoes a visible prompt and its answer", async () => {
    const input = new PassThrough();
    const { output, text } = capture();

    const answer = ask("아이디: ", { input, output });
    input.write("mantle-kr\n");

    expect(await answer).toBe("mantle-kr");
    expect(text()).toContain("아이디: ");
  });

  it("rejects rather than hanging when input ends with no answer", async () => {
    const input = new PassThrough();
    const { output } = capture();

    const answer = ask("비밀번호: ", { hidden: true, input, output });
    input.end();

    // Ctrl-C and Ctrl-D both close readline without ever firing the question callback. A promise
    // that simply never settles exits the process silently under an "unsettled top-level await"
    // warning, which reads like a crash in the hashing code rather than a cancelled prompt.
    await expect(answer).rejects.toThrow(/cancell?ed|ended/i);
  });
});

/**
 * Where a prompt is written decides whether `pnpm auth:hash > file` works at all.
 *
 * Both CLIs wrote their prompts to **stdout**, so redirecting stdout — the obvious way to capture a
 * hash without it passing through a clipboard or a shell history — swallowed the prompts into the
 * file and left the operator staring at a blank terminal, with the program waiting for input it had
 * given no sign of wanting. Reported 2026-08-05 against exactly that command.
 *
 * A prompt is interface, not output. stderr is where it belongs, and then the redirect captures the
 * two `.env` lines and nothing else.
 *
 * Asserted against the source because these two files run on import (top-level await) and cannot be
 * imported by a test; the seam that IS testable — `ask` itself — already takes the stream as an
 * argument and has no default to get wrong.
 */
describe("CLI prompt destination", () => {
  const files = ["src/cli/auth-hash.ts", "src/cli/deploy-smoke.ts"];

  for (const file of files) {
    it(`${file} prompts on stderr, so stdout stays redirectable`, async () => {
      const source = await readFile(join(REPO_ROOT, file), "utf8");
      expect(source, `${file}: prompts written to stdout are captured by \`> file\``).not.toMatch(
        /output:\s*stdout/,
      );
      expect(source).toMatch(/output:\s*stderr/);
    });
  }
});
