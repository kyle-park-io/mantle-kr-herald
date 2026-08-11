import "./registerErrorHandler";
import { loadDbConfig } from "../config";
import { createDb } from "../adapters/db/createDb";
import { createStores } from "./stores";
import { tickStartupLine } from "./tickStartup";
import { JsonGlossaryStore } from "../adapters/store/JsonGlossaryStore";
import { JsonGlossaryDismissalStore } from "../adapters/store/JsonGlossaryDismissalStore";
import { mineGlossaryCandidates, type ReferenceRun } from "../domain/translation/glossaryMining";
import { corpusSummary, renderCandidateReview } from "../domain/translation/glossaryReview";
import { miningNotification } from "./glossaryMineReport";
import { notifyOps } from "../shared/notifyOps";
import { readJsonFile, writeJsonFileAtomic } from "../shared/store/jsonFile";
import type { CollectedThread } from "../domain/models";
import { OUTPUT_DIR, glossaryCandidatesPath, paths } from "../paths";

/**
 * `pnpm glossary:mine [--notify]` — which terms are still waiting on a glossary DECISION.
 *
 * The complement to `translate:check`, and the reason it is on the same weekly unit. That command
 * measures translations against decisions already recorded; this one asks what has never been
 * decided. Neither can answer the other's question, and the bottleneck the 2026-08-11 hand-run
 * exposed was this one: the glossary went 96 → 106 entries in an afternoon, not because anybody
 * lacked a place to type them, but because nobody knew which ten terms to type.
 *
 * Three signals, all in `src/domain/translation/glossaryMining.ts` where a test can fail on them:
 * un-glossed recurring proper nouns in the English source, word-level substitutions a human made
 * between our draft and the published post, and cross-validation of both against the @0xMantleKR
 * reference corpus. The corpus half is what makes the output usable rather than a word list — on the
 * hand-run it threw away two candidates (`시장가`, `사이즈`) that would otherwise have gone into the
 * glossary as wrong renderings.
 *
 * READ-ONLY apart from the review file. Writes no database row, changes no status, and — like
 * `translate:check` — never exits non-zero on a finding. Every candidate is a question for a human,
 * and a question is not a build failure.
 *
 * The review file is the deliverable; stdout and the alert are pointers to it. Its absolute path is
 * printed on stdout and carried in the alert, because the scheduled run resolves it under
 * `HERALD_OUTPUT_DIR=%h/.herald/output` while an interactive run resolves it under the checkout's own
 * `output/` — an alert that says "open the draft" without saying which one is a trap.
 *
 * Names its database and its output root on the first line, like every other scheduled command here.
 */
const notify = process.argv.includes("--notify");
const now = new Date().toISOString();
const day = now.slice(0, 10);

console.log(
  tickStartupLine("glossary:mine", OUTPUT_DIR, process.env.HERALD_OUTPUT_DIR, loadDbConfig(), [
    notify ? "notify on" : "notify off",
  ]),
);

/**
 * An optional JSON input that must never fail the run — but must never fail SILENTLY either.
 *
 * `readJsonFile` already returns the fallback on ENOENT (an absent reference corpus is the ordinary
 * state of a fresh checkout). A corrupt one is different: it means cross-validation is degraded for a
 * reason somebody can fix, and swallowing that without a word is how a run starts grading everything
 * B forever with no explanation. Degrade, say so, carry on.
 */
async function readOptional<T>(path: string, fallback: T, label: string): Promise<T> {
  try {
    return await readJsonFile<T>(path, fallback);
  } catch (err) {
    console.log(`⚠ ${label} could not be read (${(err as Error).message}) — continuing without it.`);
    return fallback;
  }
}

