import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTextFileAtomic, writeJsonFileAtomic } from "../../../src/shared/store/jsonFile";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jsonfile-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writeTextFileAtomic", () => {
  it("writes text verbatim, without JSON encoding it", async () => {
    const path = join(dir, "doc.md");
    await writeTextFileAtomic(dir, path, "# 제목\n\n본문\n");
    expect(await readFile(path, "utf8")).toBe("# 제목\n\n본문\n");
  });

  it("creates missing parent directories", async () => {
    const nested = join(dir, "a", "b");
    const path = join(nested, "doc.md");
    await writeTextFileAtomic(nested, path, "hi");
    expect(await readFile(path, "utf8")).toBe("hi");
  });

  it("leaves no temp file behind on success", async () => {
    const path = join(dir, "doc.md");
    await writeTextFileAtomic(dir, path, "hi");
    expect(await readdir(dir)).toEqual(["doc.md"]);
  });

  it("overwrites an existing file", async () => {
    const path = join(dir, "doc.md");
    await writeTextFileAtomic(dir, path, "old");
    await writeTextFileAtomic(dir, path, "new");
    expect(await readFile(path, "utf8")).toBe("new");
  });
});

describe("writeJsonFileAtomic", () => {
  it("still writes 2-space JSON with a trailing newline", async () => {
    const path = join(dir, "data.json");
    await writeJsonFileAtomic(dir, path, { a: 1 });
    expect(await readFile(path, "utf8")).toBe('{\n  "a": 1\n}\n');
  });
});
