// tests/doctor/deploySteering.test.ts
//
// Two halves, for two different reasons.
//
// `resolveDeployTree` is fed fake `systemctl show` output, the way `tests/status/translateFloor.test.ts`
// does: a unit that is not installed, a masked unit and a machine with no systemd at all are all
// states production can be in and this machine cannot.
//
// `deploySteeringStatus` gets real temp git repos, the way `tests/deploy/deployFreeze.test.ts` does:
// the file list is derived by `git check-ignore`, and a fake would exercise none of it — nor the
// opposite symlink rules the two trees get, which is where this check would silently answer the
// wrong question.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  resolveDeployTree,
  deploySteeringStatus,
  deploySteeringResult,
  DEPLOY_STEERING_CHECK,
  DEPLOY_DIR_VAR,
  type DeployTree,
} from "../../src/doctor/deploySteering";
import { WATCH_UNIT } from "../../src/status/translateFloor";

const show = (...lines: string[]) => lines.join("\n");
const LOADED = show("WorkingDirectory=/home/kyle/.herald/app", "LoadState=loaded");

describe("resolveDeployTree", () => {
  it("takes the systemd unit's WorkingDirectory when nothing overrides it", () => {
    expect(resolveDeployTree({ unitShow: LOADED })).toEqual({
      known: true,
      dir: "/home/kyle/.herald/app",
      source: "unit",
    });
  });

  it("lets HERALD_DEPLOY_DIR win over a loaded unit, and says the override is where it came from", () => {
    // Precedence, not merely "an override exists": a setting something else can silently outrank is
    // not a setting. The unit here names a different directory on purpose.
    expect(resolveDeployTree({ override: "/srv/herald-app", unitShow: LOADED })).toEqual({
      known: true,
      dir: "/srv/herald-app",
      source: "env",
    });
  });

  it("resolves a relative override to an absolute path", () => {
    const tree = resolveDeployTree({ override: "some/relative/tree" });
    expect(tree.known && tree.dir).toBe(join(process.cwd(), "some/relative/tree"));
  });

  it("ignores an empty or whitespace-only override rather than comparing against the cwd", () => {
    // `HERALD_DEPLOY_DIR=` in a .env reaches Node as "", not undefined. Passed through, `resolve("")`
    // is the current directory — a comparison of this checkout against wherever the shell happened
    // to be, reported as though someone had asked for it.
    expect(resolveDeployTree({ override: "   ", unitShow: LOADED })).toEqual({
      known: true,
      dir: "/home/kyle/.herald/app",
      source: "unit",
    });
    expect(resolveDeployTree({ override: "" })).toEqual({
      known: false,
      detail: `no systemd on this machine to ask about ${WATCH_UNIT}`,
    });
  });

  it("reports a machine with no systemd as unknown, not as a missing deploy tree", () => {
    const tree = resolveDeployTree({ unitShow: undefined });
    expect(tree.known).toBe(false);
    expect(!tree.known && tree.detail).toContain("no systemd");
  });

  it("separates a unit that is not installed from a unit that names nothing", () => {
    // `systemctl show` exits 0 for a unit it has never heard of and prints a bare
    // `WorkingDirectory=` — byte-identical to a loaded unit that sets none. Both are `known: false`,
    // but only the second is anybody's mistake, so the wording has to differ.
    const absent = resolveDeployTree({ unitShow: show("WorkingDirectory=", "LoadState=not-found") });
    const silent = resolveDeployTree({ unitShow: show("WorkingDirectory=", "LoadState=loaded") });
    expect(!absent.known && absent.detail).toBe(`${WATCH_UNIT} is not installed here`);
    expect(!silent.known && silent.detail).toBe(`${WATCH_UNIT} is loaded but names no WorkingDirectory`);
  });

  it("refuses a masked unit's WorkingDirectory", () => {
    // The unit exists in some form but will not run as written, so the directory it names is not a
    // claim about what any timer does.
    const tree = resolveDeployTree({ unitShow: show("WorkingDirectory=/home/kyle/.herald/app", "LoadState=masked") });
    expect(tree.known).toBe(false);
    expect(!tree.known && tree.detail).toBe(`${WATCH_UNIT} is masked, not loaded`);
  });

  it("treats output with no LoadState line as unreadable", () => {
    const tree = resolveDeployTree({ unitShow: "WorkingDirectory=/home/kyle/.herald/app" });
    expect(tree.known).toBe(false);
    expect(!tree.known && tree.detail).toContain("LoadState");
  });
});

