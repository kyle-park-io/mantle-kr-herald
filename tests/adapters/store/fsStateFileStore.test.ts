import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsStateFileStore } from "../../../src/adapters/store/FsStateFileStore";

let root: string;
let store: FsStateFileStore;

const REL = ["output/formatted/overrides.json", "output/publish/deliveries.json"] as const;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "herald-state-"));
  store = new FsStateFileStore(REL.map((rel) => ({ abs: join(root, rel), rel })));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(rel: string, content: string): Promise<void> {
  const abs = join(root, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf8");
}

describe("FsStateFileStore", () => {
  it("lists nothing on a tree where the pipeline has never written", async () => {
    expect(await store.list()).toEqual([]);
  });

  it("skips a tracked file that does not exist yet, and keeps the ones that do", async () => {
    await put(REL[1], '[{"a":1}]');
    expect(await store.list()).toEqual([{ path: REL[1], content: '[{"a":1}]' }]);
  });

  it("writes a tracked file, creating its directory", async () => {
    await store.write(REL[0], '[{"forked":true}]');
    expect(await readFile(join(root, REL[0]), "utf8")).toBe('[{"forked":true}]');
  });

  it("refuses a path outside the tracked manifest", async () => {
    // The path comes off the network — it must never be joined onto a root and written blind.
    await expect(store.write("../../.ssh/authorized_keys", "ssh-rsa AAAA")).rejects.toThrow(/untracked/);
    await expect(store.write("output/publish/x-article.json", "[]")).rejects.toThrow(/untracked/);
  });

  it("backs up every existing tracked file under the destination, preserving relative paths", async () => {
    await put(REL[0], "A");
    await put(REL[1], "B");
    const dest = join(root, "output/archive/state-stamp");

    await store.backup(dest);

    expect(await readFile(join(dest, REL[0]), "utf8")).toBe("A");
    expect(await readFile(join(dest, REL[1]), "utf8")).toBe("B");
  });

  it("exposes its manifest so a pull can validate a snapshot before writing", () => {
    expect(store.tracked()).toEqual([...REL]);
  });
});
