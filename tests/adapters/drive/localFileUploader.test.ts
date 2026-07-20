import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFileUploader } from "../../../src/adapters/drive/LocalFileUploader";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "localpub-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("LocalFileUploader", () => {
  it("is named local", () => {
    expect(new LocalFileUploader(root).name).toBe("local");
  });

  it("writes a review doc under review/ and returns a rootDir-relative id", async () => {
    const uploader = new LocalFileUploader(root);

    const result = await uploader.upload({ name: "x-1.md", content: "# hi", folder: "review" });

    expect(result).toEqual({ id: join("review", "x-1.md"), name: "x-1.md" });
    expect(await readFile(join(root, "review", "x-1.md"), "utf8")).toBe("# hi");
  });

  it("writes an approved doc under approved/", async () => {
    const uploader = new LocalFileUploader(root);
    await uploader.upload({ name: "x-2.md", content: "ko", folder: "approved" });
    expect(await readFile(join(root, "approved", "x-2.md"), "utf8")).toBe("ko");
  });

  it("overwrites in place when the filename did not change", async () => {
    const uploader = new LocalFileUploader(root);
    const first = await uploader.upload({ name: "x-1.md", content: "old", folder: "approved" });

    const second = await uploader.update(first.id, { name: "x-1.md", content: "new", folder: "approved" });

    expect(second.id).toBe(first.id);
    expect(await readFile(join(root, "approved", "x-1.md"), "utf8")).toBe("new");
    expect(await readdir(join(root, "approved"))).toEqual(["x-1.md"]);
  });

  it("deletes the old file when the filename changed, leaving exactly one document", async () => {
    const uploader = new LocalFileUploader(root);
    const first = await uploader.upload({ name: "2026-07-15-x-1.md", content: "old", folder: "approved" });

    const second = await uploader.update(first.id, { name: "2026-07-21-x-1.md", content: "new", folder: "approved" });

    expect(second.id).toBe(join("approved", "2026-07-21-x-1.md"));
    expect(await readdir(join(root, "approved"))).toEqual(["2026-07-21-x-1.md"]);
    expect(await readFile(join(root, "approved", "2026-07-21-x-1.md"), "utf8")).toBe("new");
  });

  it("restores the document instead of failing when the old file was deleted by hand", async () => {
    const uploader = new LocalFileUploader(root);
    const first = await uploader.upload({ name: "2026-07-15-x-1.md", content: "old", folder: "approved" });
    await rm(join(root, first.id));

    const second = await uploader.update(first.id, { name: "2026-07-21-x-1.md", content: "new", folder: "approved" });

    expect(await readFile(join(root, second.id), "utf8")).toBe("new");
  });

  it("rethrows a non-ENOENT failure from the old-path unlink instead of swallowing it", async () => {
    const uploader = new LocalFileUploader(root);
    // Make the "old" path a non-empty directory rather than a file: unlink() on it fails with
    // EISDIR (this platform) / EPERM / ENOTEMPTY rather than ENOENT, exercising the rethrow branch
    // that only the "deleted by hand" (ENOENT) case is meant to swallow.
    await mkdir(join(root, "approved", "old-dir"), { recursive: true });
    await writeFile(join(root, "approved", "old-dir", "keep.txt"), "x");

    await expect(
      uploader.update(join("approved", "old-dir"), { name: "new.md", content: "new", folder: "approved" }),
    ).rejects.toThrow();
  });

  it("rejects a file name that tries to escape rootDir via a path separator or ..", async () => {
    const uploader = new LocalFileUploader(root);

    await expect(uploader.upload({ name: "../escape.md", content: "x", folder: "approved" })).rejects.toThrow(
      /unsafe file name/,
    );

    // The guard fires before any write, so nothing should have landed in rootDir or beside it.
    expect(await readdir(root)).toEqual([]);
  });
});
