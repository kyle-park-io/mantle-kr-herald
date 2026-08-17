/**
 * Value following a `--flag` on the command line, or undefined.
 *
 * `argv` defaults to the real one, which is what every CLI passes (i.e. nothing). It is a parameter
 * at all so that a command's flag parsing can be lifted out of its entry file and tested — those
 * files open a database connection at import time, so anything left inline in one is unreachable
 * from a test. `src/cli/convertPrepareSelector.ts` is the first caller to pass its own array.
 */
export function argValue(flag: string, argv: string[] = process.argv): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Parse a comma-separated flag value into a trimmed, non-empty list (or undefined). */
export function parseList(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  const parts = v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return parts.length > 0 ? parts : undefined;
}
