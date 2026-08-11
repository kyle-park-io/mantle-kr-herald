// tests/cli/glossaryMineReport.test.ts
//
// `src/cli/glossary-mine.ts` is a top-level script with no coverage of its own — importing it opens a
// database connection — so its ops-alert wording lives in `src/cli/glossaryMineReport.ts` and is
// asserted here, the same split `translateCheckReport.ts` / `tests/cli/translateCheckReport.test.ts`
// already uses. The `--notify` WIRING, which no pure function can hold, is pinned at the source level
// in the second block.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { miningNotification, corpusWarningLine, NOTIFY_MAX_LINES } from "../../src/cli/glossaryMineReport";
import type { CorpusStatus, GlossaryCandidate } from "../../src/domain/translation/glossaryMining";

const FRESH: CorpusStatus = {
  state: "fresh",
  tweetCount: 118,
  coveredFrom: "2026-06-01T07:55:24.000Z",
  coveredTo: "2026-08-11T04:00:59.000Z",
  ageDays: 0,
};

const REVIEW_PATH = "/home/kyle/.herald/output/glossary/candidates-2026-08-17.json";

const properNoun = (term: string, tier: "A" | "B", ours: number): GlossaryCandidate => ({
  key: term,
  signal: "proper-noun",
  tier,
  term,
  occurrences: 7,
  corpus: { ours },
  rule: ours > 0 ? "keep" : undefined,
  note: "",
  source: "",
});

const substitution = (draft: string, published: string, tier: "A" | "B", ours: number, theirs: number): GlossaryCandidate => ({
  key: `${draft} → ${published}`,
  signal: "substitution",
  tier,
  term: published,
  draft,
  published,
  occurrences: 1,
  itemIds: ["x:2083206182484005059"],
  corpus: { ours, theirs },
  rule: "transliterate",
  target: published,
  note: "",
  source: "",
});

describe("miningNotification", () => {
  it("sends nothing on a week with no candidates", () => {
    // The common case, and the one that decides whether the alert is worth having. A weekly job that
    // pages with "nothing to report" is a job whose alerts get muted, and this one has exactly one
    // job: getting a human to open one file.
    expect(miningNotification({ candidates: [], corpus: FRESH, reviewFilePath: REVIEW_PATH })).toBeUndefined();
  });

  it("stays silent on a clean week even when the corpus is stale", () => {
    // Not an oversight. The corpus only ever GRADES candidates; it never produces one — candidates
    // come from our own collected English source and our own published translations. So staleness
    // cannot hide a decision, and paging about it would send the identical line every Monday until
    // somebody runs a manual `collect:reference`, which is the noise failure this whole design is
    // organised around.
    const stale: CorpusStatus = { ...FRESH, state: "stale", ageDays: 61 };
    expect(miningNotification({ candidates: [], corpus: stale, reviewFilePath: REVIEW_PATH })).toBeUndefined();
  });

  it("reproduces the alert for the findings actually present in production", () => {
    // Pinned as a whole string, not by substrings: this is the entire message a human sees on a
    // phone, and the only way to catch a regression in what surrounds the facts (the grammar's <pre>
    // block, the icon, the tier counts, the trailing path) is to compare all of it. The two findings
    // are real — `RWA` and `낸슨 → 난센`, both applied to the glossary on 2026-08-11.
    const message = miningNotification({
      candidates: [properNoun("RWA", "A", 24), substitution("낸슨", "난센", "B", 0, 0)],
      corpus: FRESH,
      reviewFilePath: REVIEW_PATH,
    });
    expect(message).toBe(
      "ℹ glossary:mine — 용어집 결정 대기 후보 2건 (A 1 · B 1)\n" +
        "<pre>A  RWA  코퍼스 원문 24회\n" +
        "B  낸슨 → 난센  코퍼스 0:0\n" +
        `검토 파일: ${REVIEW_PATH}</pre>`,
    );
  });

  it("always ends on the review file's absolute path", () => {
    // The scheduler runs from ~/.herald/app with HERALD_OUTPUT_DIR=%h/.herald/output, so the file it
    // writes is in a different tree from the `output/` of the checkout the reader works in. "Open the
    // draft file" without saying which one sends them to a directory that does not exist, or — worse
    // — to last week's.
    const message = miningNotification({
      candidates: [properNoun("RWA", "A", 24)],
      corpus: FRESH,
      reviewFilePath: REVIEW_PATH,
    });
    expect(message!.split("\n").at(-1)).toBe(`검토 파일: ${REVIEW_PATH}</pre>`);
  });

  it("carries the staleness warning when there is something to act on", () => {
    const stale: CorpusStatus = { ...FRESH, state: "stale", ageDays: 61 };
    const message = miningNotification({
      candidates: [properNoun("RWA", "B", 24)],
      corpus: stale,
      reviewFilePath: REVIEW_PATH,
    });
    expect(message).toContain("⚠ 참조 코퍼스 61일 지남 (2026-08-11까지) — 전부 B");
    expect(message).toContain("pnpm collect:reference");
  });

  it("says the corpus is gone rather than quietly grading everything B", () => {
    const message = miningNotification({
      candidates: [properNoun("RWA", "B", 0)],
      corpus: { state: "missing" },
      reviewFilePath: REVIEW_PATH,
    });
    expect(message).toContain("⚠ 참조 코퍼스 없음 — 대조 못 해서 전부 B");
    // The line still has to say where the file is; the warning must not push it out.
    expect(message).toContain(`검토 파일: ${REVIEW_PATH}`);
  });

  it("stops listing candidates before the message stops being readable", () => {
    // The review file is the deliverable; the alert is a pointer to it. A bad week can produce forty
    // candidates, and forty lines on a phone is the same mistake as the fourteen-id comma run that
    // made the first x:reconcile alert unreadable.
    const many = Array.from({ length: NOTIFY_MAX_LINES + 5 }, (_, i) => properNoun(`Term${i}`, "B", 1));
    const message = miningNotification({ candidates: many, corpus: FRESH, reviewFilePath: REVIEW_PATH })!;
    expect(message).toContain(`용어집 결정 대기 후보 ${NOTIFY_MAX_LINES + 5}건`);
    expect(message).toContain("…외 5건 (전부 검토 파일에 있습니다)");
    expect(message).not.toContain(`Term${NOTIFY_MAX_LINES}`);
    expect(message).toContain(`검토 파일: ${REVIEW_PATH}`);
  });

  it("escapes a term Telegram would otherwise read as markup", () => {
    // Sent with parse_mode: "HTML". A bare `&` or `<` in a candidate — mined straight out of tweet
    // text, so `R&D` and `<3` are both reachable — makes Telegram reject the whole message, which
    // costs the alert, not just its formatting.
    const message = miningNotification({
      candidates: [properNoun("R&D", "A", 9)],
      corpus: FRESH,
      reviewFilePath: REVIEW_PATH,
    });
    expect(message).toContain("A  R&amp;D  코퍼스 원문 9회");
    expect(message).not.toContain("A  R&D");
  });
});

