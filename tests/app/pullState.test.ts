import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { PullState } from "../../src/app/PullState";
import type { ConfigDrive } from "../../src/ports/ConfigDrive";
import type { StateFileStore } from "../../src/ports/StateFileStore";
import { assembleStateSnapshot } from "../../src/domain/state/snapshot";

const DELIVERIES = "output/publish/deliveries.json";
const OVERRIDES = "output/formatted/overrides.json";
const TRACKED = [OVERRIDES, DELIVERIES, "output/publish/x-article.json", "output/publish/state.json"];

function fakeFiles(current: { path: string; content: string }[]) {
  const events: string[] = [];
  const written: { path: string; content: string }[] = [];
  const store: StateFileStore = {
    list: async () => current,
    write: async (path, content) => {
      events.push(`write:${path}`);
      written.push({ path, content });
    },
    backup: async (dest) => {
      events.push(`backup:${dest}`);
    },
    tracked: () => TRACKED,
  };
  return { store, events, written };
}

function driveWith(bundle: string, name = "operational-state-2026-07-29T00-00-00-000Z.json"): ConfigDrive {
  return {
    upload: async () => ({ id: "x" }),
    latest: async () => ({ id: "L1", name }),
    download: async () => bundle,
  };
}

const snapshot = assembleStateSnapshot(
  [
    { path: DELIVERIES, content: '[{"a":1},{"a":2},{"a":3}]' },
    { path: OVERRIDES, content: '[{"a":1}]' },
  ],
  () => "2026-07-29T00:00:00.000Z",
);

describe("PullState — the dry-run gate", () => {
  it("writes nothing without `apply`, and shows current rows beside the snapshot's", async () => {
    const f = fakeFiles([{ path: DELIVERIES, content: '[{"a":1}]' }]);

    const res = await new PullState(f.store, driveWith(snapshot), "/arch").run("FOLDER");

    expect(f.events).toEqual([]);
    expect(f.written).toHaveLength(0);
    expect(res!.applied).toBe(false);
    expect(res!.backupDir).toBeUndefined();
    expect(res!.diff).toEqual([
      { path: DELIVERIES, current: 1, incoming: 3, change: "overwrite" },
      { path: OVERRIDES, current: undefined, incoming: 1, change: "restore" },
    ]);
  });

  it("writes nothing when `apply` is explicitly false", async () => {
    const f = fakeFiles([]);
    await new PullState(f.store, driveWith(snapshot), "/arch").run("FOLDER", { apply: false });
    expect(f.written).toHaveLength(0);
  });

  it("writes only when `apply` is passed", async () => {
    const f = fakeFiles([{ path: DELIVERIES, content: '[{"a":1}]' }]);

    const res = await new PullState(f.store, driveWith(snapshot), "/arch", () => "2026-07-29T00:00:00.000Z").run(
      "FOLDER",
      { apply: true },
    );

    expect(res!.applied).toBe(true);
    expect(f.written.map((w) => w.path)).toEqual([DELIVERIES, OVERRIDES]);
    expect(f.written[0].content).toBe('[{"a":1},{"a":2},{"a":3}]');
    expect(res!.restored).toBe(2);
    expect(res!.backedUp).toBe(1);
  });
});

describe("PullState — backup before write", () => {
  it("backs the current tree up before the first write", async () => {
    const f = fakeFiles([{ path: DELIVERIES, content: '[{"a":1}]' }]);

    const res = await new PullState(f.store, driveWith(snapshot), "/arch", () => "2026-07-29T00:00:00.000Z").run(
      "FOLDER",
      { apply: true },
    );

    expect(f.events[0]).toBe(`backup:${join("/arch", "state-2026-07-29T00-00-00-000Z")}`);
    expect(f.events.slice(1).every((e) => e.startsWith("write:"))).toBe(true);
    expect(res!.backupDir).toBe(join("/arch", "state-2026-07-29T00-00-00-000Z"));
  });

  it("aborts with zero writes when the backup fails", async () => {
    const f = fakeFiles([{ path: DELIVERIES, content: '[{"a":1}]' }]);
    f.store.backup = async () => {
      throw new Error("disk full");
    };

    await expect(
      new PullState(f.store, driveWith(snapshot), "/arch").run("FOLDER", { apply: true }),
    ).rejects.toThrow(/disk full/);
    expect(f.written).toHaveLength(0);
  });

  it("aborts with zero writes — and no backup — when the snapshot will not parse", async () => {
    const f = fakeFiles([{ path: DELIVERIES, content: '[{"a":1}]' }]);

    await expect(new PullState(f.store, driveWith("not json"), "/arch").run("FOLDER", { apply: true })).rejects.toThrow(
      /not a valid operational state bundle/,
    );
    expect(f.events).toEqual([]);
  });

  it("aborts with zero writes when the snapshot names a file this version does not track", async () => {
    const rogue = assembleStateSnapshot([{ path: "../../.ssh/authorized_keys", content: "ssh-rsa AAAA" }], () => "t");
    const f = fakeFiles([]);

    await expect(new PullState(f.store, driveWith(rogue), "/arch").run("FOLDER", { apply: true })).rejects.toThrow(
      /does not track/,
    );
    expect(f.events).toEqual([]);
  });
});

