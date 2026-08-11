import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsConfigFileStore } from "../../src/adapters/store/FsConfigFileStore";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cfg-"));
  await mkdir(join(root, "translation"), { recursive: true });
  await mkdir(join(root, "conversion"), { recursive: true });
  await writeFile(join(root, "translation", "glossary.json"), "[]", "utf8");
  await writeFile(join(root, "translation", "glossary.example.json"), "[]", "utf8"); // skipped
  await writeFile(join(root, "conversion", "announcement.md"), "# 공지", "utf8");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function store(): FsConfigFileStore {
  return new FsConfigFileStore(
    [{ abs: join(root, "translation"), rel: "translation" }, { abs: join(root, "conversion"), rel: "conversion" }],
    root,
  );
}

describe("FsConfigFileStore", () => {
  it("lists non-.example. files with repo-relative paths", async () => {
    const files = await store().list();
    expect(files.map((f) => f.path).sort()).toEqual(["conversion/announcement.md", "translation/glossary.json"]);
    expect(files.find((f) => f.path === "conversion/announcement.md")!.content).toBe("# 공지");
  });

  /**
   * `few-shot.json` / `few-shot.<type>.json` are `pnpm db:export` artifacts, not configuration —
   * nothing reads them at runtime since the corpus moved to `few_shot_examples`. Listing them made
   * `config:push` upload a snapshot frozen at cutover and report success for it.
   */
  it("list skips the db:export few-shot artifacts but keeps tm.json", async () => {
    await writeFile(join(root, "translation", "few-shot.json"), "[]", "utf8");
    await writeFile(join(root, "translation", "tm.json"), "[]", "utf8");
    await writeFile(join(root, "conversion", "few-shot.x.json"), "[]", "utf8");
    const files = await store().list();
    expect(files.map((f) => f.path).sort()).toEqual([
      "conversion/announcement.md",
      "translation/glossary.json",
      "translation/tm.json",
    ]);
  });

  it("backup leaves the few-shot artifacts out too, so a pull never restores them", async () => {
    await writeFile(join(root, "translation", "few-shot.json"), "[]", "utf8");
    const dest = join(root, "output", "archive", "steering-y");
    await store().backup(dest);
    await expect(readFile(join(dest, "translation", "few-shot.json"), "utf8")).rejects.toThrow();
    expect(await readFile(join(dest, "translation", "glossary.json"), "utf8")).toBe("[]");
  });

  it("list skips nested subdirectories", async () => {
    await mkdir(join(root, "translation", "nested"), { recursive: true });
    await writeFile(join(root, "translation", "nested", "inner.json"), "[]", "utf8");
    const files = await store().list();
    expect(files.map((f) => f.path).sort()).toEqual(["conversion/announcement.md", "translation/glossary.json"]);
  });

  it("write creates the file under the repo root", async () => {
    await store().write("translation/tm.json", "[1]");
    expect(await readFile(join(root, "translation", "tm.json"), "utf8")).toBe("[1]");
  });

  it("write creates missing parent directories", async () => {
    await store().write("newdir/nested/file.json", "x");
    expect(await readFile(join(root, "newdir", "nested", "file.json"), "utf8")).toBe("x");
  });

  it("backup copies the current set into destDir", async () => {
    const dest = join(root, "output", "archive", "steering-x");
    await store().backup(dest);
    expect(await readFile(join(dest, "translation", "glossary.json"), "utf8")).toBe("[]");
    expect(await readFile(join(dest, "conversion", "announcement.md"), "utf8")).toBe("# 공지");
  });
});
