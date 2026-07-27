import { describe, it, expect } from "vitest";
import { PushConfig } from "../../src/app/PushConfig";
import type { ConfigFileStore } from "../../src/ports/ConfigFileStore";
import type { ConfigDrive } from "../../src/ports/ConfigDrive";
import { parseConfigBundle } from "../../src/domain/config/bundle";

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
    expect(res).toEqual({ name: "steering-config-2026-07-28T00-00-00-000Z.json", id: "F1", count: 1 });
    expect(uploads).toHaveLength(1);
    expect(parseConfigBundle(uploads[0].content)).toEqual([{ path: "translation/tm.json", content: "[1]" }]);
    expect(JSON.parse(uploads[0].content).pushedAt).toBe("2026-07-28T00:00:00.000Z");
  });
});
