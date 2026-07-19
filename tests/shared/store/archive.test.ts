import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveFile } from "../../../src/shared/store/archive";

describe("archiveFile", () => {
  it("moves the file into a dated folder and returns the destination", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arch-"));
    const src = join(dir, "pending.json");
    await writeFile(src, '{"a":1}', "utf8");
    const root = join(dir, "archive");

    const dest = await archiveFile(src, root, "pending-translations", new Date("2026-07-20T09:30:15.000Z"));

    expect(dest).not.toBeNull();
    expect(dest).toContain(join("archive", "2026-07-20"));
    expect(await readFile(dest as string, "utf8")).toBe('{"a":1}');
    await expect(readFile(src, "utf8")).rejects.toThrow();
  });

  it("returns null when there is nothing to archive", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arch-"));
    expect(await archiveFile(join(dir, "absent.json"), join(dir, "archive"), "x")).toBeNull();
  });

  it("does not collide when archiving twice in the same second", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arch-"));
    const root = join(dir, "archive");
    const at = new Date("2026-07-20T09:30:15.000Z");
    for (const body of ["one", "two"]) {
      await writeFile(join(dir, "pending.json"), body, "utf8");
      await archiveFile(join(dir, "pending.json"), root, "pending", at);
    }
    expect(await readdir(join(root, "2026-07-20"))).toHaveLength(2);
  });
});
