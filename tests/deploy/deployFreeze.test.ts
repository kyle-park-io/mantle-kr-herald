// tests/deploy/deployFreeze.test.ts
//
// Follows tests/deploy/runLogging.test.ts: the real CLI is executed against temp directories, never
// a stub, so the git plumbing that derives the steering file list is the one production runs. Both
// temp trees are real git repos with the repo's own ignore rules, because `git check-ignore` is how
// the list is derived and a fake would not exercise it.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(__dirname, "../..");

let dev = "";
let app = "";

/** A git repo whose .gitignore matches the real one for the directories the freeze touches. */
async function makeRepo(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  spawnSync("git", ["-C", dir, "init", "--quiet"]);
  await writeFile(join(dir, ".gitignore"), [
    ".env*", "!.env.example",
    "translation/*", "!translation/*.example.json",
    "conversion/*", "!conversion/*.example.json",
    "keys/*", "!keys/README.md",
    "",
  ].join("\n"));
  for (const rel of ["translation", "conversion", "keys"]) await mkdir(join(dir, rel));
  return dir;
}

function freeze(...args: string[]) {
  return spawnSync("pnpm", ["deploy:freeze", ...args], { cwd: repoRoot, encoding: "utf8" });
}

beforeEach(async () => {
  dev = await makeRepo("freeze-dev-");
  app = await makeRepo("freeze-app-");
});

afterEach(async () => {
  await rm(dev, { recursive: true, force: true });
  await rm(app, { recursive: true, force: true });
});

describe("deploy:freeze --check", () => {
  it("refuses when the development .env is missing", async () => {
    const res = freeze("--check", "--dev", dev, "--app", app);
    expect(res.status).toBe(1);
    expect(res.stderr + res.stdout).toContain(".env");
  });

  it("reports every name as added on the first freeze, and gates on it", async () => {
    await writeFile(join(dev, ".env"), "TELEGRAM_BOT_TOKEN=secret-token-value\nX_PREMIUM=true\n");
    const res = freeze("--check", "--dev", dev, "--app", app);
    expect(res.status).toBe(2);
    expect(res.stdout).toContain("+ TELEGRAM_BOT_TOKEN");
    expect(res.stdout).toContain("+ X_PREMIUM");
    expect(res.stdout).not.toContain("secret-token-value");
  });

  it("passes with --yes", async () => {
    await writeFile(join(dev, ".env"), "A=1\n");
    expect(freeze("--check", "--dev", dev, "--app", app, "--yes").status).toBe(0);
  });

  it("passes without --yes when nothing changed", async () => {
    await writeFile(join(dev, ".env"), "A=1\n");
    await writeFile(join(app, ".env"), "A=1\n");
    const res = freeze("--check", "--dev", dev, "--app", app);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("unchanged");
  });

  it("counts an existing symlink as no snapshot at all", async () => {
    // Migration from the old layout: reading through the link would compare the development .env
    // with itself and report "unchanged" for what is in fact the very first freeze.
    await writeFile(join(dev, ".env"), "A=1\n");
    spawnSync("ln", ["-sfn", join(dev, ".env"), join(app, ".env")]);
    const res = freeze("--check", "--dev", dev, "--app", app);
    expect(res.status).toBe(2);
    expect(res.stdout).toContain("+ A");
  });

  it("diffs steering files and ignores the committed examples", async () => {
    await writeFile(join(dev, ".env"), "A=1\n");
    await writeFile(join(app, ".env"), "A=1\n");
    await writeFile(join(dev, "translation", "glossary.json"), "{}");
    await writeFile(join(dev, "translation", "tm.example.json"), "{}");
    const res = freeze("--check", "--dev", dev, "--app", app);
    expect(res.status).toBe(2);
    expect(res.stdout).toContain("+ translation/glossary.json");
    expect(res.stdout).not.toContain("tm.example.json");
  });

  it("changes nothing on disk", async () => {
    await writeFile(join(dev, ".env"), "A=1\n");
    freeze("--check", "--dev", dev, "--app", app, "--yes");
    const res = spawnSync("test", ["-e", join(app, ".env")]);
    expect(res.status).not.toBe(0);
  });
});
