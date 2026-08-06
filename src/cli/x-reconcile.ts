import "./registerErrorHandler";
import { skipIfLocal } from "./skipIfLocal";
import { argValue } from "./args";
import { loadConfig, loadDbConfig, loadGoogleAuthConfig, loadGoogleSheetConfig } from "../config";
import { createDb } from "../adapters/db/createDb";
import { createStores } from "./stores";
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";
import { GoogleSheetClient } from "../adapters/sheets/GoogleSheetClient";
import { TwitterClient } from "../adapters/twitterapi/TwitterClient";
import { TwitterApiSourceGateway } from "../adapters/twitterapi/TwitterApiSourceGateway";
import { assembleThreads } from "../domain/threadAssembler";
import { parseSince } from "../shared/time/parseSince";
import { postUrl } from "../domain/publish/xReconcile";
import { reconcileXPublished } from "../app/ReconcileXPublished";
import {
  candidateReasonText,
  externalSummaryLine,
  retireNotification,
  sortedPostedNearMisses,
  xReconcileStartupLine,
} from "./xReconcileReport";
import { RecordObservedDelivery } from "../app/RecordObservedDelivery";
import { RecordPublish } from "../app/RecordPublish";
import { RetireTranslation } from "../app/RetireTranslation";
import { notifyOps } from "../shared/notifyOps";
import type { SourceTweet } from "../domain/models";
import type { SheetClient } from "../ports/SheetClient";

skipIfLocal("x:reconcile");

// Same expression `metrics-record.ts:16` uses for the env fallback; `--handle` (not present there)
// takes priority over it so an operator can point one run at a different account without an env edit.
const handle =
  argValue("--handle")?.trim().replace(/^@/, "") ||
  process.env.REFERENCE_X_HANDLE?.trim().replace(/^@/, "") ||
  "0xMantleKR";
const since = parseSince(argValue("--since") ?? "30d", new Date());
const writeConfirmed = process.argv.includes("--yes");

// A–D: itemId, type, channel, postId (see HISTORY_HEADER). Columns E–J are RecordPublish's and
// RecordImpressions' to own; nothing here writes them and nothing here needs to read them.
const HISTORY_KEYS_RANGE = "history!A2:D";

/**
 * The `history` tab read as the two identities an already-recorded X post can carry: the `itemId` in
 * column A and the `postId` in column D.
 *
 * Both are needed, and column A alone was a bug. `kr:<rootId>` in column A only ever matches a row
 * this reconcile itself wrote. The tab's real identity for an X row is the postId — that is what
 * `RecordImpressions` filters and fetches on — and the same live post can already sit there under a
 * different itemId: `pnpm history:record --item x:… --post-id …` is the documented manual path for
 * exactly these hand-posted threads, and a `send:channels` send whose rendering later stopped being an
 * eligible candidate leaves one too. Keyed on column A alone, such a post gained a *second* row and
 * `impressions:record` wrote view counts into both.
 *
 * A workbook that has never had a row written to it — or one where `history:record`/`send:channels`
 * never ran at all — has no `history` tab, and the raw Sheets error for that is `HTTP 400`. That must
 * read as "nothing recorded yet", not a crash: same handling `LoadKolMap.readTab` gives the `kol-map`
 * tab's own first-run-before-anyone-created-it case.
 */
async function loadHistoryKeys(sheet: SheetClient): Promise<{ itemIds: Set<string>; postIds: Set<string> }> {
  try {
    const rows = await sheet.getValues(HISTORY_KEYS_RANGE);
    return {
      itemIds: new Set(rows.map((r) => r[0]).filter((v): v is string => Boolean(v))),
      postIds: new Set(rows.map((r) => r[3]).filter((v): v is string => Boolean(v))),
    };
  } catch (err) {
    const message = (err as Error)?.message ?? "";
    if (/HTTP 400/.test(message)) return { itemIds: new Set(), postIds: new Set() };
    throw err;
  }
}

