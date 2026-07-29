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
 * - `publish/channels.json` — the **pre-outlet** send ledger. Still live: `JsonDeliveryLedger`
 *   falls back to it whenever `deliveries.json` is absent, which is every install that predates the
 *   outlet axis. Leaving it out would mean `state:push` bundling three files, reporting success, and
 *   a later restore producing a machine with no send history at all — every previously-sent room
 *   reading as never-sent. That is this feature's own threat model, so it is tracked even though
 *   nothing writes it any more.
 * - `publish/x-article.json` — the X article send ledger, same hazard.
 * - `publish/state.json` — the Drive sync ledger.
 *
 * Push and pull share this one list, so the two can never disagree about what a snapshot holds.
 * A tree that has no legacy file simply pushes four (`FsStateFileStore.list` skips what is absent),
 * and a snapshot that *does* carry one aborts `state:pull` on a checkout predating this list —
 * `unknownStatePaths` refusing rather than half-restoring, which is the designed behaviour.
 */
const TRACKED = [
  paths.formattedOverrides,
  paths.publishDeliveries,
  paths.publishChannelsLegacy,
  paths.publishXArticle,
  paths.publishState,
];

/** Repo-relative, POSIX-separated — the key a file takes inside a snapshot, stable across platforms. */
export function trackedStateFiles(): TrackedStateFile[] {
  return TRACKED.map((abs) => ({ abs, rel: relative(REPO_ROOT, abs).split(sep).join("/") }));
}

export function createStateFileStore(): FsStateFileStore {
  return new FsStateFileStore(trackedStateFiles());
}

/** Names this bundle in `GoogleConfigDrive`'s failure messages — a stale `GDRIVE_STATE_FOLDER_ID`
 *  must not report itself as a *config* download failure. */
export const DRIVE_LABEL = "operational-state";

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

/**
 * The warning after a `--yes` run, or `undefined` when the restore covered everything.
 *
 * A `유지` row prints at the same weight as every other row in the preview above, and the closing
 * summary ("4개 파일을 복원했습니다") reads like a complete restore on its own. A kept file means the
 * tree is now mixed — a ledger from the snapshot's date beside one from today — which is the
 * operator's to reconcile, so the count gets said out loud rather than left to be inferred.
 */
export function describeKeptFiles(diff: readonly RowCountDiff[]): string | undefined {
  const kept = diff.filter((d) => d.change === "keep");
  if (kept.length === 0) return undefined;
  return `⚠ ${kept.length}개 파일은 스냅샷에 없어 그대로 뒀습니다(${kept.map((d) => d.path).join(", ")}) — 지금 트리는 스냅샷 시점과 현재가 섞여 있습니다. 발송 원장이 섞였다면 보드에서 한 번 확인하세요.`;
}

/**
 * What `state:push` says about the folder it is about to use. `findFolder(...) ?? createFolder(...)`
 * covers two very different situations in one line, and the found branch is the ordinary
 * `.env`-lost-but-Drive-intact recovery — being told a folder holding months of snapshots was just
 * "created" is precisely the wrong signal there.
 */
export function describeProvisionedFolder(f: {
  created: boolean;
  name: string;
  id: string;
  parentName?: string;
}): string {
  const where = `"${f.name}"${f.parentName ? ` (상위: "${f.parentName}")` : ""}`;
  return f.created
    ? `운영 상태 폴더 ${where} 를 새로 만들었습니다 — ${f.id}`
    : `이미 있는 운영 상태 폴더 ${where} 를 찾았습니다 — ${f.id} (기존 스냅샷이 그대로 있습니다)`;
}
