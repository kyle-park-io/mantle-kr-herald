// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranslationDetail } from "../src/components/TranslationDetail";
import type { PublishStateRow, Translation } from "../src/types";

const URL = "https://pbs.twimg.com/media/HOUihv6bgAA52e_.jpg";
const PHOTO = `![](${URL})`;

const translation = (o: Partial<Translation> = {}): Translation => ({
  itemId: "x:2081711456320655644",
  source: "x",
  sourceText: `Built from the inside out.\n\n${PHOTO}`,
  koreanText: `맨틀은 이 구조를 내부에서부터 구축했습니다.\n\n${PHOTO}`,
  status: "translated",
  translatedAt: "2026-07-30T00:00:00.000Z",
  ...o,
});

function mount(
  item: Translation,
  o: {
    onUnretire?: (id: string) => Promise<void>;
    onRetire?: (id: string) => Promise<void>;
    publishRows?: PublishStateRow[];
    availableTargets?: ("local" | "google" | "lark")[];
  } = {},
) {
  return render(
    <TranslationDetail
      item={item}
      publishRows={o.publishRows ?? []}
      availableTargets={o.availableTargets ?? ["local"]}
      onSave={async () => {}}
      onApprove={async () => {}}
      onUnapprove={async () => {}}
      onUnretire={o.onUnretire ?? (async () => {})}
      onRetire={o.onRetire ?? (async () => {})}
      onPublish={async () => {}}
      onDirtyChange={() => {}}
    />,
  );
}

afterEach(cleanup);

