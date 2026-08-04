import "./registerErrorHandler";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT } from "../paths";
import { checkEnvNames } from "../deploy/requirements";
import { formatReport, type CheckResult } from "../doctor/report";

/**
 * `pnpm deploy:check` — what an operator runs before `npx vercel deploy --prod`. Doctor's sibling
 * (`src/cli/doctor.ts`): same `CheckResult`/`formatReport` shape, same "spawn the real thing,
 * don't reimplement it" posture for `pnpm test` and `pnpm doctor --live`, same
 * `process.exitCode = 1` ending.
 *
 * One rule every Vercel-facing check below obeys: never read an environment variable's *value*.
 * `vercel env ls production --json` gives names only, which is all `checkEnvNames` needs — reading
 * a value (e.g. from `vercel env pull` or a wider API response) would put a production secret on
 * this machine's disk. `vercel api /v9/projects/<id>` is read for its `serverlessFunctionRegion`
 * field only; the response also embeds an `env` array (Vercel's project API shape, not something
 * this command asked for) whose entries carry a `value` field for non-`sensitive` types, so the
 * parsed response is destructured for the one field needed and never logged, forwarded, or
 * persisted whole.
 */
const skipTests = process.argv.includes("--skip-tests");
const results: CheckResult[] = [];

/** One `git` call against the repo containing this file (`REPO_ROOT`), never `process.cwd()` —
 *  same reasoning as `src/paths.ts`: this command must behave the same regardless of which
 *  directory the operator happened to run `pnpm deploy:check` from. */
function git(args: string[]): { ok: boolean; stdout: string; error: string } {
  const r = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
  return {
    ok: r.status === 0 && !r.error,
    stdout: (r.stdout ?? "").trim(),
    error: (r.stderr ?? r.error?.message ?? "").trim(),
  };
}

/** One `vercel` call via `npx` — this project has no `vercel` binary of its own on `PATH`
 *  (see `docs/ko/setup/vercel.md` / `DEPLOY.md`, every command there is `npx vercel ...` too). */
function vercel(args: string[]): { ok: boolean; stdout: string; error: string } {
  const r = spawnSync("npx", ["vercel", ...args], { cwd: REPO_ROOT, encoding: "utf8" });
  return {
    ok: r.status === 0 && !r.error,
    stdout: r.stdout ?? "",
    error: (r.stderr ?? r.error?.message ?? "").trim(),
  };
}

// --- git: deploys ship from a clean, in-sync main ---

const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
results.push(
  branch.ok && branch.stdout === "main"
    ? { name: "Git branch", status: "ok", detail: "main" }
    : {
        name: "Git branch",
        status: "fail",
        detail: branch.ok
          ? `On "${branch.stdout}", not main — deploy from main.`
          : `git rev-parse failed — ${branch.error || "unknown error"}.`,
      },
);

// --untracked-files=no: DEPLOY.md is deliberately untracked in this repo and must not fail this
// check — only uncommitted changes to tracked files are a deploy blocker.
const dirty = git(["status", "--porcelain", "--untracked-files=no"]);
results.push(
  dirty.ok && dirty.stdout === ""
    ? { name: "Git working tree", status: "ok", detail: "clean" }
    : {
        name: "Git working tree",
        status: "fail",
        detail: dirty.ok
          ? `${dirty.stdout.split("\n").length} tracked file(s) not committed — commit or stash before deploying.`
          : `git status failed — ${dirty.error || "unknown error"}.`,
      },
);

