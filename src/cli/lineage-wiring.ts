import { JsonlLineageStore } from "../adapters/store/JsonlLineageStore";
import type { LineageStore } from "../ports/LineageStore";
import { paths } from "../paths";

/** Always-on local lineage store (writes output/lineage/). */
export function buildLineage(): LineageStore {
  return new JsonlLineageStore(paths.lineageDir);
}
