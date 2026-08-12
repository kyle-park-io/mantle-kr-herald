// tests/adapters/web/board.test.ts
import { describe, expect, it } from "vitest";
import { buildBoard } from "../../../src/adapters/web/board";
import { deliveredToRoom } from "../../../src/domain/delivery/models";
import type { ChannelRendering } from "../../../src/domain/formatting/models";
import type { SourceApproval } from "../../../src/domain/send/sendBlock";

const r = (type: string, channel: string, text: string, status: "rendered" | "approved" = "approved"): ChannelRendering =>
  ({ itemId: "x:1", type, channel, text, refined: false, createdAt: "T", status, approvedAt: "T2" } as ChannelRendering);

/**
 * The 1차 translation the renderings descend from, approved before them. Every test that is not
 * about the source gate itself needs one, because `sendBlock` blocks a row it cannot check.
 */
const approvedSource: SourceApproval = { status: "approved", approvedAt: "T1" };

/** A KR X post already up and reconciled — what clears the 공지 CTA gate (`xUrlBlock`). */
const POSTED_URL = "https://x.com/0xMantleKR/status/2087418810458382585";

describe("buildBoard", () => {
  it("groups by (type, channel) and lists the rooms that receive each group", () => {
    const board = buildBoard("x:1", [r("announcement", "telegram", "공통")], [], [], approvedSource);
    const group = board.groups.find((g) => g.type === "announcement" && g.channel === "telegram");
    expect(group?.text).toBe("공통");
    // Every telegram room suggests `announcement` — 텔레그램 KOL방 included (ALL_OUTLETS gives it
    // `["kol", "announcement"]`), so the whole channel is rowed and nothing is left to add.
    expect(group?.rows.map((row) => row.outletId)).toEqual(["tg-community", "tg-dev", "tg-blockchain", "tg-kol"]);
    expect(group?.addableOutletIds).toEqual([]);
  });

  it("rows the suggested rooms and offers the channel's remaining rooms as addable", () => {
    const board = buildBoard("x:1", [r("kol", "telegram", "브리프")], [], [], approvedSource);
    const group = board.groups.find((g) => g.type === "kol");
    expect(group?.rows.map((row) => row.outletId)).toEqual(["tg-kol"]);
    // suggestedTypes is a default, not a constraint — the rest of the channel stays reachable.
    expect(group?.addableOutletIds).toEqual(["tg-community", "tg-dev", "tg-blockchain"]);
  });

  it("rows a non-suggested room once it has a delivery, and drops it from addable", () => {
    const board = buildBoard("x:1", [r("kol", "telegram", "브리프")], [], [
      { itemId: "x:1", type: "kol", outletId: "tg-community", status: "delivered", at: "T", by: "manual" },
    ], approvedSource);
    const group = board.groups.find((g) => g.type === "kol");
    expect(group?.rows.map((row) => row.outletId)).toEqual(["tg-kol", "tg-community"]);
    expect(group?.addableOutletIds).not.toContain("tg-community");
  });

  it("rows a non-suggested room once it has an override", () => {
    const board = buildBoard("x:1", [r("kol", "telegram", "브리프")], [
      { itemId: "x:1", type: "kol", outletId: "tg-dev", text: "데브방용", status: "rendered", createdAt: "T" },
    ], [], approvedSource);
    const group = board.groups.find((g) => g.type === "kol");
    expect(group?.rows.map((row) => row.outletId)).toEqual(["tg-kol", "tg-dev"]);
  });

  it("marks a forked room and gives it its own text and status", () => {
    const board = buildBoard("x:1", [r("announcement", "telegram", "공통")], [
      { itemId: "x:1", type: "announcement", outletId: "tg-blockchain", text: "이 방 전용", status: "rendered", createdAt: "T" },
    ], [], approvedSource);
    const rows = board.groups[0]!.rows;
    expect(rows.find((row) => row.outletId === "tg-blockchain")).toMatchObject({ forked: true, text: "이 방 전용", status: "rendered" });
    expect(rows.find((row) => row.outletId === "tg-community")).toMatchObject({ forked: false, text: "공통", status: "approved" });
  });

  it("attaches delivery state per room, keeping two rooms on one channel apart", () => {
    const board = buildBoard("x:1", [r("announcement", "telegram", "공통")], [], [
      { itemId: "x:1", type: "announcement", outletId: "tg-community", status: "sent", at: "T", by: "auto", url: "u" },
    ], approvedSource);
    const rows = board.groups[0]!.rows;
    expect(rows.find((row) => row.outletId === "tg-community")).toMatchObject({ deliveryStatus: "sent", url: "u" });
    expect(rows.find((row) => row.outletId === "tg-dev")?.deliveryStatus).toBeUndefined();
  });

  /**
   * A `dropped` row is a scheduled Typefully draft that was deleted before it published: the room
   * never received anything, so the board must forward that fact rather than silently treating the
   * row like a `sent` one. `deliveredToRoom` is the one predicate the board's own send gate
   * (`sendBlock`/`SendChannels`) and the ledgers already agree "already delivered" means — the same
   * value the dashboard's completion tally has to agree with, or a dropped room would count as done
   * while still offering nothing but a stale record.
   */
  it("surfaces a dropped delivery as `deliveryStatus: \"dropped\"`, not as delivered", () => {
    const board = buildBoard("x:1", [r("x", "x", "트윗")], [], [
      { itemId: "x:1", type: "x", outletId: "x-post", status: "dropped", at: "T", by: "auto" },
    ], approvedSource);
    const row = board.groups[0]!.rows.find((row) => row.outletId === "x-post");
    expect(row).toMatchObject({ deliveryStatus: "dropped", at: "T" });
    // Not a live url either — a dropped draft was deleted before it ever had one.
    expect(row?.url).toBeUndefined();
    // The same predicate every ledger's `loadKeys()` uses to decide "already delivered" says no —
    // proving the tally the dashboard builds from this field would exclude the row too.
    expect(deliveredToRoom({ status: row?.deliveryStatus })).toBe(false);
  });

  it("numbers a room that appears in several groups", () => {
    const board = buildBoard("x:1", [r("announcement", "telegram", "공지"), r("explainer", "telegram", "해설")], [], [], approvedSource);
    const dev = board.groups.flatMap((g) => g.rows).filter((row) => row.outletId === "tg-dev");
    expect(dev.map((row) => [row.siblingIndex, row.siblingCount])).toEqual([[1, 2], [2, 2]]);
  });

  it("numbers a room that receives only one group as 1/1", () => {
    const board = buildBoard("x:1", [r("announcement", "telegram", "공지"), r("explainer", "telegram", "해설")], [], [], approvedSource);
    const community = board.groups.flatMap((g) => g.rows).filter((row) => row.outletId === "tg-community");
    expect(community.map((row) => [row.siblingIndex, row.siblingCount])).toEqual([[1, 1]]);
  });

  it("lists the types with no rendering yet", () => {
    const board = buildBoard("x:1", [r("announcement", "telegram", "공통")], [], [], approvedSource);
    expect(board.unconverted).toEqual(["x", "kakao_notice", "explainer", "casual", "kol", "pr"]);
  });

  it("keeps a group no room suggests, offering the whole channel as addable", () => {
    // `pr` is suggested by pr-mail only, so a `pr` rendering formatted for telegram has no default
    // room. The card must still render — otherwise the text a human already wrote is unreachable.
    const board = buildBoard("x:1", [r("pr", "telegram", "보도자료")], [], [], approvedSource);
    const group = board.groups.find((g) => g.type === "pr");
    expect(group?.rows).toEqual([]);
    expect(group?.addableOutletIds).toEqual(["tg-community", "tg-dev", "tg-blockchain", "tg-kol"]);
  });

  it("rows the X channel's one room and offers nothing else", () => {
    // The board used to filter this channel: X Articles were registered as a second `x` room, and
    // rowing them produced a card with no exit — the send route refused them and MarkDelivery
    // refused the tick. They are not a room any more, so there is nothing left to filter, and the
    // empty `addableOutletIds` here means what it says rather than hiding something.
    const board = buildBoard("x:1", [r("x", "x", "트윗")], [], [], approvedSource);
    const group = board.groups[0]!;
    expect(group.rows.map((row) => row.outletId)).toEqual(["x-post"]);
    expect(group.addableOutletIds).toEqual([]);
  });

  it("ignores a delivery or override naming a room that no longer exists", () => {
    const board = buildBoard("x:1", [r("kol", "telegram", "브리프")], [
      { itemId: "x:1", type: "kol", outletId: "tg-retired", text: "옛 방", status: "rendered", createdAt: "T" },
    ], [
      { itemId: "x:1", type: "kol", outletId: "tg-gone", status: "delivered", at: "T", by: "manual" },
    ], approvedSource);
    expect(board.groups[0]!.rows.map((row) => row.outletId)).toEqual(["tg-kol"]);
  });

  it("ignores renderings, overrides and deliveries belonging to another item", () => {
    const other = { ...r("announcement", "telegram", "남의 글"), itemId: "x:2" };
    const board = buildBoard("x:1", [r("kol", "telegram", "브리프"), other], [
      { itemId: "x:2", type: "kol", outletId: "tg-dev", text: "남의 수정", status: "rendered", createdAt: "T" },
    ], [
      { itemId: "x:2", type: "kol", outletId: "tg-community", status: "delivered", at: "T", by: "manual" },
    ], approvedSource);
    expect(board.groups.map((g) => g.type)).toEqual(["kol"]);
    expect(board.groups[0]!.rows.map((row) => row.outletId)).toEqual(["tg-kol"]);
  });

  it("orders groups by type so the sibling numbering is stable across loads", () => {
    const board = buildBoard("x:1", [r("explainer", "telegram", "해설"), r("announcement", "telegram", "공지")], [], [], approvedSource);
    expect(board.groups.map((g) => g.type)).toEqual(["announcement", "explainer"]);
  });
});

