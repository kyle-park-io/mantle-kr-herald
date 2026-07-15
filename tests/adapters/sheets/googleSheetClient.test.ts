import { describe, it, expect } from "vitest";
import { GoogleSheetClient } from "../../../src/adapters/sheets/GoogleSheetClient";

const auth = { getToken: async () => "ya29.tok" };

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

  it("throws on a non-ok response", async () => {
    const badFetch = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
    const c = new GoogleSheetClient(auth, "SID", badFetch);
    await expect(c.getValues("targets!A2:E")).rejects.toThrow(/403/);
  });
});
