// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarkerText, MediaEditNotice, MediaEditNoticeSlot } from "../src/components/MarkerText";

const URL = "https://pbs.twimg.com/media/HOUihv6bgAA52e_.jpg";
const PHOTO = `[사진](${URL})`;
const VIDEO_URL =
  "https://video.twimg.com/amplify_video/2076703853182074880/vid/avc1/720x720/vPz8ankm0777GHP_.mp4?tag=14";
const VIDEO = `[영상] ${VIDEO_URL}`;

afterEach(cleanup);

/**
 * The clip is mounted the first time the pointer reaches the marker, so every video assertion has to
 * hover first. `fireEvent.mouseOver`, not `mouseEnter`: React implements `onMouseEnter` by watching
 * `mouseover`/`mouseout` at the root, and a `mouseenter` event does not bubble there — dispatching it
 * would leave the handler unrun and the test asserting on an unarmed marker.
 */
const hoverMarker = (container: HTMLElement, label: string) => {
  const marker = [...container.querySelectorAll("span")].find((s) => s.firstChild?.textContent === label);
  if (!marker) throw new Error(`no ${label} marker to hover`);
  fireEvent.mouseOver(marker);
  return marker;
};

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

  it("previews nothing when there is no marker carrying a url", () => {
    const { container } = render(<MarkerText text={"[영상]\n\n평범한 본문\n[결과 확인]"} />);
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.querySelectorAll("video")).toHaveLength(0);
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

describe("MarkerText — video markers", () => {
  it("shows the label and links to the original, without printing the raw url", () => {
    const { container } = render(<MarkerText text={`본문 첫 줄\n\n${VIDEO}`} />);
    expect(container.textContent).toContain("본문 첫 줄");
    expect(container.textContent).toContain("[영상]");
    expect(container.textContent).not.toContain(VIDEO_URL);
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe(VIDEO_URL);
    expect(link.textContent).toContain("원본 보기");
  });

  it("plays the clip one hover away", () => {
    const { container } = render(<MarkerText text={VIDEO} />);
    hoverMarker(container, "[영상]");
    expect(container.querySelector("video")!.getAttribute("src")).toBe(VIDEO_URL);
  });

  it("mounts no clip until the pointer reaches the marker", () => {
    // Otherwise a board showing a dozen markers pulls down a dozen mp4s before anyone looks at one:
    // the popover is only `display:none`, which does not stop a media element from fetching.
    const { container } = render(<MarkerText text={`${VIDEO}\n\n---\n\n${VIDEO}`} />);
    expect(container.querySelectorAll("video")).toHaveLength(0);
    hoverMarker(container, "[영상]");
    expect(container.querySelectorAll("video")).toHaveLength(1);
  });

  it("never plays sound and never stops on its own", () => {
    const { container } = render(<MarkerText text={VIDEO} />);
    hoverMarker(container, "[영상]");
    const video = container.querySelector("video")!;
    expect(video.muted).toBe(true);
    expect(video.autoplay).toBe(true);
    expect(video.loop).toBe(true);
    // Without `playsinline` iOS Safari takes the clip fullscreen instead of playing it in the popover.
    expect(video.hasAttribute("playsinline")).toBe(true);
  });

  it("leaves a legacy url-less marker as the plain text it is today", () => {
    // Every translation and rendering saved before the url was captured carries this spelling, and
    // nothing re-derives stored text on read. It must look exactly as it looked before this change:
    // literal text, no preview, no link — not a marker whose preview is permanently empty.
    const { container } = render(<MarkerText text={"본문\n\n[영상]"} />);
    expect(container.textContent).toBe("본문\n\n[영상]");
    expect(container.querySelectorAll("video")).toHaveLength(0);
    expect(container.querySelectorAll("a")).toHaveLength(0);
  });

  it("says so when the clip cannot be loaded, instead of showing a dead black box", () => {
    const { container } = render(<MarkerText text={VIDEO} />);
    hoverMarker(container, "[영상]");
    fireEvent.error(container.querySelector("video")!);
    expect(container.querySelectorAll("video")).toHaveLength(0);
    expect(container.textContent).toContain("영상을 불러오지 못했습니다");
  });

  it("clears the failed state when a different clip is rendered at the same position", () => {
    const other = "https://video.twimg.com/amplify_video/1/vid/avc1/720x720/OTHER.mp4?tag=14";
    const { container, rerender } = render(<MarkerText text={VIDEO} />);
    hoverMarker(container, "[영상]");
    fireEvent.error(container.querySelector("video")!);
    expect(container.textContent).toContain("영상을 불러오지 못했습니다");

    rerender(<MarkerText text={`[영상] ${other}`} />);
    hoverMarker(container, "[영상]");
    expect(container.textContent).not.toContain("영상을 불러오지 못했습니다");
    expect(container.querySelector("video")!.getAttribute("src")).toBe(other);
  });

  it("previews a photo and a video in the same text, each with its own original", () => {
    const { container } = render(<MarkerText text={`${PHOTO}\n\n---\n\n${VIDEO}`} />);
    hoverMarker(container, "[영상]");
    expect(container.querySelector("img")!.getAttribute("src")).toBe(URL);
    expect(container.querySelector("video")!.getAttribute("src")).toBe(VIDEO_URL);
    expect([...container.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
      URL,
      VIDEO_URL,
    ]);
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

  it("says a url-less video has no preview at all", () => {
    const { container } = render(<MediaEditNotice text={"번역문\n\n[영상]"} where="원문" />);
    expect(container.textContent).toBe("영상은 미리보기가 없습니다");
  });

  it("points at the pane for a video that does carry a url", () => {
    const { container } = render(<MediaEditNotice text={`번역문\n\n${VIDEO}`} where="원문" />);
    expect(container.textContent).toBe("영상 미리보기는 원문에서 확인하세요");
  });

  it("names both kinds once when a photo and a previewable video are in the same copy", () => {
    const { container } = render(<MediaEditNotice text={`${PHOTO}\n\n${VIDEO}`} where="변환 원문" />);
    expect(container.textContent).toBe("이미지와 영상 미리보기는 변환 원문에서 확인하세요");
  });

  /**
   * The case the old unconditional copy got flatly wrong in both directions: it would have claimed
   * the previewable clip has no preview. Saying both halves plainly would be no better — "영상
   * 미리보기는 …에서 확인하세요 · 영상은 미리보기가 없습니다" reads as a contradiction — so the
   * second half is scoped to `일부`.
   */
  it("does not claim both at once when only some of the videos carry a url", () => {
    const { container } = render(<MediaEditNotice text={`${VIDEO}\n\n[영상]`} where="원문" />);
    expect(container.textContent).toBe("영상 미리보기는 원문에서 확인하세요 · 일부 영상은 미리보기가 없습니다");
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
