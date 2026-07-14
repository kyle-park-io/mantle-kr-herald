import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "../../../src/shared/store/jsonFile";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jsonfile-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writeJsonFileAtomic", () => {
  it("creates missing nested parent directories before writing", async () => {
    const nestedDir = join(dir, "a", "b");
    const path = join(nestedDir, "c.json");

    await writeJsonFileAtomic(nestedDir, path, { hello: "world" });

    expect(await readJsonFile(path, null)).toEqual({ hello: "world" });
  });
});