const auth = await createGoogleAuth(loadGoogleAuthConfig());
const sheet = new GoogleSheetClient(auth, loadGoogleSheetConfig().spreadsheetId);
const gateway = new TwitterApiSourceGateway(new TwitterClient(loadConfig().apiKey));

const dbConfig = loadDbConfig();
const db = createDb(dbConfig);
try {
  // Names the database on the FIRST line, like `pnpm watch` and `pnpm status` do, because this
  // command's own unit runs it with `--yes`: there is no "start it by hand and read the first line
  // before you enable" step to copy, so the runbook's install has the operator preview with the
  // production environment sourced and stop if this line says `development`.
  console.log(xReconcileStartupLine({ handle, since, write: writeConfirmed, db: dbConfig }));

  // Read what's live. Never through CollectAuthoredContent/a CollectionRepository: this reads the
  // account back for comparison only, and must never advance the collect watermark or touch
  // `x_threads` — collecting reference content is `collect:reference`'s job, not this one's.
  const tweets: SourceTweet[] = [];
  for await (const t of gateway.fetchAuthoredTweets(handle, since)) tweets.push(t);
  const threads = assembleThreads(tweets);

  const stores = createStores(db);
  const [renderings, deliveredKeys, history, allTranslations] = await Promise.all([
    stores.formattingStore.loadAll(),
    stores.deliveryLedger.loadKeys(),
    loadHistoryKeys(sheet),
    stores.translationStore.loadAll(),
  ]);
  // Lark-sourced translations never went anywhere near this account — the design scopes Lark out
  // of this feature entirely (see the spec) — and nothing upstream of this filter does the
  // narrowing: reconcileXPublished takes whatever `translations` it is handed and would happily
  // score a Lark translation against an X thread if this file let one through.
  const translations = allTranslations.filter((t) => t.source === "x");

  const plan = reconcileXPublished({
    threads,
    renderings,
    translations,
    deliveredKeys,
    historyIds: history.itemIds,
    historyPostIds: history.postIds,
    handle,
  });

  console.log(`${threads.length} live thread(s) found.\n`);

  console.log(`confirmed (${plan.confirmed.length}) — pasted copy; recordable as a "sent" observation:`);
  for (const { entry, score } of plan.confirmed) {
    console.log(`  ${entry.itemId} (${entry.type}) → post ${entry.postId} — score ${score.toFixed(3)} — ${entry.url}`);
  }

  console.log(`\ncandidates (${plan.candidates.length}) — a human's call; nothing written for these:`);
  for (const c of plan.candidates) {
    console.log(
      `  ${c.rootId} → ${c.itemId} — score ${c.score.toFixed(3)} — ${postUrl(handle, c.rootId)}\n` +
        `      [${c.reason}] ${candidateReasonText(c.reason, c.itemId, renderings)}`,
    );
  }

  // What a `score === 0` row does and does not mean is decided in `externalSummaryLine`, which is
  // tested; this is the only place it is printed.
  console.log(`\n${externalSummaryLine(plan.external)}`);
  // One line per row, not just a count. This is the longest write list and the only one that touches
  // the team's shared workbook, so it is the list a human most needs to eyeball before the first
  // `--yes` — a count tells them how many rows are coming but not which posts, which is the only
  // thing they can actually check. Plan order, so a line here matches the order the write loop below
  // reports.
  for (const { record, score } of plan.external) {
    console.log(`  root ${record.postId} → ${record.itemId} — score ${score.toFixed(3)} — ${record.url}`);
  }
  // A non-zero score below CANDIDATE_AT is not a match, but it is not nothing either — either our
  // copy went out modified enough that `classify` didn't call it a candidate, or the matcher is
  // mis-scoring, and both are worth a person's eyes. `classify`/`reconcileXPublished` carry this
  // real score through for exactly this reason (see `xReconcile.ts`'s `Verdict` and
  // `ReconcilePlan.external`'s doc comment) — dropping it here, after the aggregate/zero-count line
  // above, would be the one place that work stops paying off. Sorted highest-first so the most
  // suspicious near-miss is on top — which is what this block adds over the plan-ordered list above,
  // where a 0.49 sits wherever the timeline put it; by nature there are usually few, often none.
  const nearMisses = plan.external.filter((e) => e.score > 0).sort((a, b) => b.score - a.score);
  if (nearMisses.length > 0) {
    console.log(`  ${nearMisses.length} near-miss(es) scored above 0 but below CANDIDATE_AT (highest first):`);
    for (const { record, score } of nearMisses) {
      const rootId = record.itemId.replace(/^kr:/, "");
      console.log(`    root ${rootId} → post ${record.postId} — score ${score.toFixed(3)}`);
    }
  }

  console.log(
    `\nposted (${plan.posted.length}) — a translation that already went out by hand; retirable as a history row:`,
  );
  for (const p of plan.posted) {
    console.log(`  ${p.itemId} → post ${p.rootId} — score ${p.score.toFixed(3)} — ${p.url}`);
  }
  // Same argument as the `external` near-misses just above: a translation that scored close to
  // TRANSLATION_MATCH_AT without clearing it is real information, not nothing. Computed by
  // `reconcileXPublished` itself now, against the exact pool it used at the moment of scoring —
  // see `ReconcilePlan`'s own doc comment on `postedNearMisses` for why this file no longer
  // re-derives it (Task 4 review round 2, Concern 2).
  const translationMisses = sortedPostedNearMisses(plan.postedNearMisses);
  if (translationMisses.length > 0) {
    console.log(`  ${translationMisses.length} near-miss(es) scored above 0 but below TRANSLATION_MATCH_AT (highest first):`);
    for (const { itemId, rootId, score } of translationMisses) {
      console.log(`    ${itemId} → root ${rootId} — score ${score.toFixed(3)}`);
    }
  }

  // One line per row, not just a count — same argument as `external` above. `skipped` used to hold
  // only already-recorded rows, but it now also holds every rootless thread (see the guard in
  // `reconcileXPublished`), which is neither already recorded nor recorded by hand: 85 of 196
  // threads in the committed reference corpus have that shape. The caption below stays neutral
  // about *why* a row is here, and each row's own `reason` — built for exactly this — says why.
  console.log(`\nskipped (${plan.skipped.length}) — left alone; nothing written for these:`);
  for (const { rootId, reason } of plan.skipped) {
    console.log(`  ${rootId} — ${reason}`);
  }

  if (!writeConfirmed) {
    console.log(
      `\npreview only — nothing was written. Re-run with --yes to record ${plan.confirmed.length} confirmed, ` +
        `${plan.external.length} external, and retire ${plan.posted.length} posted row(s).`,
    );
  } else {
    const recorder = new RecordObservedDelivery(stores.deliveryLedger);
    const publisher = new RecordPublish(sheet);
    // historyIds (column A) dropped — Task 4 review's Finding 3: it is redundant
    // (RecordPublish.record already matches on itemId/type/channel/outletId and updates rather
    // than duplicates) and could suppress a legitimate row (a Telegram send writes the same bare
    // `x:<id>` into column A). historyPostIds (column D, the postId) is the guard that actually
    // protects against two rows for one post.
    const retirer = new RetireTranslation(stores.translationStore, publisher, history.postIds);
    let written = 0;
    let alreadyRecorded = 0;
    let replacedDropped = 0;
    let failed = 0;
    let retired = 0;
    let alreadyRetired = 0;
    let historyWritten = 0;
    let historyFailed = 0;
    const retiredItemIds: string[] = [];

    console.log("\nwriting…");
    for (const { entry } of plan.confirmed) {
      try {
        const result = await recorder.record(entry);
        if (result === "written") {
          written++;
          console.log(`  ✓ ${entry.itemId} recorded as sent (post ${entry.postId})`);
        } else if (result === "replaced-dropped") {
          // Reported as its own outcome, never as a plain write: a `dropped` row was overwritten. That
          // is the right record — the post is live now, so "the draft was deleted before publishing"
          // has stopped being true — but it changes an existing row's meaning, and the operator should
          // see which one. See RecordObservedDelivery's doc comment.
          replacedDropped++;
          console.log(`  ↻ ${entry.itemId} replaced a dropped row with this live post (post ${entry.postId})`);
        } else {
          alreadyRecorded++;
          console.log(`  · ${entry.itemId} already recorded — skipped`);
        }
      } catch (err) {
        failed++;
        console.error(`  ✗ ${entry.itemId}: ${(err as Error).message}`);
      }
    }

    for (const { record } of plan.external) {
      try {
        await publisher.record(record);
        written++;
        console.log(`  ✓ ${record.itemId} recorded in history (post ${record.postId})`);
      } catch (err) {
        failed++;
        console.error(`  ✗ ${record.itemId}: ${(err as Error).message}`);
      }
    }

    for (const p of plan.posted) {
      try {
        // status and history are independent outcomes — see RetireTranslation's own doc comment
        // (Task 4 review's Finding 1). Neither one gates the other, and both are reported: a
        // translation can be freshly retired with its history row written in the same call, or
        // already-retired from an earlier run yet only now getting its history row (a previous
        // run's history write threw), or freshly retired while history fails right here.
        const result = await retirer.run({ itemId: p.itemId, rootId: p.rootId, url: p.url, postedAt: p.postedAt });

        if (result.status === "retired") {
          retired++;
          retiredItemIds.push(p.itemId);
          console.log(`  ✓ ${p.itemId} retired — already posted by hand (post ${p.rootId})`);
        } else {
          alreadyRetired++;
          console.log(`  · ${p.itemId} already retired`);
        }

        if (result.history === "written") {
          historyWritten++;
          console.log(`    ✓ history recorded (post ${p.rootId})`);
        } else if (result.history === "failed") {
          // Counted into `failed` below (Task 4 review's Finding 2) — not swallowed the way
          // RetireTranslation itself swallows the underlying error. A hand-post whose history row
          // never lands is a post `impressions:record` will never measure, and that must fail this
          // run's exit code loudly and keep failing every tick until it is fixed, not read as a
          // clean batch because the status half alone succeeded.
          historyFailed++;
          failed++;
          console.log(`    ✗ history write failed for ${p.itemId} (post ${p.rootId}) — will retry next run`);
        }
        // "skipped" (already in historyPostIds) prints nothing further — the status line above
        // already said what happened to this row.
      } catch (err) {
        // RetireTranslation.run only throws for a translation row that has vanished since the plan
        // was built — genuinely exceptional, unlike a history write's own caught-and-reported failure.
        failed++;
        console.error(`  ✗ ${p.itemId}: ${(err as Error).message}`);
      }
    }

    console.log(
      `\nwrote ${written}, replaced ${replacedDropped} dropped row(s), already recorded ${alreadyRecorded}, ` +
        `retired ${retired}, already retired ${alreadyRetired}, history written ${historyWritten}, ` +
        `history failed ${historyFailed}, failed ${failed}.`,
    );
    // Only an actual write throwing counts as a failure — a plan full of candidates that a human
    // still needs to look at is the normal, expected outcome of a run, not an error. A failed
    // history write counts too (folded into `failed` above), on purpose: see the comment at that
    // increment.
    if (failed > 0) process.exitCode = 1;

    // A one-off, not an every-run alert: fires only when `retireNotification` (xReconcileReport.ts)
    // says there's something to send — see that function's own doc comment for the threshold and
    // why it lives somewhere testable rather than as a literal here. Fired after the write loop,
    // not per-item, so one alert names the whole batch rather than a Telegram message per retired
    // translation.
    const notification = retireNotification(retired, retiredItemIds, handle);
    if (notification !== undefined) await notifyOps(notification);
  }
} finally {
  await db.close();
}
