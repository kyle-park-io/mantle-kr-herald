import { describe, it, expect } from "vitest";
import { pinSslMode } from "../../src/config";

/**
 * `pg` prints this on every production connection today:
 *
 *   SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca' are treated as aliases
 *   for 'verify-full'. In the next major version (pg-connection-string v3.0.0 and pg v9.0.0),
 *   these modes will adopt standard libpq semantics, which have weaker security guarantees.
 *
 * Our production DSN is Neon's, injected by the Vercel marketplace integration, and it says
 * `sslmode=require`. Under pg 8 that verifies the certificate chain and the hostname; under pg 9
 * the same string will stop doing either, and nothing about the connection will look different
 * when it happens. The DSN cannot be fixed where it is written — the integration owns that value
 * and re-syncs it — so it is pinned here, at `loadDbConfig`, the only reader of DATABASE_URL.
 *
 * Rewriting all three aliases is what preserves today's behaviour, not a tightening of it: pg 8
 * already treats them identically, so `verify-full` is what each one means right now. The warning
 * itself prescribes exactly this ("If you want the current behavior, explicitly use
 * 'sslmode=verify-full'").
 */
describe("pinSslMode", () => {
  it.each(["require", "prefer", "verify-ca"])(
    "rewrites sslmode=%s, whose meaning pg 9 changes out from under us",
    (mode) => {
      const pinned = pinSslMode(`postgres://u:p@db.neon.tech/neondb?sslmode=${mode}`);

      expect(pinned).toBe("postgres://u:p@db.neon.tech/neondb?sslmode=verify-full");
    },
  );

  it.each(["verify-full", "disable", "no-verify"])(
    "leaves sslmode=%s alone — pg 9 does not redefine it, so rewriting would change behaviour",
    (mode) => {
      const url = `postgres://u:p@db.neon.tech/neondb?sslmode=${mode}`;

      expect(pinSslMode(url)).toBe(url);
    },
  );

  it("leaves a DSN with no sslmode alone, which is what the local container's is", () => {
    const url = "postgres://postgres:herald@127.0.0.1:5432/herald";

    // Adding sslmode=verify-full here would break every developer's setup at once: the container
    // in docs/ko/quickstart.md §1.5 serves no TLS at all.
    expect(pinSslMode(url)).toBe(url);
  });

  it("keeps the other query parameters, and their order", () => {
    const pinned = pinSslMode("postgres://u:p@h/db?application_name=herald&sslmode=require&connect_timeout=10");

    expect(pinned).toBe("postgres://u:p@h/db?application_name=herald&sslmode=verify-full&connect_timeout=10");
  });

  it("returns a malformed DSN unchanged instead of throwing", () => {
    // `loadDbConfig` deliberately does not validate that DATABASE_URL parses (see
    // `tryDescribeDbTarget`'s comment), so this runs before anything has checked. Throwing here
    // would replace `pg`'s own connection error — the one that names what is wrong — with a
    // parse error from a security tweak the operator never asked about.
    const url = "not a connection string at all";

    expect(pinSslMode(url)).toBe(url);
  });

  it("does not touch an sslmode-lookalike elsewhere in the DSN", () => {
    const url = "postgres://u:p@h/sslmode=require";

    expect(pinSslMode(url)).toBe(url);
  });
});
