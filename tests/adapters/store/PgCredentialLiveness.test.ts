// tests/adapters/store/PgCredentialLiveness.test.ts
//
// One row: what the deployment last observed about its own credentials, and when. The board's whole
// claim rests on a round trip preserving both — a status without its instant is a status stated as
// though it had just been checked.
import { describe, it, expect, afterEach } from "vitest";
import { createTestDb } from "../../support/testDb";
import { PgCredentialLiveness } from "../../../src/adapters/store/PgCredentialLiveness";
import type { LivenessObservation } from "../../../src/status/liveness";

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

// Typed against `LivenessObservation` (not `as const`): `write()` takes a mutable `StoredProbe[]`,
// and `as const` would freeze `probes` into a readonly tuple that no longer satisfies that — the
// annotation gets the same literal `"ok"`/`"dead"` status types without that mismatch.
const OBSERVATION: LivenessObservation = {
  observedAt: "2026-08-11T06:23:04.000Z",
  probes: [
    { key: "google_auth", status: "ok", detail: "token refreshed" },
    { key: "telegram", status: "dead", detail: "getMe answered 401" },
  ],
};

describe("PgCredentialLiveness", () => {
  it("reads back exactly what the deployment observed", async () => {
    db = await createTestDb();
    const store = new PgCredentialLiveness(db);
    await store.write(OBSERVATION);
    expect(await store.read()).toEqual(OBSERVATION);
  });

  it("has no observation at all until something probes", async () => {
    // `undefined`, not an empty report: "nothing has ever looked" and "everything answered" are
    // different facts, and the badge shows nothing for the first while showing green for the second.
    db = await createTestDb();
    expect(await new PgCredentialLiveness(db).read()).toBeUndefined();
  });

  it("keeps one row, replacing it — never a growing log", async () => {
    db = await createTestDb();
    const store = new PgCredentialLiveness(db);
    await store.write({ ...OBSERVATION, observedAt: "2026-08-10T06:23:04.000Z" });
    await store.write(OBSERVATION);
    expect((await store.read())?.observedAt).toBe(OBSERVATION.observedAt);
    const rows = await db.query<{ n: string }>("select count(*) as n from credential_liveness");
    expect(Number(rows[0].n)).toBe(1);
  });

  it("reads a malformed payload as no observation rather than throwing", async () => {
    // The status route calls this on every board load. A row this code cannot parse — hand-edited,
    // or written by a build whose shape has since changed — must degrade to "nothing has looked",
    // never take the header down.
    db = await createTestDb();
    await db.query(
      `insert into credential_liveness (id, probes, observed_at) values ('singleton', $1, $2)`,
      ["{not json", "2026-08-11T06:23:04.000Z"],
    );
    expect(await new PgCredentialLiveness(db).read()).toBeUndefined();
  });

  it("reads a payload that parses but is not a probe array as no observation", async () => {
    db = await createTestDb();
    await db.query(
      `insert into credential_liveness (id, probes, observed_at) values ('singleton', $1, $2)`,
      [JSON.stringify({ google_auth: "ok" }), "2026-08-11T06:23:04.000Z"],
    );
    expect(await new PgCredentialLiveness(db).read()).toBeUndefined();
  });

  it("stores the instant as the exact bytes it was given", async () => {
    db = await createTestDb();
    await new PgCredentialLiveness(db).write({ ...OBSERVATION, observedAt: "2026-08-11T06:23:04.123Z" });
    const rows = await db.query<{ observed_at: string }>("select observed_at from credential_liveness");
    expect(rows[0].observed_at).toBe("2026-08-11T06:23:04.123Z");
  });
});
