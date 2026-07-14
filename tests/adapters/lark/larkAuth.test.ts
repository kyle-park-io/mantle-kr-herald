import { describe, it, expect } from "vitest";
import { LarkAuth } from "../../../src/adapters/lark/LarkAuth";
import type { IHttpClient } from "../../../src/shared/http/IHttpClient";

class FakeHttpClient implements IHttpClient {
  public postCount = 0;
  public calls: Array<{ path: string; body: unknown }> = [];
  constructor(private readonly responder: () => unknown) {}
  async get<T>(): Promise<T> {
    throw new Error("not used");
  }
  async post<T>(path: string, body?: unknown): Promise<T> {
    this.postCount += 1;
    this.calls.push({ path, body });
    return this.responder() as T;
  }
  async patch<T>(): Promise<T> {
    throw new Error("not used");
  }
  async delete<T>(): Promise<T> {
    throw new Error("not used");
  }
}

describe("LarkAuth", () => {
  it("fetches a token and caches it (no second request within validity)", async () => {
    const http = new FakeHttpClient(() => ({ code: 0, msg: "ok", tenant_access_token: "t-1", expire: 7200 }));
    const auth = new LarkAuth(http, "app", "secret", () => 1000);

    expect(await auth.getToken()).toBe("t-1");
    expect(await auth.getToken()).toBe("t-1");
    expect(http.postCount).toBe(1);
    expect(http.calls[0]).toEqual({
      path: "/open-apis/auth/v3/tenant_access_token/internal",
      body: { app_id: "app", app_secret: "secret" },
    });
  });

  it("refreshes when the cached token is near expiry", async () => {
    let n = 0;
    const http = new FakeHttpClient(() => ({ code: 0, tenant_access_token: `t-${++n}`, expire: 7200 }));
    let clock = 0;
    const auth = new LarkAuth(http, "app", "secret", () => clock);

    expect(await auth.getToken()).toBe("t-1");
    clock = (7200 - 30) * 1000; // within the 60s refresh window
    expect(await auth.getToken()).toBe("t-2");
    expect(http.postCount).toBe(2);
  });

  it("force-refreshes even when the cached token is still valid", async () => {
    let n = 0;
    const http = new FakeHttpClient(() => ({ code: 0, tenant_access_token: `t-${++n}`, expire: 7200 }));
    const auth = new LarkAuth(http, "app", "secret", () => 0);

    expect(await auth.getToken()).toBe("t-1");
    expect(await auth.getToken(true)).toBe("t-2"); // forced despite valid cache
    expect(http.postCount).toBe(2);
  });

  it("throws when the auth response has a non-zero code", async () => {
    const http = new FakeHttpClient(() => ({ code: 10003, msg: "bad app_secret" }));
    const auth = new LarkAuth(http, "app", "secret");
    await expect(auth.getToken()).rejects.toThrow(/10003|bad app_secret/);
  });
});
