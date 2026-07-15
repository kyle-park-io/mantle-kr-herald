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
