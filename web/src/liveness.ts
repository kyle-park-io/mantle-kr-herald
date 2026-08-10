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

/** Publishing first: it is the tier that stops the pipeline, so it is the one the one-line chip names.
 *  Exported (not just used internally) so `tests/web/typeMirror.test.ts` can pin its member set
 *  against the server's `ProbeTier` union — the same drift `PROBE_LABEL`/`EXPECTED_PROBE_KEYS` is
 *  pinned against, one level up (tiers instead of keys). */
export const TIER_ORDER = ["publish", "send", "data"] as const;
type Tier = (typeof TIER_ORDER)[number];

/** Korean name per known tier. Keyed by `Tier` (derived from `TIER_ORDER`, not written out again)
 *  so the two can never list a different set of tiers from each other. */
export const TIER_LABEL: Record<Tier, string> = { publish: "발행 키", send: "발송 키", data: "시트" };

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
 *
 * A `tier` this bundle does not recognise (a deployment one probe ahead of this bundle, same case
 * `probeLabel`'s `?? key` fallback exists for) must not be silently coerced into a *known* tier: an
 * earlier version of this function defaulted an unmatched tier to `"publish"` and then filtered
 * `dead` for `"publish"` entries, which — for a `dead` list that carried no `"publish"` entry at all
 * — produced a self-contradictory chip (red tone, "발행 키 0개 응답 없음") for a credential that had
 * genuinely failed. `count` must never render as zero; it is the proof the wording describes the
 * data. So an unrecognised tier gets a generic, tier-less wording instead, over every dead entry
 * (never zero, since this branch only runs when `summary.dead.length > 0`) — still coloured off
 * `summary.worst`, which the server graded and is trustworthy regardless of tier.
 */
export function livenessChip(
  summary: LivenessSummary | undefined,
  now: Date,
): { text: string; tone: "red" | "amber" } | undefined {
  if (summary === undefined) return undefined;
  if (summary.dead.length > 0) {
    const tier = TIER_ORDER.find((t) => summary.dead.some((d) => d.tier === t));
    const text =
      tier === undefined
        ? `키 ${summary.dead.length}개 응답 없음`
        : tier === "data"
          ? "시트 응답 없음"
          : `${TIER_LABEL[tier]} ${summary.dead.filter((d) => d.tier === tier).length}개 응답 없음`;
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
