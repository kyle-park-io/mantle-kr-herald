import type { ConfigDrive } from "../ports/ConfigDrive";
import type { StateFileStore } from "../ports/StateFileStore";
import { assembleStateSnapshot, countRows, snapshotName } from "../domain/state/snapshot";

export interface PushedStateFile {
  path: string;
  /** `undefined` when the file's shape has no row count — see `countRows`. */
  rows?: number;
}

export interface PushStateResult {
  name: string;
  id: string;
  files: PushedStateFile[];
}

/**
 * Uploads one timestamped snapshot of the tracked operational files. Snapshots never overwrite —
 * the Drive folder's history is the rollback, exactly as for the steering config.
 */
export class PushState {
  constructor(
    private readonly files: StateFileStore,
    private readonly drive: ConfigDrive,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * `undefined` means there was nothing to push, and nothing was uploaded.
   *
   * That refusal matters: an accidental `state:push` from a fresh checkout would otherwise put an
   * empty snapshot at the head of the folder, and the next `state:pull` would show four `keep` rows
   * and restore nothing — a backup that reports success and holds none of the operator's records.
   * Refusing keeps the newest snapshot a real one.
   */
  async run(folderId: string): Promise<PushStateResult | undefined> {
    const files = await this.files.list();
    if (files.length === 0) return undefined;
    const stamp = this.now();
    const bundle = assembleStateSnapshot(files, () => stamp);
    const name = snapshotName(stamp);
    const { id } = await this.drive.upload(folderId, name, bundle);
    return { name, id, files: files.map((f) => ({ path: f.path, rows: countRows(f.content) })) };
  }
}