describe("corpusWarningLine", () => {
  it("says nothing at all on a fresh corpus", () => {
    // Silence is the good news, and a warning printed every week regardless is a warning nobody reads.
    expect(corpusWarningLine(FRESH)).toBeUndefined();
  });

  it("distinguishes a corpus with no dates from one with no tweets", () => {
    // Two different degradations that call for the same command but mean different things: `undated`
    // still has real counts behind it, `missing` has none.
    expect(corpusWarningLine({ state: "undated", tweetCount: 118 })).toContain("수집 기간 불명");
    expect(corpusWarningLine({ state: "missing" })).toContain("참조 코퍼스 없음");
  });
});

describe("glossary:mine --notify wiring", () => {
  const SOURCE = readFileSync(fileURLToPath(new URL("../../src/cli/glossary-mine.ts", import.meta.url)), "utf8");

  it("sends only under --notify", () => {
    expect(SOURCE).toContain('const notify = process.argv.includes("--notify");');
    expect(SOURCE.match(/await notifyOps\(/g)).toHaveLength(1);
    expect(SOURCE).toMatch(/if \(notify\) \{[\s\S]{0,400}?await notifyOps\(/);
  });

  it("pages on candidates, never on the rejected list", () => {
    // A rejection is this job doing its work silently — it found the corpus 13:0 against 규모 → 사이즈
    // and threw the edit away. That is a line in the review file for whoever wants to overrule it, not
    // a notification.
    expect(SOURCE).toContain("candidates: result.candidates");
    expect(SOURCE).not.toContain("candidates: result.rejected");
  });

  it("writes the review file before it decides whether to page", () => {
    // The alert names the file. Paging first would name a path that does not exist yet, and a run
    // killed between the two would page about a file it never wrote.
    expect(SOURCE.indexOf("writeJsonFileAtomic")).toBeLessThan(SOURCE.indexOf("await notifyOps("));
  });

  it("prints the resolved review path on stdout too, not only in the alert", () => {
    // ~/.herald/logs/herald-translate-check/ is where a scheduled run's output actually survives —
    // the journal on this box holds about eight minutes against a seven-day cadence — so the path has
    // to be in the log as well as on somebody's phone.
    expect(SOURCE).toContain("`\\nreview file: ${reviewPath}`");
  });

  it("still exits 0 whatever it finds", () => {
    // A report, not a gate. notifyOps swallows its own failures, so the only way this could regress is
    // an exit code set here.
    expect(SOURCE).not.toContain("process.exitCode");
    expect(SOURCE).not.toContain("process.exit(");
  });

  it("refuses to run against an empty glossary", () => {
    // Same trap `translate:check` refuses on, mirrored: there an empty glossary is a vacuous PASS,
    // here it is a vacuous flood — every proper noun the account has written becomes a candidate.
    // `translation/` is git-ignored, so a git worktree has only the *.example.* files.
    expect(SOURCE).toContain("glossary.length === 0");
    expect(SOURCE).toContain("docs/ko/setup/steering.md");
  });
});
