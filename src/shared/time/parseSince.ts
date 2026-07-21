const UNIT_MS: Record<string, number> = {
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Resolve a `--since` value to an ISO 8601 string.
 * Relative: `<n><h|d|w>` (e.g. `12h`, `3d`, `1w`) → `now` minus that span.
 * Absolute: any Date-parseable ISO date/datetime, passed through.
 * `m` (minute/month ambiguity) and any other form throw.
 */
export function parseSince(value: string, now: Date): string {
  const rel = /^(\d+)([a-z])$/.exec(value.trim());
  if (rel) {
    const [, n, unit] = rel;
    const ms = UNIT_MS[unit];
    if (ms === undefined) throw new Error(`Unsupported --since unit "${unit}" (use h, d, or w)`);
    return new Date(now.getTime() - Number(n) * ms).toISOString();
  }
  // Validate ISO date/datetime format (YYYY-MM-DD or YYYY-MM-DDTHH:...)
  if (!/^\d{4}-\d{2}-\d{2}(T|$)/.test(value.trim())) {
    throw new Error(`Invalid --since value "${value}" (use <n>h|d|w or an ISO date)`);
  }
  const abs = new Date(value);
  if (Number.isNaN(abs.getTime())) {
    throw new Error(`Invalid --since value "${value}" (use <n>h|d|w or an ISO date)`);
  }
  return abs.toISOString();
}
