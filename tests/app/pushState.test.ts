import { describe, it, expect } from "vitest";
import { PushState } from "../../src/app/PushState";
import type { ConfigDrive } from "../../src/ports/ConfigDrive";
import type { StateFileStore } from "../../src/ports/StateFileStore";
import { parseStateSnapshot } from "../../src/domain/state/snapshot";

const TRACKED = ["output/formatted/overrides.json", "output/publish/deliveries.json", "output/publish/state.json"];

function fakeFiles(current: { path: string; content: string }[]): StateFileStore {
  return {
    list: async () => current,
    write: async () => {},
    backup: async () => {},
    tracked: () => TRACKED,
  };
}

function recordingDrive(): { drive: ConfigDrive; uploads: { name: string; content: string }[] } {
  const uploads: { name: string; content: string }[] = [];
  return {
    uploads,
    drive: {
      upload: async (_folder, name, content) => {
        uploads.push({ name, content });
        return { id: "F1" };
      },
      latest: async () => undefined,
      download: async () => "",
    },
  };
}

describe("PushState", () => {
  it("bundles the tracked files into one timestamped snapshot", async () => {
    const files = fakeFiles([
      { path: "output/formatted/overrides.json", content: '[{"itemId":"x:1"}]' },
      { path: "output/publish/state.json", content: '{"entries":[{"itemId":"x:1"},{"itemId":"x:2"}]}' },
    ]);
    const { drive, uploads } = recordingDrive();

    const res = await new PushState(files, drive, () => "2026-07-29T00:00:00.000Z").run("FOLDER");

    expect(res!.name).toBe("operational-state-2026-07-29T00-00-00-000Z.json");
    expect(res!.id).toBe("F1");
    expect(uploads).toHaveLength(1);
    expect(parseStateSnapshot(uploads[0].content)).toEqual([
      { path: "output/formatted/overrides.json", content: '[{"itemId":"x:1"}]' },
      { path: "output/publish/state.json", content: '{"entries":[{"itemId":"x:1"},{"itemId":"x:2"}]}' },
    ]);
    expect(JSON.parse(uploads[0].content).pushedAt).toBe("2026-07-29T00:00:00.000Z");
  });

  it("reports each file's row count, so the operator can see the snapshot holds what they expect", async () => {
    const files = fakeFiles([
      { path: "output/publish/deliveries.json", content: '[{"a":1},{"a":2}]' },
      { path: "output/publish/state.json", content: '{"entries":[]}' },
    ]);
    const res = await new PushState(files, recordingDrive().drive, () => "t").run("FOLDER");
    expect(res!.files).toEqual([
      { path: "output/publish/deliveries.json", rows: 2 },
      { path: "output/publish/state.json", rows: 0 },
    ]);
  });

  it("uploads nothing when no tracked file exists yet", async () => {
    // An accidental push from a fresh checkout would otherwise put an empty snapshot at the head of
    // the folder — a backup that reports success and holds none of the operator's records.
    const { drive, uploads } = recordingDrive();
    expect(await new PushState(fakeFiles([]), drive).run("FOLDER")).toBeUndefined();
    expect(uploads).toHaveLength(0);
  });
});
