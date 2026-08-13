import { describe, it, expect } from "vitest";
import { PushConfig } from "../../src/app/PushConfig";
import type { ConfigFileStore } from "../../src/ports/ConfigFileStore";
import type { ConfigDrive } from "../../src/ports/ConfigDrive";
import { assembleConfigBundle, parseConfigBundle } from "../../src/domain/config/bundle";

const files: ConfigFileStore = {
  list: async () => [{ path: "translation/tm.json", content: "[1]" }],
  write: async () => {}, backup: async () => {},
};

describe("PushConfig", () => {
  it("bundles the file set and uploads one timestamped snapshot", async () => {
    const uploads: { name: string; content: string }[] = [];
    const drive: ConfigDrive = {
      upload: async (_f, name, content) => { uploads.push({ name, content }); return { id: "F1" }; },
      latest: async () => undefined, download: async () => "",
    };
    const res = await new PushConfig(files, drive, () => "2026-07-28T00:00:00.000Z").run("FOLDER");
    expect(res).toEqual({ name: "steering-config-2026-07-28T00-00-00-000Z.json", id: "F1", count: 1, skipped: false });
    expect(uploads).toHaveLength(1);
    expect(parseConfigBundle(uploads[0].content)).toEqual([{ path: "translation/tm.json", content: "[1]" }]);
    expect(JSON.parse(uploads[0].content).pushedAt).toBe("2026-07-28T00:00:00.000Z");
  });

  it("skips the upload when the newest snapshot holds the same files", async () => {
    // The bundle embeds `pushedAt`, so its raw text differs on every call — the comparison has to be
    // on the parsed file map, not the JSON. Comparing raw text would never match and the skip would
    // silently never fire.
    const uploads: { name: string; content: string }[] = [];
    const existing = assembleConfigBundle(
      [{ path: "translation/glossary.json", content: "[]\n" }],
      () => "2026-08-12T00:00:00.000Z",
    );
    const drive: ConfigDrive = {
      upload: async (_f, name, content) => { uploads.push({ name, content }); return { id: "new" }; },
      latest: async () => ({ id: "old", name: "steering-config-2026-08-12T00-00-00-000Z.json" }),
      download: async () => existing,
    };
    const files: ConfigFileStore = {
      list: async () => [{ path: "translation/glossary.json", content: "[]\n" }],
      write: async () => {},
      backup: async () => {},
    };

    const res = await new PushConfig(files, drive, () => "2026-08-13T00:00:00.000Z").run("folder");
    expect(res.skipped).toBe(true);
    expect(res.id).toBe("old");
    expect(uploads).toHaveLength(0);
  });

  it("uploads when a file's content differs", async () => {
    const uploads: { name: string; content: string }[] = [];
    const existing = assembleConfigBundle(
      [{ path: "translation/glossary.json", content: "[]\n" }],
      () => "2026-08-12T00:00:00.000Z",
    );
    const drive: ConfigDrive = {
      upload: async (_f, name, content) => { uploads.push({ name, content }); return { id: "new" }; },
      latest: async () => ({ id: "old", name: "steering-config-2026-08-12T00-00-00-000Z.json" }),
      download: async () => existing,
    };
    const files: ConfigFileStore = {
      list: async () => [{ path: "translation/glossary.json", content: '[{"ko":"온체인"}]\n' }],
      write: async () => {},
      backup: async () => {},
    };

    const res = await new PushConfig(files, drive, () => "2026-08-13T00:00:00.000Z").run("folder");
    expect(res.skipped).toBe(false);
    expect(uploads).toHaveLength(1);
  });

  it("uploads when a file was added, even though every existing file matches", async () => {
    const uploads: { name: string }[] = [];
    const existing = assembleConfigBundle(
      [{ path: "translation/glossary.json", content: "[]\n" }],
      () => "2026-08-12T00:00:00.000Z",
    );
    const drive: ConfigDrive = {
      upload: async (_f, name) => { uploads.push({ name }); return { id: "new" }; },
      latest: async () => ({ id: "old", name: "x" }),
      download: async () => existing,
    };
    const files: ConfigFileStore = {
      list: async () => [
        { path: "translation/glossary.json", content: "[]\n" },
        { path: "translation/glossary-dismissed.json", content: "[]\n" },
      ],
      write: async () => {},
      backup: async () => {},
    };

    const res = await new PushConfig(files, drive, () => "2026-08-13T00:00:00.000Z").run("folder");
    expect(res.skipped).toBe(false);
    expect(uploads).toHaveLength(1);
  });

  it("uploads when the folder is empty", async () => {
    const uploads: { name: string }[] = [];
    const drive: ConfigDrive = {
      upload: async (_f, name) => { uploads.push({ name }); return { id: "new" }; },
      latest: async () => undefined,
      download: async () => { throw new Error("must not download when there is no snapshot"); },
    };
    const files: ConfigFileStore = {
      list: async () => [{ path: "translation/glossary.json", content: "[]\n" }],
      write: async () => {},
      backup: async () => {},
    };

    const res = await new PushConfig(files, drive, () => "2026-08-13T00:00:00.000Z").run("folder");
    expect(res.skipped).toBe(false);
    expect(uploads).toHaveLength(1);
  });

  it("uploads when the newest snapshot cannot be parsed", async () => {
    // A corrupt or truncated newest snapshot must not be read as "same, skip" — that would leave the
    // corpus with no good copy at exactly the moment its newest one is broken.
    const uploads: { name: string }[] = [];
    const drive: ConfigDrive = {
      upload: async (_f, name) => { uploads.push({ name }); return { id: "new" }; },
      latest: async () => ({ id: "old", name: "x" }),
      download: async () => "{ not json",
    };
    const files: ConfigFileStore = {
      list: async () => [{ path: "translation/glossary.json", content: "[]\n" }],
      write: async () => {},
      backup: async () => {},
    };

    const res = await new PushConfig(files, drive, () => "2026-08-13T00:00:00.000Z").run("folder");
    expect(res.skipped).toBe(false);
    expect(uploads).toHaveLength(1);
  });
});
