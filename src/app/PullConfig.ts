import type { ConfigFileStore } from "../ports/ConfigFileStore";
import type { ConfigDrive } from "../ports/ConfigDrive";
import { parseConfigBundle } from "../domain/config/bundle";

export interface PullChange {
  path: string;
  kind: "new" | "modified" | "same";
}
export interface PullResult {
  pulled: number;
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
    const latest = await this.drive.latest(folderId, "steering-config-");
    if (!latest) return undefined;
    const incoming = parseConfigBundle(await this.drive.download(latest.id));
    const current = new Map((await this.files.list()).map((f) => [f.path, f.content]));
    const changes: PullChange[] = incoming.map((f) => ({
      path: f.path,
      kind: !current.has(f.path) ? "new" : current.get(f.path) === f.content ? "same" : "modified",
    }));

    if (opts.dryRun) return { pulled: 0, dryRun: true, changes };

    const backupDir = `${this.archiveDir}/steering-${this.now().replace(/[:.]/g, "-")}`;
    await this.files.backup(backupDir); // before any write — a failure here aborts the pull
    for (const f of incoming) await this.files.write(f.path, f.content);
    return { pulled: incoming.length, backupDir, dryRun: false, changes };
  }
}
