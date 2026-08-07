import { describe, it, expect } from "vitest";
import { withDbTarget } from "../../../src/adapters/db/createDb";
import type { Db } from "../../../src/adapters/db/Db";
import type { DbConfig } from "../../../src/config";

const DEV: DbConfig = { url: "postgres://u:p@127.0.0.1:5432/herald", env: "development" };
const PROD: DbConfig = { url: "postgres://u:p@ep-x.aws.neon.tech/neondb", env: "production" };

/** A `Db` whose every call rejects with `err`. */
function failing(err: unknown): Db {
  return {
    query: async () => {
      throw err;
    },
    tx: async () => {
      throw err;
    },
  };
}

function connErr(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe("withDbTarget", () => {
  it("names the database a refused connection was trying to reach", async () => {
    // The whole point. `connect ECONNREFUSED 127.0.0.1:5432` alone says nothing about WHICH
    // database was meant — and this repo routinely runs the same command against a local Postgres
    // and against Neon, differing only by which env file was loaded.
    const db = withDbTarget(DEV, failing(connErr("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:5432")));

    await expect(db.query("select 1")).rejects.toThrow(
      /cannot reach the development database at 127\.0\.0\.1:5432\/herald/,
    );
  });

  it("keeps the driver's own message, so nothing is lost by wrapping", async () => {
    const db = withDbTarget(DEV, failing(connErr("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:5432")));
    await expect(db.query("select 1")).rejects.toThrow(/connect ECONNREFUSED 127\.0\.0\.1:5432/);
  });

  it("wraps a transaction the same way as a query", async () => {
    const db = withDbTarget(PROD, failing(connErr("ENOTFOUND", "getaddrinfo ENOTFOUND ep-x.aws.neon.tech")));
    await expect(db.tx(async () => 1)).rejects.toThrow(/cannot reach the production database at ep-x\.aws\.neon\.tech\/neondb/);
  });

  it.each(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"])(
    "treats %s as unreachable",
    async (code) => {
      const db = withDbTarget(DEV, failing(connErr(code, `boom ${code}`)));
      await expect(db.query("select 1")).rejects.toThrow(/cannot reach the development database/);
    },
  );

  it("leaves an ordinary SQL error alone, so a real query bug is not disguised as a connection problem", async () => {
    // Over-wrapping is its own failure: `relation "translations" does not exist` is a schema
    // problem with a completely different remedy, and dressing it as "cannot reach" would send an
    // operator to check Docker instead of running pnpm db:migrate.
    const sqlErr = connErr("42P01", 'relation "translations" does not exist');
    const db = withDbTarget(DEV, failing(sqlErr));

    await expect(db.query("select 1")).rejects.toThrow(/relation "translations" does not exist/);
    await expect(db.query("select 1")).rejects.not.toThrow(/cannot reach/);
  });

  it("leaves an error with no code alone", async () => {
    const db = withDbTarget(DEV, failing(new Error("something else entirely")));
    await expect(db.query("select 1")).rejects.toThrow(/^something else entirely$/);
  });

  it("still names the env when DATABASE_URL is malformed, rather than throwing while reporting", async () => {
    // An error path that throws its own error buries the original. Same reason `watchStartupLine`
    // uses `tryDescribeDbTarget` rather than `describeDbTarget`.
    const broken: DbConfig = { url: "not a url", env: "development" };
    const db = withDbTarget(broken, failing(connErr("ECONNREFUSED", "connect ECONNREFUSED")));
    await expect(db.query("select 1")).rejects.toThrow(/cannot reach the development database/);
  });

  it("passes a successful call straight through", async () => {
    const ok: Db = { query: async () => [{ n: 1 }] as never, tx: async (fn) => fn(ok) };
    const db = withDbTarget(DEV, ok);
    await expect(db.query("select 1")).resolves.toEqual([{ n: 1 }]);
    await expect(db.tx(async () => "done")).resolves.toBe("done");
  });
});
