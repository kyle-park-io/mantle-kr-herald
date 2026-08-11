// tests/app/createDeps.test.ts
import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { createTestDb } from "../support/testDb";
import { createDeps } from "../../src/app/createDeps";
import { handleApi, type ApiDeps } from "../../src/adapters/web/apiHandlers";
import { PgPublishStore } from "../../src/adapters/store/PgPublishStore";
import { PgTranslateFloorReport } from "../../src/adapters/store/PgTranslateFloorReport";
import { PgCredentialLiveness } from "../../src/adapters/store/PgCredentialLiveness";
import type { Db } from "../../src/adapters/db/Db";
import { VALID_PASSWORD_HASH } from "../support/authFixtures";

/**
 * `createDeps` calls `loadAuthConfig()`/`loadSessionConfig()` — required now that the session gate
 * exists — plus `loadStorageMode()` and `loadDbEnv()` (the `StatusView.dbEnv` label; not
 * `loadDbConfig()`, which additionally wants a `DATABASE_URL` this file's PGlite-backed `db` has no
 * use for — see `createDeps.ts`'s own comment). None of these tests are about that config; they set
 * the minimum env `createDeps` needs to build at all, restoring whatever was there before so this
 * file does not leak state into others run in the same process.
 */
const ENV_KEYS = ["HERALD_AUTH_USERNAME", "HERALD_AUTH_PASSWORD_HASH", "HERALD_SESSION_SECRET", "HERALD_STORAGE_MODE", "HERALD_DB_ENV"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.HERALD_AUTH_USERNAME = "test-user";
  process.env.HERALD_AUTH_PASSWORD_HASH = VALID_PASSWORD_HASH;
  process.env.HERALD_SESSION_SECRET = "test-only-session-secret-do-not-use-in-prod!!!!";
  process.env.HERALD_STORAGE_MODE = "local";
  process.env.HERALD_DB_ENV = "development";
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** A deps set with a valid session already attached — none of these tests are about the gate. */
function authenticated(deps: ApiDeps): ApiDeps {
  return { ...deps, session: { issuedAt: new Date().toISOString() } };
}

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

describe("createDeps", () => {
  it("builds a dependency set the API can serve from", async () => {
    db = await createTestDb();
    const deps = createDeps({ db, routes: "local" });
    const result = await handleApi(authenticated(deps), "GET", "/api/translations", undefined);
    expect(result.status).toBe(200);
  });

  /**
   * The whole point of 되돌리기 is that `postedUrl` survives it — that is what stops the next
   * unattended `x:reconcile` tick from re-retiring an item a human just disputed (see
   * `RetireTranslation`'s own doc comment). `tests/adapters/web/apiHandlers.test.ts`'s equivalent
   * test only proves the ROUTE forwards to `deps.unretireTranslation` correctly: its fake
   * `unretireTranslation` re-implements preservation by hand (`{ ...existing, status: "translated" }`),
   * so it would stay green even if `createDeps.ts`'s real implementation stopped preserving
   * `postedUrl` entirely. This test drives the real `createDeps`-built `unretireTranslation` — real
   * `SaveTranslation`, real `PgTranslationStore` over PGlite — so a regression in that specific
   * implementation choice (not just in the route wiring) actually fails a test.
   */
  it("되돌리기 (unretire) keeps postedUrl — the real write path, not a test double", async () => {
    db = await createTestDb();
    const deps = createDeps({ db, routes: "local" });
    await deps.translationStore.upsert({
      itemId: "x:1",
      source: "x",
      sourceText: "s",
      koreanText: "k",
      status: "posted",
      translatedAt: "t",
      postedUrl: "https://x.com/0xMantleKR/status/1",
      postedAt: "2026-08-06T00:00:00.000Z",
    });

    const res = await handleApi(authenticated(deps), "POST", "/api/translations/x:1/unretire", undefined);

    expect(res.status).toBe(200);
    const row = (await deps.translationStore.loadAll()).find((t) => t.itemId === "x:1");
    expect(row?.status).toBe("translated");
    expect(row?.postedUrl).toBe("https://x.com/0xMantleKR/status/1");
  });

  /**
   * Final review, Important 2. `loadPublishState` computes each ledger row's `synced` flag, and the
   * dashboard turns `synced === false` into "재발행 필요" plus the "발행을 다시 눌러 갱신하세요" notice.
   * A translation that was approved, published to `approved/`, and then retired by reconcile keeps a
   * ledger row at status `approved` while the item itself reads `posted` — so the plain
   * `e.status === t.status` comparison called it stale forever, and following the instruction it
   * produced uploaded the item to `review/` and deleted the approved doc. This drives the real
   * `createDeps`-built closure (real `PgPublishStore`/`PgTranslationStore` over PGlite) because the
   * comparison lives in that closure and nowhere else — a fake would just re-implement it.
   */
  describe("loadPublishState and a retired item", () => {
    const row = { itemId: "x:1", stage: "translation" as const, status: "approved", target: "google", fileName: "f.md", remoteId: "g-1", contentHash: "hash-of-the-published-bytes", uploadedAt: "2026-08-06T00:00:00.000Z" };
    const item = { itemId: "x:1", source: "x" as const, sourceText: "s", koreanText: "k", status: "approved" as const, translatedAt: "t" };

    it("reports a `posted` item's row as synced, not as needing republish", async () => {
      db = await createTestDb();
      const deps = createDeps({ db, routes: "local" });
      await new PgPublishStore(db).record(row);
      await deps.translationStore.upsert({ ...item, status: "posted", postedUrl: "https://x.com/0xMantleKR/status/1", postedAt: "2026-08-06T00:00:00.000Z" });

      const state = await deps.loadPublishState();
      expect(state).toHaveLength(1);
      expect(state[0].synced).toBe(true);
    });

    it("still reports a stale APPROVED item's row as needing republish", async () => {
      // The scope check. `contentHash` above is a literal that cannot match the current render, so
      // this row is genuinely stale — the case where pressing 발행 IS the fix, and which a blanket
      // "always synced" would have swallowed along with the posted one.
      db = await createTestDb();
      const deps = createDeps({ db, routes: "local" });
      await new PgPublishStore(db).record(row);
      await deps.translationStore.upsert(item);

      const state = await deps.loadPublishState();
      expect(state).toHaveLength(1);
      expect(state[0].synced).toBe(false);
    });
  });

  it("registers convert-prepare locally", async () => {
    db = await createTestDb();
    const deps = createDeps({ db, routes: "local" });
    const result = await handleApi(authenticated(deps), "POST", "/api/items/x:1/convert-prepare", { types: ["announcement"] });
    expect(result.status).not.toBe(404);
  });

  it("does not register convert-prepare on the hosted route set — the local agent is not there", async () => {
    db = await createTestDb();
    const deps = createDeps({ db, routes: "hosted" });
    const result = await handleApi(authenticated(deps), "POST", "/api/items/x:1/convert-prepare", { types: ["announcement"] });
    expect(result.status).toBe(404);
  });

  it("still serves every other write route on the hosted route set", async () => {
    db = await createTestDb();
    const deps = createDeps({ db, routes: "hosted" });
    // `POST /api/translations/x:1/approve` 404s on a translation store that has never heard of
    // "x:1" — `handleApi`'s own "not found" branch, nothing to do with the route set. Seeding one
    // is what isolates this test's actual question (is the route reachable at all?) from that
    // unrelated data question; the fresh `db` from `createTestDb()` starts with neither.
    await deps.translationStore.upsert({ itemId: "x:1", source: "x", sourceText: "s", koreanText: "k", status: "translated", translatedAt: "t" });
    for (const [method, path] of [
      ["POST", "/api/translations/x:1/approve"],
      ["POST", "/api/items/x:1/format"],
      ["POST", "/api/outlets/x:1/announcement/tg-community/send"],
    ] as const) {
      expect((await handleApi(authenticated(deps), method, path, {})).status).not.toBe(404);
    }
  });

  /**
   * Sends are a separate axis from the route set (`HERALD_SENDS_ENABLED`, `config.ts`), not folded
   * into `routes: "local" | "hosted"` — see `createDeps.ts`'s own comment on `sendsEnabled`. These
   * pin the two behaviours the flag actually has to produce: the local entry point always sends,
   * unaffected; the hosted one is closed until the flag is explicitly turned on.
   */
  describe("the send flag (HERALD_SENDS_ENABLED)", () => {
    const SEND_KEY = "HERALD_SENDS_ENABLED" as const;
    let savedSendFlag: string | undefined;

    beforeEach(() => {
      savedSendFlag = process.env[SEND_KEY];
      delete process.env[SEND_KEY];
    });
    afterEach(() => {
      if (savedSendFlag === undefined) delete process.env[SEND_KEY];
      else process.env[SEND_KEY] = savedSendFlag;
    });

    it("sendToOutlet is present on the local route set even with the flag unset", async () => {
      db = await createTestDb();
      const deps = createDeps({ db, routes: "local" });
      expect(deps.sendToOutlet).toBeDefined();
      expect((await deps.loadStatus()).sendsEnabled).toBe(true);
    });

    it("sendToOutlet is absent on the hosted route set by default (flag unset)", async () => {
      db = await createTestDb();
      const deps = createDeps({ db, routes: "hosted" });
      expect(deps.sendToOutlet).toBeUndefined();
      expect((await deps.loadStatus()).sendsEnabled).toBe(false);
      await deps.translationStore.upsert({ itemId: "x:1", source: "x", sourceText: "s", koreanText: "k", status: "translated", translatedAt: "t" });
      const res = await handleApi(authenticated(deps), "POST", "/api/outlets/x:1/announcement/tg-community/send", {});
      expect(res.status).toBe(400);
      expect((res.json as { error: string }).error).toContain("발송이 아직 열려 있지 않습니다");
    });

    it("sendToOutlet is present on the hosted route set once the flag is true", async () => {
      process.env[SEND_KEY] = "true";
      db = await createTestDb();
      const deps = createDeps({ db, routes: "hosted" });
      expect(deps.sendToOutlet).toBeDefined();
      expect((await deps.loadStatus()).sendsEnabled).toBe(true);
    });
  });

  /**
   * The `local` publish target, which is a property of the entry point rather than of the storage
   * mode — see `createDeps.ts`'s `localPublishEnabled`. On the hosted deployment the target resolves
   * to a `LocalFileUploader` writing under `/var/task/output/publish/local/` (read-only), and the one
   * route that could read those files back (`GET /api/publish/local/*`) is served outside `handleApi`
   * and so does not exist there at all.
   *
   * Both halves are pinned separately, and the local half is the one that must not move: publishing
   * to the filesystem is the documented, intended behaviour of `pnpm serve` and `pnpm drive:publish`
   * (`src/cli/publish.ts`: "in local mode publishing is not skipped, it targets the filesystem").
   */
  describe("the local publish target", () => {
    const MODE_KEY = "HERALD_STORAGE_MODE" as const;
    let savedMode: string | undefined;

    beforeEach(() => {
      savedMode = process.env[MODE_KEY];
    });
    afterEach(() => {
      if (savedMode === undefined) delete process.env[MODE_KEY];
      else process.env[MODE_KEY] = savedMode;
    });

    it("is offered on the local route set, and publishing to it is accepted", async () => {
      db = await createTestDb();
      const deps = createDeps({ db, routes: "local" });
      expect((await deps.loadStatus()).availableTargets).toContain("local");
      // An itemId no translation has: `PublishTranslations.run` filters to it, finds nothing, and
      // returns an all-zero result WITHOUT writing a byte — which is the only way to drive the real
      // closure here without a real markdown file landing in the developer's own
      // `output/publish/local/`. `paths.OUTPUT_DIR` is fixed when `paths.ts` is imported, so
      // `HERALD_OUTPUT_DIR` cannot be redirected from inside a test to make a real publish safe. What
      // this still pins is the only thing this change could break locally: the target is not refused.
      await expect(deps.publishOne("x:not-in-the-store", "local")).resolves.toMatchObject({ failed: 0 });
    });

    it("is withheld from the hosted route set, so the board never offers the button", async () => {
      // The mode the hosted entry point is forced into (`assertCloudStorage`) — and the reason
      // `resolveTargets` cannot be the layer that catches this: in `cloud` mode it passes `local`
      // through, deliberately, because `--target both,local` is a real CLI use.
      process.env[MODE_KEY] = "cloud";
      db = await createTestDb();
      const targets = (await createDeps({ db, routes: "hosted" }).loadStatus()).availableTargets;
      expect(targets).not.toContain("local");
    });

    it("refuses a hosted request that names it anyway, loudly, rather than writing", async () => {
      // The half the withheld button cannot cover — the button is the only caller that reads
      // `availableTargets`, and `POST /api/translations/:id/publish` forwards `body.target` verbatim
      // (`apiHandlers.ts`). A tab left open across the deploy that shipped this, a replayed request,
      // `curl`. It must THROW: both entry points turn an uncaught error into a 500 carrying the
      // message for a signed-in operator, where a refusal shaped as a `PublishResult` would arrive as
      // the same 200 the read-only write already produced — `PublishTranslations` records each
      // uploader's error into `failures` rather than rethrowing, so the board read a publish onto a
      // filesystem that does not exist as an ordinary attempt that did not take.
      //
      // Same unknown itemId as the local test above, and here it does double duty: the refusal must
      // land before `createUploaders` regardless, so a regression fails on `.rejects` rather than by
      // leaving a stray markdown file in whoever ran the suite.
      process.env[MODE_KEY] = "cloud";
      db = await createTestDb();
      const deps = createDeps({ db, routes: "hosted" });
      await expect(deps.publishOne("x:not-in-the-store", "local")).rejects.toThrow(
        /"local" is not available on the hosted deployment/,
      );
      // The scope check: this withholds ONE target, it does not close hosted publishing. A target
      // this gate has no opinion about still fails the way it always did, with `resolveTargets`'
      // own message. `google`/`lark` are not asserted here on purpose — reaching their branch means
      // `createUploaders` reading real credentials, and on a developer machine with the deployment's
      // env exported that is a live outbound call, which an ordinary `vitest run` must never make
      // (the same hazard `credential liveness` below clears `PROBE_ENV_KEYS` for).
      await expect(deps.publishOne("x:not-in-the-store", "dropbox")).rejects.toThrow(/Unknown publish target: dropbox/);
    });
  });

  /**
   * The 수집 card's floor half on the deployment that has no systemd to ask. `routes: "hosted"` skips
   * the `systemctl` probe entirely (spawning one in a Vercel function costs a process to learn
   * nothing), so everything this screen can say about the floor comes from what the scheduler wrote
   * down.
   */
  describe("the scheduler's reported translation floor", () => {
    it("reports the floor the scheduler recorded, on a deployment that cannot ask systemd", async () => {
      db = await createTestDb();
      await new PgTranslateFloorReport(db).write({
        floor: "2026-07-27T14:35:25.000Z",
        at: "2026-08-08T04:17:09.000Z",
      });

      const reach = (await createDeps({ db, routes: "hosted" }).loadStatus()).funnel.collected.breakdown.reach;

      expect(reach.kind).toBe("reported");
      expect(reach.reportedFloor).toBe("2026-07-27T14:35:25.000Z");
      expect(reach.reportedAt).toBe("2026-08-08T04:17:09.000Z");
    });

    it("still says the floor cannot be seen from here when nothing has reported", async () => {
      // The state this screen was stuck in before reports existed, and still the right answer for a
      // database no scheduler has ever ticked against.
      db = await createTestDb();
      const reach = (await createDeps({ db, routes: "hosted" }).loadStatus()).funnel.collected.breakdown.reach;
      expect(reach.kind).toBe("unknown");
    });

    /**
     * The deploy-ordering window this degradation exists for. The hosted entry point does not call
     * `applySchema` (only `serve.ts` does), and Vercel ships on merge while `pnpm db:migrate` runs
     * when someone runs `deploy/herald-deploy.sh` — so new code can meet a Neon that has no
     * `translate_floor_reports` yet. An uncaught `42P01` there would 500 the whole status payload and
     * leave the dashboard with no header at all, which is far worse than one hover card falling back
     * to the honest "cannot be seen from here".
     */
    it("degrades to `unknown` rather than 500ing the whole status payload when the table is missing", async () => {
      db = await createTestDb();
      // The refusal Postgres actually gives for a table that is not there, injected rather than
      // produced by a real `drop table`: the shared PGlite instance behind `createTestDb` truncates
      // every name in `TABLE_NAMES` on release, so a genuinely dropped table would fail the teardown
      // instead of this assertion.
      const missingTable: Db = {
        query: async (sql, params) => {
          if (sql.includes("translate_floor_reports")) {
            throw new Error('relation "translate_floor_reports" does not exist');
          }
          return db!.query(sql, params);
        },
        tx: (fn) => db!.tx(fn),
      };

      const status = await createDeps({ db: missingTable, routes: "hosted" }).loadStatus();

      expect(status.funnel.collected.breakdown.reach.kind).toBe("unknown");
      // The rest of the payload is unaffected — which is the point: the funnel a reviewer reads is
      // derived from tables that are all still there.
      expect(status.funnel.translated).toBeDefined();
      expect(status.sync).toBeDefined();
    });
  });

  describe("credential liveness", () => {
    /**
     * Every env var `buildLiveProbeInput()` (`liveProbes.ts`) can read across the seven probes it
     * builds — cleared for this whole block, the same guard `the send flag` above applies to
     * `HERALD_SENDS_ENABLED`. Without this, a developer who has exported the deployment's own env
     * (`set -a; . .env`) and runs `pnpm test` would have `deps.probeLiveness()` below make up to
     * seven live outbound calls against production credentials — exactly what an ordinary `vitest
     * run` must never do (`vitest.probe.config.ts`'s whole reason to exist as a separate config).
     */
    const PROBE_ENV_KEYS = [
      "GOOGLE_AUTH_MODE",
      "GOOGLE_OAUTH_REFRESH_TOKEN",
      "GOOGLE_OAUTH_CLIENT_ID",
      "GOOGLE_OAUTH_CLIENT_SECRET",
      "GOOGLE_SA_KEY_FILE",
      "GDRIVE_REVIEW_FOLDER_ID",
      "GDRIVE_APPROVED_FOLDER_ID",
      "GSHEET_ID",
      "LARK_APP_ID",
      "LARK_APP_SECRET",
      "TYPEFULLY_API_KEY",
      "TYPEFULLY_SOCIAL_SET_ID",
      "TELEGRAM_BOT_TOKEN",
    ] as const;
    let savedProbeEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      savedProbeEnv = Object.fromEntries(PROBE_ENV_KEYS.map((k) => [k, process.env[k]]));
      for (const k of PROBE_ENV_KEYS) delete process.env[k];
    });
    afterEach(() => {
      for (const k of PROBE_ENV_KEYS) {
        if (savedProbeEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedProbeEnv[k];
      }
    });

    /**
     * A `Db` that answers a real 42P01 for `credential_liveness` and forwards everything else to
     * `real` — NOT a genuine `drop table`. `createTestDb`'s pool truncates every name in
     * `TABLE_NAMES` on release (see that file's own comment), so a real drop here would fail this
     * test's own teardown instead of the assertion below, same as the reason
     * `the scheduler's reported translation floor > degrades to unknown...` above injects rather
     * than drops.
     */
    function missingCredentialLivenessTable(real: Db): Db {
      return {
        query: async (sql, params) => {
          if (sql.includes("credential_liveness")) throw new Error('relation "credential_liveness" does not exist');
          return real.query(sql, params);
        },
        tx: (fn) => real.tx(fn),
      };
    }

    it("records what it just probed, so every caller of the diagnostics route populates the row", async () => {
      db = await createTestDb();
      const deps = createDeps({ db, routes: "local" });
      const probes = await deps.probeLiveness();
      // Pins this describe block's own precondition: with `PROBE_ENV_KEYS` cleared above, every one
      // of the seven probes must come back `skipped` — never a live call — so this test (and every
      // other one below that calls the real `probeLiveness`) cannot silently start spending
      // production credentials if that guard ever stops covering a key `liveProbes.ts` reads.
      expect(probes).toHaveLength(7);
      expect(probes.every((p) => p.status === "skipped")).toBe(true);
      const observation = await new PgCredentialLiveness(db).read();
      expect(observation?.probes.map((p) => p.key)).toContain("google_auth");
      expect(observation?.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("still answers with the probes when recording them throws", async () => {
      // The route exists to answer when things are broken. A diagnostic that fails because it could
      // not write its own answer down is the same mistake as one that 500s because a probe failed,
      // which `diagnosticsRoute.test.ts` already pins against.
      db = await createTestDb();
      const deps = createDeps({ db: missingCredentialLivenessTable(db), routes: "local" });
      await expect(deps.probeLiveness()).resolves.toBeInstanceOf(Array);
    });

    it("returns the probes promptly rather than hanging when the write stalls", async () => {
      // The other axis a bounded write has to cover, and the one `missingCredentialLivenessTable`
      // above cannot exercise: a `Db.query` that never settles at all — a stalled connection (pool
      // exhaustion, a blackholed socket, Neon mid-restart), not one that answers with an error.
      // `LIVENESS_WRITE_TIMEOUT_MS` (`createDeps.ts`) is what stops this from hanging `probeLiveness`
      // — and therefore `GET /api/diagnostics/live` itself — indefinitely.
      db = await createTestDb();
      const stallingDb: Db = { query: () => new Promise<never>(() => {}), tx: (fn) => db!.tx(fn) };
      const deps = createDeps({ db: stallingDb, routes: "local" });
      // `performance.now()`, not `Date.now()` — monotonic, so a wall-clock step mid-test cannot
      // manufacture (or hide) a slow result. See `tests/cli/claudeSpawnKill.test.ts`'s own comment
      // on this exact substitution.
      const startedAt = performance.now();
      const probes = await deps.probeLiveness();
      // The exact number here does not matter — a hang is unbounded, so anything comfortably above
      // the 2s write budget proves the same thing a tighter bound would. What matters is that this
      // stays well short of "hanging": 5s is 2.5x the budget, generous enough not to flake in a
      // fork-contended CI suite, and still an assertion that fails if the bound were ever dropped or
      // made unbounded again.
      expect(performance.now() - startedAt).toBeLessThan(5_000);
      expect(probes.every((p) => p.status === "skipped")).toBe(true);
    });

    it("reports no liveness at all on a database that has never been probed", async () => {
      db = await createTestDb();
      const deps = createDeps({ db, routes: "local" });
      expect((await deps.loadStatus()).liveness).toBeUndefined();
    });

    it("grades a recorded observation into the status payload", async () => {
      db = await createTestDb();
      await new PgCredentialLiveness(db).write({
        observedAt: "2026-08-11T06:23:04.000Z",
        probes: [{ key: "google_auth", status: "dead", detail: "400 invalid_grant" }],
      });
      const deps = createDeps({ db, routes: "local" });
      const status = await deps.loadStatus();
      expect(status.liveness?.worst).toBe("fail");
      expect(status.liveness?.dead[0]).toMatchObject({ key: "google_auth", tier: "publish" });
    });

    it("degrades to no liveness rather than 500ing the header when the table is missing", async () => {
      // The hosted deployment is the one reader that does not apply the schema at startup, so between
      // a Vercel deploy and the next `pnpm db:migrate` this code talks to a database without the
      // table. An uncaught 42P01 there renders no header at all. Same window `readFloorReport` closes.
      db = await createTestDb();
      const deps = createDeps({ db: missingCredentialLivenessTable(db), routes: "local" });
      await expect(deps.loadStatus()).resolves.toMatchObject({ liveness: undefined });
    });
  });
});
