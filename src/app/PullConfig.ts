import type { ConfigFileStore } from "../ports/ConfigFileStore";
import type { ConfigDrive } from "../ports/ConfigDrive";
import { parseConfigBundle } from "../domain/config/bundle";
import { isSteeringConfigFile, STEERING_SNAPSHOT_PREFIX } from "../domain/config/steering";

export interface PullChange {
  path: string;
  kind: "new" | "modified" | "same";
}
export interface PullResult {
  pulled: number;
  backedUp: number;
  backupDir?: string;
  dryRun: boolean;
  changes: PullChange[];
}

export class PullConfig {
  constructor(
    private readonly files: ConfigFileStore,
    private readonly drive: ConfigDrive,
    private readonly archiveDir: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(folderId: string, opts: { dryRun?: boolean } = {}): Promise<PullResult | undefined> {
    const latest = await this.drive.latest(folderId, STEERING_SNAPSHOT_PREFIX);
    if (!latest) return undefined;
    // Filtered on the way IN, not only on the way out. Every bundle pushed before the few-shot files
    // stopped being treated as configuration still carries them, and `files.list()` no longer
    // reports the local copies — so an unfiltered pull would write a corpus snapshot frozen at
    // cutover back into the tree, report it as `new` every single time (nothing local to compare
    // against), and hand `db:import` a stale corpus to resurrect into `few_shot_examples`.
    const incoming = parseConfigBundle(await this.drive.download(latest.id)).filter((f) =>
      isSteeringConfigFile(f.path.slice(f.path.lastIndexOf("/") + 1)),
    );
    const current = new Map((await this.files.list()).map((f) => [f.path, f.content]));
    const changes: PullChange[] = incoming.map((f) => ({
      path: f.path,
      kind: !current.has(f.path) ? "new" : current.get(f.path) === f.content ? "same" : "modified",
    }));

    if (opts.dryRun) return { pulled: 0, backedUp: 0, dryRun: true, changes };

    const backupDir = `${this.archiveDir}/steering-${this.now().replace(/[:.]/g, "-")}`;
    await this.files.backup(backupDir); // before any write — a failure here aborts the pull
    for (const f of incoming) await this.files.write(f.path, f.content);
    return { pulled: incoming.length, backedUp: current.size, backupDir, dryRun: false, changes };
  }
}
