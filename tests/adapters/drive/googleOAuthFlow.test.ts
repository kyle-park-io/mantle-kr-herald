import { describe, it, expect } from "vitest";
import { buildConsentUrl, exchangeCodeForTokens } from "../../../src/adapters/drive/googleOAuthFlow";

describe("buildConsentUrl", () => {
  it("builds a Google consent URL with offline access and forced consent", () => {
    const url = buildConsentUrl({ clientId: "cid", redirectUri: "http://localhost:1234", scope: "S" });

    expect(url.startsWith("https://accounts.google.com/o/oauth2/v2/auth")).toBe(true);
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain("response_type=code");
    expect(decoded).toContain("access_type=offline");
    expect(decoded).toContain("prompt=consent");
    expect(decoded).toContain("client_id=cid");
    expect(decoded).toContain("redirect_uri=http://localhost:1234");
    expect(decoded).toContain("scope=S");
  });
});

describe("exchangeCodeForTokens", () => {
  function fakeFetch(capture: { calls: Array<{ url: string; body: string }> }, response: unknown, status = 200): typeof fetch {
    return (async (url: string, init?: RequestInit) => {
      capture.calls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response(JSON.stringify(response), { status, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
  }

  it("exchanges an authorization code for tokens", async () => {
    const cap = { calls: [] as Array<{ url: string; body: string }> };
    const result = await exchangeCodeForTokens({
      code: "auth-code",
      clientId: "cid",
      clientSecret: "csecret",
      redirectUri: "http://localhost:1234",
      fetchFn: fakeFetch(cap, { access_token: "at", refresh_token: "rt" }),
    });

    expect(result).toEqual({ refreshToken: "rt", accessToken: "at" });
    expect(cap.calls).toHaveLength(1);
    expect(cap.calls[0].url).toBe("https://oauth2.googleapis.com/token");
    const params = new URLSearchParams(cap.calls[0].body);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe("auth-code");
    expect(params.get("client_id")).toBe("cid");
    expect(params.get("client_secret")).toBe("csecret");
    expect(params.get("redirect_uri")).toBe("http://localhost:1234");
  });

  it("throws when the response has no refresh_token", async () => {
    const cap = { calls: [] as Array<{ url: string; body: string }> };
    await expect(
      exchangeCodeForTokens({
        code: "auth-code",
        clientId: "cid",
        clientSecret: "csecret",
        redirectUri: "http://localhost:1234",
        fetchFn: fakeFetch(cap, { access_token: "at" }),
      }),
    ).rejects.toThrow(/refresh_token/);
  });

  it("throws on a non-ok response", async () => {
    const cap = { calls: [] as Array<{ url: string; body: string }> };
    await expect(
      exchangeCodeForTokens({
        code: "auth-code",
        clientId: "cid",
        clientSecret: "csecret",
        redirectUri: "http://localhost:1234",
        fetchFn: fakeFetch(cap, {}, 400),
      }),
    ).rejects.toThrow(/400/);
  });
});
