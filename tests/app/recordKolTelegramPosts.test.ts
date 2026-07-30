import { describe, it, expect } from "vitest";
import { RecordKolTelegramPosts } from "../../src/app/RecordKolTelegramPosts";
import { KOL_TELEGRAM_HEADER } from "../../src/domain/kol/models";
import type { ChannelPost, KolMapEntry } from "../../src/domain/kol/models";
import type { SheetClient } from "../../src/ports/SheetClient";
import type { TelegramChannelGateway } from "../../src/ports/TelegramChannelGateway";

const TAB = "kol-telegram-posts";

function fakeSheet() {
  const state: { rows: string[][]; ensured: string[] } = { rows: [], ensured: [] };
  const sheet: SheetClient = {
    ensureTab: async (t) => { state.ensured.push(t); },
    getValues: async (range) =>
      range.endsWith("A1:M1") ? (state.rows[0] ? [state.rows[0]] : []) : state.rows.slice(1),
    appendValues: async (_r, rows) => { for (const row of rows) state.rows.push(row); },
    updateValues: async (range, rows) => {
      if (range.endsWith("A1:M1")) { state.rows[0] = rows[0]; return; }
      const m = /A(\d+):M\1$/.exec(range);
      if (m) state.rows[Number(m[1]) - 1] = rows[0];
    },
    createSpreadsheet: async () => ({ spreadsheetId: "x" }),
  };
  return { sheet, state };
}

const col = (name: string) => KOL_TELEGRAM_HEADER.indexOf(name);
const cell = (row: string[], name: string) => row[col(name)];

const post = (handle: string, id: number, over: Partial<ChannelPost> = {}): ChannelPost => ({
  handle,
  messageId: id,
  url: `https://t.me/${handle}/${id}`,
  postedAt: "2026-07-10T00:00:00.000Z",
  views: 2000,
  reactions: [{ emoji: "👍", count: 2 }],
  text: "맨틀에서 토큰화 주식 거래 지원",
  ...over,
});

function gateway(byHandle: Record<string, ChannelPost[] | Error>): TelegramChannelGateway {
  return {
    fetchPostsInWindow: async (handle) => {
      const v = byHandle[handle];
      if (v instanceof Error) throw v;
      return v ?? [];
    },
  };
}

const MAP: KolMapEntry[] = [
  { kolId: "marine", tgHandle: "marshallog", sheetLabel: "Marine", pricePerPost: 100, active: true },
];
const AT = () => new Date("2026-07-31T00:00:00.000Z");

