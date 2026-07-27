import { describe, it, expect } from "vitest";
import { PullConfig } from "../../src/app/PullConfig";
import type { ConfigFileStore } from "../../src/ports/ConfigFileStore";
import type { ConfigDrive } from "../../src/ports/ConfigDrive";
import { assembleConfigBundle } from "../../src/domain/config/bundle";

function fakeFiles(current: { path: string; content: string }[]) {
  const events: string[] = [];
  const written: { path: string; content: string }[] = [];
  const store: ConfigFileStore = {
    list: async () => current,
    write: async (path, content) => { events.push(`write:${path}`); written.push({ path, content }); },
    backup: async (dest) => { events.push(`backup:${dest}`); },
  };
  return { store, events, written };
}
function driveWith(bundle: string): ConfigDrive {
  return { upload: async () => ({ id: "x" }), latest: async () => ({ id: "L1", name: "steering-config-x.json" }), download: async () => bundle };
}

const bundle = assembleConfigBundle([{ path: "translation/tm.json", content: "NEW" }], () => "t");

describe("PullConfig", () => {
  it("backs up before writing, then writes each pulled file", async () => {
    const f = fakeFiles([{ path: "translation/tm.json", content: "OLD" }]);
    const res = await new PullConfig(f.store, driveWith(bundle), "/arch", () => "2026-07-28T00-00-00").run("FOLDER");
    expect(f.events[0]).toMatch(/^backup:/); // backup precedes writes
    expect(f.events).toContain("write:translation/tm.json");
    expect(res!.pulled).toBe(1);
    expect(res!.backedUp).toBe(1);
    expect(res!.changes).toEqual([{ path: "translation/tm.json", kind: "modified" }]);
  });

  it("--dry-run writes nothing and reports the change list", async () => {
    const f = fakeFiles([]);
    const res = await new PullConfig(f.store, driveWith(bundle), "/arch").run("FOLDER", { dryRun: true });
    expect(f.written).toHaveLength(0);
    expect(res!.dryRun).toBe(true);
    expect(res!.changes).toEqual([{ path: "translation/tm.json", kind: "new" }]);
  });

  it("returns undefined when there is no snapshot", async () => {
    const f = fakeFiles([]);
    const drive: ConfigDrive = { upload: async () => ({ id: "x" }), latest: async () => undefined, download: async () => "" };
    expect(await new PullConfig(f.store, drive, "/arch").run("FOLDER")).toBeUndefined();
    expect(f.written).toHaveLength(0);
  });

  it("aborts (no writes) if the backup fails", async () => {
    const f = fakeFiles([]);
    f.store.backup = async () => { throw new Error("disk full"); };
    await expect(new PullConfig(f.store, driveWith(bundle), "/arch").run("FOLDER")).rejects.toThrow(/disk full/);
    expect(f.written).toHaveLength(0);
  });
});
