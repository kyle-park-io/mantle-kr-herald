import { describe, it, expect } from "vitest";
import { GoogleOAuthAuth } from "../../../src/adapters/drive/GoogleOAuthAuth";

const client = { clientId: "cid", clientSecret: "csecret" };
const refreshToken = "rt-123";

function fakeFetch(capture: { calls: Array<{ url: string; body: string }> }, token: string, expiresIn = 3600): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    capture.calls.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("GoogleOAuthAuth", () => {
  it("exchanges the refresh token for an access token", async () => {
    const cap = { calls: [] as Array<{ url: string; body: string }> };
    const auth = new GoogleOAuthAuth(client, refreshToken, () => 0, fakeFetch(cap, "at1"));

    const token = await auth.getToken();

    expect(token).toBe("at1");
    expect(cap.calls).toHaveLength(1);
    expect(cap.calls[0].url).toBe("https://oauth2.googleapis.com/token");
    const params = new URLSearchParams(cap.calls[0].body);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe(refreshToken);
    expect(params.get("client_id")).toBe(client.clientId);
    expect(params.get("client_secret")).toBe(client.clientSecret);
  });

  it("caches the token across calls and only refetches when forced", async () => {
    const cap = { calls: [] as Array<{ url: string; body: string }> };
    const auth = new GoogleOAuthAuth(client, refreshToken, () => 1_000_000, fakeFetch(cap, "at1"));

    expect(await auth.getToken()).toBe("at1");
    expect(await auth.getToken()).toBe("at1");
    expect(cap.calls).toHaveLength(1);

    await auth.getToken(true);
    expect(cap.calls).toHaveLength(2);
  });

  it("refetches once the cached token is near expiry", async () => {
    const cap = { calls: [] as Array<{ url: string; body: string }> };
    let clock = 0;
    const auth = new GoogleOAuthAuth(client, refreshToken, () => clock, fakeFetch(cap, "at1"));

    await auth.getToken();
    clock = (3600 - 30) * 1000; // within the 60s refresh margin
    await auth.getToken();

    expect(cap.calls).toHaveLength(2);
  });

  it("throws when the token refresh response is not ok", async () => {
    const badFetch = (async () => new Response("nope", { status: 400 })) as unknown as typeof fetch;
    const auth = new GoogleOAuthAuth(client, refreshToken, () => 0, badFetch);
    await expect(auth.getToken()).rejects.toThrow(/400/);
  });

  it("throws when the token response lacks access_token", async () => {
    const badFetch = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    const auth = new GoogleOAuthAuth(client, refreshToken, () => 0, badFetch);
    await expect(auth.getToken()).rejects.toThrow(/access_token/);
  });
});