/**
 * The board's half of the send gate. Both the screen and `SendChannels` call `sendBlock`, so these
 * assertions are about the *wiring* — that the board passes the room's resolved copy and the item's
 * own translation, and reports the block rather than swallowing it.
 */
describe("buildBoard — the source translation gate", () => {
  const rows = (board: ReturnType<typeof buildBoard>) => board.groups[0]!.rows;

  it("leaves `block` off every row when the source is approved and older than the copy", () => {
    // `postedUrl` here and in the fork test below is about the OTHER gate: this is an announcement,
    // so `xUrlBlock` would block it for want of an X post and mask what this test is asserting.
    // Set per-test rather than on `approvedSource`, which must keep meaning "approved, X post not up
    // yet" for the CTA gate's own tests.
    const board = buildBoard("x:1", [r("announcement", "telegram", "공통")], [], [], { ...approvedSource, postedUrl: POSTED_URL });
    expect(rows(board).map((row) => row.block)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("blocks every row when the source's approval was withdrawn", () => {
    const board = buildBoard("x:1", [r("announcement", "telegram", "공통")], [], [], { status: "translated" });
    expect(rows(board).every((row) => row.block === "source-unapproved")).toBe(true);
  });

  /** 승인 취소 → 수정 → 재승인: the copy predates the current Korean, so the rooms stay shut. */
  it("blocks rows approved before the source was re-approved", () => {
    const board = buildBoard("x:1", [r("announcement", "telegram", "공통")], [], [], { status: "approved", approvedAt: "T9" });
    expect(rows(board).every((row) => row.block === "source-changed")).toBe(true);
  });

  it("blocks every row when the item has no translation at all", () => {
    const board = buildBoard("x:1", [r("announcement", "telegram", "공통")], [], [], undefined);
    expect(rows(board).every((row) => row.block === "source-missing")).toBe(true);
  });

  it("reports an unapproved room as `unapproved`, not as a source problem", () => {
    const board = buildBoard("x:1", [r("announcement", "telegram", "공통", "rendered")], [], [], approvedSource);
    expect(rows(board).every((row) => row.block === "unapproved")).toBe(true);
  });

  /**
   * The fork case: `[포맷 다시]` regenerates the group from the new Korean and leaves forks alone by
   * design, so one room can be current while another is not — and both read `approved`.
   */
  it("blocks only the stale fork when the group was regenerated after the source changed", () => {
    const regenerated = { ...r("announcement", "telegram", "새 공통"), approvedAt: "T9" };
    const board = buildBoard("x:1", [regenerated], [
      { itemId: "x:1", type: "announcement", outletId: "tg-dev", text: "옛 데브방 글", status: "approved", createdAt: "T", approvedAt: "T2" },
    ], [], { status: "approved", approvedAt: "T8", postedUrl: POSTED_URL });
    const byRoom = Object.fromEntries(rows(board).map((row) => [row.outletId, row.block]));
    expect(byRoom["tg-dev"]).toBe("source-changed");
    expect(byRoom["tg-community"]).toBeUndefined();
  });
});

describe("buildBoard — the 공지 CTA gate", () => {
  const X_URL = "https://x.com/0xMantleKR/status/2087418810458382585";
  /** The `x-post` delivery row a bot-sent KR post leaves behind, once reconciled to its x.com url. */
  const xPostRow = (url: string | undefined) =>
    [{ itemId: "x:1", type: "x", outletId: "x-post", status: "sent" as const, at: "T", by: "auto" as const, url }];

  it("blocks every 공지 room while the item has no X post", () => {
    const board = buildBoard("x:1", [r("announcement", "telegram", "공지")], [], [], approvedSource);
    const rows = board.groups[0].rows;
    expect(rows.every((row) => row.block === "x-url-missing")).toBe(true);
  });

  it("clears once the x-post delivery row carries an x.com url", () => {
    const board = buildBoard("x:1", [r("announcement", "telegram", "공지")], [], xPostRow(X_URL), approvedSource);
    const rows = board.groups.find((g) => g.type === "announcement")!.rows;
    expect(rows.every((row) => row.block === undefined)).toBe(true);
  });

  it("still blocks while that row holds only a typefully share url", () => {
    const board = buildBoard("x:1", [r("announcement", "telegram", "공지")], [], xPostRow("https://typefully.com/t/abc"), approvedSource);
    const rows = board.groups.find((g) => g.type === "announcement")!.rows;
    expect(rows.every((row) => row.block === "x-url-missing")).toBe(true);
  });

  it("clears from the translation's posted url too", () => {
    const board = buildBoard("x:1", [r("announcement", "telegram", "공지")], [], [], { ...approvedSource, postedUrl: X_URL });
    expect(board.groups[0].rows.every((row) => row.block === undefined)).toBe(true);
  });

  it("leaves a type that carries no CTA alone", () => {
    const board = buildBoard("x:1", [r("explainer", "telegram", "해설")], [], [], approvedSource);
    expect(board.groups[0].rows.every((row) => row.block === undefined)).toBe(true);
  });

  /**
   * Approval is named first when both apply: an unreviewed room has a reviewer to go find, and
   * "X를 먼저 게시하세요" would send them to a screen that cannot release it.
   */
  it("names the approval gate ahead of the missing X post", () => {
    const board = buildBoard("x:1", [r("announcement", "telegram", "공지", "rendered")], [], [], approvedSource);
    expect(board.groups[0].rows.every((row) => row.block === "unapproved")).toBe(true);
  });
});
