import { describe, it, expect, vi, afterEach } from "vitest";
import { RecordKolTelegramPosts } from "../../src/app/RecordKolTelegramPosts";
import { KOL_TELEGRAM_HEADER } from "../../src/domain/kol/models";
import type { ChannelPost, KolMapEntry } from "../../src/domain/kol/models";
import type { SheetClient } from "../../src/ports/SheetClient";
import type { TelegramChannelGateway } from "../../src/ports/TelegramChannelGateway";

const TAB = "kol-telegram-posts";

/** "A" → 0, "M" → 12. */
function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Parse "kol-telegram-posts!E5:G5" into the cells it covers. */
function parseRange(range: string): { first: number; last: number; rowNumber: number } {
  const m = /!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
  if (!m) throw new Error(`fake sheet cannot parse range ${range}`);
  return { first: colIndex(m[1]), last: colIndex(m[3]), rowNumber: Number(m[2]) };
}

/**
 * A fake that reconstructs sheet state **and records which ranges it was asked to write**.
 *
 * Recording the ranges is the point. The previous fake rebuilt every row from a whole-width
 * `A{n}:M{n}` write and never looked at the range, so a writer that rewrote a human's `confirmed`
 * and `pricePerPost` on every refresh passed a green suite: the values were copied forward, so the
 * *outcome* was right even though the *mechanism* was to write those columns. Under concurrent
 * editing — a run takes minutes — copying forward a value read at t+0 and writing it at t+90s is
 * not preservation. So these tests assert on `state.writes`.
 */
function fakeSheet() {
  const state: {
    rows: string[][];
    ensured: string[];
    /** Every range written, in order, whether via updateValues or batchUpdateValues. */
    writes: string[];
    appendedBatches: string[][][];
    batchCalls: number;
  } = { rows: [], ensured: [], writes: [], appendedBatches: [], batchCalls: 0 };

  const applyRange = (range: string, values: string[]) => {
    const { first, rowNumber } = parseRange(range);
    state.writes.push(range);
    const target = state.rows[rowNumber - 1] ?? [];
    for (let i = 0; i < values.length; i++) target[first + i] = values[i];
    state.rows[rowNumber - 1] = target;
  };

  const sheet: SheetClient = {
    ensureTab: async (t) => { state.ensured.push(t); },
    getValues: async (range) =>
      /!A1:[A-Z]+1$/.test(range) ? (state.rows[0] ? [state.rows[0]] : []) : state.rows.slice(1),
    appendValues: async (_r, rows) => {
      state.appendedBatches.push(rows.map((r) => [...r]));
      for (const row of rows) state.rows.push(row);
    },
    updateValues: async (range, rows) => { applyRange(range, rows[0]); },
    batchUpdateValues: async (updates) => {
      state.batchCalls += 1;
      for (const u of updates) applyRange(u.range, u.rows[0]);
    },
    createSpreadsheet: async () => ({ spreadsheetId: "x" }),
  };
  return { sheet, state };
}

const col = (name: string) => KOL_TELEGRAM_HEADER.indexOf(name);
const cell = (row: string[], name: string) => row[col(name)];

/** The header's own write is not a row write; these tests only care about data rows. */
const dataWrites = (writes: string[]) => writes.filter((r) => !/!A1:[A-Z]+1$/.test(r));

/** Does any recorded write range cover the column holding `field`? */
function wroteColumnOf(writes: string[], field: string): boolean {
  const target = col(field);
  return dataWrites(writes).some((range) => {
    const { first, last } = parseRange(range);
    return first <= target && target <= last;
  });
}

afterEach(() => vi.restoreAllMocks());

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

