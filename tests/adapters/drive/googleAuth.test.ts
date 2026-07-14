import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { GoogleAuth } from "../../../src/adapters/drive/GoogleAuth";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const key = { client_email: "sa@project.iam.gserviceaccount.com", private_key: privateKey as string };

function fakeFetch(capture: { calls: Array<{ url: string; body: string }> }, token: string, expiresIn = 3600): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    capture.calls.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("GoogleAuth", () => {
  it("mints a token via a signed JWT assertion and caches it", async () => {
    const cap = { calls: [] as Array<{ url: string; body: string }> };
    const auth = new GoogleAuth(key, () => 1_000_000, fakeFetch(cap, "ya29.token"));
    expect(await auth.getToken()).toBe("ya29.token");
    expect(await auth.getToken()).toBe("ya29.token"); // cached
    expect(cap.calls).toHaveLength(1);
    expect(cap.calls[0].url).toBe("https://oauth2.googleapis.com/token");
    expect(cap.calls[0].body).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
    const assertion = new URLSearchParams(cap.calls[0].body).get("assertion") ?? "";
    expect(assertion.split(".")).toHaveLength(3); // header.claim.signature
  });

  it("refreshes when the cached token is near expiry", async () => {
    const cap = { calls: [] as Array<{ url: string; body: string }> };
    let clock = 0;
    const auth = new GoogleAuth(key, () => clock, fakeFetch(cap, "t"));
    await auth.getToken();
    clock = (3600 - 30) * 1000; // within 60s refresh margin
    await auth.getToken();
    expect(cap.calls).toHaveLength(2);
  });

  it("throws when the token response lacks access_token", async () => {
    const badFetch = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    const auth = new GoogleAuth(key, () => 0, badFetch);
    await expect(auth.getToken()).rejects.toThrow(/access_token/);
  });
});
