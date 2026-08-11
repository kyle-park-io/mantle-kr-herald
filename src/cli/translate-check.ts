import "./registerErrorHandler";
import { argValue } from "./args";
import { loadDbConfig, tryDescribeDbTarget, INVALID_DB_URL } from "../config";
import { createDb } from "../adapters/db/createDb";
import { createStores } from "./stores";
import { JsonGlossaryStore } from "../adapters/store/JsonGlossaryStore";
import { paths } from "../paths";
import { checkGlossary, checkPublishedOverrides, type GlossaryMiss, type GlossaryOverride } from "../domain/translation/glossaryCompliance";
import { overrideNotification } from "./translateCheckReport";
import { notifyOps } from "../shared/notifyOps";

/**
 * `pnpm translate:check [--status <s>] [--since <ISO>] [--published] [--notify]` — answers two
 * questions about the glossary.
 *
 * 1. Did our draft use a decided term the source called for? (`checkGlossary`, over `koreanText`
 *    by default, or over `publishedText` under `--published` — see below.)
 * 2. Which decided terms do the humans keep overriding once a translation reaches their hands?
 *    (`checkPublishedOverrides`, always run.) That is a statement about the glossary itself — a
 *    term the humans routinely drop is a candidate for the humans being right and the glossary
 *    entry being wrong — not about any single translation, so it runs regardless of `--published`.
 *
 * Read-only. Writes nothing, changes no status, and never exits non-zero on a finding: a glossary
 * has real exceptions, so this is a list a human reads before 1차 검수, not a gate.
 *
 * `--notify` adds one ops-room alert for question 2's findings only, for the scheduled run: nobody
 * reads a timer's journal, and the override list is the half of this report that goes stale in a
 * direction that matters (a glossary entry the humans keep undoing stays wrong until someone looks).
 * Question 1's drift never pages — see `overrideNotification`'s own doc comment. Off by default, so
 * an interactive run is exactly what it was: stdout, exit 0.
 *
 * Why it exists. The drift it catches is invisible one item at a time — `narrative` rendered `이야기`
 * is a perfectly good sentence, wrong only against a decision recorded elsewhere. Measured on
 * 2026-08-07: a batch of nineteen translations drifted from four decided terms, and every individual
 * sentence read fine. A reviewer cannot hold twenty items' terminology in their head; this is the
 * part of that job a machine can actually do.
 *
 * Names its database on the first line, like every other CLI here — this reads production or the
 * local Docker database depending only on which env file was loaded.
 */
const wantStatus = argValue("--status");
const since = argValue("--since");
const usePublished = process.argv.includes("--published");
const notify = process.argv.includes("--notify");

const dbConfig = loadDbConfig();
console.log(`translate:check — database ${dbConfig.env} · ${tryDescribeDbTarget(dbConfig) ?? INVALID_DB_URL}`);

const db = createDb(dbConfig);
try {
  const stores = createStores(db);
  const [all, glossary] = await Promise.all([
    stores.translationStore.loadAll(),
    new JsonGlossaryStore(paths.translationConfigDir).load(),
  ]);

  // Refuses rather than reporting a clean run. An empty glossary makes every check vacuous, and
  // "no drift found" is the most dangerous thing this command could print in that state — it reads
  // as a pass. This is not hypothetical: the first run of this command printed exactly that, from a
  // git worktree, because `translation/` is git-ignored and a worktree gets only the `*.example.*`
  // files. That is the same trap that produced the drift this command exists to catch.
  if (glossary.length === 0) {
    throw new Error(
      `glossary is empty (${paths.translationConfigDir}/glossary.json) — every check would pass vacuously. ` +
        `Steering config is git-ignored, so a git worktree has only the *.example.* files: run this from the ` +
        `main checkout, or restore the config there (docs/ko/setup/steering.md). Never \`pnpm config:init\` to ` +
        `fix this — it writes empty skeletons over the real glossary.`,
    );
  }

  const selected = all
    .filter((t) => (wantStatus ? t.status === wantStatus : true))
    .filter((t) => (since ? (t.approvedAt ?? t.translatedAt) >= since : true));

  // Under --published, a row with no published text is not a passing row — it is untested, and
  // silently counting it as one would be the same vacuous-pass failure the empty-glossary refusal
  // above exists to prevent. So it is excluded, and how many were excluded is printed rather than
  // swallowed.
  const publishedRows = selected.filter((t) => t.publishedText);
  const skippedForNoPublished = selected.length - publishedRows.length;
  const checkedRows = usePublished
    ? publishedRows.map((t) => ({ ...t, koreanText: t.publishedText! }))
    : selected;

  const misses: GlossaryMiss[] = checkedRows.flatMap((t) => checkGlossary(t, glossary));
  // Always runs, regardless of --published: this is the second question the command answers, a
  // statement about the glossary rather than about any one translation, and it costs one extra
  // pass only over rows that already carry a published text.
  const overrides: GlossaryOverride[] = selected.flatMap((t) => checkPublishedOverrides(t, glossary));

  console.log(
    `\nchecked ${checkedRows.length} translation(s)${usePublished ? " (published text)" : ""} against ${glossary.length} glossary entries.`,
  );
  if (usePublished) {
    console.log(`skipped ${skippedForNoPublished} row(s) with no published text yet.`);
  }
  console.log();

  if (misses.length === 0) {
    console.log("no drift found.");
  } else {
    // Grouped by item, because the unit a reviewer opens is an item, not a term.
    const byItem = new Map<string, GlossaryMiss[]>();
    for (const m of misses) byItem.set(m.itemId, [...(byItem.get(m.itemId) ?? []), m]);
    console.log(`${misses.length} possible drift(s) across ${byItem.size} item(s):`);
    for (const [itemId, ms] of byItem) {
      console.log(`\n  ${itemId}`);
      for (const m of ms) console.log(`    "${m.term}" → expected ${m.expected}`);
    }
    console.log(`\nNot every line is a defect — a term inside a quoted English sentence, or a rephrasing`);
    console.log(`that drops the noun, will show up here. Read them; do not batch-apply them.`);
  }

  console.log();
  if (overrides.length === 0) {
    console.log("no published overrides found.");
  } else {
    // Grouped by item, same as the miss report above.
    const byItem = new Map<string, GlossaryOverride[]>();
    for (const o of overrides) byItem.set(o.itemId, [...(byItem.get(o.itemId) ?? []), o]);
    console.log(
      `${overrides.length} published override(s) across ${byItem.size} item(s) — decided terms the humans ` +
        `dropped once the post actually went out:`,
    );
    for (const [itemId, os] of byItem) {
      console.log(`\n  ${itemId}`);
      for (const o of os) console.log(`    "${o.term}" → expected ${o.expected}`);
    }
    console.log(`\nThis is a statement about the glossary entry, not about these translations — a term`);
    console.log(`the humans keep overriding may be a decision worth revisiting.`);
  }

  // After the whole report is on stdout, and only under --notify: one alert for the batch, not one
  // per finding, and only when `overrideNotification` (translateCheckReport.ts) says there is
  // something to send — the threshold and the overrides-not-drift decision live there, where a test
  // can fail on them. `notifyOps` never throws and this sets no exit code, so a run that pages and
  // a run whose page failed both still exit 0: this command is a report, and it stays one.
  if (notify) {
    const notification = overrideNotification(overrides);
    if (notification !== undefined) await notifyOps(notification);
  }
} finally {
  await db.close();
}