let here = "";
let deploy = "";

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

const asTree = (dir: string): DeployTree => ({ known: true, dir, source: "env" });

beforeEach(async () => {
  here = await makeRepo("drift-here-");
  deploy = await makeRepo("drift-app-");
});

afterEach(async () => {
  await rm(here, { recursive: true, force: true });
  await rm(deploy, { recursive: true, force: true });
});

describe("deploySteeringStatus", () => {
  it("reports a glossary edited here and never deployed", async () => {
    await writeFile(join(here, "translation", "glossary.json"), `[{"term":"Mantle"}]`);
    await writeFile(join(deploy, "translation", "glossary.json"), "[]");
    const s = deploySteeringStatus(here, asTree(deploy));
    expect(s.kind).toBe("drifted");
    expect(s.diff?.changed).toEqual(["translation/glossary.json"]);
    expect(s.compared).toBe(1);
  });

  it("reports a file the deploy tree has never seen as only-here", async () => {
    await writeFile(join(here, "translation", "tm.json"), "{}");
    const s = deploySteeringStatus(here, asTree(deploy));
    expect(s.kind).toBe("drifted");
    expect(s.diff?.added).toEqual(["translation/tm.json"]);
    expect(s.diff?.removed).toEqual([]);
  });

  it("grades a difference made only of files the deploy tree holds extra as stale-in-deploy", async () => {
    // Direction is the whole grading rule. Nothing the scheduler reads is missing or different here
    // — the deploy tree is carrying something extra, which the next deploy deletes.
    await writeFile(join(here, "translation", "glossary.json"), "[]");
    await writeFile(join(deploy, "translation", "glossary.json"), "[]");
    await writeFile(join(deploy, "conversion", "retired.md"), "# old");
    const s = deploySteeringStatus(here, asTree(deploy));
    expect(s.kind).toBe("stale-in-deploy");
    expect(s.diff?.removed).toEqual(["conversion/retired.md"]);
  });

  it("is drifted, not stale-in-deploy, as soon as anything is missing or different over there", async () => {
    // The boundary: one changed file alongside the extras is the alarming direction, and the extras
    // must not soften it.
    await writeFile(join(here, "translation", "glossary.json"), `[{"term":"Mantle"}]`);
    await writeFile(join(deploy, "translation", "glossary.json"), "[]");
    await writeFile(join(deploy, "conversion", "retired.md"), "# old");
    const s = deploySteeringStatus(here, asTree(deploy));
    expect(s.kind).toBe("drifted");
    expect(deploySteeringResult(s).status).toBe("warn");
  });

  it("is in-sync when both trees hold the same bytes, and says how many files that was", async () => {
    for (const dir of [here, deploy]) {
      await writeFile(join(dir, "translation", "glossary.json"), `[{"term":"Mantle"}]`);
      await writeFile(join(dir, "conversion", "x.md"), "# x");
    }
    const s = deploySteeringStatus(here, asTree(deploy));
    expect(s.kind).toBe("in-sync");
    expect(s.compared).toBe(2);
  });

  it("ignores the committed example files, which are not steering config", async () => {
    // `*.example.*` arrives with the clone in both trees and is never copied by a deploy, so an
    // example present on one side only must not read as drift.
    await writeFile(join(here, "translation", "glossary.json"), "[]");
    await writeFile(join(deploy, "translation", "glossary.json"), "[]");
    await writeFile(join(here, "translation", "tm.example.json"), "{}");
    const s = deploySteeringStatus(here, asTree(deploy));
    expect(s.kind).toBe("in-sync");
    expect(s.compared).toBe(1);
  });

  it("counts a symlink in the deploy tree as drift even when it resolves to identical bytes", async () => {
    // The two trees get opposite symlink rules, and this is the half that decides which `Tree` the
    // deploy side is read with. A link there is the pre-2026-08-09 layout — the deploy checkout is
    // reading the development tree live rather than holding a snapshot — so it is drift whatever it
    // currently points at. Read with the development tree's rule, this would report in-sync.
    await writeFile(join(here, "translation", "glossary.json"), `[{"term":"Mantle"}]`);
    spawnSync("ln", ["-sfn", join(here, "translation", "glossary.json"), join(deploy, "translation", "glossary.json")]);
    const s = deploySteeringStatus(here, asTree(deploy));
    expect(s.kind).toBe("drifted");
    expect(s.diff?.changed).toEqual(["translation/glossary.json"]);
  });

  it("follows a symlinked steering file in this checkout, because that is what a deploy would copy", async () => {
    // The other half: on this side a link is configuration like any other — `deploy:freeze --apply`
    // copies through it — so a link whose target matches the deployed file is in sync. Read with the
    // deploy tree's rule, this would report drift on every doctor run and never stop.
    await writeFile(join(here, "glossary.shared.json"), `[{"term":"Mantle"}]`);
    spawnSync("ln", ["-sfn", join(here, "glossary.shared.json"), join(here, "translation", "glossary.json")]);
    await writeFile(join(deploy, "translation", "glossary.json"), `[{"term":"Mantle"}]`);
    expect(deploySteeringStatus(here, asTree(deploy)).kind).toBe("in-sync");
  });

  it("answers same-tree when doctor is running inside the deploy checkout", () => {
    const s = deploySteeringStatus(deploy, asTree(deploy));
    expect(s.kind).toBe("same-tree");
    expect(s.diff).toBeUndefined();
  });

  it("answers same-tree when the deploy path reaches this checkout through a symlink", async () => {
    // One tree, two names — `%h/.herald/app` where the home directory is itself a link. Compared as
    // two directories it would read as a confident in-sync for a comparison that never happened.
    const alias = join(await mkdtemp(join(tmpdir(), "drift-alias-")), "app");
    spawnSync("ln", ["-sfn", deploy, alias]);
    expect(deploySteeringStatus(deploy, asTree(alias)).kind).toBe("same-tree");
    await rm(alias, { force: true });
  });

  it("never calls a db:export few-shot artifact in this checkout drift", async () => {
    // `isSteeringConfigFile` (#186) took the seven `few-shot*.json` files out of the development
    // listing: nothing reads them at runtime, `db:export` writes them, and a deploy must not ship
    // them. Derived here without the predicate, each one would be a permanent `only here` on every
    // machine that has ever run `db:export` — drift a deploy could never resolve, because the deploy
    // deliberately does not copy them.
    await writeFile(join(here, "translation", "glossary.json"), "[]");
    await writeFile(join(deploy, "translation", "glossary.json"), "[]");
    await writeFile(join(here, "translation", "few-shot.json"), "[]");
    await writeFile(join(here, "conversion", "few-shot.x.json"), "[]");
    expect(deploySteeringStatus(here, asTree(deploy)).kind).toBe("in-sync");
  });

  it("keeps tm.json in the comparison — the near miss the predicate is written around", async () => {
    // `tm.json` is a `FewShotStore` in the code too, but `translate:prepare`/`translate:align`
    // genuinely read it, so an undeployed edit to it IS the failure this check exists for.
    await writeFile(join(here, "translation", "tm.json"), `[{"src":"a","tgt":"ㄱ"}]`);
    await writeFile(join(deploy, "translation", "tm.json"), "[]");
    const s = deploySteeringStatus(here, asTree(deploy));
    expect(s.kind).toBe("drifted");
    expect(s.diff?.changed).toEqual(["translation/tm.json"]);
  });

  it("reports few-shot copies an earlier deploy froze as stale, not as drift", async () => {
    // The state every machine deployed before 2026-08-11 is in, and the one the wording has to get
    // right: the deploy side of the listing is deliberately unfiltered so `apply()` can sweep these,
    // so doctor sees them too — as something to tidy, not as a scheduler running the wrong config.
    await writeFile(join(here, "translation", "glossary.json"), "[]");
    await writeFile(join(deploy, "translation", "glossary.json"), "[]");
    await writeFile(join(deploy, "translation", "few-shot.json"), "[]");
    await writeFile(join(deploy, "conversion", "few-shot.x.json"), "[]");

    const s = deploySteeringStatus(here, asTree(deploy));
    expect(s.kind).toBe("stale-in-deploy");
    expect(s.diff?.removed).toEqual(["conversion/few-shot.x.json", "translation/few-shot.json"]);

    const r = deploySteeringResult(s);
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("no longer syncs");
    expect(r.detail).toContain("nothing the schedulers read");
    expect(r.detail).toContain("sweeps them");
    // Not worded as a defect, and not worded as agreement either.
    expect(r.detail).not.toContain("differ");
    expect(r.detail).not.toContain("record of truth");
  });

  it("says nothing-here for a checkout that holds no steering config at all", async () => {
    // A git worktree, or a fresh clone on the machine that does have a deploy tree. Compared
    // literally it is 19 files of "drift" naming an empty worktree as the record of truth — the
    // wrong tree and the wrong finding, over a cause `doctor`'s presence check already fails on.
    await writeFile(join(deploy, "translation", "glossary.json"), `[{"term":"Mantle"}]`);
    const s = deploySteeringStatus(here, asTree(deploy));
    expect(s.kind).toBe("nothing-here");
    expect(s.diff).toBeUndefined();
    expect(deploySteeringResult(s).status).toBe("ok");
    expect(deploySteeringResult(s).detail).toContain("not applicable");
  });

  it("still compares when this checkout has any steering file at all", async () => {
    // The boundary of the branch above: one file here is a configured checkout, and the deploy
    // tree's other eighteen are then genuinely missing from it.
    await writeFile(join(here, "translation", "glossary.json"), "[]");
    await writeFile(join(deploy, "translation", "glossary.json"), "[]");
    await writeFile(join(deploy, "conversion", "x.md"), "# x");
    const s = deploySteeringStatus(here, asTree(deploy));
    expect(s.kind).not.toBe("nothing-here");
    expect(s.diff?.removed).toEqual(["conversion/x.md"]);
  });

  it("warns rather than comparing nothing when the named deploy tree does not exist", async () => {
    await rm(deploy, { recursive: true, force: true });
    const s = deploySteeringStatus(here, asTree(deploy));
    expect(s.kind).toBe("unreadable");
    expect(s.detail).toBe("no such directory");
  });

  it("passes an unidentified deploy tree straight through with its own words", () => {
    const s = deploySteeringStatus(here, { known: false, detail: `${WATCH_UNIT} is not installed here` });
    expect(s.kind).toBe("no-deploy-tree");
    expect(s.detail).toBe(`${WATCH_UNIT} is not installed here`);
    expect(s.here).toBe(here);
  });
});

