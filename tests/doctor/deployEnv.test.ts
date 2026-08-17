import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployEnvStatus, deployEnvResult, DEPLOY_ENV_CHECK } from "../../src/doctor/deployEnv";
import type { DeployTree } from "../../src/doctor/deploySteering";

/**
 * The `.env` half of the sync `Steering deploy sync` already reports for steering files, and it
 * exists for the same reason: `deploy/herald-deploy.sh` copies this checkout's `.env` into the
 * deploy tree, and only that script ever moves it. Rotate a credential here without redeploying and
 * the scheduler keeps using the old one — no error, no alert, just timers authenticating with a
 * value nobody believes is still in use.
 *
 * Names, never values. `diffEnv` (the deploy gate's own function) is what produces them, so the two
 * cannot disagree about what counts as a change.
 */
function tree(dir: string): DeployTree {
  return { known: true, dir, source: "unit" };
}

function scratch(): { here: string; there: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "herald-deploy-env-"));
  const here = join(root, "dev");
  const there = join(root, "app");
  mkdirSync(here);
  mkdirSync(there);
  return { here, there, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("deployEnvStatus", () => {
  it("is in sync when both trees hold the same assignments", () => {
    const { here, there, cleanup } = scratch();
    try {
      writeFileSync(join(here, ".env"), "TWITTERAPI_IO_KEY=abc\nLARK_APP_ID=xyz\n");
      writeFileSync(join(there, ".env"), "TWITTERAPI_IO_KEY=abc\nLARK_APP_ID=xyz\n");

      const status = deployEnvStatus(here, tree(there));

      expect(status.kind).toBe("in-sync");
      expect(status.compared).toBe(2);
      expect(deployEnvResult(status).status).toBe("ok");
    } finally {
      cleanup();
    }
  });

  it("reports a rotated credential as drift, by name and never by value", () => {
    const { here, there, cleanup } = scratch();
    try {
      writeFileSync(join(here, ".env"), "TWITTERAPI_IO_KEY=rotated-new-secret\n");
      writeFileSync(join(there, ".env"), "TWITTERAPI_IO_KEY=stale-old-secret\n");

      const status = deployEnvStatus(here, tree(there));
      const result = deployEnvResult(status);

      expect(status.kind).toBe("drifted");
      expect(status.diff?.changed).toEqual(["TWITTERAPI_IO_KEY"]);
      expect(result.status).toBe("warn");
      expect(result.detail).toContain("TWITTERAPI_IO_KEY");
      expect(result.detail).not.toContain("rotated-new-secret");
      expect(result.detail).not.toContain("stale-old-secret");
    } finally {
      cleanup();
    }
  });

  it("reports a variable this checkout has and the scheduler does not", () => {
    const { here, there, cleanup } = scratch();
    try {
      writeFileSync(join(here, ".env"), "TWITTERAPI_IO_KEY=abc\nTELEGRAM_CHAT_ID_OPS=-100\n");
      writeFileSync(join(there, ".env"), "TWITTERAPI_IO_KEY=abc\n");

      const status = deployEnvStatus(here, tree(there));

      expect(status.kind).toBe("drifted");
      expect(status.diff?.added).toEqual(["TELEGRAM_CHAT_ID_OPS"]);
      expect(deployEnvResult(status).status).toBe("warn");
    } finally {
      cleanup();
    }
  });

  /**
   * The same asymmetry `Steering deploy sync` grants: a value left only in the deploy tree is not
   * something the scheduler reads and this checkout forgot, it is something the *next* deploy
   * sweeps. Reporting it would put a warn on a state that resolves itself, which is how a check
   * teaches people to ignore it.
   */
  it("does not warn about a variable only the deploy tree still has", () => {
    const { here, there, cleanup } = scratch();
    try {
      writeFileSync(join(here, ".env"), "TWITTERAPI_IO_KEY=abc\n");
      writeFileSync(join(there, ".env"), "TWITTERAPI_IO_KEY=abc\nRETIRED_KEY=old\n");

      const status = deployEnvStatus(here, tree(there));
      const result = deployEnvResult(status);

      expect(status.kind).toBe("stale-in-deploy");
      expect(result.status).toBe("ok");
      expect(result.detail).toContain("RETIRED_KEY");
    } finally {
      cleanup();
    }
  });

  it("says the scheduler has no .env at all rather than calling that a diff", () => {
    const { here, there, cleanup } = scratch();
    try {
      writeFileSync(join(here, ".env"), "TWITTERAPI_IO_KEY=abc\n");

      const status = deployEnvStatus(here, tree(there));
      const result = deployEnvResult(status);

      expect(status.kind).toBe("missing-in-deploy");
      // Every timer reads it, so this is not a preference the way steering drift is.
      expect(result.status).toBe("fail");
    } finally {
      cleanup();
    }
  });

  it("is not applicable when no deploy tree could be found", () => {
    const { here, cleanup } = scratch();
    try {
      const status = deployEnvStatus(here, { known: false, detail: "no systemd on this machine" });
      const result = deployEnvResult(status);

      expect(status.kind).toBe("no-deploy-tree");
      expect(result.status).toBe("ok");
      expect(result.detail).toContain("not applicable");
    } finally {
      cleanup();
    }
  });

  it("refuses to compare a tree with itself", () => {
    const { here, cleanup } = scratch();
    try {
      writeFileSync(join(here, ".env"), "TWITTERAPI_IO_KEY=abc\n");

      const status = deployEnvStatus(here, tree(here));

      expect(status.kind).toBe("same-tree");
      expect(deployEnvResult(status).status).toBe("ok");
    } finally {
      cleanup();
    }
  });

  it("names itself the same way doctor prints it", () => {
    expect(DEPLOY_ENV_CHECK).toBe(".env deploy sync");
  });
});
