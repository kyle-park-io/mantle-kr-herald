import type { CheckResult } from "./report";

/** Run a config loader: ok if it doesn't throw, fail with its own message otherwise. */
export function configCheck(name: string, run: () => void, okDetail = "configured"): CheckResult {
  try {
    run();
    return { name, status: "ok", detail: okDetail };
  } catch (err) {
    return { name, status: "fail", detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * A config check for a credential that cloud mode requires but local mode doesn't. A success is
 * still reported ok (the check is still meaningful information either way); a failure is
 * downgraded from fail to warn when `local` is true, so a fresh local-mode clone doesn't exit
 * non-zero over credentials it genuinely doesn't need — `localDetail` explains why not.
 */
export function cloudCheck(
  name: string,
  run: () => void,
  local: boolean,
  localDetail: string,
  okDetail?: string,
): CheckResult {
  const result = configCheck(name, run, okDetail);
  if (local && result.status === "fail") {
    return { name, status: "warn", detail: `${localDetail} (${result.detail})` };
  }
  return result;
}

/** A space-separated OAuth scope string → array (empties dropped). */
export function parseScopes(scope: string | undefined): string[] {
  return (scope ?? "").split(/\s+/).filter((s) => s.length > 0);
}

const shortScope = (scope: string) => scope.replace("https://www.googleapis.com/auth/", "");

/** ok if `needed` is in the granted scopes, else warn with a fix hint. */
export function scopeCheck(name: string, granted: string[], needed: string, hint: string): CheckResult {
  return granted.includes(needed)
    ? { name, status: "ok", detail: `scope ${shortScope(needed)} granted` }
    : { name, status: "warn", detail: `scope ${shortScope(needed)} NOT granted — ${hint}` };
}

/** Interpret a Drive file-metadata fetch: ok if reachable, fail (404 → re-init hint). */
export function accessResult(name: string, res: { ok: boolean; status: number; fileName?: string }): CheckResult {
  if (res.ok) return { name, status: "ok", detail: `accessible${res.fileName ? ` (${res.fileName})` : ""}` };
  const detail =
    res.status === 404
      ? "not found under this token — re-run pnpm drive:init (drive.file only sees files the app created)"
      : `HTTP ${res.status}`;
  return { name, status: "fail", detail };
}