describe("PullState — a restore that fails part-way", () => {
  it("names the backup directory, because a mixed tree is only recoverable from there", async () => {
    const f = fakeFiles([{ path: DELIVERIES, content: '[{"a":1}]' }]);
    const ok = f.store.write;
    f.store.write = async (path, content) => {
      if (path === OVERRIDES) throw new Error("EIO: i/o error");
      await ok(path, content);
    };

    const run = new PullState(f.store, driveWith(snapshot), "/arch", () => "2026-07-29T00:00:00.000Z").run("FOLDER", {
      apply: true,
    });

    // A bare `✖ EIO: i/o error` would leave the operator with a half-restored ledger and no idea
    // their pre-pull copy still exists.
    await expect(run).rejects.toThrow(new RegExp(join("/arch", "state-2026-07-29T00-00-00-000Z")));
    await expect(run).rejects.toThrow(/섞인 상태/);
    expect(f.written.map((w) => w.path)).toEqual([DELIVERIES]); // the tree really is mixed
  });

  it("keeps the underlying failure as the cause", async () => {
    const f = fakeFiles([]);
    f.store.write = async () => {
      throw new Error("ENOSPC: no space left on device");
    };
    await new PullState(f.store, driveWith(snapshot), "/arch")
      .run("FOLDER", { apply: true })
      .then(() => expect.unreachable("should have thrown"))
      .catch((err: Error) => expect((err.cause as Error).message).toMatch(/ENOSPC/));
  });
});

describe("PullState — files present on only one side", () => {
  it("restores a file the local tree does not have", async () => {
    const f = fakeFiles([]);
    await new PullState(f.store, driveWith(snapshot), "/arch").run("FOLDER", { apply: true });
    expect(f.written.map((w) => w.path).sort()).toEqual([OVERRIDES, DELIVERIES].sort());
  });

  it("never deletes a local file the snapshot lacks — it keeps it, and says so", async () => {
    const local = assembleStateSnapshot([{ path: DELIVERIES, content: "[]" }], () => "t");
    const f = fakeFiles([
      { path: DELIVERIES, content: "[]" },
      { path: OVERRIDES, content: '[{"a":1},{"a":2}]' },
    ]);

    const res = await new PullState(f.store, driveWith(local), "/arch").run("FOLDER", { apply: true });

    expect(f.written.map((w) => w.path)).toEqual([DELIVERIES]);
    expect(res!.diff).toContainEqual({ path: OVERRIDES, current: 2, change: "keep" });
  });
});

describe("PullState — nothing to pull", () => {
  it("returns undefined and writes nothing when the folder holds no snapshot", async () => {
    const f = fakeFiles([]);
    const drive: ConfigDrive = { upload: async () => ({ id: "x" }), latest: async () => undefined, download: async () => "" };
    expect(await new PullState(f.store, drive, "/arch").run("FOLDER", { apply: true })).toBeUndefined();
    expect(f.events).toEqual([]);
  });

  it("asks Drive only for operational-state snapshots, never the steering-config ones", async () => {
    const asked: string[] = [];
    const drive: ConfigDrive = {
      upload: async () => ({ id: "x" }),
      latest: async (_folder, prefix) => {
        asked.push(prefix);
        return undefined;
      },
      download: async () => "",
    };
    await new PullState(fakeFiles([]).store, drive, "/arch").run("FOLDER");
    expect(asked).toEqual(["operational-state-"]);
  });
});