describe("TranslationDetail media", () => {
  it("previews the photo the source post carries", () => {
    const { container } = mount(translation());
    // Photo previews are click-to-open now: open the marker before looking for its image.
    fireEvent.click(screen.getByText("[이미지]"));
    expect([...container.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual([URL]);
  });

  it("tells the editor where the preview is", () => {
    const { container } = mount(translation());
    expect(container.textContent).toContain("이미지 미리보기는 원문에서 확인하세요");
  });

  it("stays silent for a translation with no media", () => {
    const { container } = mount(translation({ sourceText: "no media", koreanText: "미디어 없음" }));
    expect(container.textContent).not.toContain("미리보기");
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });

  it("leaves the textarea holding the stored text, markers included", () => {
    const { container } = mount(translation());
    expect(container.querySelector("textarea")!.value).toBe(translation().koreanText);
  });

  // jsdom has no layout engine, so these two pin the *structure* the height-reservation fix relies
  // on rather than an actual pixel height: the same slot node must exist whether or not a marker is
  // present, so nothing below it can ever collapse to zero height and jump on the very next keystroke.
  it("reserves the notice's slot even when there is no marker to show", () => {
    const { container } = mount(translation({ sourceText: "no media", koreanText: "미디어 없음" }));
    const slot = container.querySelector('[data-testid="media-edit-notice-slot"]');
    expect(slot).not.toBeNull();
    // The slot node existing is not enough by itself — proven by mutation, deleting just the strut
    // placeholder inside it left this assertion (as it stood before this fix) green. The placeholder
    // itself, at the notice's own type scale, is what actually reserves the line.
    const strut = slot!.querySelector('p[aria-hidden="true"]');
    expect(strut).not.toBeNull();
    expect(strut!.className).toContain("text-[12px]");
    expect(strut!.className).toContain("leading-relaxed");
  });

  it("reuses that same slot to hold the notice once a marker is present", () => {
    const { container } = mount(translation());
    const slot = container.querySelector('[data-testid="media-edit-notice-slot"]');
    expect(slot).not.toBeNull();
    expect(slot!.textContent).toContain("이미지 미리보기는 원문에서 확인하세요");
  });
});

/**
 * `posted` is the reconcile-retired state (Task 2/4): a translation reconcile matched against a
 * live @0xMantleKR post and marked done outside this dashboard. "Lock, do not hide" is the
 * requirement — a reviewer must still be able to read what went out, just not edit or approve it —
 * and 되돌리기 is the one way back, which must keep `postedUrl` on record so the next unattended
 * `x:reconcile` tick does not re-retire what a human just disputed (see `RetireTranslation`'s own
 * doc comment and `SaveTranslation.run`'s preservation of postedUrl/postedAt across an ordinary save).
 */
describe("TranslationDetail — 게시됨 (posted)", () => {
  const POSTED_URL = "https://x.com/0xMantleKR/status/1999999999999999999";

  it("locks a posted item: no edit, no 승인", () => {
    mount(translation({ status: "posted", postedUrl: POSTED_URL }));
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.readOnly).toBe(true);
    // Neither the "아직 대기" approve button nor the "승인됨" approved control may appear — a posted
    // item is not mid-1차-review, it is already done.
    expect(screen.queryByRole("button", { name: "승인하기" })).toBeNull();
    expect(screen.queryByRole("button", { name: /승인 취소/ })).toBeNull();
    expect(screen.queryByText("승인됨 ✓")).toBeNull();
    // 저장 stays disabled even for a no-op click — the textarea being readOnly is not enough on its
    // own, since a locked approved item still renders (and disables) the 저장 button too.
    expect((screen.getByRole("button", { name: "저장" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("links the live post it was matched to", () => {
    mount(translation({ status: "posted", postedUrl: POSTED_URL }));
    const link = screen.getByRole("link", { name: /게시된 글/ }) as HTMLAnchorElement;
    expect(link.href).toBe(POSTED_URL);
  });

  it("shows when it went out, in KST, beside the link", () => {
    // 05:39 UTC is 14:39 the same day in Seoul. A reviewer's first question about a row nobody
    // approved is "when did this happen?" — and reading UTC as local would be nine hours wrong.
    mount(translation({ status: "posted", postedUrl: POSTED_URL, postedAt: "2026-07-31T05:39:41.000Z" }));
    expect(screen.getByText("게시 시각 2026-07-31 14:39 KST")).toBeTruthy();
  });

  it("renders no timestamp when postedAt is absent, rather than an empty slot", () => {
    // A legacy row retired before postedAt existed, or a hand-edited one.
    mount(translation({ status: "posted", postedUrl: POSTED_URL }));
    expect(screen.queryByText(/KST/)).toBeNull();
  });

  it("shows the timestamp on the reverted-item note too", () => {
    mount(translation({ status: "translated", postedUrl: POSTED_URL, postedAt: "2026-07-31T22:10:00.000Z" }));
    // 22:10 UTC is already the next day in Seoul — the case a naive ISO slice gets wrong.
    expect(screen.getByText("게시 시각 2026-08-01 07:10 KST")).toBeTruthy();
  });

  it("offers 되돌리기 on a posted item and not on any other status", () => {
    mount(translation({ status: "posted", postedUrl: POSTED_URL }));
    expect(screen.getByRole("button", { name: "되돌리기" })).toBeTruthy();
    cleanup();

    mount(translation({ status: "translated" }));
    expect(screen.queryByRole("button", { name: "되돌리기" })).toBeNull();
    cleanup();

    mount(translation({ status: "approved", approvedAt: "2026-07-30T00:00:00.000Z" }));
    expect(screen.queryByRole("button", { name: "되돌리기" })).toBeNull();
  });

  it("shows the earlier match as a note on an item that was reverted (postedUrl set, status translated)", () => {
    mount(translation({ status: "translated", postedUrl: POSTED_URL }));
    // Reverted, not locked: the reviewer can edit and approve exactly as any other translated item.
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.readOnly).toBe(false);
    expect(screen.getByRole("button", { name: "승인하기" })).toBeTruthy();
    // But the evidence of the earlier match is not hidden — the whole point of keeping postedUrl.
    const link = screen.getByRole("link", { name: /게시된 글/ }) as HTMLAnchorElement;
    expect(link.href).toBe(POSTED_URL);
  });

  /**
   * The note's condition is `!posted && postedUrl` — a strict superset of the brief's stated
   * `status: "translated"` case — because nothing clears `postedUrl` once a retire sets it except
   * another retire overwriting it with a different url. A translation can be 되돌려진 and then
   * approved normally (ordinary 1차 flow), landing on `status: "approved"` with `postedUrl` still
   * set; hiding the evidence there would be the same "lock, don't hide" violation the brief warns
   * about for the `translated` case.
   */
  it("also shows the earlier-match note on an approved item (postedUrl survived past a later approval)", () => {
    mount(translation({ status: "approved", approvedAt: "2026-07-30T00:00:00.000Z", postedUrl: POSTED_URL }));
    // Approved and locked exactly as any other approved item — the note is additive, not a lock.
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.readOnly).toBe(true);
    const link = screen.getByRole("link", { name: /게시된 글/ }) as HTMLAnchorElement;
    expect(link.href).toBe(POSTED_URL);
  });

  /**
   * Final review, Important 2. A translation that was approved, published to Drive, and then retired
   * by reconcile ends up with a ledger row whose status ("approved") no longer matches the item's
   * ("posted"). The server used to report that row as `synced: false`, which lit "재발행 필요" and the
   * notice below, telling the reviewer to press 발행 — while the 발행 buttons stayed enabled. Pressing
   * them re-rendered the item as a *review* doc, uploaded it to review/, and deleted the approved doc
   * holding the copy that actually went out. `x:2080608995371597892`, one of the five items retiring
   * on the first production run, is exactly this shape.
   *
   * The server is the source of truth (`createDeps.loadPublishState` now reports a retired item's
   * rows as synced), so the stale row fed below is what the client can still be *holding*: App.tsx
   * fetches `publishState` and `translations` as two requests, and a retire landing between them
   * leaves a fresh `posted` item beside a stale row.
   */
  const STALE_ROW: PublishStateRow = { itemId: "x:2081711456320655644", status: "approved", target: "google", synced: false };

  it("disables 발행 on a posted item", () => {
    mount(translation({ status: "posted", postedUrl: POSTED_URL }), { publishRows: [STALE_ROW] });
    for (const label of ["로컬 폴더", "Google Drive", "Lark Drive"]) {
      expect((screen.getByRole("button", { name: label }) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("does not tell a reviewer to press 발행 again on a posted item", () => {
    const { container } = mount(translation({ status: "posted", postedUrl: POSTED_URL }), { publishRows: [STALE_ROW] });
    expect(container.textContent).not.toContain("발행을 다시 눌러");
  });

  it("still shows that notice, with 발행 usable, on a NON-posted item whose files are outdated", () => {
    // The scope check: the suppression is about `posted`, not about hiding a real staleness warning.
    // Without this, "delete the notice entirely" would pass the test above.
    const { container } = mount(translation({ status: "translated" }), { publishRows: [STALE_ROW] });
    expect(container.textContent).toContain("발행을 다시 눌러");
    expect((screen.getByRole("button", { name: "로컬 폴더" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("되돌리기 hands the item's id to onUnretire", async () => {
    const calls: string[] = [];
    mount(translation({ status: "posted", postedUrl: POSTED_URL }), {
      onUnretire: async (id) => {
        calls.push(id);
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "되돌리기" }));
    await vi.waitFor(() => expect(calls).toEqual(["x:2081711456320655644"]));
  });
});

/**
 * Why a disabled 발행 button says why, and why that has to be RENDERED TEXT rather than a `title`.
 *
 * Every reason the button carries also forces `disabled`, and a disabled button dispatches no
 * pointer events — so the browser never draws its native tooltip. The message existed in the markup
 * and no reviewer could ever see it. That is invisible to a test that asserts on the attribute,
 * which is why these assert on `textContent`: the reason has to be in the DOM as text the
 * `group/tip` wrapper can reveal on hover.
 *
 * jsdom applies no CSS, so what these pin is the half a unit test CAN see — the message is present,
 * and it is present only when it applies.
 *
 * `Tip` now renders through `InfoPopover`, whose panel is not in the DOM until opened — so each test
 * below clicks the (disabled) button first.
 *
 * What that click here does NOT prove: a real disabled control dispatches no click at all — no
 * bubbling, no keyboard activation, and no tab stop. jsdom has no layout engine, so it cannot
 * hit-test `[&_:disabled]:pointer-events-none` on `InfoPopover`'s trigger (the fix that makes a real
 * click land on the wrapper instead of the disabled child), and `fireEvent.click` dispatches straight
 * to the node regardless of `disabled`, bypassing that native suppression entirely. See
 * `InfoPopover.test.tsx`'s "disabled 트리거" block for the keyboard half jsdom CAN check, and the task
 * report for the Playwright check (real Chromium, tap + Tab/Enter) of the half it cannot.
 */
describe("TranslationDetail — why a 발행 target is unavailable", () => {
  const HOSTED: ("local" | "google" | "lark")[] = ["google", "lark"];
  const POSTED_URL = "https://x.com/0xMantleKR/status/1999999999999999999";

  it("says why the hosted board's [로컬 폴더] is greyed, as text and not a dead title", () => {
    const { container } = mount(translation(), { availableTargets: HOSTED });
    const button = screen.getByRole("button", { name: "로컬 폴더" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    // Not `getAttribute("title")` — that is exactly the shape that did not work.
    expect(container.textContent).toContain("이 모드에서는 사용할 수 없는 타깃");
  });

  it("stays quiet about a target this deployment does offer", () => {
    // The scope check: without it, "render the reason unconditionally" would pass the test above and
    // park a permanent tooltip over the buttons a reviewer actually uses.
    const { container } = mount(translation(), { availableTargets: ["local", ...HOSTED] });
    expect((screen.getByRole("button", { name: "로컬 폴더" }) as HTMLButtonElement).disabled).toBe(false);
    expect(container.textContent).not.toContain("이 모드에서는 사용할 수 없는 타깃");
  });

  it("explains the posted lock on the 발행 buttons too", () => {
    // The same dead-`title` bug covered all three reasons, not just the unavailable-target one.
    const { container } = mount(translation({ status: "posted", postedUrl: POSTED_URL }));
    fireEvent.click(screen.getByRole("button", { name: "로컬 폴더" }));
    expect(container.textContent).toContain("이미 X에 직접 게시된 것으로 확인되어");
  });
});

/**
 * The published block. `x:reconcile` stores the copy @0xMantleKR actually published beside the draft
 * we produced; until this block existed, the only way to read it was SQL. Its whole value is showing
 * *what the human changed* — the motivating case was `구매하신 → 구매한` and `무엇입니까 → 무엇인가요`,
 * a register shift the team makes deliberately and the steering config forbids.
 */
describe("TranslationDetail published copy", () => {
  const posted = (publishedText?: string) =>
    translation({
      status: "posted",
      koreanText: "가장 최근에 구매하신 토큰화 자산은 무엇입니까?",
      postedUrl: "https://x.com/0xMantleKR/status/999",
      postedAt: "2026-07-31T05:39:41.000Z",
      publishedText,
    });

  it("shows the published copy for a posted item", () => {
    mount(posted("가장 최근에 구매한 토큰화 자산은 무엇인가요?"));
    expect(screen.getByText(/실제 게시된 글/)).toBeTruthy();
    expect(screen.getByTestId("published-copy").textContent).toBe(
      "가장 최근에 구매한 토큰화 자산은 무엇인가요?",
    );
  });

  it("highlights only the changed part of a word, not the whole word", () => {
    // Character-level, deliberately: `구매하신` → `구매한` shares the stem, and marking the whole
    // token would repaint text the human did not touch. Korean is agglutinative, so word-level
    // marking also called light rewrites "mostly new" and switched the highlight off — see
    // publishedDiff's own doc comment for the measurement.
    const { container } = mount(posted("가장 최근에 구매한 토큰화 자산은 무엇인가요?"));
    const marks = [...container.querySelectorAll("[data-changed='true']")].map((n) => n.textContent);
    expect(marks).toEqual(["한", "인가요"]);
  });

  it("renders nothing when the item has no published copy yet", () => {
    mount(posted(undefined));
    expect(screen.queryByText(/실제 게시된 글/)).toBeNull();
  });

  it("renders nothing for an item that was never posted", () => {
    mount(translation({ publishedText: "어쩌다 남은 값" }));
    expect(screen.queryByText(/실제 게시된 글/)).toBeNull();
  });

  it("drops the highlighting, and says so, when most of the copy is new", () => {
    const { container } = mount(posted("완전히 다른 문장이 여기에 들어갑니다 전부 새로 쓴 내용입니다."));
    expect(container.querySelectorAll("[data-changed='true']").length).toBe(0);
    expect(screen.getByText(/거의 새로 쓰였습니다/)).toBeTruthy();
    // The copy itself is still shown in full — the note replaces the highlighting, not the text.
    expect(screen.getByTestId("published-copy").textContent).toBe(
      "완전히 다른 문장이 여기에 들어갑니다 전부 새로 쓴 내용입니다.",
    );
  });
});

/**
 * The other half of 되돌리기. `postedUrl` survives the dispute so no unattended tick can undo a
 * human's correction — which also meant nothing could undo the human's own mis-click. The button
 * lives in the note that already tells the reviewer this item was once matched to a live post.
 */
describe("TranslationDetail 게시됨으로", () => {
  const disputed = { status: "translated" as const, postedUrl: "https://x.com/0xMantleKR/status/1" };

  it("offers 게시됨으로 on an item that carries a posted record but is not posted", () => {
    mount(translation(disputed));
    expect(screen.getByRole("button", { name: "게시됨으로" })).toBeTruthy();
  });

  it("offers it on an approved item too, since that is where a dispute plus an approval lands", () => {
    mount(translation({ ...disputed, status: "approved", approvedAt: "2026-08-08T00:00:00.000Z" }));
    expect(screen.getByRole("button", { name: "게시됨으로" })).toBeTruthy();
  });

  it("does not offer it on an item that was never posted — there is nothing to restore", () => {
    mount(translation({ status: "translated" }));
    expect(screen.queryByRole("button", { name: "게시됨으로" })).toBeNull();
  });

  it("does not offer it on an item already posted — 되돌리기 is the control there", () => {
    mount(translation({ status: "posted", postedUrl: "https://x.com/0xMantleKR/status/1" }));
    expect(screen.queryByRole("button", { name: "게시됨으로" })).toBeNull();
    expect(screen.getByRole("button", { name: "되돌리기" })).toBeTruthy();
  });

  it("hands the item's id to onRetire", async () => {
    const onRetire = vi.fn(async () => {});
    mount(translation(disputed), { onRetire });
    fireEvent.click(screen.getByRole("button", { name: "게시됨으로" }));
    expect(onRetire).toHaveBeenCalledWith("x:2081711456320655644");
  });
});
