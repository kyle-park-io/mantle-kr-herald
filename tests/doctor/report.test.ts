import { describe, it, expect } from "vitest";
import { summarize, formatReport, type CheckResult } from "../../src/doctor/report";

const results: CheckResult[] = [
  { name: "twitterapi.io (A)", status: "ok", detail: "TWITTERAPI_IO_KEY set" },
  { name: "Google Sheet (§9a)", status: "warn", detail: "spreadsheets scope NOT granted" },
  { name: "Lark Drive (D)", status: "fail", detail: "Missing LARK_DRIVE_REVIEW_FOLDER_TOKEN" },
];

describe("summarize", () => {
  it("counts each status", () => {
    expect(summarize(results)).toEqual({ ok: 1, warn: 1, fail: 1 });
  });
});

describe("formatReport", () => {
  it("renders a glyph per status, the details, and a summary line", () => {
    const out = formatReport(results, { live: true });
    expect(out).toContain("setup check (--live)");
    expect(out).toContain("✓ twitterapi.io (A)");
    expect(out).toContain("⚠ Google Sheet (§9a)");
    expect(out).toContain("✗ Lark Drive (D)");
    expect(out).toContain("TWITTERAPI_IO_KEY set");
    expect(out).toContain("1 ok · 1 warn · 1 fail");
  });

  it("omits the (--live) marker when not live", () => {
    expect(formatReport([results[0]], { live: false })).not.toContain("--live");
  });
});
