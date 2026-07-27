import type { UserProfile } from "../models";

/** Format a human-readable estimate of how many `collect:reference` runs it would take to
 *  backfill an account's full history, given its reported post count. */
export function formatMeasureReport(p: UserProfile, pageSize: number, maxPages: number): string {
  if (p.statusesCount === undefined) {
    return `@${p.userName} — post count unavailable from the API. Run \`pnpm collect:reference\` incrementally; output/x/reference/runs.json reports coverage.`;
  }
  const pages = Math.ceil(p.statusesCount / pageSize);
  const runs = Math.ceil(pages / maxPages);
  return `@${p.userName} — ~${p.statusesCount} posts. ~${pages} advanced_search pages (~${pageSize}/page); with the ${maxPages}-page cap, ~${runs} incremental \`pnpm collect:reference\` run(s) cover full history.`;
}
