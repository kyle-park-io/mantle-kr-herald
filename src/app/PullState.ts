import { join } from "node:path";
import type { ConfigDrive } from "../ports/ConfigDrive";
import type { StateFileStore } from "../ports/StateFileStore";
import {
  diffRowCounts,
  parseStateSnapshot,
  unknownStatePaths,
  STATE_SNAPSHOT_PREFIX,
  type RowCountDiff,
} from "../domain/state/snapshot";

export interface PullStateResult {
  /** The Drive file this result describes. */
  snapshot: string;
  /** `false` = preview only; nothing was written. */
  applied: boolean;
  diff: RowCountDiff[];
  backupDir?: string;
  backedUp: number;
  restored: number;
}

/**
 * Restores the newest operational-state snapshot — cautiously, because unlike `config:pull` this is
 * single-machine recovery and not distribution. Pulling someone else's operational state would
 * overwrite this machine's delivery ledger, and rooms it had already posted to would read as
 * never-sent; from there a single confirmation puts months-old copy into a live room.
 *
 * So the order is fixed and the default is safe:
 *
 *   download → parse → validate → **preview unless `apply`** → back up → write
 *
 * Everything that can fail happens before the first write, so a failed pull leaves the tree exactly
 * as it found it. `apply` defaults to false rather than the caller opting *out* of writing, so a
 * caller that forgets the flag gets a preview instead of an overwrite.
 */
export class PullState {
  constructor(
    private readonly files: StateFileStore,
    private readonly drive: ConfigDrive,
    private readonly archiveDir: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** `undefined` means the folder holds no snapshot yet. */
  async run(folderId: string, opts: { apply?: boolean } = {}): Promise<PullStateResult | undefined> {
    const latest = await this.drive.latest(folderId, STATE_SNAPSHOT_PREFIX);
    if (!latest) return undefined;
    const incoming = parseStateSnapshot(await this.drive.download(latest.id));
    const unknown = unknownStatePaths(incoming, this.files.tracked());
    if (unknown.length > 0) {
      throw new Error(
        `snapshot ${latest.name} contains file(s) this version does not track: ${unknown.join(", ")} — upgrade before restoring`,
      );
    }
    const current = await this.files.list();
    const diff = diffRowCounts(current, incoming);

    if (!opts.apply) return { snapshot: latest.name, applied: false, diff, backedUp: 0, restored: 0 };

    const backupDir = join(this.archiveDir, `state-${this.now().replace(/[:.]/g, "-")}`);
    await this.files.backup(backupDir); // before any write — a failure here aborts the pull
    for (const f of incoming) await this.files.write(f.path, f.content);
    return { snapshot: latest.name, applied: true, diff, backupDir, backedUp: current.length, restored: incoming.length };
  }
}
