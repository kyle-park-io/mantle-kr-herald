import type { ConfigFileStore } from "../ports/ConfigFileStore";
import type { ConfigDrive } from "../ports/ConfigDrive";
import { assembleConfigBundle } from "../domain/config/bundle";

export class PushConfig {
  constructor(
    private readonly files: ConfigFileStore,
    private readonly drive: ConfigDrive,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(folderId: string): Promise<{ name: string; id: string; count: number }> {
    const files = await this.files.list();
    const stamp = this.now();
    const bundle = assembleConfigBundle(files, () => stamp);
    const name = `steering-config-${stamp.replace(/[:.]/g, "-")}.json`;
    const { id } = await this.drive.upload(folderId, name, bundle);
    return { name, id, count: files.length };
  }
}
