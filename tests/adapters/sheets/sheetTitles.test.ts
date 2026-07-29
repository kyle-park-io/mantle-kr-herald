import { describe, expect, it, vi } from "vitest";
import { resolveSheetTitles } from "../../../src/adapters/sheets/sheetTitles";

const auth = () => Promise.resolve({ getToken: async () => "TOK" });
const links = {
  data: { url: "https://docs.google.com/spreadsheets/d/AAA/edit", title: "데이터 시트" },
  qa: { url: "https://docs.google.com/spreadsheets/d/BBB/edit", title: "QA 시트" },
};
const ok = (title: string) => new Response(JSON.stringify({ properties: { title } }), { status: 200 });

describe("resolveSheetTitles", () => {
  it("names each link after its workbook", async () => {
    const fetchFn = vi.fn(async (url: string) =>
      ok(String(url).includes("/AAA?") ? "2026 Q3 KR Work Sheet" : "Mantle KR Herald QA"),
    ) as unknown as typeof fetch;
    const named = await resolveSheetTitles(auth, fetchFn)(links);
    expect(named.data?.title).toBe("2026 Q3 KR Work Sheet");
    expect(named.qa?.title).toBe("Mantle KR Herald QA");
    expect(named.data?.url).toBe(links.data.url); // the link itself is untouched
  });

  /** `/api/status` is polled, and a workbook title changes about never. */
  it("fetches each workbook once and serves the rest from cache", async () => {
    const fetchFn = vi.fn(async () => ok("제목")) as unknown as typeof fetch;
    const resolve = resolveSheetTitles(auth, fetchFn);
    await resolve(links);
    await resolve(links);
    await resolve(links);
    expect((fetchFn as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2); // one per workbook
  });

  /**
   * Every failure keeps the placeholder and the working link. A header label is not worth taking
   * the dashboard down for — and the most likely failure, a token without the spreadsheets scope,
   * is exactly the setup where the rest of the dashboard is fine.
   */
  it("keeps the placeholder title when the API refuses", async () => {
    const fetchFn = vi.fn(async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
    expect((await resolveSheetTitles(auth, fetchFn)(links)).data?.title).toBe("데이터 시트");
  });

  it("keeps the placeholder title when the request throws", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect((await resolveSheetTitles(auth, fetchFn)(links)).qa?.title).toBe("QA 시트");
  });

  it("keeps the placeholder when auth itself fails", async () => {
    const dead = () => Promise.reject(new Error("no refresh token"));
    const fetchFn = vi.fn(async () => ok("제목")) as unknown as typeof fetch;
    expect((await resolveSheetTitles(dead, fetchFn)(links)).data?.title).toBe("데이터 시트");
  });

  it("omits a link that was not configured, without calling the API for it", async () => {
    const fetchFn = vi.fn(async () => ok("제목")) as unknown as typeof fetch;
    const named = await resolveSheetTitles(auth, fetchFn)({ data: links.data });
    expect(named).toEqual({ data: { ...links.data, title: "제목" } });
    expect("qa" in named).toBe(false);
  });
});
