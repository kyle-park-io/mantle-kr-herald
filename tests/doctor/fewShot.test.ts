import { describe, it, expect, afterEach } from "vitest";
import { createTestDb } from "../support/testDb";
import { PgFewShotStore, fewShotStoresByType } from "../../src/adapters/store/PgFewShotStore";
import {
  unkeyedFewShotScopes,
  unkeyedFewShotResult,
  FEW_SHOT_KEY_CHECK,
} from "../../src/doctor/fewShot";

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

describe("unkeyedFewShotScopes", () => {
  it("finds nothing in a corpus where every example carries an itemId", async () => {
    db = await createTestDb();
    await new PgFewShotStore(db, "translation").add({ source: "a", target: "가", itemId: "x:1" });
    await fewShotStoresByType(db).x.add({ source: "b", target: "나", itemId: "x:2" });

    expect(await unkeyedFewShotScopes(db)).toEqual([]);
  });

  it("finds nothing in an empty database", async () => {
    db = await createTestDb();
    expect(await unkeyedFewShotScopes(db)).toEqual([]);
  });

  it("counts the itemId-less rows per scope, and only those", async () => {
    // The row this check exists for. `add` is `insert ... on conflict (scope, item_id) do update`
    // and Postgres never considers one null item_id equal to another, so these two never collided
    // with each other on insert — which is exactly why re-approving that example would append a
    // third copy rather than replace one.
    db = await createTestDb();
    const translation = new PgFewShotStore(db, "translation");
    await translation.add({ source: "a", target: "가", itemId: "x:1" });
    await translation.add({ source: "b", target: "나" });
    await translation.add({ source: "b", target: "나" });
    await fewShotStoresByType(db).x.add({ source: "c", target: "다" });
    await fewShotStoresByType(db).kol.add({ source: "d", target: "라", itemId: "x:9" });

    expect(await unkeyedFewShotScopes(db)).toEqual([
      { scope: "conversion:x", count: 1 },
      { scope: "translation", count: 2 },
    ]);
  });
});

describe("unkeyedFewShotResult", () => {
  it("ok when no scope holds one", () => {
    const result = unkeyedFewShotResult([]);
    expect(result).toEqual({
      name: FEW_SHOT_KEY_CHECK,
      status: "ok",
      detail: expect.stringContaining("item_id"),
    });
  });

  it("warns — never fails — and names every affected scope with its count", () => {
    // `warn`, not `fail`: nothing is broken and no command is blocked, so doctor must not exit
    // non-zero over it. The scope names are the whole point of the line — the remedy is to go and
    // look at specific rows, and "some corpus somewhere" would not say which.
    const result = unkeyedFewShotResult([
      { scope: "conversion:x", count: 1 },
      { scope: "translation", count: 2 },
    ]);
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("conversion:x");
    expect(result.detail).toContain("translation");
    expect(result.detail).toContain("3 example(s)");
  });

  it("says the backup is not affected, because that refusal is what moved here", () => {
    // This line replaced a `state:push` refusal. An operator who remembers the old behaviour must
    // not read this warning as "your nightly backup is broken" — it is not, and saying so is the
    // difference between a finding and an alarm.
    const detail = unkeyedFewShotResult([{ scope: "translation", count: 1 }]).detail;
    expect(detail).toContain("state:push");
    expect(detail).toContain("state:pull");
  });
});
