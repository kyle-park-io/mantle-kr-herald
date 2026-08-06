// tests/app/createDeps.test.ts
import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { createTestDb } from "../support/testDb";
import { createDeps } from "../../src/app/createDeps";
import { handleApi, type ApiDeps } from "../../src/adapters/web/apiHandlers";
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
});