// Both `rev-list --count` calls below read the local `origin/main` remote-tracking ref, which is
// only as fresh as the last fetch — nothing else in this command talks to the network first. Without
// this, an operator who has not fetched today sees "0 commits behind" against a ref that is itself
// stale, and deploys a tree that is genuinely behind. A failed fetch (offline, no network) is not
// itself a deploy blocker — it only means the two counts below cannot be trusted — so it becomes a
// `warn` naming that risk rather than a `fail` that would refuse to deploy over a network hiccup.
const fetched = git(["fetch", "origin", "main"]);
results.push(
  fetched.ok
    ? { name: "Git fetch origin/main", status: "ok", detail: "origin/main refreshed" }
    : {
        name: "Git fetch origin/main",
        status: "warn",
        detail: `git fetch origin main failed — ${fetched.error || "unknown error"}; the ahead/behind checks below may be comparing against a stale origin/main.`,
      },
);

const ahead = git(["rev-list", "--count", "origin/main..HEAD"]);
results.push(
  ahead.ok && ahead.stdout === "0"
    ? { name: "Git ahead of origin/main", status: "ok", detail: "0 unpushed commits" }
    : {
        name: "Git ahead of origin/main",
        status: "fail",
        detail: ahead.ok
          ? `${ahead.stdout} commit(s) not pushed to origin/main — push before deploying.`
          : `git rev-list failed — ${ahead.error || "unknown error"}.`,
      },
);

const behind = git(["rev-list", "--count", "HEAD..origin/main"]);
results.push(
  behind.ok && behind.stdout === "0"
    ? { name: "Git behind origin/main", status: "ok", detail: "0 commits behind" }
    : {
        name: "Git behind origin/main",
        status: "fail",
        detail: behind.ok
          ? `${behind.stdout} commit(s) behind origin/main — pull/merge before deploying.`
          : `git rev-list failed — ${behind.error || "unknown error"}.`,
      },
);

// --- test suite ---

if (skipTests) {
  results.push({ name: "Test suite", status: "warn", detail: "skipped (--skip-tests)" });
} else {
  const test = spawnSync("pnpm", ["test"], { cwd: REPO_ROOT, stdio: "inherit" });
  results.push(
    test.status === 0
      ? { name: "Test suite", status: "ok", detail: "pnpm test exited 0" }
      : { name: "Test suite", status: "fail", detail: `pnpm test exited ${test.status ?? "with an error"} — see output above.` },
  );
}

// --- Vercel production environment: names only, never values (see module doc) ---

const envLs = vercel(["env", "ls", "production", "--json"]);
if (!envLs.ok) {
  results.push({
    name: "Vercel env names",
    status: "fail",
    detail: `vercel env ls production --json failed — ${envLs.error || "unknown error"}.`,
  });
} else {
  try {
    const parsed = JSON.parse(envLs.stdout) as { envs?: { key?: unknown }[] };
    const names = (parsed.envs ?? [])
      .map((e) => e.key)
      .filter((k): k is string => typeof k === "string");
    results.push(...checkEnvNames(names));
  } catch (err) {
    results.push({
      name: "Vercel env names",
      status: "fail",
      detail: `Could not parse vercel env ls output — ${err instanceof Error ? err.message : String(err)}.`,
    });
  }
}

// --- Vercel project: function region, and the domain HERALD_DEPLOYMENT_ORIGIN must match ---

const projectJsonPath = join(REPO_ROOT, ".vercel", "project.json");
let projectId: string | undefined;
if (existsSync(projectJsonPath)) {
  try {
    const project = JSON.parse(readFileSync(projectJsonPath, "utf8")) as { projectId?: unknown };
    projectId = typeof project.projectId === "string" ? project.projectId : undefined;
  } catch {
    projectId = undefined;
  }
}