const db = createDb(loadDbConfig());
try {
  const stores = createStores(db);
  const [threads, translations, glossary, dismissed, corpusThreads, corpusRuns] = await Promise.all([
    stores.collectionRepository.loadAll(),
    stores.translationStore.loadAll(),
    new JsonGlossaryStore(paths.translationConfigDir).load(),
    new JsonGlossaryDismissalStore(paths.translationConfigDir).load(),
    readOptional<CollectedThread[]>(paths.referenceItems, [], "reference corpus (x/reference/items.json)"),
    readOptional<ReferenceRun[]>(paths.referenceRuns, [], "reference run ledger (x/reference/runs.json)"),
  ]);

  // The same refusal `translate:check` makes, for a mirrored reason. There it is a vacuous PASS — an
  // empty glossary makes every check succeed. Here it is a vacuous flood: every proper noun the
  // account has ever written becomes an un-glossed candidate, and the review file arrives with
  // hundreds of lines that all look like findings. Both come from the same trap — `translation/` is
  // git-ignored, so a git worktree has only the `*.example.*` files.
  if (glossary.length === 0) {
    throw new Error(
      `glossary is empty (${paths.translationConfigDir}/glossary.json) — every term would look like a new ` +
        `candidate. Steering config is git-ignored, so a git worktree has only the *.example.* files: run this ` +
        `from the main checkout, or restore the config there (docs/ko/setup/steering.md). Never ` +
        `\`pnpm config:init\` to fix this — it writes empty skeletons over the real glossary.`,
    );
  }

  // Every tweet of every thread, deleted ones included: a term that appeared in a thread the account
  // later took down was still a term we translated, and the glossary decision it needs outlives the
  // post. Matches what the 2026-08-11 sweep counted (`select tweets from x_threads`, no status filter).
  const sourceTweets = threads.flatMap((t) => t.tweets.map((tw) => tw.text ?? ""));
  const corpusTweets = corpusThreads.flatMap((t) => t.tweets.map((tw) => tw.text ?? ""));

  const result = mineGlossaryCandidates({
    sourceTweets,
    translations,
    glossary,
    dismissed,
    corpusTweets,
    corpusRuns,
    now,
  });

  const reviewPath = glossaryCandidatesPath(day);
  await writeJsonFileAtomic(
    paths.glossaryDir,
    reviewPath,
    renderCandidateReview(result, {
      path: reviewPath,
      now,
      sourceTweetCount: sourceTweets.length,
      translationCount: translations.filter((t) => t.publishedText).length,
    }),
  );

  const tierA = result.candidates.filter((c) => c.tier === "A").length;
  console.log(
    `\nmined ${sourceTweets.length} source tweet(s) and ${translations.filter((t) => t.publishedText).length} ` +
      `published translation(s) against ${glossary.length} glossary entries and ${dismissed.length} dismissal(s).`,
  );
  console.log(corpusSummary(result.corpus));
  console.log();

  if (result.candidates.length === 0) {
    console.log("no glossary candidates — nothing waiting on a decision.");
  } else {
    console.log(
      `${result.candidates.length} candidate(s) — A ${tierA} · B ${result.candidates.length - tierA}:`,
    );
    for (const c of result.candidates) {
      const evidence =
        c.corpus === undefined
          ? "코퍼스 대조 못 함"
          : c.corpus.theirs === undefined
            ? `코퍼스 원문 ${c.corpus.ours}회`
            : `코퍼스 ${c.corpus.ours}:${c.corpus.theirs}`;
      console.log(`  ${c.tier}  ${c.key.padEnd(30)} ${evidence}`);
    }
  }

  if (result.rejected.length > 0) {
    console.log(`\n${result.rejected.length} rejected — the corpus was on our draft's side:`);
    for (const r of result.rejected) console.log(`  ${r.key.padEnd(30)} 코퍼스 ${r.corpus.ours}:${r.corpus.theirs}`);
  }

  // The one line that has to survive being read out of a log a week later. Printed even on an empty
  // week: "which file did this run write?" must never be a question, and an empty review file is
  // still the record that this ran and found nothing.
  console.log(`\nreview file: ${reviewPath}`);
  console.log(
    `fill in what you want, then \`pnpm glossary add …\`; to silence a candidate forever add its ` +
      `_후보 value to ${paths.translationConfigDir}/glossary-dismissed.json.`,
  );

  // After the whole report is on stdout, and only under --notify: one alert for the batch, and only
  // when `miningNotification` says there is something to send — the "rejections never page" and
  // "a stale corpus alone never pages" decisions live there, where a test can fail on them.
  // `notifyOps` never throws and this sets no exit code, so a run that pages and a run whose page
  // failed both still exit 0. This command is a report, and it stays one.
  if (notify) {
    const notification = miningNotification({
      candidates: result.candidates,
      corpus: result.corpus,
      reviewFilePath: reviewPath,
    });
    if (notification !== undefined) await notifyOps(notification);
  }
} finally {
  await db.close();
}