describe("deploySteeringResult", () => {
  it("warns on drift, names both trees and says which one is the record of truth", async () => {
    await writeFile(join(here, "translation", "glossary.json"), `[{"term":"Mantle"}]`);
    await writeFile(join(deploy, "translation", "glossary.json"), "[]");
    const r = deploySteeringResult(deploySteeringStatus(here, asTree(deploy)));

    expect(r.name).toBe(DEPLOY_STEERING_CHECK);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("differing: translation/glossary.json");
    expect(r.detail).toContain(`${here}) is the record of truth`);
    expect(r.detail).toContain(`${deploy} (${DEPLOY_DIR_VAR}) is what the schedulers run`);
    expect(r.detail).toContain("deploy/herald-deploy.sh");
  });

  it("never prints a steering value, only the names", async () => {
    // The whole reason this configuration is git-ignored. Both sides carry a distinctive string, so
    // a diff that leaked either side's content — or the sha it was hashed to — would show up here.
    await writeFile(join(here, "translation", "glossary.json"), `[{"target":"NEW-SECRET-TERM"}]`);
    await writeFile(join(deploy, "keys", "sa.json"), `{"private_key":"OLD-SECRET-KEY"}`);
    const r = deploySteeringResult(deploySteeringStatus(here, asTree(deploy)));

    expect(r.detail).toContain("translation/glossary.json");
    expect(r.detail).toContain("keys/sa.json");
    expect(r.detail).not.toContain("NEW-SECRET-TERM");
    expect(r.detail).not.toContain("OLD-SECRET-KEY");
  });

  it("caps a long list of names but keeps the count and the remedy", async () => {
    // The never-deployed tree: uncapped, the paths would push the sentence that says what to do off
    // the right of the terminal.
    for (const name of ["a", "b", "c", "d", "e", "f"]) {
      await writeFile(join(here, "conversion", `${name}.md`), `# ${name}`);
    }
    const r = deploySteeringResult(deploySteeringStatus(here, asTree(deploy)));
    expect(r.detail).toContain("6 of 6 steering file(s) differ");
    expect(r.detail).toContain("+2 more");
    expect(r.detail).not.toContain("conversion/f.md");
    expect(r.detail).toContain("deploy/herald-deploy.sh");
  });

  it("names the systemd unit when that is where the deploy tree came from", async () => {
    await writeFile(join(here, "translation", "glossary.json"), "[]");
    const s = deploySteeringStatus(here, { known: true, dir: deploy, source: "unit" });
    expect(deploySteeringResult(s).detail).toContain(`${WATCH_UNIT} WorkingDirectory`);
  });

  it("is ok and explicitly not-applicable when no deploy tree is identified", () => {
    // The state every open-source user, every CI run and every fresh clone is in. A warn here would
    // be carried forever by everyone it does not apply to, which is how a report stops being read.
    const r = deploySteeringResult(
      deploySteeringStatus(here, { known: false, detail: "no systemd on this machine" }),
    );
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("not applicable");
    expect(r.detail).toContain("no systemd on this machine");
    expect(r.detail).toContain(DEPLOY_DIR_VAR);
  });

  it("is ok and says so differently when doctor is running inside the deploy tree", () => {
    // Not "in sync": from in here the development checkout is not identified at all, so agreement
    // was never established — and saying it was is the one wrong answer this state prevents.
    const r = deploySteeringResult(deploySteeringStatus(deploy, asTree(deploy)));
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("this checkout IS the deploy tree");
    expect(r.detail).toContain(deploy);
    expect(r.detail).not.toContain("identical");
  });

  it("warns with the directory it could not read", async () => {
    await rm(deploy, { recursive: true, force: true });
    const r = deploySteeringResult(deploySteeringStatus(here, asTree(deploy)));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain(deploy);
    expect(r.detail).toContain("no such directory");
  });

  it("is ok when the trees agree, and says how many files that verdict covers", async () => {
    // "0 differences" between two empty trees is not the same finding as agreement on 19 files, and
    // an operator who reads ✓ without the count cannot tell which one they were handed.
    for (const dir of [here, deploy]) await writeFile(join(dir, "translation", "glossary.json"), "[]");
    const r = deploySteeringResult(deploySteeringStatus(here, asTree(deploy)));
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("1 file(s) identical in the deploy tree");
    expect(r.detail).toContain(deploy);
  });
});
