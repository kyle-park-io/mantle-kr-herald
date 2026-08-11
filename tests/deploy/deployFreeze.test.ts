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

import { statSync, readFileSync, existsSync, lstatSync } from "node:fs";

describe("deploy:freeze --apply", () => {
  it("writes the env file with mode 600", async () => {
    await writeFile(join(dev, ".env"), "A=1\n");
    expect(freeze("--apply", "--dev", dev, "--app", app).status).toBe(0);
    expect(readFileSync(join(app, ".env"), "utf8")).toBe("A=1\n");
    expect(statSync(join(app, ".env")).mode & 0o777).toBe(0o600);
  });

  it("replaces a symlink left by the old layout with a real file", async () => {
    // Content distinct from the "A=1\n" used elsewhere in this file, so a write that landed on the
    // wrong file could not coincidentally read back as correct.
    await writeFile(join(dev, ".env"), "REAL_DEV_SECRET=do-not-touch\n");
    const devModeBefore = statSync(join(dev, ".env")).mode & 0o777;
    spawnSync("ln", ["-sfn", join(dev, ".env"), join(app, ".env")]);
    freeze("--apply", "--dev", dev, "--app", app);
    // `statSync` follows symlinks, so it cannot tell a replaced file from an untouched link that
    // still resolves to one — only `lstatSync` on the app path sees the link itself.
    expect(lstatSync(join(app, ".env")).isSymbolicLink()).toBe(false);
    expect(existsSync(join(app, ".env"))).toBe(true);
    expect(readFileSync(join(app, ".env"), "utf8")).toBe("REAL_DEV_SECRET=do-not-touch\n");
    // The development copy must survive: rename replaces the link, not its target. Content alone
    // cannot prove this — a write that went straight through the old symlink instead of using the
    // tmp+rename dance would read dev/.env's own bytes and write those same bytes straight back, so
    // content would come out identical either way. What it would also do is `chmod` the file the
    // link points at — dev/.env — down to the frozen `.env` mode. Checking the mode is what actually
    // fails if apply() ever wrote through the link again.
    expect(readFileSync(join(dev, ".env"), "utf8")).toBe("REAL_DEV_SECRET=do-not-touch\n");
    expect(statSync(join(dev, ".env")).mode & 0o777).toBe(devModeBefore);
  });

  it("copies steering files and gives keys/ mode 600", async () => {
    await writeFile(join(dev, ".env"), "A=1\n");
    await writeFile(join(dev, "translation", "glossary.json"), `{"a":1}`);
    await writeFile(join(dev, "keys", "mantle-sa.json"), `{"private_key":"x"}`);
    freeze("--apply", "--dev", dev, "--app", app);
    expect(readFileSync(join(app, "translation", "glossary.json"), "utf8")).toBe(`{"a":1}`);
    expect(statSync(join(app, "keys", "mantle-sa.json")).mode & 0o777).toBe(0o600);
  });

  it("removes a steering file that no longer exists in the development checkout", async () => {
    await writeFile(join(dev, ".env"), "A=1\n");
    await writeFile(join(app, "translation", "glossary.json"), "{}");
    freeze("--apply", "--dev", dev, "--app", app);
    expect(existsSync(join(app, "translation", "glossary.json"))).toBe(false);
  });

  it("leaves committed example files alone", async () => {
    await writeFile(join(dev, ".env"), "A=1\n");
    await writeFile(join(app, "translation", "tm.example.json"), "{}");
    freeze("--apply", "--dev", dev, "--app", app);
    expect(existsSync(join(app, "translation", "tm.example.json"))).toBe(true);
  });

  it("is idempotent", async () => {
    await writeFile(join(dev, ".env"), "A=1\n");
    freeze("--apply", "--dev", dev, "--app", app);
    const second = freeze("--apply", "--dev", dev, "--app", app);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("unchanged");
  });
});

