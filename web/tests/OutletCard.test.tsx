// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OutletCard } from "../src/components/OutletCard";
import { api } from "../src/api";
import type { ConfirmRequest } from "../src/components/ConfirmDialog";
import { SENDS_CLOSED_MESSAGE, type BoardGroup, type BoardRow, type BoardView } from "../src/types";

/**
 * The board's own components, in a DOM — the first tests in this repo that click a button rather than
 * call a function.
 *
 * They exist for one class of defect that nothing else can catch. `rowEditor.ts` decides which story
 * an irreversible click is described by (`resendKind`, `reconcileOutcome`) and is thoroughly tested as
 * pure functions; what was verified only by READING is that the card hands each verdict to the right
 * dialog and the right message. A card that computes `unlinked` and then renders the `posted` lines
 * is a screen telling the operator "먼저 보낸 글은 지워지지 않습니다" about a post nobody knows exists,
 * one keystroke before it cannot be taken back — and every pure test in the suite would still pass.
 *
 * Deliberately not a snapshot suite: these assert the load-bearing SENTENCES, so a layout change does
 * not fail them and a reworded promise about a live post does.
 */

const row = (o: Partial<BoardRow> = {}): BoardRow => ({
  outletId: "x-main",
  label: "맨틀 한국 X",
  delivery: "auto",
  forked: false,
  status: "approved",
  text: "이 방에 나갈 글",
  siblingCount: 1,
  siblingIndex: 1,
  ...o,
});

const group = (o: Partial<BoardGroup> & { rows: BoardRow[] }): BoardGroup => ({
  type: "announcement",
  channel: "x",
  text: "그룹 글",
  status: "approved",
  addableOutletIds: [],
  ...o,
});

const board = (...groups: BoardGroup[]): BoardView => ({ itemId: "2026-07-30-a", groups, unconverted: [] });

/**
 * Mounting fetches each text's emitted spelling for [복사]. The card already tolerates that failing
 * (`api.emissions(...).catch(() => ({}))`), so a rejecting stub is the honest default: it keeps these
 * tests off the network without also making them depend on a payload none of them assert on. Routes a
 * test does care about are stubbed per test.
 */
function stubFetch(handler?: (url: string, init?: RequestInit) => unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const answer = handler?.(url, init);
      if (answer === undefined) throw new Error(`unstubbed ${url}`);
      return new Response(JSON.stringify(answer), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
}

/**
 * `api` is a module-level singleton — `OutletCard`/`Row` import it directly rather than taking it as
 * a prop, so a test that wants to observe or answer a call (the send tests below) has to patch that
 * shared object rather than pass one in. Snapshotting it once, before any test runs, is what lets
 * `afterEach` put it back: without that, a `sendOutlet` stub installed by one test would leak into
 * whichever test runs next and silently swallow its `fetch` traffic.
 */
const defaultApi = { ...api };

/**
 * Renders one card and hands back the confirm requests it raised and the errors it reported, plus a
 * `rerender` that re-mounts with a new `group` — same component instance, same React state — for
 * tests that need to simulate the board repainting under an editor the reviewer already has open
 * (e.g. a room going `sent` from outside this tab while a draft still sits in its editor).
 *
 * `o.api` patches the shared `api` singleton for the duration of the test (see `defaultApi` above) —
 * only the tests that care about what reaches `api.sendOutlet` need it, so every other call site in
 * this file keeps mounting with just `{ convertedText?, sendsEnabled? }` and never sees the patch.
 */
function mount(g: BoardGroup, o: { convertedText?: string; sendsEnabled?: boolean; api?: Partial<typeof api> } = {}) {
  if (o.api) Object.assign(api, o.api);
  const confirms: ConfirmRequest[] = [];
  const errors: (string | null)[] = [];
  const boards: { board: BoardView; quotaMayHaveChanged?: boolean }[] = [];
  const element = (group: BoardGroup, opts: { convertedText?: string; sendsEnabled?: boolean }) => (
    <OutletCard
      itemId="2026-07-30-a"
      group={group}
      // Defaults open — most of this file is about editor/confirm-dialog behaviour that has nothing
      // to do with the send flag; the tests that ARE about it (below) pass `sendsEnabled: false`
      // explicitly.
      sendsEnabled={opts.sendsEnabled ?? true}
      convertedText={opts.convertedText ?? "변환 원문"}
      hovered={null}
      onHover={() => {}}
      onBoard={(b, q) => boards.push({ board: b, quotaMayHaveChanged: q })}
      onGroupChanged={async () => {}}
      onError={(m) => errors.push(m)}
      onDirty={() => {}}
      onConfirm={(r) => confirms.push(r)}
    />
  );
  const { container, rerender } = render(element(g, o));
  return {
    confirms,
    errors,
    boards,
    container,
    rerender: (g2: BoardGroup, o2: { convertedText?: string; sendsEnabled?: boolean } = o) => rerender(element(g2, o2)),
  };
}

/** The lines the operator is shown, as one string — these assert sentences, not array shapes. */
const said = (r: ConfirmRequest) => r.lines.join("\n");

beforeEach(() => stubFetch());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.assign(api, defaultApi);
});

