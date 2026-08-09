// tests/doctor/liveProbes.test.ts
//
// These probes are the only thing that can tell a live credential from a present one, and they run
// in two places: `pnpm doctor --live` on an operator's machine, and inside the deployment behind
// `GET /api/diagnostics/live`. The deployment case is why the redaction test at the bottom is the
// most important one here — the module holds every live secret the function has, and its output
// travels back over the network into a terminal and a CI log.
//
// The Telegram probe is the sharp edge: its bot token goes in the URL path, so a thrown fetch error
// can carry the token inside `err.message` without anyone writing it there on purpose.
import { describe, it, expect } from "vitest";
import { runLiveProbes, type LiveProbeInput, type LiveProbeResult } from "../../src/doctor/liveProbes";

const ok = (body: unknown = {}): Response => new Response(JSON.stringify(body), { status: 200 });
const status = (code: number): Response => new Response("{}", { status: code });

/** Every probe configured, with values distinctive enough to spot if one ever leaks. */
const SECRETS = {
  larkSecret: "lark-secret-ZZZZZZZZZZZZ",
  typefullyKey: "tf-key-YYYYYYYYYYYYYYYY",
  telegramToken: "1234567890:AAH-telegram-token-XXXXXXXXXXXX",
};

function fullInput(overrides: Partial<LiveProbeInput> = {}): LiveProbeInput {
  return {
    googleToken: async () => "ya29.access-token-WWWWWWWW",
    googleDrive: { reviewFolderId: "revfolder", approvedFolderId: "appfolder" },
    googleSheetId: "sheet123",
    lark: { appId: "cli_app", appSecret: SECRETS.larkSecret, baseUrl: "https://open.larksuite.com" },
    typefully: { apiKey: SECRETS.typefullyKey, socialSetId: "283589" },
    telegramBotToken: SECRETS.telegramToken,
    ...overrides,
  };
}

const byKey = (rs: LiveProbeResult[], key: string): LiveProbeResult => {
  const r = rs.find((x) => x.key === key);
  expect(r, `no result for ${key}`).toBeDefined();
  return r as LiveProbeResult;
};

describe("runLiveProbes", () => {
  it("reports every probe ok when each call succeeds", async () => {
    const results = await runLiveProbes(fullInput(), async () => ok({ code: 0, tenant_access_token: "t" }));
    expect(results.map((r) => r.key)).toEqual(["google_auth", "google_drive", "google_sheets", "lark", "typefully", "telegram"]);
    expect(results.every((r) => r.status === "ok")).toBe(true);
  });

  it("skips a probe whose config is absent, rather than failing it", async () => {
    // A Telegram-only install must not go red because Lark Drive is not set up.
    const results = await runLiveProbes({}, async () => ok());
    expect(results.every((r) => r.status === "skipped")).toBe(true);
  });

  it("marks a probe dead on a non-2xx, carrying the status code", async () => {
    const results = await runLiveProbes(fullInput(), async (url) =>
      String(url).includes("typefully") ? status(401) : ok({ code: 0 }),
    );
    expect(byKey(results, "typefully").status).toBe("dead");
    expect(byKey(results, "typefully").detail).toContain("401");
  });

  it("marks a probe dead when fetch throws, instead of propagating", async () => {
    const results = await runLiveProbes(fullInput(), async (url) => {
      if (String(url).includes("telegram")) throw new Error("getaddrinfo ENOTFOUND api.telegram.org");
      return ok({ code: 0 });
    });
    expect(byKey(results, "telegram").status).toBe("dead");
    expect(byKey(results, "telegram").detail).toContain("ENOTFOUND");
  });

  it("marks Google auth dead when the token cannot be refreshed", async () => {
    const results = await runLiveProbes(
      fullInput({ googleToken: async () => { throw new Error("Google OAuth token refresh failed: HTTP 400"); } }),
      async () => ok({ code: 0 }),
    );
    expect(byKey(results, "google_auth").status).toBe("dead");
    expect(byKey(results, "google_auth").detail).toContain("400");
  });

  it("does not claim Drive and Sheets are dead on their own merits when the token never came", async () => {
    // They were never reached. Saying "folder unreachable" would send the operator after a folder id
    // that is fine — the same mis-blame tests/doctor/checks.test.ts already guards for the Sheet 404.
    const results = await runLiveProbes(
      fullInput({ googleToken: async () => { throw new Error("refresh failed"); } }),
      async () => ok({ code: 0 }),
    );
    for (const key of ["google_drive", "google_sheets"]) {
      expect(byKey(results, key).status).toBe("dead");
      expect(byKey(results, key).detail).toMatch(/token/i);
    }
  });

  it("reports Lark dead when the API answers 200 with a non-zero code", async () => {
    // Lark signals failure in the body, not the status line.
    const results = await runLiveProbes(fullInput(), async (url) =>
      String(url).includes("larksuite") ? ok({ code: 10003, msg: "invalid app_secret" }) : ok({ code: 0 }),
    );
    expect(byKey(results, "lark").status).toBe("dead");
    expect(byKey(results, "lark").detail).toContain("10003");
  });

  // The load-bearing test of this file.
  it("never puts a credential in any detail, even when the error message contains one", async () => {
    const results = await runLiveProbes(fullInput(), async (url) => {
      // Mirrors what a real failure looks like: the message quotes the whole URL, and the Telegram
      // bot token is IN that URL.
      throw new Error(`request to ${String(url)} failed`);
    });
    const all = results.map((r) => r.detail).join("\n");
    for (const secret of Object.values(SECRETS)) expect(all).not.toContain(secret);
    expect(all).not.toContain("ya29.access-token-WWWWWWWW");
    // And it still says something useful rather than swallowing the error.
    expect(byKey(results, "telegram").detail.length).toBeGreaterThan(0);
  });

  it("bounds each call with the given timeout", async () => {
    let seen: AbortSignal | undefined;
    await runLiveProbes(fullInput({ googleToken: undefined, googleDrive: undefined, googleSheetId: undefined, lark: undefined, typefully: undefined }),
      async (_url, init) => { seen = (init as RequestInit | undefined)?.signal ?? undefined; return ok(); }, 1234);
    expect(seen).toBeInstanceOf(AbortSignal);
  });

  it("redacts secrets from Lark's 200 response when msg echoes the secret back", async () => {
    // Lark signals failure via a non-zero code in the body. If the provider echoes back the secret
    // in the msg field, that detail would leak to the network and logs without redaction on the
    // return path.
    const results = await runLiveProbes(fullInput(), async (url) =>
      String(url).includes("larksuite") ? ok({ code: 10003, msg: `invalid app_secret: ${SECRETS.larkSecret}` }) : ok({ code: 0 }),
    );
    const detail = byKey(results, "lark").detail;
    expect(detail).not.toContain(SECRETS.larkSecret);
    expect(detail).toContain("10003");
  });

  it("redacts secrets from any probe returning dead, not only on throw", async () => {
    // A probe fails by returning dead() as commonly as by throwing. Typefully returning 401 is the
    // natural failure case to verify redaction on the return path is universal.
    const results = await runLiveProbes(fullInput(), async (url) =>
      String(url).includes("typefully") ? status(401) : ok({ code: 0 }),
    );
    expect(byKey(results, "typefully").status).toBe("dead");
    expect(byKey(results, "typefully").detail).not.toContain(SECRETS.typefullyKey);
  });
});
