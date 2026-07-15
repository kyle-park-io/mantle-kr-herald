/** Value following a `--flag` on the command line, or undefined. */
export function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Parse a comma-separated flag value into a trimmed, non-empty list (or undefined). */
export function parseList(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  const parts = v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return parts.length > 0 ? parts : undefined;
}
