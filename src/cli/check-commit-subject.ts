/**
 * Rejects a commit subject that is not written in English.
 *
 * Why this exists: on 2026-08-11 two Korean subjects reached `main` — `feat(deploy): 배포본
 * 자격증명이 배포 사이에 죽는 것을 매일 잡는다` and `fix(deploy): 알림이 systemd 얘기 말고 실제로
 * 실패한 것을 말하게 한다` — against four hundred English ones. They got there through a gap nothing
 * was watching: this repo squash-merges, so **the pull request title becomes the commit subject**,
 * and the PR title is the one piece of text no test and no reviewer had ever looked at. Every
 * commit made on a branch was English; only the titles were not.
 *
 * So the check runs on the PR title in CI (`.github/workflows/ci.yml`), not on branch commits —
 * squash discards those, and guarding them would pass while the thing that actually lands fails.
 *
 * ## The rule, and why it is not "ASCII only"
 *
 * Korean belongs in these subjects. The pipeline's own vocabulary is Korean — `[영상]`, `[사진]`,
 * `1차 검수`, `되돌리기`, `게시됨`, `핀으로 고정하기` — and naming a UI label or a stage in the
 * language it is written in is correct, not sloppy. Ten subjects on `main` do exactly that. A
 * no-non-ASCII rule would have rejected all ten and caught nothing the author of those two bad
 * titles would not have worked around.
 *
 * What separates them is proportion, not presence: the subject is an English sentence that may
 * quote Korean terms. Measured over four hundred subjects, the most Korean a legitimate one gets is
 * 22% of its letters (`feat(web): offer 핀으로 고정하기 on a Telegram room's send`); the two that
 * were wrong are 74% and 100%. Requiring Latin letters to outnumber Hangul puts the line in the
 * empty space between, with zero false positives against the whole history.
 */

/**
 * Conventional-commits shape: `type(optional scope)!: description`.
 *
 * Swept over all 569 non-merge subjects: six do not match, and all six are from the first two weeks
 * (`Initial commit`, `Dashboard: modern-minimal redesign`, `docs+fix:` …, the newest 2026-07-28).
 * Everything since conforms. The check only ever sees a new pull request title, never history, so
 * those six cost nothing — they are recorded here so the next person does not run the same sweep,
 * find them, and conclude the rule is wrong.
 *
 * The language rule below rejects **zero** of the 569.
 */
const SUBJECT = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<breaking>!)?: (?<description>.+)$/;

export interface SubjectProblem {
  readonly code: "shape" | "language" | "empty";
  readonly message: string;
}

/**
 * Returns the reason a subject is unacceptable, or `undefined` when it is fine.
 *
 * Deliberately not a boolean: a check that only says "no" makes the author guess, and this one
 * fires on a pull request title where the fix is a re-title, not a code change.
 */
export function checkCommitSubject(subject: string): SubjectProblem | undefined {
  const trimmed = subject.trim();
  if (trimmed === "") return { code: "empty", message: "The subject is empty." };

  const match = SUBJECT.exec(trimmed);
  if (!match?.groups) {
    return {
      code: "shape",
      message:
        `Not a conventional-commit subject: ${JSON.stringify(trimmed)}\n` +
        `Expected \`type(scope): description\` — e.g. \`fix(deploy): read the run log before the journal\`.`,
    };
  }

  const description = match.groups.description ?? "";
  // Latin letters, not "characters": punctuation, digits and code identifiers say nothing about
  // which language the sentence is in, and counting them would let `fix(x): 되돌리기 v1.2.3-rc4`
  // through on the strength of a version number.
  const latin = description.match(/[A-Za-z]/g)?.length ?? 0;
  const hangul = description.match(/[가-힣ㄱ-ㆎ]/g)?.length ?? 0;

  if (hangul > 0 && latin <= hangul) {
    return {
      code: "language",
      message:
        `Commit subjects are written in English: ${JSON.stringify(trimmed)}\n` +
        `Found ${hangul} Hangul character(s) against ${latin} Latin letter(s) in the description.\n` +
        `Korean terms are welcome inside an English sentence — \`feat(web): offer 핀으로 고정하기 on a ` +
        `Telegram room's send\` is fine — but the sentence itself should be English.\n` +
        `This repo squash-merges, so a pull request title becomes the commit subject: re-title the PR.`,
    };
  }

  return undefined;
}