// A bare array is shorthand for a normal, non-truncated sweep — most tests don't care about
// truncation, so they pass posts directly rather than the full `{ posts, truncated }` shape.
function gateway(
  byHandle: Record<string, ChannelPost[] | Error | { posts: ChannelPost[]; truncated: boolean }>,
): TelegramChannelGateway {
  return {
    fetchPostsInWindow: async (handle) => {
      const v = byHandle[handle];
      if (v instanceof Error) throw v;
      if (Array.isArray(v)) return { posts: v, truncated: false };
      return v ?? { posts: [], truncated: false };
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

    expect(res).toEqual({ created: 1, refreshed: 0, channelsSwept: 1, channelsFailed: 0, channelsTruncated: 0 });
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

    expect(res).toEqual({ created: 0, refreshed: 1, channelsSwept: 1, channelsFailed: 0, channelsTruncated: 0 });
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

    // Simulate a real API response for a row whose trailing cells are blank: `pricePerPost`,
    // `fetchedAt` and `confirmed` are the last three columns, so the API drops them entirely.
    // Without padding, `existing[pricePerPost]` would be `undefined` rather than `""` and every
    // blank-only rule below would compare against the wrong thing — the price would never be
    // backfilled and a `reject` check would read `undefined`.
    const full = new Array(KOL_TELEGRAM_HEADER.length).fill("");
    full[col("kolId")] = "marine";
    full[col("tgHandle")] = "marshallog";
    full[col("deliverableLink")] = "https://t.me/marshallog/22794";
    full[col("views")] = "2800";
    full[col("engagements")] = "3";
    const short = full.slice(0, col("pricePerPost"));
    expect(short.length).toBeLessThan(KOL_TELEGRAM_HEADER.length);
    state.rows.push(short);

    const gw = gateway({
      marshallog: [post("marshallog", 22794, { views: 3100, reactions: [{ emoji: "🔥", count: 4 }] })],
    });
    const res = await new RecordKolTelegramPosts(sheet, gw, AT).run({
      month: "2026-07", map: MAP, renderings: [],
    });

    expect(res).toEqual({ created: 0, refreshed: 1, channelsSwept: 1, channelsFailed: 0, channelsTruncated: 0 });
    const row = state.rows[1];
    expect(cell(row, "views")).toBe("3100");
    expect(cell(row, "engagements")).toBe("4");
    expect(cell(row, "pricePerPost")).toBe("100"); // the ragged blank was recognised as blank
    // `confirmed` is the human's column: it is never in a written range, so a ragged row simply
    // keeps its absent trailing cell rather than being filled in by the machine.
    expect(wroteColumnOf(state.writes, "confirmed")).toBe(false);
  });

  describe("write mechanism — never writes a column a human owns", () => {
    /** An existing row that is complete: priced, attributed, and confirmed by a human. */
    function settledRow(over: Record<string, string> = {}): string[] {
      const row = new Array(KOL_TELEGRAM_HEADER.length).fill("");
      row[col("kolId")] = "marine";
      row[col("tgHandle")] = "marshallog";
      row[col("postedAt")] = "2026-07-10T00:00:00.000Z";
      row[col("deliverableLink")] = "https://t.me/marshallog/22794";
      row[col("views")] = "2800";
      row[col("engagements")] = "3";
      row[col("reactionsDetail")] = "👍3";
      row[col("itemId")] = "x:111";
      row[col("topic")] = "USPXx Live on Mantle";
      row[col("matchScore")] = "0.44";
      row[col("pricePerPost")] = "100";
      row[col("fetchedAt")] = "2026-07-03T00:00:00.000Z";
      row[col("confirmed")] = "paid";
      for (const [k, v] of Object.entries(over)) row[col(k)] = v;
      return row;
    }

    it("writes only the measurement columns and fetchedAt on a measurement-only refresh", async () => {
      const { sheet, state } = fakeSheet();
      state.rows.push(KOL_TELEGRAM_HEADER, settledRow());

      const gw = gateway({ marshallog: [post("marshallog", 22794, { views: 2930, reactions: [{ emoji: "👍", count: 9 }] })] });
      const res = await new RecordKolTelegramPosts(sheet, gw, AT).run({
        month: "2026-07", map: MAP, renderings: [],
      });

      expect(res.refreshed).toBe(1);
      // E:G is views/engagements/reactionsDetail; L is fetchedAt. K (pricePerPost) sits between
      // them and M (confirmed) after them, so neither can be inside a range this run wrote.
      expect(dataWrites(state.writes)).toEqual([`${TAB}!E2:G2`, `${TAB}!L2:L2`]);
      expect(wroteColumnOf(state.writes, "pricePerPost")).toBe(false);
      expect(wroteColumnOf(state.writes, "confirmed")).toBe(false);
      expect(wroteColumnOf(state.writes, "topic")).toBe(false);
      expect(wroteColumnOf(state.writes, "kolId")).toBe(false);
    });

    it("issues no write at all when a re-run finds nothing changed", async () => {
      const { sheet, state } = fakeSheet();
      // fetchedAt already equals this run's clock and the measurements match, so there is nothing
      // to say. A no-op write would still be a chance to clobber a concurrent edit.
      state.rows.push(
        KOL_TELEGRAM_HEADER,
        settledRow({ views: "2800", engagements: "3", reactionsDetail: "👍3", fetchedAt: AT().toISOString() }),
      );

      const gw = gateway({ marshallog: [post("marshallog", 22794, { views: 2800, reactions: [{ emoji: "👍", count: 3 }] })] });
      const res = await new RecordKolTelegramPosts(sheet, gw, AT).run({
        month: "2026-07", map: MAP, renderings: [],
      });

      expect(res.refreshed).toBe(1);
      expect(dataWrites(state.writes)).toEqual([]);
      expect(state.batchCalls).toBe(0);
    });

    it("widens to the attribution columns only when attribution newly fills a blank itemId", async () => {
      const { sheet, state } = fakeSheet();
      const ours = "맨틀에서 토큰화 주식 거래 지원";
      state.rows.push(
        KOL_TELEGRAM_HEADER,
        settledRow({ itemId: "", topic: "", matchScore: "", confirmed: "" }),
      );

      const gw = gateway({ marshallog: [post("marshallog", 22794, { text: ours, views: 2930 })] });
      await new RecordKolTelegramPosts(sheet, gw, AT).run({
        month: "2026-07", map: MAP, renderings: [{ itemId: "x:111", text: ours }],
      });

      const row = state.rows[1];
      expect(cell(row, "itemId")).toBe("x:111");
      // The measurements (E:G) run straight into itemId (H) as one range, and matchScore (J) is its
      // own. `topic` (I) splits them precisely *because* no sibling row had a topic to inherit, so
      // it did not change — the machine writes what it changed and nothing else. K is excluded too,
      // the row already carrying a price.
      expect(dataWrites(state.writes)).toEqual([`${TAB}!E2:H2`, `${TAB}!J2:J2`, `${TAB}!L2:L2`]);
      expect(wroteColumnOf(state.writes, "topic")).toBe(false);
      expect(wroteColumnOf(state.writes, "pricePerPost")).toBe(false);
      expect(wroteColumnOf(state.writes, "confirmed")).toBe(false);
    });

    it("collapses every new row of a run into one append call", async () => {
      const { sheet, state } = fakeSheet();
      const map: KolMapEntry[] = [
        ...MAP,
        { kolId: "raoni", tgHandle: "Raoni1", sheetLabel: "Raoni", pricePerPost: 60, active: true },
      ];
      const gw = gateway({
        marshallog: [post("marshallog", 1), post("marshallog", 2), post("marshallog", 3)],
        Raoni1: [post("Raoni1", 4), post("Raoni1", 5)],
      });
      const res = await new RecordKolTelegramPosts(sheet, gw, AT).run({
        month: "2026-07", map, renderings: [],
      });

      // Five rows, one API call — not five. At ~16 candidate rows per channel over 13 channels a
      // write per row does not fit in Sheets' 60-per-minute quota.
      expect(res.created).toBe(5);
      expect(state.appendedBatches).toHaveLength(1);
      expect(state.appendedBatches[0]).toHaveLength(5);
    });
  });

  it("records the canonical handle the page reported, not the casing kol-map was typed with", async () => {
    const { sheet, state } = fakeSheet();
    const map: KolMapEntry[] = [{ ...MAP[0], kolId: "raoni", tgHandle: "raoni1" }];
    // t.me resolves the handle case-insensitively and answers with the canonical casing, so the
    // gateway hands back a post whose handle and url are canonical.
    const gw = gateway({ raoni1: [post("Raoni1", 20914)] });
    await new RecordKolTelegramPosts(sheet, gw, AT).run({ month: "2026-07", map, renderings: [] });

    const row = state.rows[1];
    expect(cell(row, "tgHandle")).toBe("Raoni1");
    expect(cell(row, "deliverableLink")).toBe("https://t.me/Raoni1/20914");
  });

  it("keeps the first of two rows sharing a deliverableLink and warns, so one post cannot be billed twice", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sheet, state } = fakeSheet();
    state.rows.push(KOL_TELEGRAM_HEADER);
    for (const views of ["2800", "2900"]) {
      const dup = new Array(KOL_TELEGRAM_HEADER.length).fill("");
      dup[col("deliverableLink")] = "https://t.me/marshallog/22794";
      dup[col("views")] = views;
      state.rows.push(dup);
    }

    const gw = gateway({ marshallog: [post("marshallog", 22794, { views: 3000 })] });
    const res = await new RecordKolTelegramPosts(sheet, gw, AT).run({
      month: "2026-07", map: MAP, renderings: [],
    });

    expect(res).toEqual({ created: 0, refreshed: 1, channelsSwept: 1, channelsFailed: 0, channelsTruncated: 0 });
    // The FIRST row is the maintained one, so which row a run keeps current is stable across runs;
    // keeping the last would have frozen this row at stale numbers forever.
    expect(cell(state.rows[1], "views")).toBe("3000");
    expect(cell(state.rows[2], "views")).toBe("2900");
    expect(warn.mock.calls.flat().join(" ")).toMatch(/duplicate deliverableLink.*22794/);
  });

  it("does not inherit a topic from a row a human rejected", async () => {
    const { sheet, state } = fakeSheet();
    state.rows.push(KOL_TELEGRAM_HEADER);

    // Rejected precisely because the attribution was wrong. Topic is never overwritten once set, so
    // seeding from this row would spread the wrong label to every row sharing the itemId, for good.
    const rejected = new Array(KOL_TELEGRAM_HEADER.length).fill("");
    rejected[col("deliverableLink")] = "https://t.me/enjoymyhobby/1";
    rejected[col("itemId")] = "x:111";
    rejected[col("topic")] = "wrong topic";
    rejected[col("confirmed")] = "reject";
    state.rows.push(rejected);

    const ours = "맨틀에서 토큰화 주식 거래 지원";
    const gw = gateway({ marshallog: [post("marshallog", 5, { text: ours })] });
    await new RecordKolTelegramPosts(sheet, gw, AT).run({
      month: "2026-07", map: MAP, renderings: [{ itemId: "x:111", text: ours }],
    });

    const added = state.rows[2];
    expect(cell(added, "itemId")).toBe("x:111");
    expect(cell(added, "topic")).toBe("");
  });

  describe("matchScore stays coherent with itemId", () => {
    function rowWith(over: Record<string, string>): string[] {
      const row = new Array(KOL_TELEGRAM_HEADER.length).fill("");
      row[col("deliverableLink")] = "https://t.me/marshallog/22794";
      row[col("views")] = "2800";
      row[col("pricePerPost")] = "100";
      for (const [k, v] of Object.entries(over)) row[col(k)] = v;
      return row;
    }

    it("does not clear an existing matchScore when itemId is blank and nothing matches now", async () => {
      const { sheet, state } = fakeSheet();
      state.rows.push(KOL_TELEGRAM_HEADER, rowWith({ itemId: "", matchScore: "0.42" }));

      const gw = gateway({ marshallog: [post("marshallog", 22794, { views: 2930 })] });
      await new RecordKolTelegramPosts(sheet, gw, AT).run({
        month: "2026-07", map: MAP, renderings: [], // nothing to match against
      });

      // The rule is fill-while-blank, not clear-when-blank.
      expect(cell(state.rows[1], "matchScore")).toBe("0.42");
      expect(wroteColumnOf(state.writes, "matchScore")).toBe(false);
    });

    it("clears a stale matchScore once a human's itemId differs from the machine's match", async () => {
      const { sheet, state } = fakeSheet();
      // A human corrected itemId to x:222; the 0.44 was scored against x:111 and describes a
      // different item, so leaving it would read as evidence for an attribution it never scored.
      state.rows.push(KOL_TELEGRAM_HEADER, rowWith({ itemId: "x:222", matchScore: "0.44" }));

      const ours = "맨틀에서 토큰화 주식 거래 지원";
      const gw = gateway({ marshallog: [post("marshallog", 22794, { text: ours, views: 2930 })] });
      await new RecordKolTelegramPosts(sheet, gw, AT).run({
        month: "2026-07", map: MAP, renderings: [{ itemId: "x:111", text: ours }],
      });

      expect(cell(state.rows[1], "itemId")).toBe("x:222"); // the human's id is untouched
      expect(cell(state.rows[1], "matchScore")).toBe("");
    });
  });

  describe("pricePerPost", () => {
    it("leaves a new row's price blank rather than 0 when kol-map has no usable rate", async () => {
      const { sheet, state } = fakeSheet();
      const gw = gateway({ marshallog: [post("marshallog", 22794)] });
      await new RecordKolTelegramPosts(sheet, gw, AT).run({
        month: "2026-07",
        map: [{ ...MAP[0], pricePerPost: 0 }],
        renderings: [],
      });
      // A written "0" would be sticky: pricePerPost is only ever filled while blank, so fixing
      // kol-map later could never repair the row.
      expect(cell(state.rows[1], "pricePerPost")).toBe("");
    });

    it("backfills a blank price on an existing row once kol-map carries one", async () => {
      const { sheet, state } = fakeSheet();
      const existing = new Array(KOL_TELEGRAM_HEADER.length).fill("");
      existing[col("deliverableLink")] = "https://t.me/marshallog/22794";
      existing[col("views")] = "2800";
      existing[col("pricePerPost")] = "";
      state.rows.push(KOL_TELEGRAM_HEADER, existing);

      const gw = gateway({ marshallog: [post("marshallog", 22794, { views: 2930 })] });
      await new RecordKolTelegramPosts(sheet, gw, AT).run({
        month: "2026-07", map: MAP, renderings: [],
      });

      expect(cell(state.rows[1], "pricePerPost")).toBe("100");
    });

    it("does not touch a price that is already on the row", async () => {
      const { sheet, state } = fakeSheet();
      const existing = new Array(KOL_TELEGRAM_HEADER.length).fill("");
      existing[col("deliverableLink")] = "https://t.me/marshallog/22794";
      existing[col("views")] = "2800";
      existing[col("pricePerPost")] = "62.5"; // a human's correction
      state.rows.push(KOL_TELEGRAM_HEADER, existing);

      const gw = gateway({ marshallog: [post("marshallog", 22794, { views: 2930 })] });
      await new RecordKolTelegramPosts(sheet, gw, AT).run({
        month: "2026-07", map: MAP, renderings: [], // kol-map says 100
      });

      expect(cell(state.rows[1], "pricePerPost")).toBe("62.5");
      expect(wroteColumnOf(state.writes, "pricePerPost")).toBe(false);
    });
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

    expect(res).toEqual({ created: 0, refreshed: 0, channelsSwept: 1, channelsFailed: 0, channelsTruncated: 0 });
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

    expect(res).toEqual({ created: 2, refreshed: 0, channelsSwept: 3, channelsFailed: 1, channelsTruncated: 0 });
    expect(state.rows.slice(1).map((r) => cell(r, "kolId")).sort()).toEqual(["marine", "raoni"]);
  });

  it("does not sweep an inactive channel", async () => {
    const { sheet } = fakeSheet();
    let asked = 0;
    const gw: TelegramChannelGateway = {
      fetchPostsInWindow: async () => { asked += 1; return { posts: [], truncated: false }; },
    };
    const res = await new RecordKolTelegramPosts(sheet, gw, AT).run({
      month: "2026-07",
      map: [{ ...MAP[0], active: false }],
      renderings: [],
    });
    expect(asked).toBe(0);
    expect(res.channelsSwept).toBe(0);
  });

  it("counts a truncated channel while still recording the rows it did collect", async () => {
    const { sheet, state } = fakeSheet();
    const gw = gateway({
      marshallog: { posts: [post("marshallog", 1)], truncated: true },
    });
    const res = await new RecordKolTelegramPosts(sheet, gw, AT).run({
      month: "2026-07", map: MAP, renderings: [],
    });

    expect(res).toEqual({ created: 1, refreshed: 0, channelsSwept: 1, channelsFailed: 0, channelsTruncated: 1 });
    expect(state.rows.slice(1)).toHaveLength(1);
  });

  it("counts truncation independently of failure — a truncated channel is not a failed one", async () => {
    const { sheet, state } = fakeSheet();
    const map: KolMapEntry[] = [
      ...MAP,
      { kolId: "gone", tgHandle: "gone", sheetLabel: "Gone", pricePerPost: 10, active: true },
    ];
    const gw = gateway({
      marshallog: { posts: [post("marshallog", 1)], truncated: true },
      gone: new Error("HTTP 404"),
    });
    const res = await new RecordKolTelegramPosts(sheet, gw, AT).run({
      month: "2026-07", map, renderings: [],
    });

    expect(res).toEqual({ created: 1, refreshed: 0, channelsSwept: 2, channelsFailed: 1, channelsTruncated: 1 });
    expect(state.rows.slice(1)).toHaveLength(1);
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
