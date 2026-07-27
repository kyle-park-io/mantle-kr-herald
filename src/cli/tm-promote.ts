import "./registerErrorHandler";
import { JsonFewShotStore } from "../adapters/store/JsonFewShotStore";
import { readJsonFile } from "../shared/store/jsonFile";
import { acceptedRecords } from "../domain/tm/promote";
import type { ProposedRecord } from "../domain/tm/pairsReview";
import { paths } from "../paths";

const records = await readJsonFile<ProposedRecord[]>(paths.referencePairsProposed, []);
const accepted = acceptedRecords(records);

const tm = new JsonFewShotStore(paths.translationConfigDir, "tm.json");
for (const r of accepted) {
  await tm.add({ source: r.source, target: r.target, itemId: r.koId });
}

console.log(`promoted ${accepted.length} of ${records.length} pair(s) → translation/tm.json`);
