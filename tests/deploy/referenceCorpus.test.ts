// tests/deploy/referenceCorpus.test.ts
//
// The reference corpus is the only input `pnpm glossary:mine` cross-validates against, and it is the
// only thing the deploy moves that does NOT land inside the deploy checkout. Both halves of that
// sentence are failure modes this file exists to hold:
//
//   - It reached the scheduler by nobody. `collect:reference` is manual and gets run in the
//     development checkout, where OUTPUT_DIR is `<repo>/output`; the units run with
//     `HERALD_OUTPUT_DIR=%h/.herald/output`. On the first real fire of herald-translate-check.service
//     the corpus was simply absent, cross-validation was blind, and every candidate was capped at
//     tier B (`tierFor`) — a silent degradation indistinguishable from a quiet week.
//   - The destination does not follow from `$APP_DIR`. Every other thing herald-deploy.sh copies is
//     REPO_ROOT-relative, so `%h/.herald/app/<same path>` is the answer; this one is
//     OUTPUT_DIR-relative and lands outside that tree entirely. A hardcoded destination that drifts
//     from the units' own `Environment=HERALD_OUTPUT_DIR` is a deploy that fills a directory nothing
//     reads and reports success — the same shape workingDirectory.test.ts pins for `WorkingDirectory=`.
//
// The script is run for real against temp directories, the way runLogging.test.ts and
// notifyFailure.test.ts drive their scripts: "a missing corpus must not fail the deploy" is a
// behaviour, and a text assertion cannot check it.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { paths } from "../../src/paths";

const repoRoot = resolve(__dirname, "../..");
const deployDir = join(repoRoot, "deploy");
const COPY_SCRIPT = join(deployDir, "herald-copy-corpus.sh");

const deployScript = readFileSync(join(deployDir, "herald-deploy.sh"), "utf8");
const copyScript = readFileSync(COPY_SCRIPT, "utf8");

// Real tweet text, so the "names only" assertion below has something that must NOT appear on stdout.
const ITEMS_JSON = JSON.stringify([
  { rootId: "1", status: "active", tweets: [{ id: "1", createdAt: "2026-08-01T00:00:00.000Z", text: "맨틀 RWA 거래가 이어졌습니다" }] },
]);
const RUNS_JSON = JSON.stringify([{ covered: { from: "2026-06-01T00:00:00.000Z", to: "2026-08-11T04:00:59.000Z" } }]);
const STATE_JSON = JSON.stringify({ watermarks: { "0xMantleKR": "2026-08-11T04:00:59.000Z" } });

let work: string;
let devOut: string;
let appOut: string;

