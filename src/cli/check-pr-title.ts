/**
 * Fails CI when a pull request title would make a bad commit subject.
 *
 * This repo squash-merges, so the PR title IS the subject that lands on `main` — see
 * `src/cli/check-commit-subject.ts` for the rule and the two Korean subjects that got through
 * because nothing looked at titles.
 *
 * Reads the title from `PR_TITLE`, which `.github/workflows/ci.yml` passes as an env var rather
 * than interpolating `${{ github.event.pull_request.title }}` into a shell command — a title
 * containing a quote or a backtick would otherwise be executed by the runner's shell.
 *
 * Exits 0 when there is no title to check, so a `push` build (which has no pull request) is not a
 * failure.
 */
import { checkCommitSubject } from "./check-commit-subject";

const title = process.env.PR_TITLE;

if (title === undefined || title.trim() === "") {
  console.log("check-pr-title: no PR_TITLE in the environment — nothing to check.");
  process.exit(0);
}

const problem = checkCommitSubject(title);
if (problem) {
  console.error(`✖ ${problem.message}`);
  process.exit(1);
}

console.log(`✓ PR title is a usable commit subject: ${title}`);
