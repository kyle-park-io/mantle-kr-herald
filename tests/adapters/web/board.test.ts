// tests/adapters/web/board.test.ts
import { describe, expect, it } from "vitest";
import { buildBoard } from "../../../src/adapters/web/board";
import type { ChannelRendering } from "../../../src/domain/formatting/models";

const r = (type: string, channel: string, text: string, status: "rendered" | "approved" = "approved"): ChannelRendering =>
  ({ itemId: "x:1", type, channel, text, refined: false, createdAt: "T", status } as ChannelRendering);

describe("buildBoard", () => {
  it("groups by (type, channel) and lists the rooms that receive each group", () => {
    const board = buildBoard("x:1", [r("announcement", "telegram", "공통")], [], []);
    const group = board.groups.find((g) => g.type === "announcement" && g.channel === "telegram");
    expect(group?.text).toBe("공통");
    // Every telegram room suggests `announcement` — 텔레그램 KOL방 included (ALL_OUTLETS gives it
    // `["kol", "announcement"]`), so the whole channel is rowed and nothing is left to add.
    expect(group?.rows.map((row) => row.outletId)).toEqual(["tg-community", "tg-dev", "tg-kol", "tg-blockchain"]);
    expect(group?.addableOutletIds).toEqual([]);
  });

  it("rows the suggested rooms and offers the channel's remaining rooms as addable", () => {
    const board = buildBoard("x:1", [r("kol", "telegram", "브리프")], [], []);
    const group = board.groups.find((g) => g.type === "kol");
    expect(group?.rows.map((row) => row.outletId)).toEqual(["tg-kol"]);
    // suggestedTypes is a default, not a constraint — the rest of the channel stays reachable.
    expect(group?.addableOutletIds).toEqual(["tg-community", "tg-dev", "tg-blockchain"]);
  });

  it("rows a non-suggested room once it has a delivery, and drops it from addable", () => {
    const board = buildBoard("x:1", [r("kol", "telegram", "브리프")], [], [
      { itemId: "x:1", type: "kol", outletId: "tg-community", status: "delivered", at: "T", by: "manual" },
    ]);
    const group = board.groups.find((g) => g.type === "kol");
    expect(group?.rows.map((row) => row.outletId)).toEqual(["tg-kol", "tg-community"]);
    expect(group?.addableOutletIds).not.toContain("tg-community");
  });

  it("rows a non-suggested room once it has an override", () => {
    const board = buildBoard("x:1", [r("kol", "telegram", "브리프")], [
      { itemId: "x:1", type: "kol", outletId: "tg-dev", text: "데브방용", status: "rendered", createdAt: "T" },
    ], []);
    const group = board.groups.find((g) => g.type === "kol");
    expect(group?.rows.map((row) => row.outletId)).toEqual(["tg-kol", "tg-dev"]);
  });

  it("marks a forked room and gives it its own text and status", () => {
    const board = buildBoard("x:1", [r("announcement", "telegram", "공통")], [
      { itemId: "x:1", type: "announcement", outletId: "tg-blockchain", text: "이 방 전용", status: "rendered", createdAt: "T" },
    ], []);
    const rows = board.groups[0]!.rows;
    expect(rows.find((row) => row.outletId === "tg-blockchain")).toMatchObject({ forked: true, text: "이 방 전용", status: "rendered" });
    expect(rows.find((row) => row.outletId === "tg-community")).toMatchObject({ forked: false, text: "공통", status: "approved" });
  });

  it("attaches delivery state per room, keeping two rooms on one channel apart", () => {
    const board = buildBoard("x:1", [r("announcement", "telegram", "공통")], [], [
      { itemId: "x:1", type: "announcement", outletId: "tg-community", status: "sent", at: "T", by: "auto", url: "u" },
    ]);
    const rows = board.groups[0]!.rows;
    expect(rows.find((row) => row.outletId === "tg-community")).toMatchObject({ deliveryStatus: "sent", url: "u" });
    expect(rows.find((row) => row.outletId === "tg-dev")?.deliveryStatus).toBeUndefined();
  });

  it("numbers a room that appears in several groups", () => {
    const board = buildBoard("x:1", [r("announcement", "telegram", "공지"), r("explainer", "telegram", "해설")], [], []);
    const dev = board.groups.flatMap((g) => g.rows).filter((row) => row.outletId === "tg-dev");
    expect(dev.map((row) => [row.siblingIndex, row.siblingCount])).toEqual([[1, 2], [2, 2]]);
  });

  it("numbers a room that receives only one group as 1/1", () => {
    const board = buildBoard("x:1", [r("announcement", "telegram", "공지"), r("explainer", "telegram", "해설")], [], []);
    const community = board.groups.flatMap((g) => g.rows).filter((row) => row.outletId === "tg-community");
    expect(community.map((row) => [row.siblingIndex, row.siblingCount])).toEqual([[1, 1]]);
  });

  it("lists the types with no rendering yet", () => {
    const board = buildBoard("x:1", [r("announcement", "telegram", "공통")], [], []);
    expect(board.unconverted).toEqual(["x", "explainer", "casual", "kol", "pr"]);
  });

  it("keeps a group no room suggests, offering the whole channel as addable", () => {
    // `pr` is suggested by pr-mail only, so a `pr` rendering formatted for telegram has no default
    // room. The card must still render — otherwise the text a human already wrote is unreachable.
    const board = buildBoard("x:1", [r("pr", "telegram", "보도자료")], [], []);
    const group = board.groups.find((g) => g.type === "pr");
    expect(group?.rows).toEqual([]);
    expect(group?.addableOutletIds).toEqual(["tg-community", "tg-dev", "tg-kol", "tg-blockchain"]);
  });

  it("leaves out a room that can be neither sent nor ticked", () => {
    // x-article is `auto` but has its own pipeline: the send route refuses it and tells the
    // operator to tick 전달함, which MarkDelivery then refuses because the room is auto. Offering
    // it at all would produce a row with no way out of it.
    const board = buildBoard("x:1", [r("x", "x", "트윗")], [], []);
    const group = board.groups[0]!;
    expect(group.rows.map((row) => row.outletId)).toEqual(["x-post"]);
    expect(group.addableOutletIds).toEqual([]);
  });

  it("ignores a delivery or override naming a room that no longer exists", () => {
    const board = buildBoard("x:1", [r("kol", "telegram", "브리프")], [
      { itemId: "x:1", type: "kol", outletId: "tg-retired", text: "옛 방", status: "rendered", createdAt: "T" },
    ], [
      { itemId: "x:1", type: "kol", outletId: "tg-gone", status: "delivered", at: "T", by: "manual" },
    ]);
    expect(board.groups[0]!.rows.map((row) => row.outletId)).toEqual(["tg-kol"]);
  });

  it("ignores renderings, overrides and deliveries belonging to another item", () => {
    const other = { ...r("announcement", "telegram", "남의 글"), itemId: "x:2" };
    const board = buildBoard("x:1", [r("kol", "telegram", "브리프"), other], [
      { itemId: "x:2", type: "kol", outletId: "tg-dev", text: "남의 수정", status: "rendered", createdAt: "T" },
    ], [
      { itemId: "x:2", type: "kol", outletId: "tg-community", status: "delivered", at: "T", by: "manual" },
    ]);
    expect(board.groups.map((g) => g.type)).toEqual(["kol"]);
    expect(board.groups[0]!.rows.map((row) => row.outletId)).toEqual(["tg-kol"]);
  });

  it("orders groups by type so the sibling numbering is stable across loads", () => {
    const board = buildBoard("x:1", [r("explainer", "telegram", "해설"), r("announcement", "telegram", "공지")], [], []);
    expect(board.groups.map((g) => g.type)).toEqual(["announcement", "explainer"]);
  });
});
