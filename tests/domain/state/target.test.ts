import { describe, it, expect } from "vitest";
import { describeBackupTarget } from "../../../src/domain/state/target";

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
