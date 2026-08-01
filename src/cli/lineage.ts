import "./registerErrorHandler";
import { argValue } from "./args";
import { createDb } from "../adapters/db/createDb";
import { loadDbConfig } from "../config";
import { createStores } from "./stores";
import { renderLineage } from "../domain/lineage/render";

const itemId = process.argv[2]?.startsWith("--") ? argValue("--id") : process.argv[2];

const db = createDb(loadDbConfig());
try {
  const store = createStores(db).lineageStore;

  if (!itemId) {
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
