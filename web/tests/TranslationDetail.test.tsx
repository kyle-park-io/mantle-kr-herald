// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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

function mount(item: Translation) {
  return render(
    <TranslationDetail
      item={item}
      publishRows={[]}
      availableTargets={["local"]}
      onSave={async () => {}}
      onApprove={async () => {}}
      onUnapprove={async () => {}}
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
