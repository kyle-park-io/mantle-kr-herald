import { describe, it, expect } from "vitest";
import { watchStartupLine } from "../../src/cli/watchStartup";
import type { DbConfig } from "../../src/config";

describe("watchStartupLine", () => {
  it("names the default output root and the database plainly", () => {
    const db: DbConfig = { url: "postgres://user:secret@localhost:5432/herald", env: "development" };
    const line = watchStartupLine("/repo/output", undefined, db);
    expect(line).toContain("/repo/output (default)");
    expect(line).toContain("database development");
    expect(line).toContain("localhost:5432/herald");
    // describeDbTarget only ever returns host and database name — the credential embedded in
    // DATABASE_URL must never reach this line, which is meant to land in a shared journal.
    expect(line).not.toContain("secret");
  });

  it("names a HERALD_OUTPUT_DIR override so a non-default root is never silent", () => {
    const db: DbConfig = { url: "postgres://user:secret@prod-host:5432/herald", env: "production" };
    const line = watchStartupLine("/home/kyle/.herald/output", "/home/kyle/.herald/output", db);
    expect(line).toContain("/home/kyle/.herald/output (HERALD_OUTPUT_DIR override)");
    expect(line).toContain("database production");
    expect(line).toContain("prod-host:5432/herald");
  });

  it("distinguishes production from development even when the output root is identical", () => {
    // A regression here — printing the root but not the env, or vice versa — is exactly the kind
    // of half-informative line that still leaves "which database did this tick actually hit?"
    // unanswered.
    const devDb: DbConfig = { url: "postgres://u:p@localhost:5432/herald", env: "development" };
    const prodDb: DbConfig = { url: "postgres://u:p@localhost:5432/herald", env: "production" };
    expect(watchStartupLine("/repo/output", undefined, devDb)).not.toEqual(
      watchStartupLine("/repo/output", undefined, prodDb),
    );
  });
});
