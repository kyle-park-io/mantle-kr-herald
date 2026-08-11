import type { CorpusStatus, GlossaryCandidate } from "../domain/translation/glossaryMining";
import { opsNotice } from "../shared/opsAlertGrammar";

/**
 * The lines `glossary-mine.ts` decides rather than merely prints, pulled out of the script for the
 * same reason `translateCheckReport.ts` and `xReconcileReport.ts` exist: a top-level script has no
 * test coverage of its own (running it opens a database connection), so its load-bearing wording has
 * to live somewhere a test can fail on it. Pure — no clock, no I/O, no `process.env`.
 */

/**
 * How many candidate lines the ops message carries before it stops listing them.
 *
 * Twelve. The message is read on a phone and the review file is the actual deliverable — the alert's
 * job is to say "there are decisions waiting, here is where", not to be the decisions. A comma-run of
 * fourteen ids is what made the first `x:reconcile` alert unreadable (see `retireNotification`), and
 * an unbounded candidate list is the same mistake with longer lines: the 2026-08-11 run produced
 * around forty proper-noun candidates before the glossary filter, and a bad week can do it again.
 */
export const NOTIFY_MAX_LINES = 12;

/** `A  Atomic RFQ                코퍼스 원문 12회` — tier, candidate, and the number that graded it. */
function candidateLine(c: GlossaryCandidate): string {
  const evidence =
    c.corpus === undefined
      ? "대조 못 함"
      : c.corpus.theirs === undefined
        ? `코퍼스 원문 ${c.corpus.ours}회`
        : `코퍼스 ${c.corpus.ours}:${c.corpus.theirs}`;
  return `${c.tier}  ${c.key}  ${evidence}`;
}

/** The corpus caveat, when there is one. `undefined` on a fresh corpus — silence is the good news. */
export function corpusWarningLine(corpus: CorpusStatus): string | undefined {
  switch (corpus.state) {
    case "missing":
      return "⚠ 참조 코퍼스 없음 — 대조 못 해서 전부 B (pnpm collect:reference)";
    case "undated":
      return "⚠ 참조 코퍼스 수집 기간 불명 — 안전하게 전부 B (pnpm collect:reference)";
    case "stale":
      return `⚠ 참조 코퍼스 ${corpus.ageDays}일 지남 (${corpus.coveredTo.slice(0, 10)}까지) — 전부 B (pnpm collect:reference)`;
    case "fresh":
      return undefined;
  }
}

/**
 * Whether a `--notify` run should page the ops room, and the message if so. `undefined` when there is
 * nothing to decide, so the caller's `if` reads as "is there something to send" — the same shape
 * `overrideNotification` and `retireNotification` use.
 *
 * **Rejections never page, and a stale corpus alone never pages.** Both are deliberate:
 *
 * - A rejection is this job doing its work silently — it looked at 규모 → 사이즈, found the corpus 13:0
 *   against the edit, and threw it away. That is a line in the review file for whoever wants to
 *   overrule it, not a notification. Paging on work that needed no human is how an alert becomes
 *   noise, and this alert has exactly one job: getting a human to open one file.
 * - A stale corpus with no candidates is a genuinely clean week. The corpus only ever GRADES
 *   candidates; it never produces one. Candidates come from our own collected English source and our
 *   own published translations, so staleness cannot hide a decision — it can only make a decision's
 *   grade less confident, and there are no grades to be less confident about when the list is empty.
 *   Paging anyway would send the identical line every Monday until somebody runs a manual collect,
 *   which is the failure mode `translate:check --notify` was written to avoid.
 *
 * The review file's path is on the message and is not optional. The scheduler runs from
 * `~/.herald/app` with `HERALD_OUTPUT_DIR=%h/.herald/output`, so the file it writes is in a different
 * tree from the `output/` of the checkout Kyle works in. "Open the draft file" without saying which
 * one sends a reader to an `output/glossary/` that does not exist, or worse, to last week's.
 */
export function miningNotification(input: {
  candidates: GlossaryCandidate[];
  corpus: CorpusStatus;
  reviewFilePath: string;
}): string | undefined {
  const { candidates, corpus, reviewFilePath } = input;
  if (candidates.length === 0) return undefined;

  const tierA = candidates.filter((c) => c.tier === "A").length;
  const tierB = candidates.length - tierA;

  const shown = candidates.slice(0, NOTIFY_MAX_LINES).map(candidateLine);
  const hidden = candidates.length - shown.length;
  if (hidden > 0) shown.push(`…외 ${hidden}건 (전부 검토 파일에 있습니다)`);

  const warning = corpusWarningLine(corpus);
  if (warning) shown.push(warning);
  // Last line, always: it is the one thing the reader has to act on, and the one thing they cannot
  // reconstruct from anywhere else.
  shown.push(`검토 파일: ${reviewFilePath}`);

  return opsNotice({
    icon: "ℹ",
    title: `glossary:mine — 용어집 결정 대기 후보 ${candidates.length}건 (A ${tierA} · B ${tierB})`,
    lines: shown,
  });
}