describe("RecordKolTelegramPosts", () => {
  it("writes the header once and appends a candidate post", async () => {
    const { sheet, state } = fakeSheet();
    const gw = gateway({ marshallog: [post("marshallog", 22794)] });
    const res = await new RecordKolTelegramPosts(sheet, gw, AT).run({
      month: "2026-07", map: MAP, renderings: [],
    });

    expect(res).toEqual({ created: 1, refreshed: 0, channelsSwept: 1, channelsFailed: 0 });
    expect(state.ensured).toContain(TAB);
    expect(state.rows[0]).toEqual(KOL_TELEGRAM_HEADER);

    const row = state.rows[1];
    expect(cell(row, "kolId")).toBe("marine");
    expect(cell(row, "deliverableLink")).toBe("https://t.me/marshallog/22794");
    expect(cell(row, "views")).toBe("2000");
    expect(cell(row, "engagements")).toBe("2");
    expect(cell(row, "reactionsDetail")).toBe("👍2");
    expect(cell(row, "pricePerPost")).toBe("100");
    expect(cell(row, "fetchedAt")).toBe("2026-07-31T00:00:00.000Z");
    expect(cell(row, "confirmed")).toBe("");
  });

  it("skips a post that never mentions Mantle", async () => {
    const { sheet, state } = fakeSheet();
    const gw = gateway({ marshallog: [post("marshallog", 1, { text: "비트코인 홀딩합니다" })] });
    const res = await new RecordKolTelegramPosts(sheet, gw, AT).run({
      month: "2026-07", map: MAP, renderings: [],
    });
    expect(res.created).toBe(0);
    expect(state.rows.slice(1)).toEqual([]);
  });

  it("attaches an itemId and score when our copy matches", async () => {
    const { sheet, state } = fakeSheet();
    const ours = "맨틀에서 토큰화 주식 거래 지원";
    const gw = gateway({ marshallog: [post("marshallog", 5, { text: `🙃 ${ours}` })] });
    await new RecordKolTelegramPosts(sheet, gw, AT).run({
      month: "2026-07", map: MAP, renderings: [{ itemId: "x:111", text: ours }],
    });
    expect(cell(state.rows[1], "itemId")).toBe("x:111");
    expect(Number(cell(state.rows[1], "matchScore"))).toBeGreaterThan(0.3);
  });

  it("leaves itemId, matchScore, and topic blank when nothing matches — the July backfill case", async () => {
    const { sheet, state } = fakeSheet();
    const gw = gateway({ marshallog: [post("marshallog", 5)] });
    await new RecordKolTelegramPosts(sheet, gw, AT).run({
      month: "2026-07", map: MAP, renderings: [],
    });
    expect(cell(state.rows[1], "itemId")).toBe("");
    expect(cell(state.rows[1], "matchScore")).toBe("");
    expect(cell(state.rows[1], "topic")).toBe("");
  });

  it("inherits a topic a human already typed for the same itemId", async () => {
    const { sheet, state } = fakeSheet();
    state.rows.push(KOL_TELEGRAM_HEADER);
    const existing = new Array(KOL_TELEGRAM_HEADER.length).fill("");
    existing[col("deliverableLink")] = "https://t.me/enjoymyhobby/1";
    existing[col("itemId")] = "x:111";
    existing[col("topic")] = "USPXx Live on Mantle";
    state.rows.push(existing);

    const ours = "맨틀에서 토큰화 주식 거래 지원";
    const gw = gateway({ marshallog: [post("marshallog", 5, { text: ours })] });
    await new RecordKolTelegramPosts(sheet, gw, AT).run({
      month: "2026-07", map: MAP, renderings: [{ itemId: "x:111", text: ours }],
    });

    const added = state.rows[2];
    expect(cell(added, "itemId")).toBe("x:111");
    expect(cell(added, "topic")).toBe("USPXx Live on Mantle");
  });

  it("refreshes metrics on re-run but never overwrites confirmed or an edited topic", async () => {
    const { sheet, state } = fakeSheet();
    state.rows.push(KOL_TELEGRAM_HEADER);
    const existing = new Array(KOL_TELEGRAM_HEADER.length).fill("");
    existing[col("kolId")] = "marine";
    existing[col("deliverableLink")] = "https://t.me/marshallog/22794";
    existing[col("views")] = "2800";
    existing[col("engagements")] = "3";
    existing[col("topic")] = "hand typed topic";
    existing[col("confirmed")] = "paid";
    existing[col("fetchedAt")] = "2026-07-03T00:00:00.000Z";
    state.rows.push(existing);

    const gw = gateway({ marshallog: [post("marshallog", 22794, { views: 2930, reactions: [{ emoji: "❤", count: 9 }] })] });
    const res = await new RecordKolTelegramPosts(sheet, gw, AT).run({
      month: "2026-07", map: MAP, renderings: [],
    });

    expect(res).toEqual({ created: 0, refreshed: 1, channelsSwept: 1, channelsFailed: 0 });
    expect(state.rows).toHaveLength(2);
    const row = state.rows[1];
    expect(cell(row, "views")).toBe("2930");
    expect(cell(row, "engagements")).toBe("9");
    expect(cell(row, "fetchedAt")).toBe("2026-07-31T00:00:00.000Z");
    expect(cell(row, "topic")).toBe("hand typed topic");
    expect(cell(row, "confirmed")).toBe("paid");
  });

  it("inherits a topic on an existing row when attribution fills a previously blank itemId", async () => {
    const { sheet, state } = fakeSheet();
    state.rows.push(KOL_TELEGRAM_HEADER);

    // The July-backfill row: created before any copy existed to match against,
    // so itemId and topic are both still blank.
    const existing = new Array(KOL_TELEGRAM_HEADER.length).fill("");
    existing[col("kolId")] = "marine";
    existing[col("tgHandle")] = "marshallog";
    existing[col("deliverableLink")] = "https://t.me/marshallog/22794";
    existing[col("views")] = "2800";
    state.rows.push(existing);

    // A sibling row for the same itemId that already carries a human-typed topic.
    const sibling = new Array(KOL_TELEGRAM_HEADER.length).fill("");
    sibling[col("deliverableLink")] = "https://t.me/enjoymyhobby/1";
    sibling[col("itemId")] = "x:111";
    sibling[col("topic")] = "USPXx Live on Mantle";
    state.rows.push(sibling);

    const ours = "맨틀에서 토큰화 주식 거래 지원";
    const gw = gateway({ marshallog: [post("marshallog", 22794, { text: ours })] });
    const res = await new RecordKolTelegramPosts(sheet, gw, AT).run({
      month: "2026-07", map: MAP, renderings: [{ itemId: "x:111", text: ours }],
    });

    expect(res.refreshed).toBe(1);
    const row = state.rows[1];
    expect(cell(row, "itemId")).toBe("x:111");
    expect(cell(row, "topic")).toBe("USPXx Live on Mantle");
  });

  it("does not overwrite an existing row's own topic, even when a sibling row's topic differs", async () => {
    const { sheet, state } = fakeSheet();
    state.rows.push(KOL_TELEGRAM_HEADER);

    const existing = new Array(KOL_TELEGRAM_HEADER.length).fill("");
    existing[col("kolId")] = "marine";
    existing[col("tgHandle")] = "marshallog";
    existing[col("deliverableLink")] = "https://t.me/marshallog/22794";
    existing[col("topic")] = "hand typed topic";
    state.rows.push(existing);

    const sibling = new Array(KOL_TELEGRAM_HEADER.length).fill("");
    sibling[col("deliverableLink")] = "https://t.me/enjoymyhobby/1";
    sibling[col("itemId")] = "x:111";
    sibling[col("topic")] = "a different topic";
    state.rows.push(sibling);

    const ours = "맨틀에서 토큰화 주식 거래 지원";
    const gw = gateway({ marshallog: [post("marshallog", 22794, { text: ours })] });
    await new RecordKolTelegramPosts(sheet, gw, AT).run({
      month: "2026-07", map: MAP, renderings: [{ itemId: "x:111", text: ours }],
    });

    const row = state.rows[1];
    expect(cell(row, "itemId")).toBe("x:111"); // still attributed, itemId was blank
    expect(cell(row, "topic")).toBe("hand typed topic"); // but the human's topic is untouched
  });

  it("pads a row shorter than the header before upserting it, as the real Sheets API omits trailing empty cells", async () => {
    const { sheet, state } = fakeSheet();
    state.rows.push(KOL_TELEGRAM_HEADER);

    // Simulate a real API response for a not-yet-confirmed row: `confirmed`
    // is the last column and blank, so the API drops it from the row entirely.
    const full = new Array(KOL_TELEGRAM_HEADER.length).fill("");
    full[col("kolId")] = "marine";
    full[col("tgHandle")] = "marshallog";
    full[col("deliverableLink")] = "https://t.me/marshallog/22794";
    full[col("views")] = "2800";
    full[col("engagements")] = "3";
    full[col("pricePerPost")] = "100";
    full[col("fetchedAt")] = "2026-07-03T00:00:00.000Z";
    const short = full.slice(0, col("confirmed"));
    expect(short.length).toBeLessThan(KOL_TELEGRAM_HEADER.length);
    state.rows.push(short);

    const gw = gateway({
      marshallog: [post("marshallog", 22794, { views: 3100, reactions: [{ emoji: "🔥", count: 4 }] })],
    });
    const res = await new RecordKolTelegramPosts(sheet, gw, AT).run({
      month: "2026-07", map: MAP, renderings: [],
    });

    expect(res).toEqual({ created: 0, refreshed: 1, channelsSwept: 1, channelsFailed: 0 });
    const row = state.rows[1];
    expect(row).toHaveLength(KOL_TELEGRAM_HEADER.length);
    expect(cell(row, "views")).toBe("3100");
    expect(cell(row, "engagements")).toBe("4");
    expect(cell(row, "confirmed")).toBe("");
  });

  it("does not touch a rejected row and does not count it as refreshed", async () => {
    const { sheet, state } = fakeSheet();
    state.rows.push(KOL_TELEGRAM_HEADER);
    const rejected = new Array(KOL_TELEGRAM_HEADER.length).fill("");
    rejected[col("deliverableLink")] = "https://t.me/marshallog/22794";
    rejected[col("views")] = "2800";
    rejected[col("confirmed")] = "reject";
    state.rows.push(rejected);

    const gw = gateway({ marshallog: [post("marshallog", 22794, { views: 9999 })] });
    const res = await new RecordKolTelegramPosts(sheet, gw, AT).run({
      month: "2026-07", map: MAP, renderings: [],
    });

    expect(res).toEqual({ created: 0, refreshed: 0, channelsSwept: 1, channelsFailed: 0 });
    expect(cell(state.rows[1], "views")).toBe("2800");
  });

  it("isolates a failed channel and still records the others", async () => {
    const { sheet, state } = fakeSheet();
    const map: KolMapEntry[] = [
      ...MAP,
      { kolId: "gone", tgHandle: "gone", sheetLabel: "Gone", pricePerPost: 10, active: true },
      { kolId: "raoni", tgHandle: "Raoni1", sheetLabel: "Raoni", pricePerPost: 60, active: true },
    ];
    const gw = gateway({
      marshallog: [post("marshallog", 1)],
      gone: new Error("HTTP 404"),
      Raoni1: [post("Raoni1", 2)],
    });
    const res = await new RecordKolTelegramPosts(sheet, gw, AT).run({
      month: "2026-07", map, renderings: [],
    });

    expect(res).toEqual({ created: 2, refreshed: 0, channelsSwept: 3, channelsFailed: 1 });
    expect(state.rows.slice(1).map((r) => cell(r, "kolId")).sort()).toEqual(["marine", "raoni"]);
  });

  it("does not sweep an inactive channel", async () => {
    const { sheet } = fakeSheet();
    let asked = 0;
    const gw: TelegramChannelGateway = {
      fetchPostsInWindow: async () => { asked += 1; return []; },
    };
    const res = await new RecordKolTelegramPosts(sheet, gw, AT).run({
      month: "2026-07",
      map: [{ ...MAP[0], active: false }],
      renderings: [],
    });
    expect(asked).toBe(0);
    expect(res.channelsSwept).toBe(0);
  });

  it("rejects an invalid month before writing anything", async () => {
    const { sheet, state } = fakeSheet();
    const gw = gateway({});
    await expect(
      new RecordKolTelegramPosts(sheet, gw, AT).run({ month: "2026-13", map: MAP, renderings: [] }),
    ).rejects.toThrow(/2026-13/);
    expect(state.rows).toEqual([]);
  });
});
