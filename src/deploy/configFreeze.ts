/**
 * Freezing the scheduler's configuration at deploy time means answering one question — did this
 * variable change? — and answering it the way the scheduler would. These functions therefore model
 * Node's own `--env-file` parsing (measured, see `tests/deploy/configFreeze.test.ts`) rather than a
 * generic dotenv dialect, and they are pure: every file read lives in `src/cli/deploy-freeze.ts`,
 * the same split `requirements.ts` and `smokeChecks.ts` already use.
 */

/** `export FOO=`, `FOO =`, `FOO=` — the key, and everything after the first `=`. */
const ASSIGNMENT = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/**
 * A later duplicate overwrites an earlier one because Node does the same. Non-assignment lines are
 * skipped rather than rejected: this parser reads a file that already booted the scheduler, so
 * refusing it here would fail a deploy over a line Node is perfectly happy with.
 */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = ASSIGNMENT.exec(line);
    if (!match) continue;
    out.set(match[1], readValue(match[2]));
  }
  return out;
}

/**
 * Quoted values: stripped of quotes, everything after the closing quote discarded, and only `\n`
 * inside double quotes interpreted to a real newline. Unquoted: trimmed and cut at the first `#`.
 * If a value starts with a quote but has no closing quote, it's treated as unquoted (the opening
 * quote stays in the value), matching Node's behavior.
 */
function readValue(rest: string): string {
  const value = rest.trim();
  const quote = value[0];

  // Check if starts with a quote character
  if (quote === '"' || quote === "'" || quote === "`") {
    // Look for the closing quote
    const closingIndex = value.indexOf(quote, 1);
    if (closingIndex !== -1) {
      // Found closing quote - extract content between quotes
      let content = value.slice(1, closingIndex);

      // Only interpret \n to newline in double quotes
      if (quote === '"') {
        content = content.replace(/\\n/g, "\n");
      }

      return content;
    }
    // No closing quote - fall through to unquoted path
  }

  // Unquoted: truncate at first # and trim
  const hash = value.indexOf("#");
  return (hash === -1 ? value : value.slice(0, hash)).trim();
}
