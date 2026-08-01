// tests/app/createDeps.test.ts
import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { createTestDb } from "../support/testDb";
import { createDeps } from "../../src/app/createDeps";
import { handleApi, type ApiDeps } from "../../src/adapters/web/apiHandlers";

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
  process.env.HERALD_AUTH_PASSWORD_HASH = "scrypt$test$test";
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
});
