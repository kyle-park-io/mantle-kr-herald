import { describe, it, expect } from "vitest";
import { RecordMetrics } from "../../src/app/RecordMetrics";
import type { SheetClient } from "../../src/ports/SheetClient";
import type { SourceGateway } from "../../src/ports/SourceGateway";
import type { SourceTweet, UserProfile } from "../../src/domain/models";

function fakeSheet() {
  const state: { rows: string[][]; ensured: string[]; appended: string[][]; updated: { range: string; row: string[] }[] } =
    { rows: [], ensured: [], appended: [], updated: [] };
  const sheet: SheetClient = {
    ensureTab: async (t) => { state.ensured.push(t); },
    getValues: async (range) => (range.endsWith("A1:I1") ? (state.rows[0] ? [state.rows[0]] : []) : state.rows.slice(1)),
    appendValues: async (_r, rows) => { for (const row of rows) { state.rows.push(row); state.appended.push(row); } },
    updateValues: async (range, rows) => {
      state.updated.push({ range, row: rows[0] });
      if (range.endsWith("A1:I1")) { state.rows[0] = rows[0]; return; }
      const m = /A(\d+):I\1$/.exec(range);
      if (m) state.rows[Number(m[1]) - 1] = rows[0];
    },
    batchUpdateValues: async () => {},
    createSpreadsheet: async () => ({ spreadsheetId: "x" }),
  };
  return { sheet, state };
}

function gateway(followersByHandle: Record<string, number>, tweetsByHandle: Record<string, SourceTweet[]>): SourceGateway {
  const tw = (h: string) => (async function* (): AsyncGenerator<SourceTweet, boolean> { for (const t of tweetsByHandle[h] ?? []) yield t; return false; })();
  return {
    fetchUserProfile: async (h): Promise<UserProfile> => ({ userName: h, followers: followersByHandle[h] }),
    fetchAuthoredTweets: (h: string) => tw(h) as ReturnType<SourceGateway["fetchAuthoredTweets"]>,
    fetchThread: async () => [],
    fetchByIds: async () => [],
    fetchArticle: async () => [],
  };
}

const tweet = (createdAt: string, viewCount: number): SourceTweet =>
  ({ id: "1", conversationId: "1", createdAt, text: "", metrics: { viewCount, likeCount: 1 } } as SourceTweet);

describe("RecordMetrics", () => {
  it("writes the header once, then one row for the official account + each roster KOL", async () => {
    const { sheet, state } = fakeSheet();
    const gw = gateway(
      { "0xMantleKR": 4164, marine_x: 2000 },
      {
        "0xMantleKR": [tweet("2026-07-05T00:00:00.000Z", 100), tweet("2026-07-06T00:00:00.000Z", 50)],
        marine_x: [tweet("2026-07-10T00:00:00.000Z", 10)],
      },
    );
    const uc = new RecordMetrics(sheet, gw, () => new Date("2026-07-31T00:00:00.000Z"));
    const res = await uc.run({ month: "2026-07", officialHandle: "0xMantleKR", roster: [{ name: "Marine", handle: "marine_x" }] });

    expect(res).toEqual({ recorded: 2, skipped: 0 });
    expect(state.ensured).toContain("x-performance");
    expect(state.rows[0]).toEqual(["account", "name", "type", "month", "followers", "posts", "views", "engagement", "fetchedAt"]);
    // official row: 2 posts, views 150, engagement 2
    expect(state.rows[1]).toEqual(["0xMantleKR", "Mantle KR", "official", "2026-07", "4164", "2", "150", "2", "2026-07-31T00:00:00.000Z"]);
    // kol row: 1 post, views 10, engagement 1
    expect(state.rows[2]).toEqual(["marine_x", "Marine", "kol", "2026-07", "2000", "1", "10", "1", "2026-07-31T00:00:00.000Z"]);
  });

  it("upserts: a second run for the same (account, month) overwrites, not appends", async () => {
    const { sheet, state } = fakeSheet();
    const gw = gateway({ "0xMantleKR": 1 }, { "0xMantleKR": [tweet("2026-07-05T00:00:00.000Z", 10)] });
    const uc = new RecordMetrics(sheet, gw, () => new Date("2026-07-31T00:00:00.000Z"));
    await uc.run({ month: "2026-07", officialHandle: "0xMantleKR", roster: [] });
    await uc.run({ month: "2026-07", officialHandle: "0xMantleKR", roster: [] });
    const dataRows = state.rows.slice(1);
    expect(dataRows.filter((r) => r[0] === "0xMantleKR" && r[3] === "2026-07")).toHaveLength(1);
  });

  it("skips an account whose fetch throws and records the rest", async () => {
    const { sheet, state } = fakeSheet();
    const base = gateway({ "0xMantleKR": 1 }, { "0xMantleKR": [tweet("2026-07-05T00:00:00.000Z", 10)] });
    const gw: SourceGateway = { ...base, fetchUserProfile: async (h) => { if (h === "boom") throw new Error("HTTP 500"); return { userName: h, followers: 1 }; } };
    const uc = new RecordMetrics(sheet, gw, () => new Date("2026-07-31T00:00:00.000Z"));
    const res = await uc.run({ month: "2026-07", officialHandle: "0xMantleKR", roster: [{ name: "Boom", handle: "boom" }] });
    expect(res).toEqual({ recorded: 1, skipped: 1 });
    expect(state.rows.slice(1).map((r) => r[0])).toEqual(["0xMantleKR"]);
  });
});