if (!projectId) {
  results.push({
    name: "Vercel project link",
    status: "fail",
    detail: "No .vercel/project.json — run `npx vercel link`.",
  });
} else {
  let expectedRegion: string | undefined;
  try {
    const vercelJson = JSON.parse(readFileSync(join(REPO_ROOT, "vercel.json"), "utf8")) as { regions?: unknown };
    expectedRegion = Array.isArray(vercelJson.regions) && typeof vercelJson.regions[0] === "string" ? vercelJson.regions[0] : undefined;
  } catch {
    expectedRegion = undefined;
  }

  const project = vercel(["api", `/v9/projects/${projectId}`]);
  if (!project.ok) {
    results.push({
      name: "Vercel region",
      status: "fail",
      detail: `vercel api /v9/projects/<id> failed — ${project.error || "unknown error"}.`,
    });
  } else {
    try {
      const parsed = JSON.parse(project.stdout) as { serverlessFunctionRegion?: unknown };
      const actualRegion = typeof parsed.serverlessFunctionRegion === "string" ? parsed.serverlessFunctionRegion : undefined;
      results.push(
        expectedRegion !== undefined && actualRegion === expectedRegion
          ? { name: "Vercel region", status: "ok", detail: `${actualRegion} on both sides` }
          : {
              name: "Vercel region",
              status: "fail",
              detail: `vercel.json wants "${expectedRegion ?? "(unset)"}", project is set to "${actualRegion ?? "(unset)"}".`,
            },
      );
    } catch (err) {
      results.push({
        name: "Vercel region",
        status: "fail",
        detail: `Could not parse vercel api project response — ${err instanceof Error ? err.message : String(err)}.`,
      });
    }
  }

  const domains = vercel(["api", `/v9/projects/${projectId}/domains`]);
  if (!domains.ok) {
    results.push({
      name: "Vercel domain",
      status: "fail",
      detail: `vercel api /v9/projects/<id>/domains failed — ${domains.error || "unknown error"}.`,
    });
  } else {
    try {
      const parsed = JSON.parse(domains.stdout) as { domains?: { name?: unknown; verified?: unknown }[] };
      const verified = (parsed.domains ?? []).find((d) => d.verified === true && typeof d.name === "string");
      // Informational only, never a comparison — the value behind HERALD_DEPLOYMENT_ORIGIN cannot
      // be read (see module doc), so this can only ever name what it should be, not check it.
      results.push(
        verified
          ? {
              name: "Vercel domain",
              status: "ok",
              detail: `${verified.name as string} — HERALD_DEPLOYMENT_ORIGIN must equal https://${verified.name as string}.`,
            }
          : { name: "Vercel domain", status: "fail", detail: "No verified domain found on this project." },
      );
    } catch (err) {
      results.push({
        name: "Vercel domain",
        status: "fail",
        detail: `Could not parse vercel api domains response — ${err instanceof Error ? err.message : String(err)}.`,
      });
    }
  }
}

// --- local health check, unrelated to Vercel but part of the same pre-deploy ritual ---

const doctorLive = spawnSync("pnpm", ["doctor", "--live"], { cwd: REPO_ROOT, stdio: "inherit" });
results.push(
  doctorLive.status === 0
    ? { name: "pnpm doctor --live", status: "ok", detail: "exited 0" }
    : { name: "pnpm doctor --live", status: "fail", detail: `exited ${doctorLive.status ?? "with an error"} — see output above.` },
);

// The one gap this command (and `deploy:smoke`) cannot close — see `docs/superpowers/specs/
// 2026-08-04-deploy-scripts-design.md`'s "The gap neither command closes". `doctor --live` just
// above proves the LOCAL Google refresh token is alive; it says nothing about the copy sitting in
// Vercel's env, and nothing here can check that without pulling a production secret to disk.
// `createDeps` only checks presence, so a revoked deployed token still leaves `google` in
// `availableTargets` — this line exists so that fact reaches the operator's screen instead of only
// this doc, since a `doctor --live` pass reads like "Google is fine" otherwise.
results.push({
  name: "Google token liveness (deployed)",
  status: "warn",
  detail:
    "Not checked — this only verifies the local token via doctor --live; a revoked deployed token still leaves \"google\" in availableTargets. Rotate in both places, and confirm with a real publish.",
});

console.log(formatReport(results, { title: "Mantle KR Herald — deploy check" }));
if (results.some((r) => r.status === "fail")) process.exitCode = 1;
