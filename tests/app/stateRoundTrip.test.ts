import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FsStateFileStore } from "../../src/adapters/store/FsStateFileStore";
import { PullState } from "../../src/app/PullState";
import { PushState } from "../../src/app/PushState";
import type { ConfigDrive } from "../../src/ports/ConfigDrive";

/** An in-memory stand-in for the Drive folder: newest upload wins, exactly like `latest()`. */
function memoryDrive(): ConfigDrive {
  const files = new Map<string, { name: string; content: string }>();
  let n = 0;
  return {
    upload: async (_folder, name, content) => {
      const id = `f${++n}`;
      files.set(id, { name, content });
      return { id };
    },
    latest: async (_folder, prefix) => {
      const match = [...files.entries()].filter(([, f]) => f.name.includes(prefix)).at(-1);
      return match ? { id: match[0], name: match[1].name } : undefined;
    },
    download: async (id) => files.get(id)!.content,
  };
}

const REL = [
  "output/formatted/overrides.json",
  "output/publish/deliveries.json",
  "output/publish/x-article.json",
  "output/publish/state.json",
] as const;

const CONTENT: Record<string, string> = {
  [REL[0]]: '[\n  {\n    "itemId": "x:1",\n    "type": "announcement",\n    "outletId": "tg-dev",\n    "text": "방별 포크 — 다시 만들 수 없음"\n  }\n]\n',
  [REL[1]]: '[\n  {\n    "itemId": "x:1",\n    "type": "announcement",\n    "outletId": "tg-community",\n    "status": "sent"\n  }\n]\n',
  [REL[2]]: '[{"itemId":"x:1","postId":"p1","sentAt":"2026-07-01T00:00:00.000Z"}]\n',
  [REL[3]]: '{\n  "entries": [\n    { "itemId": "x:1", "stage": "translation", "status": "approved", "target": "gdrive" }\n  ]\n}\n',
};

let source: string;
let restored: string;

const storeAt = (root: string) => new FsStateFileStore(REL.map((rel) => ({ abs: join(root, rel), rel })));

beforeEach(async () => {
  source = await mkdtemp(join(tmpdir(), "herald-state-src-"));
  restored = await mkdtemp(join(tmpdir(), "herald-state-dst-"));
  for (const rel of REL) {
    const abs = join(source, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, CONTENT[rel], "utf8");
  }
});
afterEach(async () => {
  await rm(source, { recursive: true, force: true });
  await rm(restored, { recursive: true, force: true });
});

describe("state:push → state:pull round trip", () => {
  it("reproduces all four files byte for byte on a rebuilt machine", async () => {
    const drive = memoryDrive();

    const pushed = await new PushState(storeAt(source), drive, () => "2026-07-29T00:00:00.000Z").run("FOLDER");
    expect(pushed!.files.map((f) => f.rows)).toEqual([1, 1, 1, 1]);

    const target = storeAt(restored);
    expect(await target.list()).toEqual([]); // nothing survived the machine
    const res = await new PullState(target, drive, join(restored, "output/archive")).run("FOLDER", { apply: true });

    expect(res!.restored).toBe(4);
    expect(res!.diff.every((d) => d.change === "restore")).toBe(true);
    for (const rel of REL) {
      expect(await readFile(join(restored, rel), "utf8")).toBe(CONTENT[rel]);
    }
  });

  it("leaves the pre-pull tree recoverable in output/archive before overwriting it", async () => {
    const drive = memoryDrive();
    await new PushState(storeAt(source), drive, () => "2026-07-29T00:00:00.000Z").run("FOLDER");

    // The target machine already has its own, different, delivery ledger.
    const mine = '[{"itemId":"x:99","type":"announcement","outletId":"tg-dev","status":"sent"}]\n';
    await mkdir(dirname(join(restored, REL[1])), { recursive: true });
    await writeFile(join(restored, REL[1]), mine, "utf8");

    const archive = join(restored, "output/archive");
    const res = await new PullState(storeAt(restored), drive, archive, () => "2026-07-30T00:00:00.000Z").run("FOLDER", {
      apply: true,
    });

    expect(await readFile(join(restored, REL[1]), "utf8")).toBe(CONTENT[REL[1]]); // overwritten
    expect(await readFile(join(archive, "state-2026-07-30T00-00-00-000Z", REL[1]), "utf8")).toBe(mine); // and kept
    expect(res!.diff.find((d) => d.path === REL[1])).toEqual({ path: REL[1], current: 1, incoming: 1, change: "overwrite" });
  });
});
