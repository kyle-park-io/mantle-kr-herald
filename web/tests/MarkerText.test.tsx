// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarkerText, MediaEditNotice, MediaEditNoticeSlot } from "../src/components/MarkerText";

const URL = "https://pbs.twimg.com/media/HOUihv6bgAA52e_.jpg";
const PHOTO = `[사진](${URL})`;

afterEach(cleanup);

describe("MarkerText", () => {
  it("shows the marker's label and the surrounding text, but never the raw url", () => {
    // This used to assert the text rendered byte-for-byte. It deliberately no longer does: a
    // 60-character CDN url is not something a reviewer reads, and a thread carrying four photos was
    // mostly url. The stored text is unchanged — the editable textarea beside this pane still shows
    // the line verbatim, and the send path still uploads that exact string.
    const text = `본문 첫 줄\n\n${PHOTO}`;
    const { container } = render(<MarkerText text={text} />);
    expect(container.textContent).toContain("본문 첫 줄");
    expect(container.textContent).toContain("[사진]");
    expect(container.textContent).not.toContain(URL);
  });

  it("links each photo marker to its original", () => {
    const { container } = render(<MarkerText text={PHOTO} />);
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe(URL);
    expect(link.textContent).toContain("원본 보기");
  });

  it("still reads a legacy ![](url) marker, so text saved before the label existed keeps working", () => {
    // Nothing re-derives stored text on read. Every translation and rendering saved before this
    // change carries the old spelling, and must still preview and still strip at send time.
    const { container } = render(<MarkerText text={`![](${URL})`} />);
    expect(container.querySelector("img")!.getAttribute("src")).toBe(URL);
    expect(container.textContent).toContain("[이미지]");
  });

  it("gives each photo marker an image to preview", () => {
    const other = "https://pbs.twimg.com/media/OTHER.jpg";
    const { container } = render(<MarkerText text={`${PHOTO}\n\n---\n\n[사진](${other})`} />);
    expect([...container.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual([URL, other]);
  });

  it("previews nothing when there is no photo marker", () => {
    const { container } = render(<MarkerText text={"[영상]\n\n평범한 본문\n[결과 확인]"} />);
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });

  it("says so when the image cannot be loaded, instead of showing a broken box", () => {
    const { container } = render(<MarkerText text={PHOTO} />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.textContent).toContain("이미지를 불러오지 못했습니다");
  });

  it("clears the failed state when a different photo url is rendered at the same position", () => {
    const urlA = "https://pbs.twimg.com/media/A.jpg";
    const urlB = "https://pbs.twimg.com/media/B.jpg";
    const { container, rerender } = render(<MarkerText text={`[사진](${urlA})`} />);

    // First image fails
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.textContent).toContain("이미지를 불러오지 못했습니다");

    // Rerender with a different url at the same position
    rerender(<MarkerText text={`[사진](${urlB})`} />);

    // New image should be present, failure message should be gone
    const imgs = container.querySelectorAll("img");
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute("src")).toBe(urlB);
    expect(container.textContent).not.toContain("이미지를 불러오지 못했습니다");
  });

  it("does not leak failed state when rerending with different urls", () => {
    const DUP = "https://pbs.twimg.com/media/DUP.jpg";
    const OTHER = "https://pbs.twimg.com/media/OTHER.jpg";

    // Item A: DUP appears twice
    const textA = `[사진](${DUP})\n\n중간\n\n[사진](${DUP})`;
    const { container, rerender } = render(<MarkerText text={textA} />);

    // First image in item A fails
    fireEvent.error(container.querySelectorAll("img")[0]!);
    expect(container.querySelectorAll("img")).toHaveLength(1); // Only second DUP remains

    // Item B: DUP once + OTHER
    const textB = `[사진](${OTHER})\n\n중간\n\n[사진](${DUP})`;
    rerender(<MarkerText text={textB} />);

    // No orphaned failure message from item A
    expect(container.textContent).not.toContain("이미지를 불러오지 못했습니다");
    expect(container.querySelectorAll("img")).toHaveLength(2);
    expect([...container.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual([OTHER, DUP]);
  });
});

describe("MediaEditNotice", () => {
  it("renders nothing when the edited text carries no media", () => {
    const { container } = render(<MediaEditNotice text="사진 없는 번역문" where="원문" />);
    expect(container.textContent).toBe("");
  });

  it("points at the pane that has the preview", () => {
    const { container } = render(<MediaEditNotice text={`번역문\n\n${PHOTO}`} where="변환 원문" />);
    expect(container.textContent).toContain("변환 원문");
  });

  it("says video has no preview at all", () => {
    const { container } = render(<MediaEditNotice text={"번역문\n\n[영상]"} where="원문" />);
    expect(container.textContent).toContain("영상은 미리보기가 없습니다");
    expect(container.textContent).not.toContain("이미지 미리보기");
  });

  /**
   * The combined branch — both halves joined with " · " — had no coverage at all before this. It is
   * also the longest string the notice can produce, which is the one that wraps to two lines below
   * ~700px window width (accepted, out of scope for this fix).
   */
  it("joins both halves when the text carries a photo marker and a video marker", () => {
    const { container } = render(<MediaEditNotice text={`번역문\n\n${PHOTO}\n\n[영상]`} where="원문" />);
    expect(container.textContent).toContain("이미지 미리보기는 원문에서 확인하세요");
    expect(container.textContent).toContain("영상은 미리보기가 없습니다");
    expect(container.textContent).toBe("이미지 미리보기는 원문에서 확인하세요 · 영상은 미리보기가 없습니다");
  });
});

describe("MediaEditNoticeSlot", () => {
  /**
   * Proven by mutation: deleting the strut `<p>` from the old, three-times-hand-copied version of
   * this slot left every one of the 20 existing component tests green, because they only ever assert
   * on the notice's own text — none of them looked for the placeholder itself. This is what pins the
   * mechanism the layout-shift fix (`dd9ae1f`) depends on.
   *
   * jsdom has no layout engine, so this cannot assert an actual pixel height — only that, for text
   * with NO marker, the slot still contains an `aria-hidden` placeholder element carrying the
   * notice's own type scale (`text-[12px] leading-relaxed`), which is what reserves the same box a
   * real notice would occupy.
   */
  it("keeps a strut placeholder in the slot even when the text carries no marker", () => {
    const { container } = render(<MediaEditNoticeSlot text="사진 없는 번역문" where="원문" />);
    const slot = container.querySelector('[data-testid="media-edit-notice-slot"]');
    expect(slot).not.toBeNull();
    const strut = slot!.querySelector('p[aria-hidden="true"]');
    expect(strut).not.toBeNull();
    expect(strut!.className).toContain("text-[12px]");
    expect(strut!.className).toContain("leading-relaxed");
    // The real notice renders null for this text — the strut (a non-breaking space, so it does not
    // collapse to an empty line box the way an ordinary space would) is the only thing in the slot.
    expect(slot!.textContent).toBe(" ");
  });

  it("keeps the same strut placeholder alongside the real notice once a marker is present", () => {
    const { container } = render(<MediaEditNoticeSlot text={`번역문\n\n${PHOTO}`} where="원문" />);
    const slot = container.querySelector('[data-testid="media-edit-notice-slot"]');
    expect(slot!.querySelector('p[aria-hidden="true"]')).not.toBeNull();
    expect(slot!.textContent).toContain("이미지 미리보기는 원문에서 확인하세요");
  });
});
