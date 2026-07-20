import { unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { writeTextFileAtomic, isErrnoException } from "../../shared/store/jsonFile";
import type { UploadRequest, UploadResult } from "../../domain/publish/publishModels";
import type { DriveUploader } from "../../ports/DriveUploader";

/**
 * The filesystem as a publish target, so `local` storage mode produces the same human-readable
 * document Drive gets instead of skipping publication. Folder kinds map to subdirectories, which
 * is why this needs no configuration where Google and Lark need folder ids.
 */
export class LocalFileUploader implements DriveUploader {
  readonly name = "local";

  constructor(private readonly rootDir: string) {}

  async upload(req: UploadRequest): Promise<UploadResult> {
    return this.write(req);
  }

  /**
   * Writes the new file and, only when the filename changed, deletes the old one. Same name (the
   * common case) is a plain in-place overwrite. `publishFileName` embeds approvedAt's date, so
   * re-approving on a later day changes the filename — writing the new path without removing the old
   * would leave a duplicate that nothing on disk distinguishes from the current one. Google avoids
   * this by PATCHing a file id; addressing by path means the local equivalent is deleting the old
   * path.
   *
   * `remoteId` is a path relative to rootDir, as returned by upload().
   */
  async update(remoteId: string, req: UploadRequest): Promise<UploadResult> {
    const result = await this.write(req);
    const oldPath = resolve(this.rootDir, remoteId);
    const newPath = resolve(this.rootDir, result.id);
    if (oldPath !== newPath) {
      await unlink(oldPath).catch((err: unknown) => {
        // Moved or deleted by hand is not a failure — the write above already restored the current
        // content. Anything else (a permissions problem) is real and must surface.
        if (!isErrnoException(err) || err.code !== "ENOENT") throw err;
      });
    }
    return result;
  }

  /** `url` is omitted: the dashboard is served over http, where browsers block file:// links. */
  private async write(req: UploadRequest): Promise<UploadResult> {
    // req.name comes from publishFileName, whose date prefix is not slugified. A hand-corrupted
    // translations.json could smuggle a path separator or ".." into it and escape rootDir.
    if (req.name.includes("/") || req.name.includes("\\") || req.name.includes("..")) {
      throw new Error(`LocalFileUploader: refusing unsafe file name "${req.name}"`);
    }
    const relative = join(req.folder, req.name);
    const full = join(this.rootDir, relative);
    await writeTextFileAtomic(dirname(full), full, req.content);
    return { id: relative, name: req.name };
  }
}
