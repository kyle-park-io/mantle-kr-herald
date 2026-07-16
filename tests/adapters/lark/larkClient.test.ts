import { describe, it, expect } from "vitest";
import { LarkClient } from "../../../src/adapters/lark/LarkClient";
import { LarkAuth } from "../../../src/adapters/lark/LarkAuth";
import type { IHttpClient } from "../../../src/shared/http/IHttpClient";

function authReturning(token: string): LarkAuth {
  const http: IHttpClient = {
    get: async () => { throw new Error("no"); },
    post: async () => ({ code: 0, tenant_access_token: token, expire: 7200 }) as unknown,
    patch: async () => { throw new Error("no"); },
    delete: async () => { throw new Error("no"); },
  } as IHttpClient;
  return new LarkAuth(http, "app", "secret");
}

class SpyHttp implements IHttpClient {
  public authHeaders: (string | undefined)[] = [];
  public bodies: unknown[] = [];
  constructor(private readonly headers: Record<string, string>, private readonly responder: () => unknown) {}
  async get<T>(): Promise<T> {
    this.authHeaders.push(this.headers["Authorization"]);
    return this.responder() as T;
  }
  async post<T>(_path: string, body?: unknown): Promise<T> {
    this.authHeaders.push(this.headers["Authorization"]);
    this.bodies.push(body);
    return this.responder() as T;
  }
  async patch<T>(): Promise<T> { throw new Error("no"); }
  async delete<T>(): Promise<T> { throw new Error("no"); }
}

describe("LarkClient", () => {
  it("injects the bearer token from LarkAuth on GET", async () => {
    const spies: SpyHttp[] = [];
    const client = new LarkClient("https://open.larksuite.com", authReturning("t-abc"), (_base, headers) => {
      const s = new SpyHttp(headers, () => ({ code: 0, data: {} }));
      spies.push(s);
      return s;
    });

    await client.get("/open-apis/im/v1/messages", { container_id: "oc_x" });

    expect(spies[0].authHeaders[0]).toBe("Bearer t-abc");
  });

  it("refreshes the token once and retries on an auth-error envelope", async () => {
    let call = 0;
    const client = new LarkClient("https://open.larksuite.com", authReturning("t-abc"), (_base, headers) => {
      return new SpyHttp(headers, () => (++call === 1 ? { code: 99991663, msg: "expired" } : { code: 0, data: {} }));
    });

    const res = await client.get<{ code: number }>("/open-apis/im/v1/messages", {});

    expect(res.code).toBe(0);
    expect(call).toBe(2);
  });

  it("injects the bearer token and passes the body on POST", async () => {
    const spies: SpyHttp[] = [];
    const client = new LarkClient("https://open.larksuite.com", authReturning("t-abc"), (_base, headers) => {
      const s = new SpyHttp(headers, () => ({ code: 0, data: { message_id: "om_1" } }));
      spies.push(s);
      return s;
    });

    await client.post("/open-apis/im/v1/messages", { receive_id: "oc_x" });

    expect(spies[0].authHeaders[0]).toBe("Bearer t-abc");
    expect(spies[0].bodies[0]).toEqual({ receive_id: "oc_x" });
  });

  it("refreshes the token once and retries on an auth-error envelope (POST)", async () => {
    let call = 0;
    const client = new LarkClient("https://open.larksuite.com", authReturning("t-abc"), (_base, headers) => {
      return new SpyHttp(headers, () => (++call === 1 ? { code: 99991663, msg: "expired" } : { code: 0, data: {} }));
    });

    const res = await client.post<{ code: number }>("/open-apis/im/v1/messages", {});

    expect(res.code).toBe(0);
    expect(call).toBe(2);
  });
});