describe("OutletCard — 재발송 asks about the row it was clicked on", () => {
  /**
   * An `예약됨` row: sent, still a scheduled Typefully draft. Nothing has gone out, the server cancels
   * the original first, and exactly one post goes up — so the dialog may not promise a second one.
   */
  it("tells the queued story for a row whose draft has not published", () => {
    const { confirms } = mount(group({ rows: [row({ deliveryStatus: "sent", awaitingPublish: true, at: "2026-07-30T01:00:00.000Z" })] }));

    fireEvent.click(screen.getByRole("button", { name: "재발송" }));

    expect(confirms).toHaveLength(1);
    expect(said(confirms[0])).toContain("이 방에는 글이 하나만 올라갑니다");
    // The clause that would be false here, and was shown before PR #85: nothing has gone out yet.
    expect(said(confirms[0])).not.toContain("글이 하나 더 올라갑니다");
    // The refusals are named before the click, not after it — all three arrive as an error afterwards.
    expect(said(confirms[0])).toContain("발송을 멈추고 알려드립니다");
  });

  /**
   * The `unlinked` row the resend guard writes when it cancels a draft and then cannot rule out that
   * the original published anyway: `sent`, no draft id, no url. Nothing on the screen or the server
   * knows whether a post exists, and the guard's own refusal told the operator to press 재발송 once
   * more — so this is where that operator lands.
   */
  it("tells the unlinked story for a sent X row with neither draft id nor link", () => {
    const { confirms } = mount(group({ rows: [row({ deliveryStatus: "sent", at: "2026-07-30T01:00:00.000Z" })] }));

    fireEvent.click(screen.getByRole("button", { name: "재발송" }));

    expect(said(confirms[0])).toContain("글이 실제로 올라갔는지 이 화면에서도 서버에서도 확인할 수 없습니다");
    expect(said(confirms[0])).toContain("계정을 먼저 확인하세요");
    // Both of the ordinary wording's promises are claims about a post nobody has established exists.
    expect(said(confirms[0])).not.toContain("나간 글이 있습니다");
    expect(said(confirms[0])).not.toContain("링크는 이 화면에서 사라집니다");
  });

  /** The ordinary case: the room holds a post with a link, and a resend really does add a second. */
  it("tells the posted story for a row carrying a real x.com link", () => {
    const rows = [row({ deliveryStatus: "sent", url: "https://x.com/a/status/777", at: "2026-07-30T01:00:00.000Z" })];
    const { confirms } = mount(group({ rows }));

    fireEvent.click(screen.getByRole("button", { name: "재발송" }));

    expect(said(confirms[0])).toContain("이 방에 글이 하나 더 올라갑니다");
    expect(said(confirms[0])).toContain("먼저 보낸 글의 링크는 이 화면에서 사라집니다");
  });

  /** Nothing goes out until the operator confirms — the click opens a dialog and sends no request. */
  it("sends nothing on the click itself", () => {
    const { confirms } = mount(group({ rows: [row({ deliveryStatus: "sent", url: "https://x.com/a/status/777" })] }));

    fireEvent.click(screen.getByRole("button", { name: "재발송" }));

    expect(confirms[0].confirmLabel).toBe("다시 발송");
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toEqual([]);
  });
});

