import "./registerErrorHandler";
import { XContentSource } from "../adapters/content/XContentSource";
import { proposePairs } from "../domain/tm/pairing";
import { toProposedRecords, renderPairsReview } from "../domain/tm/pairsReview";
import { writeJsonFileAtomic, writeTextFileAtomic } from "../shared/store/jsonFile";
import { paths } from "../paths";

// Conservative defaults — precision over recall. Tune from the first real worksheet.
const PAIR_WINDOW_DAYS = 14;
const PAIR_MIN_ANCHORS = 2;

const enItems = await new XContentSource(paths.xItems).loadPending(new Set<string>());
const koItems = await new XContentSource(paths.referenceItems).loadPending(new Set<string>());

const pairs = proposePairs(enItems, koItems, { windowDays: PAIR_WINDOW_DAYS, minAnchors: PAIR_MIN_ANCHORS });

await writeJsonFileAtomic(paths.referenceDir, paths.referencePairsProposed, toProposedRecords(pairs));
await writeTextFileAtomic(paths.referenceDir, paths.referencePairsReview, renderPairsReview(pairs));

console.log(
  `proposed ${pairs.length} pair(s). Review ${paths.referencePairsReview}, ` +
    `set "accept": false on wrong pairs in ${paths.referencePairsProposed}, then run: pnpm tm:promote`,
);
