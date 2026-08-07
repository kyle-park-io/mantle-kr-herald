import "./registerErrorHandler";
import { argValue } from "./args";
import { createDb } from "../adapters/db/createDb";
import { loadDbConfig } from "../config";
import { createStores } from "./stores";
import { renderLineage } from "../domain/lineage/render";
import { formatActivity, lineageActivity, parseActivitySince } from "../domain/lineage/activity";

/**
 * Three readings of the same append-only table, and they answer different questions:
 *
 *   pnpm lineage                    per-item listing — which items have a history at all
 *   pnpm lineage <id> | --id <id>   one item's journey, with per-revision diffs
 *   pnpm lineage --activity         a date × stage rollup — *when did what happen*
 *
 * The third exists because the second could not be aggregated and the question kept getting asked
 * of `pnpm status` instead, which answers a different one: `status` counts where records are now,
 * and a record that has moved on carries no trace of having ever been anywhere else. See
 * `src/domain/lineage/activity.ts`'s header for the wrong conclusion that cost.
 */
const activity = process.argv.includes("--activity");
const since = argValue("--since");

// Unchanged: a leading `--` means the id can only have come from `--id`, so `--activity` and
// `--since` never get mistaken for a positional itemId.
const itemId = process.argv[2]?.startsWith("--") ? argValue("--id") : process.argv[2];

// Both refusals cover the same hazard: a flag the chosen reading does not consult would otherwise
// be dropped in silence, and an argument that looks applied and is not is worse than none at all.
// `--since` narrows only the rollup; the rollup spans every item and takes no id.
if (since !== undefined && !activity) {
  throw new Error("--since only applies to `pnpm lineage --activity` (the per-item readings show every entry).");
}
if (activity && itemId) {
  throw new Error(`--activity rolls up every item and cannot be narrowed to one. Drop it for ${itemId}'s own history.`);
}

// Parsed before the database is opened, so a mistyped date fails on the spot rather than after a
// connection and a full-table read.
const activitySince = activity ? parseActivitySince(since) : undefined;

const db = createDb(loadDbConfig());
try {
  const store = createStores(db).lineageStore;

  if (activity) {
    console.log(formatActivity(lineageActivity(await store.listEvents(), { since: activitySince })));
  } else if (!itemId) {
    const items = await store.listItems();
    if (items.length === 0) {
      console.log("no lineage yet (run the pipeline; lineage fills as items are saved)");
    } else {
      for (const s of items) console.log(`${s.itemId}\t${s.entries} entr(y/ies)\tlast: ${s.lastStage}`);
    }
  } else {
    const entries = await store.load(itemId);
    if (entries.length === 0) console.log(`no lineage for ${itemId}`);
    else console.log(renderLineage(entries));
  }
} finally {
  await db.close();
}
