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
    expect(results.map((r) => r.key)).toEqual([
      "google_auth",
      "google_drive_review",
      "google_drive_approved",
      "google_sheets",
      "lark",
      "typefully",
      "telegram",
    ]);
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

  it("reports the scopes tokeninfo grants for the Google auth probe", async () => {
    const results = await runLiveProbes(fullInput(), async (url) =>
      String(url).includes("tokeninfo")
        ? ok({ scope: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets" })
        : ok({ code: 0 }),
    );
    expect(byKey(results, "google_auth").grantedScopes).toEqual([
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/spreadsheets",
    ]);
  });

  it("still reports Google auth ok when tokeninfo itself fails — the token refreshed either way", async () => {
    const results = await runLiveProbes(fullInput(), async (url) => {
      if (String(url).includes("tokeninfo")) throw new Error("tokeninfo unreachable");
      return ok({ code: 0 });
    });
    const auth = byKey(results, "google_auth");
    expect(auth.status).toBe("ok");
    expect(auth.grantedScopes).toBeUndefined();
  });

  it("does not claim Drive and Sheets are dead on their own merits when the token never came", async () => {
    // They were never reached. Saying "folder unreachable" would send the operator after a folder id
    // that is fine — the same mis-blame tests/doctor/checks.test.ts already guards for the Sheet 404.
    const results = await runLiveProbes(
      fullInput({ googleToken: async () => { throw new Error("refresh failed"); } }),
      async () => ok({ code: 0 }),
    );
    for (const key of ["google_drive_review", "google_drive_approved", "google_sheets"]) {
      expect(byKey(results, key).status).toBe("dead");
      expect(byKey(results, key).detail).toMatch(/token/i);
      // Never reached the network, so there is no HTTP status to report either.
      expect(byKey(results, key).httpStatus).toBeUndefined();
    }
  });

  it("reports the review and approved Drive folders as separate results, each carrying its own HTTP status on failure", async () => {
    const results = await runLiveProbes(fullInput(), async (url) => {
      if (String(url).includes("revfolder")) return status(404);
      if (String(url).includes("appfolder")) return status(403);
      return ok({ code: 0 });
    });
    const review = byKey(results, "google_drive_review");
    const approved = byKey(results, "google_drive_approved");
    expect(review.status).toBe("dead");
    expect(review.httpStatus).toBe(404);
    expect(approved.status).toBe("dead");
    expect(approved.httpStatus).toBe(403);
  });

  it("carries the HTTP status on a Sheets failure, so a caller can distinguish 403 from 404", async () => {
    const results = await runLiveProbes(fullInput(), async (url) =>
      String(url).includes("sheets.googleapis.com") ? status(403) : ok({ code: 0 }),
    );
    expect(byKey(results, "google_sheets").status).toBe("dead");
    expect(byKey(results, "google_sheets").httpStatus).toBe(403);
  });

  it("reports the Typefully publishing quota from the social-set response", async () => {
    const results = await runLiveProbes(fullInput(), async (url) =>
      String(url).includes("typefully")
        ? ok({ publishing_quota: { used: 1, remaining: 14, resets_at: "2026-09-01T00:00:00+09:00" } })
        : ok({ code: 0 }),
    );
    expect(byKey(results, "typefully").quota).toEqual({ remaining: 14, limit: 15, resetsAt: "2026-09-01T00:00:00+09:00" });
  });

  it("reports Typefully reachable with no quota when the response carries none", async () => {
    const results = await runLiveProbes(fullInput(), async (url) => (String(url).includes("typefully") ? ok({}) : ok({ code: 0 })));
    const t = byKey(results, "typefully");
    expect(t.status).toBe("ok");
    expect(t.quota).toBeUndefined();
  });

  it("carries the Drive folder's display name through as resourceName", async () => {
    const results = await runLiveProbes(fullInput(), async (url) => {
      if (String(url).includes("revfolder")) return ok({ id: "revfolder", name: "review" });
      if (String(url).includes("appfolder")) return ok({ id: "appfolder", name: "approved" });
      return ok({ code: 0 });
    });
    expect(byKey(results, "google_drive_review").resourceName).toBe("review");
    expect(byKey(results, "google_drive_approved").resourceName).toBe("approved");
  });

  it("carries the spreadsheet's title through as resourceName", async () => {
    const results = await runLiveProbes(fullInput(), async (url) =>
      String(url).includes("sheets.googleapis.com")
        ? ok({ spreadsheetId: "sheet123", properties: { title: "2026 Q3 KR Work Sheet" } })
        : ok({ code: 0 }),
    );
    expect(byKey(results, "google_sheets").resourceName).toBe("2026 Q3 KR Work Sheet");
  });

  it("reports the bot's chat count on the Lark probe — a tenant token alone does not prove the bot is still in a room", async () => {
    const results = await runLiveProbes(fullInput(), async (url) =>
      String(url).includes("/im/v1/chats")
        ? ok({ code: 0, data: { items: [{ chat_id: "c1" }, { chat_id: "c2" }] } })
        : ok({ code: 0, tenant_access_token: "t" }),
    );
    const lark = byKey(results, "lark");
    expect(lark.status).toBe("ok");
    expect(lark.detail).toContain("2 chat(s)");
  });

  it("reports zero chats without failing the probe — a real, if empty, answer", async () => {
    const results = await runLiveProbes(fullInput(), async (url) =>
      String(url).includes("/im/v1/chats") ? ok({ code: 0, data: { items: [] } }) : ok({ code: 0, tenant_access_token: "t" }),
    );
    const lark = byKey(results, "lark");
    expect(lark.status).toBe("ok");
    expect(lark.detail).toContain("0 chat(s)");
  });

  it("still reports Lark ok when the chat-list call fails — the tenant token itself is still real", async () => {
    const results = await runLiveProbes(fullInput(), async (url) => {
      if (String(url).includes("/im/v1/chats")) throw new Error("getaddrinfo ENOTFOUND open.larksuite.com");
      return ok({ code: 0, tenant_access_token: "t" });
    });
    const lark = byKey(results, "lark");
    expect(lark.status).toBe("ok");
    expect(lark.detail).not.toMatch(/chat\(s\)/);
  });

  it("still reports Lark ok when the chat list itself answers with a Lark error code", async () => {
    const results = await runLiveProbes(fullInput(), async (url) =>
      String(url).includes("/im/v1/chats") ? ok({ code: 99991400, msg: "no permission" }) : ok({ code: 0, tenant_access_token: "t" }),
    );
    const lark = byKey(results, "lark");
    expect(lark.status).toBe("ok");
    expect(lark.detail).not.toMatch(/chat\(s\)/);
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

  // Round-2 load-bearing test: `attempt()` used to redact only `result.detail`. A secret planted in
  // any OTHER field a probe result carries — a Drive folder's `name`, Typefully's `resets_at`,
  // Google's `tokeninfo` `scope` — survived into the returned object and into `JSON.stringify()` of
  // the whole array, which is exactly what `GET /api/diagnostics/live` will serialise over the
  // network once Task 3 exists. Asserts on the SERIALISED WHOLE RESULT, not field by field, so this
  // one test also covers whatever field gets added next — the same reason the fix went into
  // `attempt()` and not into each probe individually.
  it("redacts every secret from the serialised whole result, not only from detail, field by field", async () => {
    const GOOGLE_TOKEN = "ya29.access-token-WWWWWWWW"; // matches fullInput()'s googleToken
    const results = await runLiveProbes(fullInput(), async (url) => {
      if (String(url).includes("tokeninfo")) return ok({ scope: `leaked-in-scope:${GOOGLE_TOKEN}` });
      if (String(url).includes("revfolder")) return ok({ id: "revfolder", name: `leaked-in-name:${GOOGLE_TOKEN}` });
      if (String(url).includes("typefully")) {
        return ok({ publishing_quota: { used: 1, remaining: 14, resets_at: `leaked-in-resetsAt:${SECRETS.typefullyKey}` } });
      }
      return ok({ code: 0, tenant_access_token: "t" });
    });
    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain(GOOGLE_TOKEN);
    expect(serialized).not.toContain(SECRETS.typefullyKey);
    // And the fields are still there, redacted rather than dropped — a diagnostic that goes silent
    // instead of failing loudly is a different bug this must not trade for.
    expect(serialized).toContain("leaked-in-scope:***");
    expect(serialized).toContain("leaked-in-name:***");
    expect(serialized).toContain("leaked-in-resetsAt:***");
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

  it("never reports a chat's name, only the count — a name is untrusted response content", async () => {
    const results = await runLiveProbes(fullInput(), async (url) =>
      String(url).includes("/im/v1/chats")
        ? ok({ code: 0, data: { items: [{ chat_id: "c1", name: "internal-secret-room-name" }] } })
        : ok({ code: 0, tenant_access_token: "t" }),
    );
    const detail = byKey(results, "lark").detail;
    expect(detail).not.toContain("internal-secret-room-name");
    expect(detail).toContain("1 chat(s)");
  });

  /**
   * The design doc promises "the route answers in about five seconds even when an external API is
   * hanging". Before this, it did not: `googleToken` is a caller closure and nothing bounded it —
   * measured still hanging at 6009 ms against a `timeoutMs` of 1000 — and the probes that do take a
   * signal each got a FRESH one, so Google's two calls plus a sequential Lark's two put the real
   * worst case at 3x the number. The route runs on Vercel with no `maxDuration`, where a hang is a
   * platform 504 that `checkLiveness` cannot tell apart from a deployment too old to have the route.
   */
  describe("the deadline", () => {
    const hang = <T,>(): Promise<T> => new Promise<T>(() => {});

    it("returns within the budget when the Google token closure never resolves", async () => {
      const started = performance.now();
      const results = await runLiveProbes(fullInput({ googleToken: () => hang<string>() }), async () => ok({ code: 0 }), 300);
      const elapsed = Math.round(performance.now() - started);
      expect(elapsed, `still running after ${elapsed}ms`).toBeLessThan(2000);
      expect(byKey(results, "google_auth").status).toBe("dead");
      expect(byKey(results, "google_auth").detail).toMatch(/timed out/);
    });

    it("returns within the budget when every fetch hangs", async () => {
      const started = performance.now();
      const results = await runLiveProbes(fullInput(), () => hang<Response>(), 300);
      const elapsed = Math.round(performance.now() - started);
      expect(elapsed, `still running after ${elapsed}ms`).toBeLessThan(2000);
      expect(results).toHaveLength(7);
      for (const r of results) expect(r.status, r.key).toBe("dead");
    });

    /**
     * The half a `Promise.race` cannot do. Giving up WAITING for a hung refresh still leaves the
     * socket open, which keeps a CLI from exiting and a Vercel function billing until the platform
     * kills it — and `GoogleOAuthAuth.getToken` has no timeout of its own, so the signal handed to
     * this closure is the only thing that can cancel it.
     */
    it("hands the Google token closure the run's own abort signal", async () => {
      let seen: AbortSignal | undefined;
      await runLiveProbes(
        fullInput({
          googleToken: async (signal) => {
            seen = signal;
            return "ya29.access-token-WWWWWWWW";
          },
        }),
        async () => ok({ code: 0 }),
        300,
      );
      expect(seen).toBeInstanceOf(AbortSignal);
      expect(seen?.aborted).toBe(false);
    });

    /**
     * One hanging credential must not condemn the other six. The probes used to run Google first and
     * alone; under a single shared budget that is starvation, and it would report four healthy
     * credentials as timed out on the strength of a fifth being slow.
     */
    it("does not let a hanging Google starve the probes that do not need its token", async () => {
      const results = await runLiveProbes(
        fullInput({ googleToken: () => hang<string>() }),
        async (url) => (String(url).includes("google") ? hang<Response>() : ok({ code: 0, tenant_access_token: "t" })),
        400,
      );
      for (const key of ["lark", "typefully", "telegram"]) expect(byKey(results, key).status, key).toBe("ok");
      expect(byKey(results, "google_auth").status).toBe("dead");
    });
  });

  /**
   * Four failures with four different remedies, which one social-set call collapses into one HTTP
   * code. The pre-module `doctor --live` made two calls specifically to keep them apart, and the loss
   * was invisible to the branch's own before/after ledger because that was measured on an all-green
   * machine — every one of these is an unhappy path.
   */
  describe("the Typefully probe's four distinct answers", () => {
    const typefullyOnly = (): LiveProbeInput => ({ typefully: { apiKey: SECRETS.typefullyKey, socialSetId: "283589" } });

    it("blames the key when /v2/me rejects it", async () => {
      for (const code of [401, 403]) {
        const results = await runLiveProbes(typefullyOnly(), async (url) =>
          String(url).includes("/v2/me") ? status(code) : ok({}),
        );
        const t = byKey(results, "typefully");
        expect(t.status, String(code)).toBe("dead");
        expect(t.detail, String(code)).toContain("TYPEFULLY_API_KEY");
        expect(t.httpStatus, String(code)).toBe(code);
      }
    });

    it("blames Typefully, not the key, on any other /v2/me failure", async () => {
      // Sending an operator to rotate a perfectly good key during an upstream outage is the cost.
      const results = await runLiveProbes(typefullyOnly(), async (url) =>
        String(url).includes("/v2/me") ? status(503) : ok({}),
      );
      const t = byKey(results, "typefully");
      expect(t.status).toBe("dead");
      expect(t.detail).toContain("upstream");
      expect(t.detail).not.toContain("TYPEFULLY_API_KEY");
    });

    it("blames the social set id when the key is good and the set is not", async () => {
      const results = await runLiveProbes(typefullyOnly(), async (url) =>
        String(url).includes("/v2/me") ? ok({}) : status(404),
      );
      const t = byKey(results, "typefully");
      expect(t.status).toBe("dead");
      expect(t.detail).toContain("TYPEFULLY_SOCIAL_SET_ID");
      expect(t.detail).not.toContain("TYPEFULLY_API_KEY");
    });

    it("says unreachable when the call never reached Typefully at all", async () => {
      // A network-level rejection (DNS, TLS, connection refused) is not an HTTP code and not a
      // credential problem — the remedy is the network, and neither variable is at fault.
      const results = await runLiveProbes(typefullyOnly(), async () => {
        throw new Error("getaddrinfo ENOTFOUND api.typefully.com");
      });
      const t = byKey(results, "typefully");
      expect(t.status).toBe("dead");
      expect(t.detail).toContain("unreachable");
      expect(t.detail).toContain("ENOTFOUND");
    });

    it("still reports the quota when both calls succeed", async () => {
      const results = await runLiveProbes(typefullyOnly(), async (url) =>
        String(url).includes("/v2/me") ? ok({}) : ok({ publishing_quota: { used: 1, remaining: 14 } }),
      );
      expect(byKey(results, "typefully").status).toBe("ok");
      expect(byKey(results, "typefully").quota).toEqual({ remaining: 14, limit: 15, resetsAt: undefined });
    });
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
