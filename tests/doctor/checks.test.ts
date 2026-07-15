import { describe, it, expect } from "vitest";
import { configCheck, parseScopes, scopeCheck, accessResult } from "../../src/doctor/checks";

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