const devReference = (): string => join(devOut, "x", "reference");
const appReference = (): string => join(appOut, "x", "reference");

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function runCopy(...args: string[]): Run {
  const result = spawnSync("bash", [COPY_SCRIPT, ...args], { encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** A development artifact tree holding a full corpus plus the `tm:pair` artifacts that share its directory. */
async function seedDev(files: Record<string, string>): Promise<void> {
  await mkdir(devReference(), { recursive: true });
  for (const [name, body] of Object.entries(files)) await writeFile(join(devReference(), name), body);
}

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "herald-corpus-test-"));
  devOut = join(work, "dev-output");
  appOut = join(work, "app-output");
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("herald-copy-corpus.sh carries the corpus the scheduler reads", () => {
  it("copies everything collect:reference writes, into the scheduler's own artifact tree", async () => {
    await seedDev({ "items.json": ITEMS_JSON, "runs.json": RUNS_JSON, "state.json": STATE_JSON });
    const run = runCopy(devOut, appOut);

    expect(run.status, run.stderr).toBe(0);
    expect(await readFile(join(appReference(), "items.json"), "utf8")).toBe(ITEMS_JSON);
    // runs.json is not optional decoration: without the coverage ledger `gradeCorpus` returns
    // `undated`, which caps every candidate at tier B — the same silent failure as having no corpus
    // at all, reached a different way. Copying items alone would "work" and fix nothing.
    expect(await readFile(join(appReference(), "runs.json"), "utf8")).toBe(RUNS_JSON);
    expect(await readFile(join(appReference(), "state.json"), "utf8")).toBe(STATE_JSON);
    expect(run.stdout).toContain(appReference());
  });

  it("leaves the tm:pair review artifacts behind", async () => {
    // They live in the same directory and are the same shape, but nothing the scheduler runs reads
    // them: a human reads `pairs-review.md` and `tm:promote` folds the accepted rows into
    // `translation/tm.json`, which the steering freeze already carries. Shipping them would repeat
    // the mistake `deploy:freeze` corrected when it stopped freezing `db:export`'s few-shot files.
    await seedDev({
      "items.json": ITEMS_JSON,
      "runs.json": RUNS_JSON,
      "pairs-proposed.json": "[]",
      "pairs-review.md": "# pairs",
    });
    const run = runCopy(devOut, appOut);

    expect(run.status).toBe(0);
    expect(await readdir(appReference())).toEqual(["items.json", "runs.json"]);
  });

  it("reports and continues when the development checkout has no corpus at all", async () => {
    // The ordinary state of a fresh machine, and the one thing this step must never do is abort a
    // deploy whose code has already moved — herald-deploy.sh's header calls that worse than none.
    const run = runCopy(devOut, appOut);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("corpus:");
    expect(run.stdout).toContain(devReference());
    // Says what it costs, so the line is actionable rather than merely present.
    expect(run.stdout).toMatch(/tier B|grade every candidate B/);
  });

  it("copies what is there when only part of the set exists", async () => {
    // `state.json` is legitimately absent whenever every `collect:reference` run so far passed
    // `--since` or `--limit` — `CollectAuthoredContent` only advances a watermark on an unqualified
    // run — which is exactly the state the development checkout was in on 2026-08-11.
    await seedDev({ "items.json": ITEMS_JSON, "runs.json": RUNS_JSON });
    const run = runCopy(devOut, appOut);

    expect(run.status).toBe(0);
    expect(await readdir(appReference())).toEqual(["items.json", "runs.json"]);
    expect(run.stdout).toContain("state.json");
  });

  it("never deletes a deployed file because the development one is gone", async () => {
    // The deliberate difference from `deploy:freeze`, which sweeps a deploy-side file whose
    // development counterpart has been removed. Deleting a steering file is a decision; clearing your
    // own `output/` is housekeeping, and dropping the scheduler's coverage ledger over it would put
    // the corpus in the `undated` state and cap every grade at B until somebody re-collected.
    //
    // The development side deliberately still HAS a corpus here — a script that only skips the sweep
    // on the empty-development early return would pass a version of this test that seeded nothing.
    await seedDev({ "items.json": ITEMS_JSON });
    await mkdir(appReference(), { recursive: true });
    await writeFile(join(appReference(), "items.json"), "[]");
    await writeFile(join(appReference(), "runs.json"), RUNS_JSON);
    const run = runCopy(devOut, appOut);

    expect(run.status).toBe(0);
    expect(await readdir(appReference())).toEqual(["items.json", "runs.json"]);
    expect(await readFile(join(appReference(), "items.json"), "utf8")).toBe(ITEMS_JSON); // replaced
    expect(await readFile(join(appReference(), "runs.json"), "utf8")).toBe(RUNS_JSON); // kept
  });

  it("keeps a deployed corpus when the development checkout has none at all", async () => {
    // The other direction of the same rule, and the state a machine is in the day someone deletes
    // their local `output/`: nothing to copy must never mean "remove what is deployed".
    await mkdir(appReference(), { recursive: true });
    await writeFile(join(appReference(), "items.json"), ITEMS_JSON);
    const run = runCopy(devOut, appOut);

    expect(run.status).toBe(0);
    expect(await readdir(appReference())).toEqual(["items.json"]);
  });

  it("prints names, never contents", async () => {
    // The same discipline the freeze gate follows. The corpus is public tweets rather than a secret,
    // so this is about a deploy log staying readable — but the rule is worth holding structurally
    // rather than by habit, since the next thing copied here may not be public.
    await seedDev({ "items.json": ITEMS_JSON, "runs.json": RUNS_JSON });
    const run = runCopy(devOut, appOut);

    expect(run.stdout + run.stderr).not.toContain("맨틀 RWA 거래가 이어졌습니다");
    expect(run.stdout).toContain("items.json");
  });

  it("leaves no half-written file and no temp file behind", async () => {
    // Written to a temp name and renamed, because a weekly fire landing mid-copy must read either the
    // whole old corpus or the whole new one — never half a JSON document.
    await seedDev({ "items.json": ITEMS_JSON, "runs.json": RUNS_JSON, "state.json": STATE_JSON });
    runCopy(devOut, appOut);

    expect((await readdir(appReference())).filter((n) => n.includes(".deploy-"))).toEqual([]);
  });

  it("refuses a call with no directories rather than guessing", async () => {
    // A wiring mistake in herald-deploy.sh, not one of the runtime conditions above — and the one
    // case that SHOULD stop the deploy. EX_USAGE, the same code herald-run-logged.sh uses, so it is
    // distinguishable from every condition the script absorbs.
    expect(runCopy().status).toBe(64);
    expect(runCopy(devOut).status).toBe(64);
  });
});

describe("herald-deploy.sh runs the corpus step, into the directory the units read", () => {
  /** An executable line, never a comment — the same rule (and reason) as heraldDeploy.test.ts. */
  const lineOf = (needle: string): number => {
    const lines = deployScript.split("\n");
    const i = lines.findIndex((l) => {
      const trimmed = l.trim();
      return trimmed !== "" && !trimmed.startsWith("#") && l.includes(needle);
    });
    expect(i, `not found in an executable line of herald-deploy.sh: ${needle}`).toBeGreaterThan(-1);
    return i;
  };

  it("invokes the copy script as its own step", () => {
    expect(lineOf("herald-copy-corpus.sh")).toBeGreaterThan(
      lineOf('pnpm deploy:freeze --apply --dev "$DEV_DIR" --app "$APP_DIR"'),
    );
    expect(lineOf("herald-copy-corpus.sh")).toBeLessThan(lineOf('cd "$APP_DIR" && pnpm db:migrate'));
  });

  it("names the same artifact root every scheduled unit sets HERALD_OUTPUT_DIR to", () => {
    // Two files, one decision — the coupling workingDirectory.test.ts pins between the units'
    // `WorkingDirectory=` and `APP_DIR`. If these drift, the deploy writes a corpus into a directory
    // no timer ever reads and says "corpus: items.json runs.json →" about it.
    const appOutputDir = /^APP_OUTPUT_DIR="([^"]+)"$/m.exec(deployScript)?.[1];
    expect(appOutputDir).toBe("$HOME/.herald/output");

    const units = readdirSync(deployDir)
      .filter((f) => f.endsWith(".timer"))
      .map((f) => f.replace(/\.timer$/, ".service"))
      .filter((f) => existsSync(join(deployDir, f)));
    expect(units.length, "no scheduled units found — this check would pass vacuously").toBeGreaterThan(1);

    let compared = 0;
    for (const unit of units) {
      const text = readFileSync(join(deployDir, unit), "utf8");
      const outputDir = /^Environment=HERALD_OUTPUT_DIR=(.+)$/m.exec(text)?.[1]?.trim();
      // Not every unit sets it — herald-creds.service reads no artifacts. The ones that do must agree.
      if (outputDir === undefined) continue;
      expect(outputDir.replace("%h", "$HOME"), `${unit} disagrees with APP_OUTPUT_DIR`).toBe(appOutputDir);
      compared += 1;
    }
    // herald-translate-check.service is the unit that runs `glossary:mine`; if no unit set the
    // variable at all, the loop above would have compared nothing and passed.
    expect(compared, "no unit sets HERALD_OUTPUT_DIR — nothing was compared").toBeGreaterThan(0);
  });

  it("reads the corpus out of the development checkout's own artifact tree", () => {
    // `<repo>/output`, because that is where `src/paths.ts` puts OUTPUT_DIR when HERALD_OUTPUT_DIR is
    // unset — which is every hand-run `pnpm collect:reference`, the only thing that writes a corpus.
    expect(/^DEV_OUTPUT_DIR="([^"]+)"$/m.exec(deployScript)?.[1]).toBe("$DEV_DIR/output");
  });

  it("does not point the scheduler at the development tree instead of copying", () => {
    // The 2026-08-07 (code) and 2026-08-09 (config) incidents, in their corpus form. A symlink or an
    // `HERALD_OUTPUT_DIR` pointed at the development checkout would "fix" the miner and re-open both.
    expect(copyScript).not.toContain("ln -s");
    for (const unit of readdirSync(deployDir).filter((f) => f.endsWith(".service"))) {
      const text = readFileSync(join(deployDir, unit), "utf8");
      const outputDir = /^Environment=HERALD_OUTPUT_DIR=(.+)$/m.exec(text)?.[1]?.trim();
      if (outputDir === undefined) continue;
      expect(outputDir.startsWith("%h/.herald/"), `${unit} reads artifacts from outside %h/.herald`).toBe(true);
    }
  });
});

describe("the copied set is what collect:reference writes", () => {
  /** The `CORPUS_FILES="…"` list the script iterates. */
  const corpusFiles = (/^CORPUS_FILES="([^"]+)"$/m.exec(copyScript)?.[1] ?? "").split(/\s+/).filter(Boolean);

  it("carries the corpus and its coverage ledger, both named from src/paths.ts", () => {
    // Derived rather than retyped: these are the two files `glossary:mine` opens
    // (`paths.referenceItems`, `paths.referenceRuns`), so a rename there fails here instead of
    // silently shipping a file nothing reads.
    expect(corpusFiles).toContain(basename(paths.referenceItems));
    expect(corpusFiles).toContain(basename(paths.referenceRuns));
    expect(corpusFiles).toContain("state.json"); // LocalJsonStore's watermark, same collector
  });

  it("carries none of the tm:pair review artifacts that share the directory", () => {
    expect(corpusFiles).not.toContain(basename(paths.referencePairsProposed));
    expect(corpusFiles).not.toContain(basename(paths.referencePairsReview));
  });
});
