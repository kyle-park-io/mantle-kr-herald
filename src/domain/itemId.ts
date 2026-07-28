/**
 * An itemId is `<source>:<id>` (e.g. `x:2072…`, `lark:abc`). A CLI `--ids` filter should match either
 * the full itemId or the bare id, so `--ids 2072…` works as well as `--ids x:2072…` (the source prefix
 * is easy to forget).
 */
export function matchesItemId(ids: Set<string>, itemId: string): boolean {
  return ids.has(itemId) || ids.has(itemId.slice(itemId.indexOf(":") + 1));
}
