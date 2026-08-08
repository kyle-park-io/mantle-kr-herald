import "./registerErrorHandler";
import { loadDbConfig, tryDescribeDbTarget, INVALID_DB_URL } from "../config";
import { createDb } from "../adapters/db/createDb";
import { createStores } from "./stores";
import { BackfillTextVideoUrls } from "../app/BackfillTextVideoUrls";
import { textVideoBackfillPlanLines } from "./textVideoBackfillReport";

/**
 * `pnpm text:video-backfill [--yes]` — fill the mp4 url into bare `[영상]` markers already stored in
 * reviewed text.
 *
 * The other half of `x:video-backfill`, which fills `videoUrl` on the *collected* `x_threads` rows.
 * Translations and renderings saved before that capture existed carry a url-less `[영상]` in their
 * own stored text, and nothing re-derives stored text on read — so filling the collected side does
 * not reach them, however completely it succeeded. See `BackfillTextVideoUrls`' own doc comment.
 *
 * Reads `x_threads` (never writes it) and writes exactly three columns —
 * `translations.source_text`, `translations.korean_text`, `renderings.text`. Never
 * `translations.published_text`: that is the record of what the account actually posted, and this
 * command has no business in it. Makes no API call of any kind, so it needs no `TWITTERAPI_IO_KEY`
 * — everything it pairs comes out of the database it is about to edit.
 *
 * Previews by default and writes only under `--yes`, the convention `x:reconcile`/`x:link`/
 * `x:video-backfill` already use.
 */
const writeConfirmed = process.argv.includes("--yes");

const dbConfig = loadDbConfig();
const db = createDb(dbConfig);
try {
  // Names the database on the first line, like every other CLI here — this one rewrites reviewed
  // text, so "which database am I about to edit" is the first thing to be sure of.
  console.log(
    `text:video-backfill — database ${dbConfig.env} · ${tryDescribeDbTarget(dbConfig) ?? INVALID_DB_URL}` +
      `${writeConfirmed ? "" : " (preview — no --yes)"}`,
  );

  const stores = createStores(db);
  const usecase = new BackfillTextVideoUrls(stores.collectionRepository, stores.translationStore, stores.formattingStore);
  const plan = await usecase.plan();

  console.log(`\n${textVideoBackfillPlanLines(plan).join("\n")}`);

  const rows = plan.translations.length + plan.renderings.length;
  if (rows === 0) {
    // Covers both "nothing carries a bare marker" and "every one of them was skipped": either way
    // `--yes` would write nothing, so it must not be advertised as if it would.
    console.log(`\nnothing to write.`);
  } else if (!writeConfirmed) {
    console.log(
      `\npreview only — nothing was written. Re-run with --yes to fill ${plan.filled} marker(s) ` +
        `in ${rows} row(s).`,
    );
  } else {
    console.log(`\nwriting…`);
    const written = await usecase.apply(plan);
    console.log(
      `  ✓ filled ${plan.filled} marker(s) — ${written.translations} translation(s), ` +
        `${written.renderings} rendering(s)`,
    );
  }
} finally {
  await db.close();
}
