import type { ConfigFileStore } from "../ports/ConfigFileStore";
import type { ConfigDrive } from "../ports/ConfigDrive";
import { assembleConfigBundle, parseConfigBundle, type ConfigFile } from "../domain/config/bundle";
import { STEERING_SNAPSHOT_PREFIX } from "../domain/config/steering";

export interface PushConfigResult {
  name: string;
  id: string;
  count: number;
  /** `true` when the newest snapshot already held these exact files and nothing was uploaded. */
  skipped: boolean;
}

/** Same files, same bytes — order-independent, since the bundle stores a map. */
function sameFiles(a: ConfigFile[], b: ConfigFile[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Map(a.map((f) => [f.path, f.content]));
  return b.every((f) => left.get(f.path) === f.content);
}

export class PushConfig {
  constructor(
    private readonly files: ConfigFileStore,
    private readonly drive: ConfigDrive,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * Uploads one timestamped snapshot, **unless the newest one already holds these exact files.**
   *
   * Without the skip this uploads unconditionally, which was fine while every push was a human
   * reacting to an edit. On a daily timer it is ~365 near-identical snapshots a year in a folder
   * whose entire value is that its history is the rollback: finding the version before a bad edit
   * becomes a binary search through duplicates. Manual pushes get the same behaviour, which is also
   * right — pushing twice after one edit should not produce two snapshots either.
   *
   * The comparison is on the PARSED file map, never the bundle text: `assembleConfigBundle` embeds
   * `pushedAt`, so the raw JSON differs on every call and a text comparison would never match.
   *
   * Any failure to read the newest snapshot — absent, malformed, truncated — falls through to
   * uploading. The one thing worse than a duplicate snapshot is treating an unreadable newest
   * snapshot as "same, skip" and leaving the corpus with no good copy.
   */
  async run(folderId: string): Promise<PushConfigResult> {
    const files = await this.files.list();

    const newest = await this.drive.latest(folderId, STEERING_SNAPSHOT_PREFIX);
    if (newest) {
      try {
        if (sameFiles(parseConfigBundle(await this.drive.download(newest.id)), files)) {
          return { name: newest.name, id: newest.id, count: files.length, skipped: true };
        }
      } catch {
        // fall through and upload
      }
    }

    const stamp = this.now();
    const bundle = assembleConfigBundle(files, () => stamp);
    const name = `${STEERING_SNAPSHOT_PREFIX}${stamp.replace(/[:.]/g, "-")}.json`;
    const { id } = await this.drive.upload(folderId, name, bundle);
    return { name, id, count: files.length, skipped: false };
  }
}
