import { describe, it, expect, vi, afterEach } from "vitest";
import { GoogleSheetClient } from "../../../src/adapters/sheets/GoogleSheetClient";

const auth = { getToken: async () => "ya29.tok" };

afterEach(() => vi.restoreAllMocks());

/** Run the backoff instantly — the precedent is tests/shared/httpClient.test.ts. */
function noSleep() {
  return vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
}

function fakeFetch(capture: { url?: string; method?: string; headers?: Record<string, string>; body?: string }, responseJson: unknown = {}): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    capture.url = String(url);
    capture.method = init?.method;
    capture.headers = init?.headers as Record<string, string>;
    capture.body = init?.body ? String(init.body) : undefined;
    return new Response(JSON.stringify(responseJson), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("GoogleSheetClient", () => {
  it("getValues GETs the range with a bearer token and returns .values ([] when absent)", async () => {
    const cap: { url?: string; method?: string; headers?: Record<string, string> } = {};
    const c = new GoogleSheetClient(auth, "SID", fakeFetch(cap, { values: [["a", "b"], ["c", "d"]] }));
    const values = await c.getValues("targets!A2:E");
    expect(values).toEqual([["a", "b"], ["c", "d"]]);
    expect(cap.method).toBe("GET");
    expect(cap.url).toBe("https://sheets.googleapis.com/v4/spreadsheets/SID/values/targets!A2%3AE");
    expect(cap.headers?.["Authorization"]).toBe("Bearer ya29.tok");

    const empty = new GoogleSheetClient(auth, "SID", fakeFetch({}, {}));
    expect(await empty.getValues("targets!A2:E")).toEqual([]);
  });

  it("appendValues POSTs :append with valueInputOption=RAW and a {values} body", async () => {
    const cap: { url?: string; method?: string; body?: string } = {};
    const c = new GoogleSheetClient(auth, "SID", fakeFetch(cap));
    await c.appendValues("history!A2:G", [["x:1", "x", "telegram"]]);
    expect(cap.method).toBe("POST");
    expect(cap.url).toBe("https://sheets.googleapis.com/v4/spreadsheets/SID/values/history!A2%3AG:append?valueInputOption=RAW");
    expect(JSON.parse(cap.body!)).toEqual({ values: [["x:1", "x", "telegram"]] });
  });

  it("updateValues PUTs the range with valueInputOption=RAW", async () => {
    const cap: { url?: string; method?: string; body?: string } = {};
    const c = new GoogleSheetClient(auth, "SID", fakeFetch(cap));
    await c.updateValues("history!A5:G5", [["x:1", "x", "telegram", "", "", "posted", "2026-01-01"]]);
    expect(cap.method).toBe("PUT");
    expect(cap.url).toBe("https://sheets.googleapis.com/v4/spreadsheets/SID/values/history!A5%3AG5?valueInputOption=RAW");
    expect(JSON.parse(cap.body!).values[0][5]).toBe("posted");
  });

  it("createSpreadsheet POSTs the base URL with title + sheet tabs and returns the id", async () => {
    const cap: { url?: string; method?: string; body?: string } = {};
    const c = new GoogleSheetClient(auth, "", fakeFetch(cap, { spreadsheetId: "NEW_ID" }));
    const res = await c.createSpreadsheet("Hub", [{ title: "targets" }, { title: "history" }]);
    expect(res).toEqual({ spreadsheetId: "NEW_ID" });
    expect(cap.method).toBe("POST");
    expect(cap.url).toBe("https://sheets.googleapis.com/v4/spreadsheets");
    const body = JSON.parse(cap.body!);
    expect(body.properties.title).toBe("Hub");
    expect(body.sheets.map((s: { properties: { title: string } }) => s.properties.title)).toEqual(["targets", "history"]);
  });

  it("ensureTab creates the tab only when it is absent", async () => {
    const calls: { url: string; method?: string }[] = [];
    const fetchFn = (async (url: string, init?: { method?: string }) => {
      calls.push({ url: String(url), method: init?.method });
      if (String(url).includes("?fields=sheets.properties.title")) {
        return { ok: true, json: async () => ({ sheets: [{ properties: { title: "targets" } }] }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    const c = new GoogleSheetClient({ getToken: async () => "tok" }, "SID", fetchFn);
    await c.ensureTab("x-performance"); // absent → must batchUpdate
    expect(calls.some((x) => x.url.includes(":batchUpdate") && x.method === "POST")).toBe(true);

    calls.length = 0;
    await c.ensureTab("targets"); // present → must NOT batchUpdate
    expect(calls.some((x) => x.url.includes(":batchUpdate"))).toBe(false);
  });

  it("batchUpdateValues POSTs values:batchUpdate with every range in ONE request", async () => {
    const cap: { url?: string; method?: string; body?: string } = {};
    const fetchMock = vi.fn(fakeFetch(cap));
    const c = new GoogleSheetClient(auth, "SID", fetchMock as unknown as typeof fetch);
    await c.batchUpdateValues([
      { range: "kol-telegram-posts!E5:G5", rows: [["2930", "9", "❤9"]] },
      { range: "kol-telegram-posts!L5:L5", rows: [["2026-07-31T00:00:00.000Z"]] },
    ]);

    // One HTTP request for both ranges: that is the whole point against a 60-writes-per-minute
    // quota, and it is what lets the writer be narrow about which columns it touches for free.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cap.method).toBe("POST");
    expect(cap.url).toBe("https://sheets.googleapis.com/v4/spreadsheets/SID/values:batchUpdate");
    expect(JSON.parse(cap.body!)).toEqual({
      valueInputOption: "RAW",
      data: [
        { range: "kol-telegram-posts!E5:G5", values: [["2930", "9", "❤9"]] },
        { range: "kol-telegram-posts!L5:L5", values: [["2026-07-31T00:00:00.000Z"]] },
      ],
    });
  });

  it("batchUpdateValues makes no request for an empty batch", async () => {
    const fetchMock = vi.fn(fakeFetch({}));
    const c = new GoogleSheetClient(auth, "SID", fetchMock as unknown as typeof fetch);
    await c.batchUpdateValues([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on a non-retryable non-ok response (all methods)", async () => {
    // 400 is a request problem: thrown immediately, and LoadKolMap reads the "HTTP 400" out of it to
    // tell an operator the kol-map tab does not exist.
    const fetchMock = vi.fn((async () => new Response("nope", { status: 400 })) as unknown as typeof fetch);
    const c = new GoogleSheetClient(auth, "SID", fetchMock as unknown as typeof fetch);
    await expect(c.getValues("targets!A2:E")).rejects.toThrow(/400/);
    await expect(c.appendValues("history!A2:G", [["a"]])).rejects.toThrow(/400/);
    await expect(c.updateValues("history!A5:G5", [["a"]])).rejects.toThrow(/400/);
    await expect(c.batchUpdateValues([{ range: "h!A1:A1", rows: [["a"]] }])).rejects.toThrow(/400/);
    await expect(c.createSpreadsheet("t", [{ title: "x" }])).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(5); // one attempt each, no retry
  });

  describe("retry", () => {
    // This client had no retry at all, so a 429 threw on the spot. For kol-telegram:record that
    // threw inside the per-channel handler, which abandoned the rest of that channel's posts,
    // reported the channel as failed, and left a partial write behind. Policy mirrors
    // src/shared/http/HttpClient.ts: three attempts, 1000 * 2^attempt backoff.
    it("retries a 429 write and then succeeds", async () => {
      noSleep();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
        .mockResolvedValueOnce(new Response("{}", { status: 200 }));
      const c = new GoogleSheetClient(auth, "SID", fetchMock as unknown as typeof fetch);

      await expect(c.appendValues("kol-telegram-posts!A2:M", [["a"]])).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("retries a 5xx read and then succeeds", async () => {
      noSleep();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response("boom", { status: 503 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ values: [["ok"]] }), { status: 200 }));
      const c = new GoogleSheetClient(auth, "SID", fetchMock as unknown as typeof fetch);

      expect(await c.getValues("targets!A2:E")).toEqual([["ok"]]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("exhausts three attempts without a final backoff and still names the status", async () => {
      const timeoutMock = noSleep();
      const fetchMock = vi.fn((async () => new Response("nope", { status: 429 })) as unknown as typeof fetch);
      const c = new GoogleSheetClient(auth, "SID", fetchMock as unknown as typeof fetch);

      await expect(c.batchUpdateValues([{ range: "h!A1:A1", rows: [["a"]] }])).rejects.toThrow(/429.*3 attempts/);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(timeoutMock).toHaveBeenCalledTimes(2); // no sleep after the final attempt
    });

    describe("appendValues is not idempotent, so it retries only a definitive rejection", () => {
      // A 429 means the request was refused before it was processed, so re-sending cannot double
      // anything. A network throw or a 5xx leaves it open whether the append was committed
      // server-side and lost on the way back — and retrying that ambiguity writes the rows twice.
      // Up to 500 rows go in one call, so one blip after a ~200-row append would land ~200 duplicate
      // rows in a tab that decides KOL payments, with the run still reporting a clean summary. The
      // same shared client backs x-performance (RecordMetrics) and history (RecordPublish).

      it("attempts a network-level failure exactly once and propagates it", async () => {
        noSleep();
        const fetchMock = vi.fn((async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch);
        const c = new GoogleSheetClient(auth, "SID", fetchMock as unknown as typeof fetch);

        await expect(c.appendValues("kol-telegram-posts!A2:M", [["a"]])).rejects.toThrow(
          /not retried.*may already have been committed/,
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it("does not retry a 5xx either, since that is ambiguous too", async () => {
        noSleep();
        const fetchMock = vi.fn((async () => new Response("boom", { status: 503 })) as unknown as typeof fetch);
        const c = new GoogleSheetClient(auth, "SID", fetchMock as unknown as typeof fetch);

        await expect(c.appendValues("kol-telegram-posts!A2:M", [["a"]])).rejects.toThrow(/503/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it("still retries a 429, which is the quota case retry exists for", async () => {
        noSleep();
        const fetchMock = vi
          .fn()
          .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
          .mockResolvedValueOnce(new Response("{}", { status: 200 }));
        const c = new GoogleSheetClient(auth, "SID", fetchMock as unknown as typeof fetch);

        await expect(c.appendValues("kol-telegram-posts!A2:M", [["a"]])).resolves.toBeUndefined();
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });

      it("leaves the idempotent overwrites retrying a network error as before", async () => {
        noSleep();
        for (const call of [
          (c: GoogleSheetClient) => c.updateValues("h!A1:A1", [["a"]]),
          (c: GoogleSheetClient) => c.batchUpdateValues([{ range: "h!A1:A1", rows: [["a"]] }]),
        ]) {
          const fetchMock = vi.fn((async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch);
          const c = new GoogleSheetClient(auth, "SID", fetchMock as unknown as typeof fetch);
          await expect(call(c)).rejects.toThrow(/3 attempts.*network error/);
          expect(fetchMock).toHaveBeenCalledTimes(3); // repeating an overwrite converges, so it is safe
        }
      });
    });

    it("retries a network error and wraps it with context on exhaustion", async () => {
      noSleep();
      const fetchMock = vi.fn((async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch);
      const c = new GoogleSheetClient(auth, "SID", fetchMock as unknown as typeof fetch);

      await expect(c.updateValues("h!A1:A1", [["a"]])).rejects.toThrow(/3 attempts.*network error/);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });
});
