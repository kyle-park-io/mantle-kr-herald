export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

const GLYPH: Record<CheckStatus, string> = { ok: "✓", warn: "⚠", fail: "✗" };

export function summarize(results: CheckResult[]): { ok: number; warn: number; fail: number } {
  return {
    ok: results.filter((r) => r.status === "ok").length,
    warn: results.filter((r) => r.status === "warn").length,
    fail: results.filter((r) => r.status === "fail").length,
  };
}

export function formatReport(results: CheckResult[], opts: { live: boolean } = { live: false }): string {
  const width = results.reduce((w, r) => Math.max(w, r.name.length), 0);
  const lines = results.map((r) => `  ${GLYPH[r.status]} ${r.name.padEnd(width)}  ${r.detail}`);
  const s = summarize(results);
  return [
    `Mantle KR Herald — setup check${opts.live ? " (--live)" : ""}`,
    "",
    ...lines,
    "",
    `${s.ok} ok · ${s.warn} warn · ${s.fail} fail`,
  ].join("\n");
}
