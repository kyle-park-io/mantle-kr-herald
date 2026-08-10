// tests/deploy/deploymentSession.test.ts
//
// This module exists because of one bug. On 2026-08-10 `deploy-smoke.ts` called
// /api/diagnostics/live without the session cookie every sibling call passed; the route answered 401
// on every run and the feature it had just shipped never once executed. A full green suite and four
// clean task reviews said nothing about it.
//
// The fix is not "remember the cookie". It is `authed()`: the cookie is attached inside the client,
// so a caller cannot make an authenticated request without one. The tests below pin that property
// rather than any particular call site's spelling.
import { describe, it, expect } from "vitest";
import { createDeploymentClient } from "../../src/deploy/deploymentSession";

const ok = (body: unknown = {}, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, headers });

/** Records what the client actually sent, so the assertions are about the wire, not the call. */
function recorder(responder: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return responder(String(url), init);
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const LOGIN_OK = ok({ ok: true }, { "set-cookie": "herald_session=abc123; Path=/; HttpOnly" });

describe("createDeploymentClient", () => {
  it("sends the deployment's own Origin on a login, so the CSRF guard does not refuse it", async () => {
    const { calls, fetchFn } = recorder(() => LOGIN_OK);
    const client = createDeploymentClient("https://example.test", fetchFn);
    await client.logIn("u", "p");
    expect(calls[0].url).toBe("https://example.test/api/login");
    expect((calls[0].init?.headers as Record<string, string>).origin).toBe("https://example.test");
  });

  it("returns the login status and remembers the session", async () => {
    const { fetchFn } = recorder(() => LOGIN_OK);
    const client = createDeploymentClient("https://example.test", fetchFn);
    expect(await client.logIn("u", "p")).toBe(200);
    expect(client.loggedIn).toBe(true);
  });

  it("does not consider itself logged in when the login is refused", async () => {
    const { fetchFn } = recorder(() => new Response("{}", { status: 401 }));
    const client = createDeploymentClient("https://example.test", fetchFn);
    expect(await client.logIn("u", "bad")).toBe(401);
    expect(client.loggedIn).toBe(false);
  });

  // The load-bearing test of this file.
  it("attaches the cookie to every authed call — the caller cannot omit it", async () => {
    const { calls, fetchFn } = recorder(() => LOGIN_OK);
    const client = createDeploymentClient("https://example.test", fetchFn);
    await client.logIn("u", "p");
    await client.authed("/api/status");
    await client.authed("/api/diagnostics/live");
    for (const call of calls.slice(1)) {
      expect((call.init?.headers as Record<string, string>).cookie, call.url).toBe("herald_session=abc123");
    }
  });

  it("keeps headers the caller passed while adding the cookie", async () => {
    const { calls, fetchFn } = recorder(() => LOGIN_OK);
    const client = createDeploymentClient("https://example.test", fetchFn);
    await client.logIn("u", "p");
    await client.authed("/api/thing", { method: "POST", headers: { "content-type": "application/json" } });
    const headers = calls[1].init?.headers as Record<string, string>;
    expect(headers.cookie).toBe("herald_session=abc123");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("refuses an authed call before login rather than sending an unauthenticated one", async () => {
    // Silently sending it is how the original bug looked from the outside: a 401 that reads like the
    // deployment's fault.
    const { calls, fetchFn } = recorder(() => ok());
    const client = createDeploymentClient("https://example.test", fetchFn);
    await expect(client.authed("/api/status")).rejects.toThrow(/log in/i);
    expect(calls).toHaveLength(0);
  });

  it("forgets the session on request, so a stale cookie can never be resent", async () => {
    const { fetchFn } = recorder(() => LOGIN_OK);
    const client = createDeploymentClient("https://example.test", fetchFn);
    await client.logIn("u", "p");
    client.forgetSession();
    expect(client.loggedIn).toBe(false);
    await expect(client.authed("/api/status")).rejects.toThrow(/log in/i);
  });

  it("returns undefined and reports, rather than throwing, when the network fails", async () => {
    const messages: string[] = [];
    const fetchFn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = createDeploymentClient("https://example.test", fetchFn, (m) => messages.push(m));
    expect(await client.request("/")).toBeUndefined();
    expect(messages.join("\n")).toContain("ECONNREFUSED");
  });

  it("reports -1 for a login that never completed", async () => {
    const fetchFn = (async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    const client = createDeploymentClient("https://example.test", fetchFn, () => {});
    expect(await client.logIn("u", "p")).toBe(-1);
    expect(client.loggedIn).toBe(false);
  });
});
