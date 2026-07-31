import { describe, it, expect, afterEach } from "vitest";
import {
  configCheck,
  cloudCheck,
  optionalCheck,
  parseScopes,
  scopeCheck,
  accessResult,
  sheetAccessResult,
  quotaResult,
  runDbCheck,
  describeSchemaProbeError,
  databaseProbe,
} from "../../src/doctor/checks";
import { createTestDb, createUnmigratedTestDb } from "../support/testDb";
import type { Db } from "../../src/adapters/db/Db";

const DRIVE = "https://www.googleapis.com/auth/drive.file";
const SHEETS = "https://www.googleapis.com/auth/spreadsheets";

describe("configCheck", () => {
  it("ok when the loader does not throw", () => {
    expect(configCheck("X", () => {}, "set")).toEqual({ name: "X", status: "ok", detail: "set" });
  });

  it("fail with the loader's error message when it throws", () => {
    const r = configCheck("X", () => {
      throw new Error("Missing required environment variable: FOO");
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("FOO");
  });
});

describe("cloudCheck", () => {
  const throwMissing = () => {
    throw new Error("Missing required environment variable: FOO");
  };

  it("ok when the loader does not throw, in either mode", () => {
    expect(cloudCheck("X", () => {}, false, "not needed in local mode", "set")).toEqual({
      name: "X",
      status: "ok",
      detail: "set",
    });
    expect(cloudCheck("X", () => {}, true, "not needed in local mode", "set")).toEqual({
      name: "X",
      status: "ok",
      detail: "set",
    });
  });

  it("fail (unchanged) when the loader throws and local is false", () => {
    const r = cloudCheck("X", throwMissing, false, "not needed in local mode");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("FOO");
  });

  it("downgrades to warn with the local-mode explanation when the loader throws and local is true", () => {
    const r = cloudCheck("X", throwMissing, true, "not needed in local mode");
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("not needed in local mode");
    expect(r.detail).toContain("FOO");
  });
});

describe("optionalCheck", () => {
  const throwMissing = () => {
    throw new Error("Missing required environment variable: FOO");
  };

  it("ok when the loader does not throw", () => {
    expect(optionalCheck("X", () => {}, "only if you use X", "set")).toEqual({
      name: "X",
      status: "ok",
      detail: "set",
    });
  });

  it("warns (never fails) when the loader throws, with no mode argument — optional in every mode", () => {
    const r = optionalCheck("X", throwMissing, "only if you use X");
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("only if you use X");
    expect(r.detail).toContain("FOO");
  });
});

describe("parseScopes", () => {
  it("splits a space-separated scope string, dropping empties", () => {
    expect(parseScopes(`${DRIVE}  ${SHEETS}`)).toEqual([DRIVE, SHEETS]);
    expect(parseScopes(undefined)).toEqual([]);
  });
});

describe("scopeCheck", () => {
  it("ok when the needed scope is granted", () => {
    const r = scopeCheck("Google Drive", [DRIVE], DRIVE, "run pnpm google:auth");
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("drive.file");
  });

  it("warn with the fix hint when the needed scope is missing", () => {
    const r = scopeCheck("Google Sheet", [DRIVE], SHEETS, "add spreadsheets scope");
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("spreadsheets");
    expect(r.detail).toContain("add spreadsheets scope");
  });
});

describe("accessResult", () => {
  it("ok when the file is reachable (with its name)", () => {
    const r = accessResult("Drive review", { ok: true, status: 200, fileName: "review" });
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("review");
  });

  it("fail with a re-init hint on 404", () => {
    const r = accessResult("Drive approved", { ok: false, status: 404 });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("drive:init");
  });

  it("fail with the status on other errors", () => {
    const r = accessResult("Drive review", { ok: false, status: 403 });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("403");
  });
});

describe("sheetAccessResult", () => {
  it("ok when the sheet is reachable (with its title)", () => {
    const r = sheetAccessResult("Sheet", { ok: true, status: 200, title: "2026 Q3 KR Work Sheet" });
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("2026 Q3 KR Work Sheet");
  });

  it("403 hints at enabling the Sheets API (not a re-init like a Drive file)", () => {
    const r = sheetAccessResult("Sheet", { ok: false, status: 403 });
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/Google Sheets API/);
    expect(r.detail).not.toContain("drive:init");
  });

  it("404 hints at a wrong id or a non-native .xlsx", () => {
    const r = sheetAccessResult("Sheet", { ok: false, status: 404 });
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/native Google Sheet|\.xlsx/);
  });

  it("other status → HTTP N", () => {
    expect(sheetAccessResult("Sheet", { ok: false, status: 500 }).detail).toBe("HTTP 500");
  });
});