// The two trees get opposite symlink semantics, and each direction has its own way of failing
// silently, so each direction is pinned here rather than left to the tests above.
//
// Development side: a link is followed, because `apply()` copies with `readFileSync` and the
// scheduler reads through it too. Deploy side: a link is never a snapshot — it is the pre-2026-08-09
// layout — but it must still be *seen*, or the sweep cannot remove one the old deploy left behind.
describe("deploy:freeze and the two trees' opposite symlink rules", () => {
  it("follows a symlinked development .env instead of reporting its variables removed", async () => {
    // A development `.env` that is itself a link (a shared secrets file, a restored backup) is what
    // the scheduler would read, so the freeze must read the same bytes. Read with `lstat` instead,
    // the development snapshot comes back empty and every name the deploy checkout already holds
    // prints as removed — a diff that `--apply` then "fixes" by writing the identical bytes back,
    // so the next `--check` prints it again, forever. The second check below is that half.
    await writeFile(join(dev, ".env.source"), "SHARED_SECRET=one\n");
    spawnSync("ln", ["-sfn", join(dev, ".env.source"), join(dev, ".env")]);
    await writeFile(join(app, ".env"), "SHARED_SECRET=one\n");

    const first = freeze("--check", "--dev", dev, "--app", app);
    expect(first.stdout).toContain("env: unchanged");
    expect(first.stdout).not.toContain("- SHARED_SECRET");
    expect(first.status).toBe(0);

    expect(freeze("--apply", "--dev", dev, "--app", app).status).toBe(0);

    const second = freeze("--check", "--dev", dev, "--app", app);
    expect(second.stdout).toContain("env: unchanged");
    expect(second.status).toBe(0);
  });

  it("copies a symlinked development steering file, as a real file", async () => {
    // The bash this replaced gated on `[ -f "$src" ]`, which follows links and would have linked
    // this glossary. Skipping it writes no file and no `translation/` directory at all, and
    // JsonGlossaryStore.load() turns a missing glossary into `[]` — the scheduler would translate
    // against an empty glossary and say nothing.
    await writeFile(join(dev, ".env"), "A=1\n");
    await writeFile(join(dev, "glossary.shared.json"), `{"term":"linked"}`);
    spawnSync("ln", ["-sfn", join(dev, "glossary.shared.json"), join(dev, "translation", "glossary.json")]);

    const res = freeze("--apply", "--dev", dev, "--app", app);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("freeze: translation/glossary.json");
    expect(lstatSync(join(app, "translation", "glossary.json")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(app, "translation", "glossary.json"), "utf8")).toBe(`{"term":"linked"}`);
  });

  it("sweeps a deploy-checkout steering symlink whose development file is gone", async () => {
    // Exactly what a migration finds: `ln -sfn` from the old deploy, its target since deleted in
    // the development checkout. `ln -sfn` never removed anything, so this is the state the freeze
    // exists to clear — and a link hidden from the snapshot survives every future deploy silently.
    await writeFile(join(dev, ".env"), "A=1\n");
    await writeFile(join(app, ".env"), "A=1\n");
    const retired = join(app, "translation", "retired.json");
    spawnSync("ln", ["-sfn", join(dev, "translation", "retired.json"), retired]);

    const check = freeze("--check", "--dev", dev, "--app", app);
    expect(check.stdout).toContain("- translation/retired.json");
    expect(check.status).toBe(2);

    expect(freeze("--apply", "--dev", dev, "--app", app).status).toBe(0);
    // `existsSync` cannot answer this: it follows the link and already returns false for a dangling
    // one, so it would pass against a link that is still sitting there. `lstat` sees the link.
    expect(lstatSync(retired, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("replaces a deploy-checkout steering symlink whose development file still exists", async () => {
    // The other half of the same rule: the link is not a snapshot even when it resolves to the very
    // bytes that would be written, so it reports as changed and `--apply` turns it into a copy.
    await writeFile(join(dev, ".env"), "A=1\n");
    await writeFile(join(app, ".env"), "A=1\n");
    await writeFile(join(dev, "translation", "glossary.json"), `{"a":1}`);
    spawnSync("ln", ["-sfn", join(dev, "translation", "glossary.json"), join(app, "translation", "glossary.json")]);

    // `~`, not `+`: the deploy checkout does hold that path, it just does not hold a snapshot of it.
    const check = freeze("--check", "--dev", dev, "--app", app);
    expect(check.stdout).toContain("~ translation/glossary.json");
    expect(check.status).toBe(2);

    freeze("--apply", "--dev", dev, "--app", app);
    expect(lstatSync(join(app, "translation", "glossary.json")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(app, "translation", "glossary.json"), "utf8")).toBe(`{"a":1}`);
  });
});

// `translation/few-shot.json` and `conversion/few-shot.<type>.json` are git-ignored and sit in the
// steering tree, so `git check-ignore` calls them configuration — but since the hosted-writes
// cutover the corpus is the `few_shot_examples` table and nothing reads these files at runtime.
// They are what `pnpm db:export` writes for the rollback path. Freezing them copied a dead snapshot
// into the tree the scheduler runs from, growing on every approval and read by nothing.
describe("deploy:freeze and the db:export few-shot artifacts", () => {
  it("does not freeze them, and does not mention them in the diff", async () => {
    await writeFile(join(dev, ".env"), "A=1\n");
    await writeFile(join(app, ".env"), "A=1\n");
    await writeFile(join(dev, "translation", "few-shot.json"), "[]");
    await writeFile(join(dev, "conversion", "few-shot.x.json"), "[]");

    const check = freeze("--check", "--dev", dev, "--app", app);
    expect(check.stdout).not.toContain("few-shot");
    expect(check.stdout).toContain("steering: unchanged");
    expect(check.status).toBe(0);

    expect(freeze("--apply", "--dev", dev, "--app", app).status).toBe(0);
    expect(existsSync(join(app, "translation", "few-shot.json"))).toBe(false);
    expect(existsSync(join(app, "conversion", "few-shot.x.json"))).toBe(false);
  });

  it("still freezes tm.json, which IS read at runtime", async () => {
    // The near miss: tm.json is a `FewShotStore` in the code too, and a `startsWith("few-shot")`-
    // style filter that caught it would strip the translation-memory corpus out of every deploy —
    // `translate:prepare` would then quietly prepare worksheets with no precedent pairs at all.
    await writeFile(join(dev, ".env"), "A=1\n");
    await writeFile(join(dev, "translation", "tm.json"), `[{"source":"a","target":"b"}]`);

    const res = freeze("--apply", "--dev", dev, "--app", app);
    expect(res.stdout).toContain("freeze: translation/tm.json");
    expect(readFileSync(join(app, "translation", "tm.json"), "utf8")).toBe(`[{"source":"a","target":"b"}]`);
  });

  it("sweeps copies an earlier freeze already put in the deploy checkout", async () => {
    // The migration case, and the reason the deploy side of the listing is deliberately NOT
    // filtered: every deploy before this change left one of these in the tree. Filtering both sides
    // would leave them there forever, invisible to the diff that describes that tree.
    await writeFile(join(dev, ".env"), "A=1\n");
    await writeFile(join(app, ".env"), "A=1\n");
    await writeFile(join(dev, "translation", "few-shot.json"), "[]");
    await writeFile(join(app, "translation", "few-shot.json"), "[]");

    const check = freeze("--check", "--dev", dev, "--app", app);
    expect(check.stdout).toContain("- translation/few-shot.json");
    expect(check.status).toBe(2);

    expect(freeze("--apply", "--dev", dev, "--app", app).status).toBe(0);
    expect(existsSync(join(app, "translation", "few-shot.json"))).toBe(false);
  });

  it("does not filter keys/, where every git-ignored file is a credential", async () => {
    // The carve-out is by directory, not by name alone: a name-shaped filter over `keys/` could only
    // ever drop a credential silently, which is the one failure mode this whole command exists to
    // rule out.
    await writeFile(join(dev, ".env"), "A=1\n");
    await writeFile(join(dev, "keys", "few-shot.json"), `{"private_key":"x"}`);

    const res = freeze("--apply", "--dev", dev, "--app", app);
    expect(res.stdout).toContain("freeze: keys/few-shot.json");
    expect(readFileSync(join(app, "keys", "few-shot.json"), "utf8")).toBe(`{"private_key":"x"}`);
  });
});
