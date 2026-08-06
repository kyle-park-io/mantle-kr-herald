/**
 * Reads and validates the watch scheduler's translation cutoff (`HERALD_TRANSLATE_SINCE`).
 *
 * Why a cutoff exists at all: `PrepareTranslations.applySelector` takes the first `--limit` items
 * of the *whole* untranslated set, oldest first. Measured against production on 2026-08-06 that
 * set was 211 items reaching back to 2026-06-01, so a scheduler running 3 items every two hours
 * would have spent roughly six days on the backlog before touching the 23 threads the very first
 * tick had just collected — the scheduler exists to process new posts, and without a floor it
 * processes the oldest ones instead.
 *
 * The value is deliberately configuration (a unit's `Environment=`) rather than a constant here:
 * it is a content decision — which historical posts the Korean account is choosing never to
 * translate — and it changes on a different clock than this code does.
 */
export function parseTranslateSince(raw: string | undefined): string | undefined {
  // An `HERALD_TRANSLATE_SINCE=` line with nothing after it reaches Node as "", not as undefined.
  // Treated as unset: "" would otherwise pass validation below as a filter every ISO timestamp
  // satisfies, i.e. a cutoff that looks configured in the unit file and does nothing.
  const value = raw?.trim();
  if (!value) return undefined;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `HERALD_TRANSLATE_SINCE is not a date this can parse: ${JSON.stringify(raw)}. ` +
        `Use an ISO-8601 value such as 2026-07-27T14:35:24.000Z or 2026-07-27.`,
    );
  }

  // Normalised, not passed through: `applySelector` compares `item.createdAt >= since` as strings.
  // A date-only "2026-07-27" only sorts correctly against ISO timestamps by accident of a shared
  // prefix, and an offset form like "2026-07-27T23:35:24+09:00" sorts *after* every 2026-07-27
  // UTC timestamp while meaning 14:35:24 that same day — the exact opposite of its intent.
  return parsed.toISOString();
}
