import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `src/cli/serve.ts` is a top-level script with no importable surface — running it starts a server
 * and binds a port — so its startup line cannot be asserted by calling anything. This pins it at
 * the source level instead, the same way `tests/deploy/` pins the shape of scripts it cannot run.
 *
 * What is being protected: `serve` is the long-lived, write-capable board where a human approves
 * copy, and it is routinely pointed at either a local Postgres or production depending only on
 * which env file was loaded. A run that comes up silent gives no clue which. Every sibling CLI
 * names its database on its first line; this one did not, and the omission surfaced as a bare
 * `connect ECONNREFUSED 127.0.0.1:5432` with no indication of what was even being attempted.
 */
const SOURCE = readFileSync("src/cli/serve.ts", "utf8");

describe("serve's startup line", () => {
  it("names the database env and target", () => {
    expect(SOURCE).toMatch(/console\.log\(`serve — database \$\{dbConfig\.env\} · \$\{tryDescribeDbTarget\(dbConfig\)/);
  });

  it("prints before anything connects, so a failed connection is still attributable", () => {
    // Ordering is the whole value. Printed after `createDb`, the line would never appear in the one
    // situation that needs it most — the run that dies while connecting.
    const printedAt = SOURCE.indexOf("console.log(`serve — database");
    const connectedAt = SOURCE.indexOf("createDb(dbConfig)");
    expect(printedAt).toBeGreaterThan(-1);
    expect(connectedAt).toBeGreaterThan(-1);
    expect(printedAt).toBeLessThan(connectedAt);
  });

  it("uses the non-throwing describer, since it runs before any validation", () => {
    // `describeDbTarget` throws on a malformed DATABASE_URL; throwing here would replace a useful
    // message with a URL-parse error, and the thrown text is not guaranteed to omit credentials.
    expect(SOURCE).toContain("tryDescribeDbTarget(dbConfig) ?? INVALID_DB_URL");
    expect(SOURCE).not.toMatch(/\bdescribeDbTarget\(dbConfig\)/);
  });
});