describe("OutletCard — sends closed account-wide (sendsEnabled: false)", () => {
  /**
   * "Refuse at the route, not the button" is about enforcement, not visibility — a route that
   * refuses independently still has to say so before an operator promises themselves an irreversible
   * post via the confirm dialog. Same visual treatment (`발송 · 잠김`) an ineligible `row.block`
   * already gets, so a reviewer never has to learn a second "this is locked" shape.
   */
  it("locks an auto room's 발송 button, with the shared closed-sends message", () => {
    mount(group({ rows: [row()] }), { sendsEnabled: false });

    const button = screen.getByRole("button", { name: "발송 · 잠김" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // The message now lives in an InfoPopover, which renders nothing until opened — clicking the
    // (disabled) button still bubbles to the wrapper's click handler, the only one listening.
    fireEvent.click(button);
    expect(screen.getByText(SENDS_CLOSED_MESSAGE)).toBeTruthy();
  });

  /** The same route refuses a resend too — the button offering it must say so as well. */
  it("locks an already-sent auto room's 재발송 button too", () => {
    mount(group({ rows: [row({ deliveryStatus: "sent", url: "https://x.com/a/status/777" })] }), {
      sendsEnabled: false,
    });

    const button = screen.getByRole("button", { name: "재발송" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // See above: open the InfoPopover before reading its text.
    fireEvent.click(button);
    expect(screen.getByText(SENDS_CLOSED_MESSAGE)).toBeTruthy();
  });

  /** `sendToOutlet` never touches a manual room — 전달함 keeps working while sends are closed. */
  it("leaves a manual room's 전달함 alone", () => {
    mount(group({ rows: [row({ delivery: "manual", outletId: "kakao-kol", label: "오픈카톡 KOL방" })] }), {
      sendsEnabled: false,
    });

    expect(screen.queryByRole("button", { name: "발송 · 잠김" })).toBeNull();
    expect(screen.queryByText(SENDS_CLOSED_MESSAGE)).toBeNull();
    expect((screen.getByRole("button", { name: "전달함 ☐" }) as HTMLButtonElement).disabled).toBe(false);
  });

  /** The default (and every other test in this file): sends open, the ordinary button renders. */
  it("leaves an auto room's 발송 button unlocked when sends are open", () => {
    mount(group({ rows: [row()] }), { sendsEnabled: true });

    expect((screen.getByRole("button", { name: "발송" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "발송 · 잠김" })).toBeNull();
  });
});

describe("OutletCard — [게시 확인] reports this row, not the ledger", () => {
  const queued = row({ deliveryStatus: "sent", awaitingPublish: true, at: "2026-07-30T01:00:00.000Z" });
  const sibling = (o: Partial<BoardRow>) => row({ outletId: "x-alt", label: "다른 방", ...o });

  /** The reconcile route answers with ledger-wide counts AND the rebuilt board. */
  const reconcileAnswers = (counts: { reconciled: number; retired: number; pending: number }, after: BoardView) =>
    stubFetch((url) => (url.endsWith("/reconcile") ? { ...counts, board: after } : undefined));

  /**
   * Presses the button on `x-main`'s OWN row. Scoped by the `data-outlet` attribute the row carries,
   * because a sibling still waiting on its own draft renders a 게시 확인 button too — an unscoped query
   * would either match two buttons or silently press the wrong room's, which is the very confusion
   * these tests are about.
   */
  const press = async (g: BoardGroup) => {
    const m = mount(g);
    const own = document.querySelector('li[data-outlet="x-main"]');
    expect(own).not.toBeNull();
    fireEvent.click(within(own as HTMLElement).getByRole("button", { name: "게시 확인" }));
    // The handler awaits the route, then the board, then reports — one microtask flush is not enough.
    await vi.waitFor(() => expect(m.boards.length).toBe(1));
    return m;
  };

  /**
   * The misreport that contradicted the screen: a SIBLING's draft was deleted, so the pass answers
   * `retired: 1` — and this room, whose own draft is still queued, was told its post had been
   * cancelled, one line under the `예약됨` badge the same click had just repainted.
   */
  it("does not report a sibling's cancelled draft as this room's", async () => {
    const after = board(group({ rows: [queued, sibling({ deliveryStatus: "dropped" })] }));
    reconcileAnswers({ reconciled: 0, retired: 1, pending: 1 }, after);

    const { errors } = await press(group({ rows: [queued, sibling({ deliveryStatus: "sent", awaitingPublish: true })] }));

    expect(errors).not.toContain("예약된 게시물이 게시되기 전에 취소되었습니다 — 이 방은 다시 보낼 수 있습니다.");
    expect(errors).toContain("아직 게시되지 않았습니다 — 잠시 뒤 다시 눌러보세요.");
  });

  /**
   * The quieter one: a SIBLING published, so `reconciled` is not zero and "아직 게시되지 않았습니다"
   * was withheld — the click answered with nothing at all, which on a board that repaints itself
   * reads as success.
   */
  it("still says not-yet when a sibling published and this row did not", async () => {
    const after = board(group({ rows: [queued, sibling({ deliveryStatus: "sent", url: "https://x.com/a/status/778" })] }));
    reconcileAnswers({ reconciled: 1, retired: 0, pending: 1 }, after);

    const { errors } = await press(group({ rows: [queued, sibling({ deliveryStatus: "sent", awaitingPublish: true })] }));

    expect(errors).toContain("아직 게시되지 않았습니다 — 잠시 뒤 다시 눌러보세요.");
  });

  it("reports this room's own cancelled draft", async () => {
    const after = board(group({ rows: [row({ deliveryStatus: "dropped" })] }));
    reconcileAnswers({ reconciled: 0, retired: 1, pending: 0 }, after);

    const { errors } = await press(group({ rows: [queued] }));

    expect(errors).toContain("예약된 게시물이 게시되기 전에 취소되었습니다 — 이 방은 다시 보낼 수 있습니다.");
  });

  it("says nothing when the row came back with its link — the link is the answer", async () => {
    const after = board(group({ rows: [row({ deliveryStatus: "sent", url: "https://x.com/a/status/777" })] }));
    reconcileAnswers({ reconciled: 1, retired: 0, pending: 0 }, after);

    const { errors } = await press(group({ rows: [queued] }));

    // `run()` clears the banner before the call, so a null is expected — a message is not.
    expect(errors.filter((e) => e !== null)).toEqual([]);
  });

  /**
   * The quota is account-wide, so any row publishing in that pass moved it — the refetch flag stays
   * ledger-wide even though the message no longer is.
   */
  it("still asks the board to refetch the quota", async () => {
    const after = board(group({ rows: [queued] }));
    reconcileAnswers({ reconciled: 0, retired: 0, pending: 1 }, after);

    const { boards } = await press(group({ rows: [queued] }));

    expect(boards[0].quotaMayHaveChanged).toBe(true);
  });
});

describe("media markers", () => {
  const URL = "https://pbs.twimg.com/media/HOZMXqPbIAALIE8.jpg";
  const PHOTO = `![](${URL})`;

  beforeEach(() => stubFetch());

  it("previews the photo in the converted source", () => {
    const { container } = mount(group({ text: "그룹 글", rows: [row()] }), { convertedText: `변환 원문\n\n${PHOTO}` });
    // Photo previews are click-to-open now: open the marker before looking for its image.
    fireEvent.click(screen.getByText("[이미지]"));
    expect([...container.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual([URL]);
  });

  it("tells the group editor where the preview is", () => {
    const { container } = mount(group({ text: `그룹 글\n\n${PHOTO}`, rows: [row()] }));
    expect(container.textContent).toContain("이미지 미리보기는 변환 원문에서 확인하세요");
  });

  it("says nothing when no text on the card carries media", () => {
    const { container } = mount(group({ text: "그룹 글", rows: [row()] }));
    expect(container.textContent).not.toContain("미리보기");
  });

  // jsdom has no layout engine, so this pins the *structure* the layout-shift fix relies on rather
  // than an actual pixel height. Proven by mutation: deleting just the strut placeholder from the
  // (formerly hand-copied) slot left every other test in this describe block green, because none of
  // them look for the placeholder itself — only for the notice's text.
  it("reserves the group notice's slot with a strut, even when nothing on the card carries media", () => {
    const { container } = mount(group({ text: "그룹 글", rows: [row()] }));
    const slot = container.querySelector('[data-testid="media-edit-notice-slot"]');
    expect(slot).not.toBeNull();
    const strut = slot!.querySelector('p[aria-hidden="true"]');
    expect(strut).not.toBeNull();
    expect(strut!.className).toContain("text-[12px]");
    expect(strut!.className).toContain("leading-relaxed");
  });

  /**
   * A forked room's own copy carries its own markers, independent of the group's — and a forked row
   * is open by default (`OutletCard`'s `isOpen` is true whenever `row.forked` and nothing collapsed
   * it), so this reaches the fork textarea's notice with no click needed.
   */
  it("tells the fork editor where the preview is, for a room's own marker", () => {
    const { container } = mount(group({ text: "그룹 글", rows: [row({ forked: true, text: `이 방 글\n\n${PHOTO}` })] }));
    const own = container.querySelector('li[data-outlet="x-main"]');
    expect(own).not.toBeNull();
    expect(own!.textContent).toContain("이미지 미리보기는 변환 원문에서 확인하세요");
  });

  it("reserves the fork's notice slot with nothing to say when the room's own text has no marker", () => {
    const { container } = mount(group({ text: "그룹 글", rows: [row({ forked: true, text: "이 방 글" })] }));
    const own = container.querySelector('li[data-outlet="x-main"]');
    expect(own).not.toBeNull();
    const slots = own!.querySelectorAll('[data-testid="media-edit-notice-slot"]');
    expect(slots.length).toBeGreaterThan(0);
    expect(own!.textContent).not.toContain("미리보기");
    // Same mutation-proofing as the group-level slot: the strut placeholder, not just the (empty)
    // container div, has to be the thing under test, or deleting it leaves this green too.
    const strut = slots[0].querySelector('p[aria-hidden="true"]');
    expect(strut).not.toBeNull();
    expect(strut!.className).toContain("text-[12px]");
    expect(strut!.className).toContain("leading-relaxed");
  });

  /**
   * The fork editor's notice must describe what the textarea above it is actually showing. On a
   * `sent` (read-only) row the textarea falls back to the stored `row.text` rather than a stale
   * local draft (see the comment beside that textarea in `OutletCard`) — reproduced here exactly as
   * described: type a marker into the draft while the row is still editable, then have the board
   * repaint the same row as `sent` out from under it (as if `pnpm send:channels` sent it from another
   * tab). The notice must follow the textarea back to the stored text, not keep describing the stale
   * draft.
   */
  it("keeps the fork notice reading what the read-only textarea shows, not a stale draft", () => {
    const forkedRow = row({ forked: true, text: "이 방 글", status: "rendered" });
    const { container, rerender } = mount(group({ text: "그룹 글", rows: [forkedRow] }));
    const own = () => container.querySelector('li[data-outlet="x-main"]') as HTMLElement;

    // Type a photo marker into the still-editable draft, without saving.
    const textarea = within(own()).getByRole("textbox");
    fireEvent.change(textarea, { target: { value: `이 방 글\n\n${PHOTO}` } });
    expect(own().textContent).toContain("이미지 미리보기는 변환 원문에서 확인하세요");

    // The row goes `sent` from outside this tab, with the ORIGINAL (marker-free) stored text — the
    // draft above is now stale.
    rerender(
      group({
        text: "그룹 글",
        rows: [row({ forked: true, text: "이 방 글", status: "rendered", deliveryStatus: "sent", url: "https://x.com/a/1" })],
      }),
    );

    // The textarea falls back to the stored text (no marker); the notice must agree with it.
    expect((within(own()).getByRole("textbox") as HTMLTextAreaElement).value).toBe("이 방 글");
    expect(own().textContent).not.toContain("미리보기");
  });
});

describe("OutletCard — 핀 고정 is offered where it exists", () => {
  it("offers the pin toggle on a telegram room's 발송", () => {
    const { confirms } = mount(group({ channel: "telegram", rows: [row()] }));

    fireEvent.click(screen.getByRole("button", { name: "발송" }));

    expect(confirms[0].toggle?.label).toContain("고정");
  });

  it("offers it on 재발송 too", () => {
    const { confirms } = mount(
      group({ channel: "telegram", rows: [row({ deliveryStatus: "sent", at: "2026-07-30T01:00:00.000Z" })] }),
    );

    fireEvent.click(screen.getByRole("button", { name: "재발송" }));

    expect(confirms[0].toggle?.label).toContain("고정");
  });

  /** X posts are published through Typefully; there is nothing to pin. */
  it("does not offer it on an X room", () => {
    const { confirms } = mount(group({ channel: "x", rows: [row()] }));

    fireEvent.click(screen.getByRole("button", { name: "발송" }));

    expect(confirms[0].toggle).toBeUndefined();
  });

  /**
   * A manual room has no bot in it, so it never renders 발송/재발송 in the first place — only
   * 전달함 (a human already pasted). This is belt-and-suspenders on top of that routing: it fails
   * loudly if a future change ever lets a manual row reach the confirm dialog at all.
   */
  it("does not offer it on a manual telegram room", () => {
    const { confirms } = mount(
      group({ channel: "telegram", rows: [row({ delivery: "manual" })] }),
    );

    fireEvent.click(screen.getByRole("button", { name: "전달함 ☐" }));

    expect(confirms).toHaveLength(0);
  });

  it("sends the toggle's answer to the API", async () => {
    const sent: unknown[] = [];
    const { confirms } = mount(group({ channel: "telegram", rows: [row()] }), {
      api: {
        sendOutlet: async (...args: Parameters<typeof api.sendOutlet>) => {
          sent.push(args);
          return { sent: 1, failed: 0, board: board() };
        },
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "발송" }));
    confirms[0].onConfirm({ toggled: true });

    await waitFor(() => expect(sent).toHaveLength(1));
    expect((sent[0] as unknown[])[3]).toEqual({ resend: false, pin: true });
  });
});

/**
 * `승인됨 ✓`/`승인 취소` used to swap on hover; Task 6 routed it through a confirm dialog instead —
 * and, like every other irreversible action on this card (재발송, 발송 above), through the board's
 * one shared dialog (`props.onConfirm`) rather than a second one of its own. These pin two things a
 * unit test can still catch without rendering the real `ConfirmDialog`: the click itself never
 * reaches the unapprove route directly, and the copy that reaches the dialog says what THIS control
 * actually withdraws. Fix round 1 shipped the group-level wording ("이 항목이 다시 검수 대기로
 * 돌아갑니다") at the row-level control too, where it is false — a forked room's own approval, not
 * the item's — which is exactly the class of bug these two guard against.
 */
describe("OutletCard 승인 취소 — asks through the board's shared dialog, with copy scoped to what it withdraws", () => {
  it("group-level: withdraws the whole group's approval, and says so before doing it", async () => {
    const approveRendering: unknown[] = [];
    const { confirms } = mount(group({ status: "approved", rows: [row()] }), {
      api: {
        approveRendering: async (...args: Parameters<typeof api.approveRendering>) => {
          approveRendering.push(args);
          return {} as Awaited<ReturnType<typeof api.approveRendering>>;
        },
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "승인됨 ✓" }));
    // Nothing happens on the click itself — only the shared dialog opens.
    expect(approveRendering).toHaveLength(0);
    expect(confirms).toHaveLength(1);
    expect(said(confirms[0])).toContain("이 항목이 다시 검수 대기로 돌아갑니다");

    confirms[0].onConfirm({ toggled: false });
    await waitFor(() => expect(approveRendering).toHaveLength(1));
    expect((approveRendering[0] as unknown[])[3]).toBe(false);
  });

  it("row-level: withdraws only that forked room's approval, and says so — not the item-level copy", async () => {
    const approveOutlet: unknown[] = [];
    const forkedRow = row({ forked: true, status: "approved" });
    // `group.status` deliberately NOT "approved": the group-level control above renders on that
    // condition alone, and having both controls on screen would make `getByRole` ambiguous — the
    // row-level one (`gate.showUnapprove`) only needs the row itself forked and approved.
    const { confirms } = mount(group({ status: "rendered", rows: [forkedRow] }), {
      api: {
        approveOutlet: async (...args: Parameters<typeof api.approveOutlet>) => {
          approveOutlet.push(args);
          return { board: board() };
        },
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "승인됨 ✓" }));
    expect(approveOutlet).toHaveLength(0);
    expect(confirms).toHaveLength(1);
    expect(said(confirms[0])).toContain(`${forkedRow.label}의 승인만 취소됩니다`);
    expect(said(confirms[0])).toContain("항목이나 다른 방에는 영향이 없습니다");
    // The group-level wording would be false here — this room's approval is not the item's.
    expect(said(confirms[0])).not.toContain("검수 대기로 돌아갑니다");

    confirms[0].onConfirm({ toggled: false });
    await waitFor(() => expect(approveOutlet).toHaveLength(1));
    expect((approveOutlet[0] as unknown[])[3]).toBe(false);
  });
});

/**
 * "Why can't I press this" messages, which on this board are the ones a reviewer needs most and were
 * the ones that never appeared.
 *
 * Each of these hung on a native `title` whose condition ALSO sat in the control's `disabled`
 * expression — `groupDirty` on 승인하기, `reason` on 복사, `blocked` on 발송/전달함,
 * `gate.approveDisabled` on the row's 승인하기. A disabled button fires no hover, so the browser
 * never drew any of them. `ConfirmDialog`'s `Tip` already existed for exactly this and says so in its
 * own comment; these controls had simply never been moved onto it.
 *
 * `groupApproved` on 저장 used to be in this list too (Task 10's first pass moved it onto a `Tip` here,
 * same as the others). Fix round 1 found it already said, permanently and without any interaction, as
 * inline text next to the textarea above (also Task 10) — the `Tip` was a second, harder-to-reach copy
 * of the same sentence, not a second message. Dropped the `Tip`; the case below now asserts the inline
 * text directly rather than clicking a control that no longer carries the reason.
 *
 * Asserting on `textContent` is the point: a `title` attribute is invisible to a reviewer and to
 * `textContent` alike, so a regression that puts one back fails here.
 *
 * `Tip` now renders through `InfoPopover`, whose panel is not in the DOM until opened — so each of
 * the remaining cases clicks the (possibly disabled) control before reading the message.
 *
 * What that click here does NOT prove: in a real browser, a native disabled control never dispatches
 * a click at all — no bubbling, no keyboard activation, and it drops out of the tab order. jsdom has
 * no layout engine, so it cannot hit-test `[&_:disabled]:pointer-events-none` on `InfoPopover`'s
 * trigger (the fix that makes a real click land on the wrapper instead of the disabled child), and
 * `fireEvent.click` dispatches directly to the node regardless of `disabled`, bypassing the native
 * suppression entirely. That gap is exactly what let fix round 1 ship with these six tests green while
 * every one of these cards was still unreachable in Chromium — see `InfoPopover.test.tsx`'s
 * "disabled 트리거" describe block for the keyboard half jsdom CAN check, and the task report for the
 * Playwright verification of the half it cannot.
 */
describe("OutletCard — a blocked control says why, as text rather than a dead title", () => {
  const APPROVED_LOCK = "승인 상태에서는 편집할 수 없습니다. 먼저 승인을 취소하세요.";

  it("explains the 저장 lock on an approved group, unconditionally rather than behind a Tip", () => {
    // No click here: unlike the other cases below, this reason is inline text now (Task 10 fix round
    // 1), not a `Tip` — it has to be on screen without any interaction at all.
    const { container } = mount(group({ status: "approved", rows: [row()] }));
    expect(container.textContent).toContain(APPROVED_LOCK);
  });

  it("stays quiet about that lock while the group is still editable", () => {
    // The scope check: without it, rendering the reason unconditionally would pass the test above and
    // park a permanent notice next to a textarea the reviewer is meant to use.
    const { container } = mount(group({ status: "rendered", rows: [row()] }));
    expect(container.textContent).not.toContain(APPROVED_LOCK);
  });

  it("explains a [복사] that cannot copy yet", async () => {
    // `stubFetch()` with no handler rejects the emissions call, which is the card's own tolerated
    // failure path (`api.emissions(...).catch(() => ({}))`) and leaves `segments` null — the exact
    // state this message describes. It reached the DOM only as a `title` before. `segments` is
    // already null on the very first render (state starts empty, before the fetch even settles), so
    // the click can happen immediately.
    const { container } = mount(group({ status: "rendered", rows: [row()] }));
    fireEvent.click(screen.getByRole("button", { name: "복사" }));
    await waitFor(() => expect(container.textContent).toContain("붙여넣기용 텍스트를 아직 불러오지 못했습니다"));
  });
});
