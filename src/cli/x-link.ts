import "./registerErrorHandler";
import { skipIfLocal } from "./skipIfLocal";
import { argValue } from "./args";
import { loadConfig, loadDbConfig, loadGoogleAuthConfig, loadGoogleSheetConfig, tryDescribeDbTarget, INVALID_DB_URL } from "../config";
import { createDb } from "../adapters/db/createDb";
import { createStores } from "./stores";
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";
import { GoogleSheetClient } from "../adapters/sheets/GoogleSheetClient";
import { TwitterClient } from "../adapters/twitterapi/TwitterClient";
import { TwitterApiSourceGateway } from "../adapters/twitterapi/TwitterApiSourceGateway";
import { assembleThreads } from "../domain/threadAssembler";
import { CapturePublishedText } from "../app/CapturePublishedText";
import { RecordPublish } from "../app/RecordPublish";
import { RetireTranslation } from "../app/RetireTranslation";
import { planXLink, parsePostArg } from "./xLinkPlan";
import { loadHistoryPostIds } from "./historyKeys";

/**
 * `pnpm x:link --item <itemId> --post <id|url> [--yes]` — record that a translation was published as
 * a named post.
 *
 * The gap this fills. `x:reconcile` finds a translation's live post by scoring it against the
 * account's timeline, so it can only match a post that timeline returns. Measured 2026-08-07, two
 * real @0xMantleKR posts (2082062251876561175, 2081658695289831503) are returned by neither
 * `advanced_search` nor `user/last_tweets` nor X's own search UI, while a fetch by id returns them
 * immediately — and neither is a reply, retweet, quote or community post. No threshold and no wider
 * `--since` can reach them: they are never candidates. A human holding the url is the only source of
 * that fact, and this is where they put it.
 *
 * Writes exactly what a reconcile match writes, through the same two use cases — `RetireTranslation`
 * (status → `posted`, `postedUrl`/`postedAt`, and the publish-history row) and `CapturePublishedText`
 * (the published copy, fill-only). Nothing else: no approval, no send, nothing written to X, and the
 * collect watermark is never touched. It is reversible from the board's 되돌리기, same as any other
 * retire.
 *
 * Previews by default; `--yes` writes — the convention `x:reconcile` already uses.
 */
skipIfLocal("x:link");

const itemId = argValue("--item")?.trim();
const postArg = argValue("--post")?.trim();
const writeConfirmed = process.argv.includes("--yes");
const handle =
  argValue("--handle")?.trim().replace(/^@/, "") ||
  process.env.REFERENCE_X_HANDLE?.trim().replace(/^@/, "") ||
  "0xMantleKR";

if (!itemId || !postArg) {
  throw new Error(
    "usage: pnpm x:link --item <itemId> --post <post id or url> [--handle <account>] [--yes]\n" +
      "  e.g. pnpm x:link --item x:2081711456320655644 --post https://x.com/0xMantleKR/status/2082062251876561175",
  );
}

// Parsed before any network or database work: a `--post` that is neither an id nor a post url decides
// which post a publish-history row would claim, and there is no safe guess to fall back on.
const rootId = parsePostArg(postArg);
if (rootId === undefined) {
  throw new Error(`--post "${postArg}" is neither a post id nor a post url — refusing to guess which post you meant`);
}

const auth = await createGoogleAuth(loadGoogleAuthConfig());
const sheet = new GoogleSheetClient(auth, loadGoogleSheetConfig().spreadsheetId);
const gateway = new TwitterApiSourceGateway(new TwitterClient(loadConfig().apiKey));

const dbConfig = loadDbConfig();
const db = createDb(dbConfig);
try {
  // Names the database on the first line, like every other CLI here.
  console.log(
    `x:link — ${itemId} → post ${rootId} on @${handle} · database ${dbConfig.env} · ` +
      `${tryDescribeDbTarget(dbConfig) ?? INVALID_DB_URL}${writeConfirmed ? "" : " (preview — no --yes)"}`,
  );

  const stores = createStores(db);

  // By id, not by listing — the listing is exactly what could not see this post. `fetchThread` walks
  // the conversation so a multi-tweet thread is captured whole; `assembleThreads` then groups by
  // conversationId, and only the thread whose root IS the named post is ours (thread_context can
  // return neighbouring conversations too).
  const [translations, historyPostIds, threadTweets] = await Promise.all([
    stores.translationStore.loadAll(),
    loadHistoryPostIds(sheet),
    gateway.fetchThread(rootId),
  ]);
  const thread = assembleThreads(threadTweets).find((t) => t.rootId === rootId);

  const plan = planXLink({
    translation: translations.find((t) => t.itemId === itemId),
    itemId,
    rootId,
    thread,
    handle,
  });

  if (plan.kind === "refuse") throw new Error(plan.reason);

  if (plan.kind === "already-linked") {
    console.log(`\n${plan.itemId} is already linked to post ${plan.rootId} — nothing to do.`);
  } else {
    console.log(`\n  ${plan.itemId} → ${plan.url}`);
    console.log(`  posted at ${plan.postedAt}`);
    console.log(`  similarity to our translation: ${plan.score.toFixed(3)}`);
    if (plan.lowScore) {
      // Reported, never enforced: this command exists because the matcher was blind, so its score
      // has no standing to veto a human. A pasted url can still be the wrong one, which is a
      // different mistake and worth one loud line.
      console.log(
        `  ⚠ that is a LOW score — please confirm this really is ${plan.itemId}'s post before writing.\n` +
          `    Published copy starts: ${plan.text.slice(0, 80).replace(/\n/g, " / ")}`,
      );
    }

    if (!writeConfirmed) {
      console.log(`\npreview only — nothing was written. Re-run with --yes to record it.`);
    } else {
      console.log("\nwriting…");
      const retirer = new RetireTranslation(stores.translationStore, new RecordPublish(sheet), historyPostIds);
      const result = await retirer.run({
        itemId: plan.itemId,
        rootId: plan.rootId,
        url: plan.url,
        postedAt: plan.postedAt,
      });
      console.log(result.status === "retired" ? `  ✓ ${plan.itemId} recorded as posted` : `  · ${plan.itemId} already posted`);
      if (result.history === "written") console.log(`    ✓ history recorded (post ${plan.rootId})`);
      else if (result.history === "failed") console.log(`    ✗ history write failed — rerun to retry`);

      const captured = await new CapturePublishedText(stores.translationStore).run({
        itemId: plan.itemId,
        text: plan.text,
      });
      console.log(captured === "captured" ? `    ✓ published copy captured` : `    · published copy already stored`);

      if (result.history === "failed") process.exitCode = 1;
    }
  }
} finally {
  await db.close();
}
