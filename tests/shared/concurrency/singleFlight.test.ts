import { describe, it, expect } from "vitest";
import { singleFlight } from "../../../src/shared/concurrency/singleFlight";

/** Resolves only when `resolve` is called — lets a test hold a call "in flight" on purpose. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("singleFlight", () => {
  it("lets a single call through and returns its result", async () => {
    const wrapped = singleFlight(async (n: number) => n * 2, () => -1);
    expect(await wrapped(3)).toBe(6);
  });

  it("refuses a second call made while the first is still in flight", async () => {
    const slow = deferred<string>();
    const wrapped = singleFlight(() => slow.promise, () => "busy");

    const first = wrapped();
    const second = wrapped(); // issued before `first` resolves

    expect(await second).toBe("busy");
    slow.resolve("done");
    expect(await first).toBe("done");
  });

  it("frees the slot once the in-flight call settles, so the next call runs for real", async () => {
    const wrapped = singleFlight(async (n: number) => n + 1, () => -1);
    expect(await wrapped(1)).toBe(2);
    expect(await wrapped(2)).toBe(3);
  });

  it("frees the slot even when the wrapped call rejects", async () => {
    let shouldThrow = true;
    const wrapped = singleFlight(
      async () => {
        if (shouldThrow) throw new Error("boom");
        return "ok";
      },
      () => "busy",
    );
    await expect(wrapped()).rejects.toThrow("boom");
    shouldThrow = false;
    expect(await wrapped()).toBe("ok");
  });

  /**
   * The exact shape `serve.ts` composes `deps.login` from: a slow, login-shaped async function
   * (standing in for `Login.run`'s scrypt derivation) wrapped so a second concurrent attempt is
   * refused immediately, the same shape as a lockout refusal, rather than queued behind the first.
   */
  it("refuses a second concurrent login attempt while the first is still deriving", async () => {
    type LoginResult = { ok: true } | { ok: false; retryAfterMs: number };
    const deriving = deferred<LoginResult>();
    const login = singleFlight(
      (_credentials: { username: string; password: string }) => deriving.promise,
      (): LoginResult => ({ ok: false, retryAfterMs: 1000 }),
    );

    const first = login({ username: "herald", password: "correct" });
    const second = login({ username: "herald", password: "correct" });

    expect(await second).toEqual({ ok: false, retryAfterMs: 1000 });
    deriving.resolve({ ok: true });
    expect(await first).toEqual({ ok: true });
  });
});
