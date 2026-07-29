import { relative, sep } from "node:path";
import { FsStateFileStore, type TrackedStateFile } from "../adapters/store/FsStateFileStore";
import type { RowCountDiff } from "../domain/state/snapshot";
import { paths, REPO_ROOT } from "../paths";

/**
 * The files `state:push` snapshots: everything under `output/` that cannot be rebuilt by re-running
 * the pipeline. Items re-collect; translations, variants and renderings regenerate; lineage is an
 * append-only view of stores that are themselves in here. These four are not:
 *
 * - `formatted/overrides.json` — per-room forked copy. `format` produces the group text, not a
 *   reviewer's fork, so a lost file silently reverts every forked room.
 * - `publish/deliveries.json` — the send ledger. Losing it makes sent items read as never-sent.
 * - `publish/x-article.json` — the X article send ledger, same hazard.
 * - `publish/state.json` — the Drive sync ledger.
 *
 * Push and pull share this one list, so the two can never disagree about what a snapshot holds.
 */
const TRACKED = [paths.formattedOverrides, paths.publishDeliveries, paths.publishXArticle, paths.publishState];

/** Repo-relative, POSIX-separated — the key a file takes inside a snapshot, stable across platforms. */
export function trackedStateFiles(): TrackedStateFile[] {
  return TRACKED.map((abs) => ({ abs, rel: relative(REPO_ROOT, abs).split(sep).join("/") }));
}

export function createStateFileStore(): FsStateFileStore {
  return new FsStateFileStore(trackedStateFiles());
}

/** "행 수 알 수 없음" rather than "0행": see `countRows` — a shape we failed to read must not look empty. */
const rows = (n: number | undefined): string => (n === undefined ? "행 수 알 수 없음" : `${n}행`);

/**
 * What `state:pull` prints for each file. Lives here rather than in the entry script because it is
 * the thing the operator decides on — a preview that showed only file names would be asking them to
 * approve an overwrite sight unseen.
 */
export function describeStateDiff(diff: readonly RowCountDiff[]): string[] {
  return diff.map((d) => {
    if (d.change === "keep") return `  유지    ${d.path} — 현재 ${rows(d.current)} (스냅샷에 없음, 그대로 둡니다)`;
    if (d.change === "restore") return `  복원    ${d.path} — 현재 없음 → 스냅샷 ${rows(d.incoming)}`;
    return `  덮어씀  ${d.path} — 현재 ${rows(d.current)} → 스냅샷 ${rows(d.incoming)}`;
  });
}
