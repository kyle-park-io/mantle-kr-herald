import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StateFile } from "../../domain/state/snapshot";
import type { StateFileStore } from "../../ports/StateFileStore";
import { isErrnoException } from "../../shared/store/jsonFile";

/** One tracked file: where it lives, and the repo-relative key it takes in a snapshot. */
export interface TrackedStateFile {
  abs: string;
  rel: string;
}

export class FsStateFileStore implements StateFileStore {
  private readonly byRel: Map<string, string>;

  constructor(private readonly files: readonly TrackedStateFile[]) {
    this.byRel = new Map(files.map((f) => [f.rel, f.abs]));
  }

  tracked(): readonly string[] {
    return this.files.map((f) => f.rel);
  }

  /** A missing file is skipped, not an error. Any other read failure propagates: a file that exists
   *  but cannot be read must not be quietly dropped from a backup. */
  async list(): Promise<StateFile[]> {
    const out: StateFile[] = [];
    for (const f of this.files) {
      let content: string;
      try {
        content = await readFile(f.abs, "utf8");
      } catch (err: unknown) {
        if (isErrnoException(err) && err.code === "ENOENT") continue;
        throw err;
      }
      out.push({ path: f.rel, content });
    }
    return out;
  }

  /** Resolves through the manifest rather than joining onto a root, so a snapshot path can never
   *  escape the tracked set — the content being written came off the network. */
  async write(path: string, content: string): Promise<void> {
    const abs = this.byRel.get(path);
    if (!abs) throw new Error(`refusing to write untracked operational-state file: ${path}`);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }

  async backup(destDir: string): Promise<void> {
    for (const f of await this.list()) {
      const abs = join(destDir, f.path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, f.content, "utf8");
    }
  }
}
