import { INTAKE_TERM_LABEL, intakeTermAmount, reachCopy } from "../collectedBreakdown";
import { kstStamp, type CollectedBreakdown } from "../types";

/**
 * The story behind the header's `수집 134`, one hover away.
 *
 * A card rather than more terms on the strip: `수집 134 · 번역 23 · 변환 3 10건 · 렌더 3 13건 · 발행 9
 * 16건` has no room for four more numbers, and this dashboard already answers "the number has a
 * story" with a hover popover — the storage-mode chip in `App.tsx` and `Tip` open the same
 * `InfoPopover`. This is that idiom again, not a second one. Positioning, open/close and the trigger
 * live in `InfoPopover`; this component renders only the card's own content, which `App.tsx` wraps in
 * an `InfoPopover` at the 수집 stage of the funnel.
 *
 * Two halves, with different reach, and the difference is stated rather than smoothed over:
 *
 * - The **intake funnel** is derived from the database and works on every deployment, hosted
 *   included. It is why 수집 134 is not 223.
 * - The **floor scope** can only be *read* where the scheduler actually lives, because the floor's
 *   one real home is a systemd unit and the hosted dashboard is a Vercel function. What it shows
 *   there instead is the scheduler's own report of the floor it ran with — `reachCopy`'s `reported`
 *   state, which prints the report's age beside it so an observation is never mistaken for a
 *   reading. With no report at all it falls back to `unknown`, which says the floor cannot be seen
 *   from here rather than implying none exists.
 *
 * Every number here was computed server-side by the same function `pnpm status`'s Collected line is
 * formatted from (`collectedBreakdown` in `src/status/translateFloor.ts`). Nothing is re-derived on
 * this side — a card that did its own arithmetic is exactly how the CLI and the header drifted apart
 * the last time.
 */
export function CollectedBreakdownCard({ breakdown }: { breakdown: CollectedBreakdown }) {
  const reach = reachCopy(breakdown.reach);
  return (
    <div data-testid="collected-breakdown" className="text-left">
      <p className="font-semibold text-ink">수집 {breakdown.total}건은 이렇게 나온 숫자입니다</p>

      {/* Absent when there is no honest funnel to draw — no X threads at all, or two reads of the
          database that disagree. The server decides that; this side only renders what it was sent,
          so a card and a CLI line can never omit different terms. */}
      {breakdown.intake && (
        <dl className="mt-2 space-y-0.5">
          {breakdown.intake.map((term) => (
            <div key={term.kind} className="flex items-baseline gap-2">
              <dt className="text-ink">{INTAKE_TERM_LABEL[term.kind]}</dt>
              <dd className="ml-auto font-mono tabular-nums">{intakeTermAmount(term)}</dd>
            </div>
          ))}
          {/* The sum, spelled out. 223 - 92 = 131 but the header says 134, and a reader who
              subtracts and comes up 3 short concludes the pipeline lost items. */}
          <div className="flex items-baseline gap-2 border-t border-line pt-1">
            <dt className="text-ink">합계</dt>
            <dd className="ml-auto font-mono font-semibold tabular-nums text-ink">{breakdown.total}</dd>
          </div>
        </dl>
      )}

      <div className="mt-2 border-t border-line pt-2">
        <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-faint">스케줄러 번역 범위</div>
        <p className={reach.alarming ? "font-medium text-amber-ink" : "text-ink"}>
          {reach.alarming ? "⚠ " : ""}
          {reach.headline}
        </p>
        {/* KST, because this board is read in Korea and `kstStamp` is what keeps one instant reading
            identically for everyone. The raw ISO — the string `pnpm status` prints, and the one to
            compare against — is the tooltip, so nothing is lost. */}
        {reach.floor && (
          <p className="font-mono text-[11px] text-faint" title={reach.floor}>
            하한 {kstStamp(reach.floor)}
          </p>
        )}
        <p className="mt-0.5 text-faint">{reach.detail}</p>
        {/* The report's age, and the only thing standing between a three-week-old observation and a
            number that looks checked. Marked when it is stale or when it disagrees with what systemd
            says on this machine — see `reachCopy`'s `report`/`reportAlarming`. */}
        {reach.report && (
          <p className={`mt-0.5 ${reach.reportAlarming ? "font-medium text-amber-ink" : "text-faint"}`}>
            {reach.reportAlarming ? "⚠ " : ""}
            {reach.report}
          </p>
        )}
        {reach.refusal && <p className="mt-0.5 font-mono text-[11px] text-faint">{reach.refusal}</p>}
      </div>
    </div>
  );
}
