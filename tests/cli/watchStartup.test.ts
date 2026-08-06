import { describe, it, expect } from "vitest";
import { watchStartupLine } from "../../src/cli/watchStartup";
import type { DbConfig } from "../../src/config";

describe("watchStartupLine", () => {
  it("names the default output root and the database plainly", () => {
    const db: DbConfig = { url: "postgres://user:secret@localhost:5432/herald", env: "development" };
    const line = watchStartupLine("/repo/output", undefined, db, { batch: 3 });
    expect(line).toContain("/repo/output (default)");
    expect(line).toContain("database development");
    expect(line).toContain("localhost:5432/herald");
    // describeDbTarget only ever returns host and database name — the credential embedded in
    // DATABASE_URL must never reach this line, which is meant to land in a shared journal.
    expect(line).not.toContain("secret");
  });

  it("names a HERALD_OUTPUT_DIR override so a non-default root is never silent", () => {
    const db: DbConfig = { url: "postgres://user:secret@prod-host:5432/herald", env: "production" };
    const line = watchStartupLine("/home/kyle/.herald/output", "/home/kyle/.herald/output", db, { batch: 3 });
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

    const line = watchStartupLine("/home/kyle/.herald/output", "/home/kyle/.herald/output", db, { batch: 3 });

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
    expect(watchStartupLine("/repo/output", undefined, devDb, { batch: 3 })).not.toEqual(
      watchStartupLine("/repo/output", undefined, prodDb, { batch: 3 }),
    );
  });

  it("names the batch size and the translation floor this tick will use", () => {
    const db: DbConfig = { url: "postgres://u:p@prod-host:5432/herald", env: "production" };

    const line = watchStartupLine("/home/kyle/.herald/output", "/home/kyle/.herald/output", db, {
      batch: 3,
      translateSince: "2026-07-27T14:35:24.000Z",
    });

    expect(line).toContain("batch 3");
    expect(line).toContain("2026-07-27T14:35:24.000Z");
    // The values this line already carried must survive the addition.
    expect(line).toContain("/home/kyle/.herald/output (HERALD_OUTPUT_DIR override)");
    expect(line).toContain("database production");
  });

  it("states an absent translation floor instead of omitting it", () => {
    // A line that simply drops the floor when unset is indistinguishable from one where a cutoff
    // is configured — and "no cutoff" means the tick drains the whole untranslated backlog
    // oldest-first (211 items reaching back to 2026-06-01, measured 2026-08-06). That is the most
    // consequential difference there is between two ticks, so it is stated, not implied.
    const db: DbConfig = { url: "postgres://u:p@localhost:5432/herald", env: "development" };

    const line = watchStartupLine("/repo/output", undefined, db, { batch: 5, translateSince: undefined });

    expect(line).toContain("batch 5");
    expect(line).toMatch(/translate floor \(none\)/);
  });

  it("distinguishes two ticks that differ only in their batch size", () => {
    // Guards against a line that mentions "batch" in fixed text without interpolating the value.
    const db: DbConfig = { url: "postgres://u:p@localhost:5432/herald", env: "development" };
    const three = watchStartupLine("/repo/output", undefined, db, { batch: 3 });
    const ten = watchStartupLine("/repo/output", undefined, db, { batch: 10 });

    expect(three).not.toEqual(ten);
  });
});
