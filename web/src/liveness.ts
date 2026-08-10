import type { LivenessSummary } from "./types";
import { reportAge } from "./collectedBreakdown";

/**
 * How old an observation may be before the badge says so.
 *
 * Twenty-six hours, from the timer rather than from taste: `deploy/herald-creds.timer` fires
 * `OnCalendar=*-*-* 06:23:00`, so a healthy observation is at most twenty-four hours old plus the
 * run. Twenty-six is one missed fire plus margin.
 *
 * Worth showing at all because the unit's own `OnFailure=` hook cannot cover the case that matters:
 * when this machine is off nothing fails, no Telegram arrives, and the board is the only place the
 * silence shows. Stale is not evidence that anything is wrong — it is evidence that nothing has
 * looked, which is why it reads amber with a time rather than red with a key name.
 */
export const LIVENESS_STALE_AFTER_MS = 26 * 60 * 60 * 1000;

/** Korean names for every probe key this build knows about. Not derived from anything on the
 *  server — `web/src` cannot import `ProbeKey`, so this is a hand-kept copy, same as every other
 *  label table in `web/src/types.ts`. Exported (not just `probeLabel`) so `tests/web/typeMirror.test.ts`
 *  can check its key set against `EXPECTED_PROBE_KEYS` directly. */
export const PROBE_LABEL: Record<string, string> = {
  google_auth: "Google 인증",
  google_drive_review: "Drive 검수 폴더",
  google_drive_approved: "Drive 승인 폴더",
  google_sheets: "Google Sheet",
  lark: "Lark",
  typefully: "Typefully",
  telegram: "Telegram",
};

/** The raw key for anything this build predates — a deployment one probe ahead of this bundle names
 *  the credential badly rather than not at all. */
export function probeLabel(key: string): string {
  return PROBE_LABEL[key] ?? key;
}

const TIER_LABEL: Record<string, string> = { publish: "발행 키", send: "발송 키", data: "시트" };
/** Publishing first: it is the tier that stops the pipeline, so it is the one the one-line chip names. */
const TIER_ORDER = ["publish", "send", "data"] as const;

function isStale(observedAt: string, now: Date): boolean {
  const ms = now.getTime() - new Date(observedAt).getTime();
  return !Number.isNaN(ms) && ms > LIVENESS_STALE_AFTER_MS;
}

/**
 * The chip beside the mode pill, or `undefined` when there is nothing to say.
 *
 * Nothing to say is the common case and it must render as today's header exactly — a permanent
 * indicator that is green 364 days a year is one nobody reads on the 365th.
 *
 * `worst` and `tier` both arrive already graded on `summary.dead` — this function only picks which
 * tier to name and which colour to paint, it does not re-derive severity from `key`. Re-deriving it
 * would be a second severity table in `web/src` that can drift from `src/doctor/liveSeverity.ts`,
 * the same failure mode `web/src/components/CollectedBreakdownCard.tsx`'s own header warns about for
 * the 수집 card: "a card that did its own arithmetic is exactly how the CLI and the header drifted
 * apart the last time."
 */
export function livenessChip(
  summary: LivenessSummary | undefined,
  now: Date,
): { text: string; tone: "red" | "amber" } | undefined {
  if (summary === undefined) return undefined;
  if (summary.dead.length > 0) {
    const tier = TIER_ORDER.find((t) => summary.dead.some((d) => d.tier === t)) ?? "publish";
    const count = summary.dead.filter((d) => d.tier === tier).length;
    const text = tier === "data" ? "시트 응답 없음" : `${TIER_LABEL[tier]} ${count}개 응답 없음`;
    return { text, tone: summary.worst === "fail" ? "red" : "amber" };
  }
  if (isStale(summary.observedAt, now)) {
    return { text: `확인 ${reportAge(summary.observedAt, now)}`, tone: "amber" };
  }
  return undefined;
}

/** The hover card's one-line summary. */
export function livenessHeadline(summary: LivenessSummary, now: Date): string {
  const age = `${reportAge(summary.observedAt, now)} 확인`;
  return summary.dead.length === 0
    ? `${summary.total}개 모두 응답 · ${age}`
    : `${summary.total}개 중 ${summary.dead.length}개 응답 없음 · ${age}`;
}
