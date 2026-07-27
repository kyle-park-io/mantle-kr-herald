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

  it("write creates the file under the repo root", async () => {
    await store().write("translation/tm.json", "[1]");
    expect(await readFile(join(root, "translation", "tm.json"), "utf8")).toBe("[1]");
  });

  it("backup copies the current set into destDir", async () => {
    const dest = join(root, "output", "archive", "steering-x");
    await store().backup(dest);
    expect(await readFile(join(dest, "translation", "glossary.json"), "utf8")).toBe("[]");
    expect(await readFile(join(dest, "conversion", "announcement.md"), "utf8")).toBe("# 공지");
  });
});
