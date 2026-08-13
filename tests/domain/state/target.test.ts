import { describe, it, expect } from "vitest";
import { describeBackupTarget } from "../../../src/domain/state/target";
import { INVALID_DB_URL } from "../../../src/config";

describe("describeBackupTarget", () => {
  it("names the host and database, never the credentials", () => {
    const lines = describeBackupTarget({
      url: "postgres://postgres:hunter2@127.0.0.1:5432/herald",
      env: "development",
    });
    expect(lines.join("\n")).toContain("127.0.0.1:5432/herald");
    expect(lines.join("\n")).not.toContain("hunter2");
  });

  it("warns on a development target, because that is the accident", () => {
    // `EnvironmentFile=` is what selects the production database, not which tree the command runs
    // from — so `pnpm state:push` from the repo backs up local Docker while looking like it worked.
    const lines = describeBackupTarget({ url: "postgres://u:p@127.0.0.1:5432/herald", env: "development" });
    expect(lines.some((l) => l.includes("⚠"))).toBe(true);
    expect(lines.join("\n")).toContain("development");
  });

  it("does not warn on a production target", () => {
    const lines = describeBackupTarget({ url: "postgres://u:p@ep-x.neon.tech/herald", env: "production" });
    expect(lines.some((l) => l.includes("⚠"))).toBe(false);
    expect(lines.join("\n")).toContain("ep-x.neon.tech/herald");
  });

  it("still names the target, but drops the advice, when the caller opts out of the warning", () => {
    // `db:export`'s case. The advice ("point DATABASE_URL at production instead") is right for
    // `state:push` and actively wrong here: exporting the development database is one of
    // `db:export`'s legitimate uses, and following it would overwrite the local corpus files with
    // production's. The host line stays — knowing which database was opened is what both need.
    const lines = describeBackupTarget(
      { url: "postgres://u:p@127.0.0.1:5432/herald", env: "development" },
      { warnOnDevelopment: false },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("127.0.0.1:5432/herald");
    expect(lines.some((l) => l.includes("⚠"))).toBe(false);
  });

  it("warns by default, so only a caller that asked for it loses the advice", () => {
    const cfg = { url: "postgres://u:p@127.0.0.1:5432/herald", env: "development" } as const;
    expect(describeBackupTarget(cfg, {}).some((l) => l.includes("⚠"))).toBe(true);
    expect(describeBackupTarget(cfg, { warnOnDevelopment: true }).some((l) => l.includes("⚠"))).toBe(true);
  });
});

describe("describeBackupTarget — a malformed DATABASE_URL", () => {
  // `loadDbConfig` never checks that the value parses as a URL, and this is the first line
  // `state:push` prints — nightly, from `herald-backup.service`, whose `OnFailure=` hook relays
  // stderr into a Telegram room. `describeDbTarget`'s `new URL()` would throw here, and a URL
  // constructor's message is not guaranteed across engines not to quote the input back, credentials
  // and all. `src/config.ts` states the rule this follows: the guard belongs with the call.
  const MALFORMED = "postgres//postgres:hunter2@127.0.0.1:5432/herald";

  it("prints the fixed fallback instead of throwing", () => {
    const lines = describeBackupTarget({ url: MALFORMED, env: "production" });
    expect(lines[0]).toContain(INVALID_DB_URL);
    expect(lines[0]).toContain("HERALD_DB_ENV=production");
  });

  it("leaks no part of the URL — not the password, not the host, not the value itself", () => {
    const printed = describeBackupTarget({ url: MALFORMED, env: "development" }).join("\n");
    expect(printed).not.toContain("hunter2");
    expect(printed).not.toContain("postgres:");
    expect(printed).not.toContain("127.0.0.1");
    expect(printed).not.toContain(MALFORMED);
  });

  it("still warns about a development target — the two are independent", () => {
    const lines = describeBackupTarget({ url: MALFORMED, env: "development" });
    expect(lines.some((l) => l.includes("⚠"))).toBe(true);
  });
});
