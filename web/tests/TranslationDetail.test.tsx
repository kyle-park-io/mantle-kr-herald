// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranslationDetail } from "../src/components/TranslationDetail";
import type { Translation } from "../src/types";

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

function mount(item: Translation, o: { onUnretire?: (id: string) => Promise<void> } = {}) {
  return render(
    <TranslationDetail
      item={item}
      publishRows={[]}
      availableTargets={["local"]}
      onSave={async () => {}}
      onApprove={async () => {}}
      onUnapprove={async () => {}}
      onUnretire={o.onUnretire ?? (async () => {})}
      onPublish={async () => {}}
      onDirtyChange={() => {}}
    />,
  );
}

afterEach(cleanup);

describe("TranslationDetail media", () => {
  it("previews the photo the source post carries", () => {
    const { container } = mount(translation());
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
