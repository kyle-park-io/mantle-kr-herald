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

  it("names a malformed DATABASE_URL generically instead of throwing out of watch.ts's first statement", () => {
    // `loadDbConfig` never validates that DATABASE_URL parses as a URL, and this line is the first
    // thing `watch.ts` runs — so an unparseable DSN in ~/.herald/prod.env would otherwise throw
    // straight out of the entry point, and `registerErrorHandler` would print the `URL`
    // constructor's own message. That message is not guaranteed, across engines, not to echo the
    // input back, and this journal line is read out again by the OnFailure hook and sent to
    // Telegram. `src/doctor/checks.ts` already refused to take that risk on the identical call.
    const db: DbConfig = { url: "postgres//user:hunter2@localhost:5432/herald", env: "production" };

    const line = watchStartupLine("/home/kyle/.herald/output", "/home/kyle/.herald/output", db);

    expect(line).toContain("DATABASE_URL is not a valid URL");
    expect(line).not.toContain("hunter2");
    // The rest of the line still has to do its job — which output root this tick is attached to is
    // exactly as load-bearing when the database is misconfigured as when it is not.
    expect(line).toContain("/home/kyle/.herald/output (HERALD_OUTPUT_DIR override)");
    expect(line).toContain("database production");
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
