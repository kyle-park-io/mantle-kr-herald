import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import type { Readable } from "node:stream";

/**
 * Reads one line from `input`, echoing to `output` unless `hidden`.
 *
 * Hiding input is not a matter of silencing readline's echo: `_refreshLine()` writes its
 * cursor-home and clear-to-end-of-screen codes straight to `output`, never through the
 * `_writeToOutput` hook, so a prompt printed by hand is erased by readline's very first render —
 * leaving the operator at a blank line with no sign the program is waiting. Instead readline is
 * given a sink to render into, so nothing it emits reaches the terminal at all, and the prompt is
 * written to the terminal directly where there is nothing left to clear it.
 */
export function ask(
  question: string,
  { hidden = false, input, output }: { hidden?: boolean; input: Readable; output: Writable },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const sink = new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
    });
    const rl = createInterface({ input, output: hidden ? sink : output, terminal: true });

    let answered = false;
    // Ctrl-C and Ctrl-D close readline without ever firing the question callback. A promise that
    // never settles exits the process silently under an "unsettled top-level await" warning, which
    // reads like a crash in whatever came next rather than a cancelled prompt.
    rl.on("close", () => {
      if (!answered) reject(new Error("Cancelled: input ended before an answer was given."));
    });

    if (hidden) output.write(question);
    rl.question(hidden ? "" : question, (answer) => {
      answered = true;
      rl.close();
      if (hidden) output.write("\n");
      resolve(answer);
    });
  });
}
