import "./registerErrorHandler";
import { argValue } from "./args";
import { JsonlLineageStore } from "../adapters/store/JsonlLineageStore";
import { renderLineage } from "../domain/lineage/render";
import { paths } from "../paths";

const store = new JsonlLineageStore(paths.lineageDir);
const itemId = process.argv[2]?.startsWith("--") ? argValue("--id") : process.argv[2];

if (!itemId) {
  const items = await store.listItems();
  if (items.length === 0) {
    console.log("no lineage yet (run the pipeline; output/lineage/ fills as items are saved)");
  } else {
    for (const s of items) console.log(`${s.itemId}\t${s.entries} entr(y/ies)\tlast: ${s.lastStage}`);
  }
} else {
  const entries = await store.load(itemId);
  if (entries.length === 0) console.log(`no lineage for ${itemId}`);
  else console.log(renderLineage(entries));
}