describe("runDbCheck", () => {
  it("reports the attached database and its stated environment", async () => {
    const result = await runDbCheck({ url: "postgres://localhost/herald", env: "development" }, async () => true);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("development");
  });

  it("fails the check when the database is unreachable", async () => {
    const result = await runDbCheck({ url: "postgres://localhost/herald", env: "production" }, async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(result.ok).toBe(false);
  });

  it("names the host and database, but never the credentials", async () => {
    const result = await runDbCheck({ url: "postgres://user:s3cret@db.internal:5432/herald_prod", env: "production" }, async () => true);
    expect(result.detail).toContain("db.internal:5432/herald_prod");
    expect(result.detail).not.toContain("user");
    expect(result.detail).not.toContain("s3cret");
  });

  it("includes the probe's error message on failure", async () => {
    const result = await runDbCheck({ url: "postgres://localhost/herald", env: "development" }, async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(result.detail).toContain("ECONNREFUSED");
  });

  it("fails cleanly — never throws — when DATABASE_URL is not a parseable URL, instead of aborting the whole report", async () => {
    const probe = async () => true;
    await expect(runDbCheck({ url: "not-a-url", env: "development" }, probe)).resolves.toEqual({
      ok: false,
      detail: "development — DATABASE_URL is not a valid URL",
    });
  });

  it("never echoes a malformed DATABASE_URL back, even when it still contains credentials", async () => {
    // new URL() throws for this value (no host after the userinfo) — confirming the credential-
    // bearing raw string never reaches the report, not just that *some* generic string is unused.
    const result = await runDbCheck({ url: "postgres://user:s3cret@", env: "production" }, async () => true);
    expect(result.ok).toBe(false);
    expect(result.detail).not.toContain("user");
    expect(result.detail).not.toContain("s3cret");
  });
});

describe("describeSchemaProbeError", () => {
  it("names the remedy when the probe fails because the schema was never applied", () => {
    const err = describeSchemaProbeError(new Error('relation "deliveries" does not exist'));
    expect(err.message).toContain("Schema not applied");
    expect(err.message).toContain("pnpm db:import");
  });

  it("passes through any other probe failure unchanged", () => {
    const original = new Error("ECONNREFUSED");
    expect(describeSchemaProbeError(original)).toBe(original);
  });
});

describe("databaseProbe", () => {
  let db: (Db & { close(): Promise<void> }) | undefined;
  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  it("fails against a database whose schema was never applied, naming the remedy — doctor cannot report ok here", async () => {
    db = await createUnmigratedTestDb();
    await expect(databaseProbe(db)()).rejects.toThrow(/pnpm db:import/);
  });

  it("succeeds against a migrated database", async () => {
    db = await createTestDb();
    await expect(databaseProbe(db)()).resolves.toBe(true);
  });

  it("plugged into runDbCheck, a table-less database reports fail with the remedy in the detail", async () => {
    db = await createUnmigratedTestDb();
    const result = await runDbCheck({ url: "postgres://localhost/herald", env: "development" }, databaseProbe(db));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("pnpm db:import");
  });
});

describe("quotaResult", () => {
  it("is ok with headroom, and names the total and the reset date", () => {
    const r = quotaResult("Typefully  live", { used: 9, remaining: 6, resetsAt: "2026-08-01T00:00:00+09:00" });
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("6 left of 15");
    expect(r.detail).toContain("2026-08-01");
  });

  // "on the account" — doctor answers "is the integration healthy", not "can I send right now", and
  // this line must not be read as the latter (see the banner, which does correct for in-flight drafts).
  it("says the total is on the account, not corrected for in-flight drafts", () => {
    const r = quotaResult("t", { used: 9, remaining: 6, resetsAt: "" });
    expect(r.detail).toContain("6 left of 15 on the account");
  });

  it("warns at the low-quota threshold", () => {
    expect(quotaResult("t", { used: 12, remaining: 3, resetsAt: "" }).status).toBe("warn");
    expect(quotaResult("t", { used: 11, remaining: 4, resetsAt: "" }).status).toBe("ok");
  });

  it("warns at zero rather than failing — an exhausted plan is not a broken install", () => {
    expect(quotaResult("t", { used: 15, remaining: 0, resetsAt: "" }).status).toBe("warn");
  });

  it("omits the reset clause when the API did not give one", () => {
    expect(quotaResult("t", { used: 0, remaining: 15, resetsAt: "" }).detail).not.toContain("resets");
  });
});
