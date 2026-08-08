// tests/adapters/store/PgTranslateFloorReport.test.ts
//
// The one row the watch tick writes and the dashboard reads. Everything the card renders rests on
// two distinctions surviving a round trip through Postgres: "reported with no floor" vs "never
// reported", and the instant that turns a value into an observation with an age.
import { describe, it, expect, afterEach } from "vitest";
import { createTestDb } from "../../support/testDb";
import { PgTranslateFloorReport } from "../../../src/adapters/store/PgTranslateFloorReport";

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

describe("PgTranslateFloorReport", () => {
  it("reads back exactly what the tick reported", async () => {
    db = await createTestDb();
    const reports = new PgTranslateFloorReport(db);
    await reports.write({ floor: "2026-07-27T14:35:25.000Z", at: "2026-08-08T04:17:09.000Z" });
    expect(await reports.read()).toEqual({ floor: "2026-07-27T14:35:25.000Z", at: "2026-08-08T04:17:09.000Z" });
  });

  it("has no report at all until a tick writes one", async () => {
    // Not an empty report, and not a zero floor: `undefined` is what makes `collectedReach` fall
    // through to `unknown` — "this screen cannot see the scheduler" — which is the truth on a
    // database that predates the scheduler's first tick.
    db = await createTestDb();
    expect(await new PgTranslateFloorReport(db).read()).toBeUndefined();
  });

  it("keeps a tick that ran with NO floor distinct from never having reported", async () => {
    // The two facts the null column exists for. One means the scheduler is draining the whole
    // backlog oldest first (an alarm); the other means nothing is known (not an alarm). A store that
    // returned `undefined` for both would render the alarm as an absence of information.
    db = await createTestDb();
    const reports = new PgTranslateFloorReport(db);
    await reports.write({ at: "2026-08-08T04:17:09.000Z" });
    const report = await reports.read();
    expect(report).toEqual({ at: "2026-08-08T04:17:09.000Z" });
    expect(report).toBeDefined();
    expect(report?.floor).toBeUndefined();
  });

  it("keeps one row, replacing it — never a growing log", async () => {
    // Twelve ticks a day, forever. An append here would be a second event log beside `lineage`,
    // and the question a reader actually has ("what floor, how long ago?") only ever needs the last
    // answer.
    db = await createTestDb();
    const reports = new PgTranslateFloorReport(db);
    await reports.write({ floor: "2026-06-01T00:00:00.000Z", at: "2026-08-08T02:17:09.000Z" });
    await reports.write({ floor: "2026-07-27T14:35:25.000Z", at: "2026-08-08T04:17:09.000Z" });
    await reports.write({ floor: "2026-07-27T14:35:25.000Z", at: "2026-08-08T06:17:09.000Z" });

    expect(await reports.read()).toEqual({ floor: "2026-07-27T14:35:25.000Z", at: "2026-08-08T06:17:09.000Z" });
    const rows = await db.query<{ n: string }>("select count(*) as n from translate_floor_reports");
    expect(Number(rows[0].n)).toBe(1);
  });

  it("clears a floor when a later tick runs without one", async () => {
    // The upsert has to overwrite `floor` with null, not leave the previous value standing: a stale
    // floor beside a fresh timestamp is the single most misleading row this table could hold — it
    // would report a scheduler as correctly bounded at the exact moment it stopped being.
    db = await createTestDb();
    const reports = new PgTranslateFloorReport(db);
    await reports.write({ floor: "2026-07-27T14:35:25.000Z", at: "2026-08-08T04:17:09.000Z" });
    await reports.write({ at: "2026-08-08T06:17:09.000Z" });
    expect(await reports.read()).toEqual({ at: "2026-08-08T06:17:09.000Z" });
  });

  it("stores the instant as the exact bytes it was given", async () => {
    // Timestamps are `text` throughout this schema for this reason: `timestamptz` would not
    // reproduce the ISO string the domain carries, and the card's age arithmetic parses what it is
    // handed.
    db = await createTestDb();
    const reports = new PgTranslateFloorReport(db);
    await reports.write({ floor: "2026-07-27T14:35:25.000Z", at: "2026-08-08T04:17:09.123Z" });
    const rows = await db.query<{ reported_at: string; floor: string }>(
      "select reported_at, floor from translate_floor_reports",
    );
    expect(rows[0]).toEqual({ reported_at: "2026-08-08T04:17:09.123Z", floor: "2026-07-27T14:35:25.000Z" });
  });
});
