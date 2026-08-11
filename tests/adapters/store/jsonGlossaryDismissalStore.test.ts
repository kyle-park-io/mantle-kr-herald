// tests/adapters/store/jsonGlossaryDismissalStore.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonGlossaryDismissalStore } from "../../../src/adapters/store/JsonGlossaryDismissalStore";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "herald-dismissal-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = (text: string): Promise<void> => writeFile(join(dir, "glossary-dismissed.json"), text, "utf8");

describe("JsonGlossaryDismissalStore", () => {
  it("reads an absent file as nothing dismissed", async () => {
    // The ordinary state of a fresh checkout. A missing dismissal list must never be an error — the
    // weekly job it feeds is a report, and nobody has said no to anything yet.
    expect(await new JsonGlossaryDismissalStore(dir).load()).toEqual([]);
  });

  it("reads the entries a human typed", async () => {
    await write('[{ "term": "규모 → 사이즈", "note": "1회성 교정", "dismissedAt": "2026-08-11" }]');
    expect(await new JsonGlossaryDismissalStore(dir).load()).toEqual([
      { term: "규모 → 사이즈", note: "1회성 교정", dismissedAt: "2026-08-11" },
    ]);
  });

  it("REFUSES a file that parses as something other than an array", async () => {
    // `{}` instead of `[]` is the obvious hand-editing slip, and `readJsonFile`'s cast would hand it
    // back as an empty-looking list. That silently un-dismisses everything and floods the next alert
    // with candidates somebody already rejected — the exact failure this file exists to prevent,
    // arriving as "the dismissal file just doesn't work". Failing loudly is the better Monday.
    await write("{}");
    await expect(new JsonGlossaryDismissalStore(dir).load()).rejects.toThrow(/must be a JSON array/);
  });

  it("does not swallow a syntax error either", async () => {
    await write("[{ term: nope }");
    await expect(new JsonGlossaryDismissalStore(dir).load()).rejects.toThrow(/Failed to read JSON file/);
  });

  it("has no way to write — the pipeline must never silence its own findings", async () => {
    // Structural, not stylistic. A dismissal is a human overruling the evidence; an `add` method would
    // let an automated run record its own "no", and the file would stop being trustworthy.
    const store = new JsonGlossaryDismissalStore(dir) as unknown as Record<string, unknown>;
    for (const method of ["add", "upsert", "upsertEntry", "save", "write", "dismiss"]) {
      expect(store[method], method).toBeUndefined();
    }
  });
});
