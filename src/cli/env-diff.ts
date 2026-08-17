import "./registerErrorHandler";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT } from "../paths";
import { compareEnvNames, SHARED_WITH_DEPLOYMENT } from "../deploy/envDiff";
import { formatReport, type CheckResult } from "../doctor/report";

/**
 * `pnpm env:diff` — does this machine's `.env` hold the same credentials the deployment does?
 *
 * The question a rebuilt laptop needs answered. `.env` cannot be recovered from Vercel — everything
 * stored sensitive comes back as the literal `[SENSITIVE]`, which is most of the credentials — so
 * the operator brings their own copy, and the only useful thing a tool can do is say whether that
 * copy and production have drifted apart. `docs/ko/setup/operator-machine.md` is the procedure this
 * belongs to.
 *
 * Follows `deploy-check.ts`'s one rule exactly: `vercel env ls production --json` gives names, and
 * names are all this reads. No `vercel env pull`, so no production secret is written to this
 * machine's disk — and nothing this prints contains a value from either side, only variable names.
 *
 * **Not a value comparison, and it says so in its own output.** The values that can be read are the
 * ones the two sides are meant to disagree about (`HERALD_STORAGE_MODE`, `HERALD_DB_ENV`, the
 * database, the dashboard account), and the ones worth comparing cannot be read at all. Printing a
 * clean report while silently skipping twenty credentials is the failure this command was written
 * after — the whole point is that it never claims to have checked something it did not.
 *
 * Exit code follows `doctor`/`deploy:check`: 1 when anything is not ok, so a `&&` chain stops.
 */
const results: CheckResult[] = [];

function vercel(args: string[]): { ok: boolean; stdout: string; error: string } {
  const r = spawnSync("npx", ["vercel", ...args], { cwd: REPO_ROOT, encoding: "utf8" });
  return {
    ok: r.status === 0 && !r.error,
    stdout: r.stdout ?? "",
    error: (r.stderr ?? r.error?.message ?? "").trim(),
  };
}

/**
 * Names with a non-empty value in `.env`. A name present but blank counts as absent, because that
 * is what every loader in `src/config.ts` does with it — `?.trim() || undefined`, or a thrown
 * "Missing required environment variable". A skeleton copied from `.env.example` holds all fifty
 * names and no credentials, and reporting it as fully in sync would be the worst possible answer.
 */
function localNames(): string[] {
  const envPath = join(REPO_ROOT, ".env");
  if (!existsSync(envPath)) return [];
  return readFileSync(envPath, "utf8")
    .split("\n")
    .map((line) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim()))
    .filter((m): m is RegExpExecArray => m !== null && m[2].trim() !== "")
    .map((m) => m[1]);
}

const envPath = join(REPO_ROOT, ".env");
if (!existsSync(envPath)) {
  results.push({
    name: ".env",
    status: "fail",
    detail: "No .env in the repository root — bring this machine's copy first (docs/ko/setup/operator-machine.md).",
  });
} else {
  const envLs = vercel(["env", "ls", "production", "--json"]);
  if (!envLs.ok) {
    results.push({
      name: "Vercel env names",
      status: "fail",
      detail: `vercel env ls production --json failed — ${envLs.error || "unknown error"}. Is this checkout linked (npx vercel link)?`,
    });
  } else {
    try {
      const parsed = JSON.parse(envLs.stdout) as { envs?: { key?: unknown }[] };
      const remote = (parsed.envs ?? []).map((e) => e.key).filter((k): k is string => typeof k === "string");
      results.push(...compareEnvNames({ local: localNames(), remote }));
    } catch (err) {
      results.push({
        name: "Vercel env names",
        status: "fail",
        detail: `Could not parse vercel env ls output — ${err instanceof Error ? err.message : String(err)}.`,
      });
    }
  }
}

console.log(formatReport(results, { title: "Mantle KR Herald — .env vs Vercel production" }));
console.log(
  `\nNames only, across the ${SHARED_WITH_DEPLOYMENT.length} credentials both sides hold. Values are never read:\n` +
    "  · Vercel returns sensitive values as [SENSITIVE], so most of them cannot be compared at all.\n" +
    "  · The readable ones (storage mode, database, dashboard account) are meant to differ.\n" +
    "Whether the secrets still work is a different question — pnpm doctor --live here, pnpm creds:check for the deployment.",
);

if (results.some((r) => r.status !== "ok")) process.exitCode = 1;
