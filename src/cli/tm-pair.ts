import "./registerErrorHandler";
import { XContentSource } from "../adapters/content/XContentSource";
import { createDb } from "../adapters/db/createDb";
import { loadDbConfig } from "../config";
import { createStores } from "./stores";
import { proposePairs } from "../domain/tm/pairing";
import { toProposedRecords, renderPairsReview } from "../domain/tm/pairsReview";
import { writeJsonFileAtomic, writeTextFileAtomic } from "../shared/store/jsonFile";
import { paths } from "../paths";

// Conservative defaults — precision over recall. Tune from the first real worksheet.
const PAIR_WINDOW_DAYS = 14;
const PAIR_MIN_ANCHORS = 2;

const db = createDb(loadDbConfig());
try {
  // enItems: the main collected corpus (@Mantle_Official) — collect.ts writes this to Postgres now,
  // so it has to be read from there too, or a fresh checkout (no output/x/items.json at all) would
  // silently propose 0 pairs instead of reading real data.
  const enItems = await createStores(db).xContentSource.loadPending(new Set<string>());
  // koItems: the reference corpus (@0xMantleKR, collect-reference.ts) has no Postgres home — see
  // db-import.ts's own doc comment and the Task 17 report for why: x_threads has no handle/scope
  // column, so a second collection stream has nowhere to land without a schema change this plan
  // doesn't make. Stays file-backed, same as collect-reference.ts's output.
  const koItems = await new XContentSource(paths.referenceItems).loadPending(new Set<string>());

  const pairs = proposePairs(enItems, koItems, { windowDays: PAIR_WINDOW_DAYS, minAnchors: PAIR_MIN_ANCHORS });

  await writeJsonFileAtomic(paths.referenceDir, paths.referencePairsProposed, toProposedRecords(pairs));
  await writeTextFileAtomic(paths.referenceDir, paths.referencePairsReview, renderPairsReview(pairs));

  console.log(
    `proposed ${pairs.length} pair(s). Review ${paths.referencePairsReview}, ` +
      `set "accept": false on wrong pairs in ${paths.referencePairsProposed}, then run: pnpm tm:promote`,
  );
} finally {
  await db.close();
}
