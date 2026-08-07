// tests/cli/tickStartup.test.ts
//
// `tests/cli/watchStartup.test.ts` covers what this line has to say — the output root, the database,
// the credential it must never echo. What it cannot cover is the part that only exists because there
// are now two schedulers: the label, and a caller with a different set of inputs. A
// `tickStartupLine` that hardcoded "watch" would satisfy that whole file while making every
// `journalctl --user -u herald-convert` line claim to be the other unit's.
import { describe, it, expect } from "vitest";
import { tickStartupLine } from "../../src/cli/tickStartup";
import { watchStartupLine } from "../../src/cli/watchStartup";
import type { DbConfig } from "../../src/config";

const db: DbConfig = { url: "postgres://u:p@prod-host:5432/herald", env: "production" };

describe("tickStartupLine", () => {
  it("leads with the caller's own label", () => {
    expect(tickStartupLine("convert", "/repo/output", undefined, db, ["batch 1"]).startsWith("convert: ")).toBe(true);
    expect(tickStartupLine("watch", "/repo/output", undefined, db, ["batch 3"]).startsWith("watch: ")).toBe(true);
  });

  it("states every extra the caller gives it, in order, on the same separated line", () => {
    // The extras are the values an operator can change on a unit without a deploy. A journal that
    // records a tick's outcome but not its inputs cannot be read after the fact.
    const line = tickStartupLine("convert", "/home/kyle/.herald/output", "/home/kyle/.herald/output", db, [
      "batch 2",
      "something else",
    ]);

    expect(line).toContain("/home/kyle/.herald/output (HERALD_OUTPUT_DIR override)");
    expect(line).toContain("database production");
    expect(line).toContain("· batch 2 · something else");
  });

  it("takes no extras without producing a trailing separator", () => {
    const line = tickStartupLine("convert", "/repo/output", undefined, db, []);
    expect(line.endsWith("·")).toBe(false);
    expect(line).not.toContain("· ·");
  });

  it("still produces watchStartupLine's own shape through the wrapper", () => {
    // The delegation, asserted from this side too: `watchStartupLine` is now a call into the
    // function above, and the two inputs only that tick has must survive the indirection.
    expect(watchStartupLine("/repo/output", undefined, db, { batch: 3, translateSince: "2026-07-27T14:35:25.000Z" })).toBe(
      tickStartupLine("watch", "/repo/output", undefined, db, ["batch 3", "translate floor 2026-07-27T14:35:25.000Z"]),
    );
  });
});
