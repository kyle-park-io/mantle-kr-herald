// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarkerText, MediaEditNotice } from "../src/components/MarkerText";

const URL = "https://pbs.twimg.com/media/HOUihv6bgAA52e_.jpg";
const PHOTO = `![](${URL})`;

afterEach(cleanup);

describe("MarkerText", () => {
  it("renders the reviewed text unchanged", () => {
    const text = `본문 첫 줄\n\n${PHOTO}`;
    const { container } = render(<MarkerText text={text} />);
    expect(container.textContent).toBe(text);
  });

  it("gives each photo marker an image to preview", () => {
    const other = "https://pbs.twimg.com/media/OTHER.jpg";
    const { container } = render(<MarkerText text={`${PHOTO}\n\n---\n\n![](${other})`} />);
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
    const { container, rerender } = render(<MarkerText text={`![](${urlA})`} />);

    // First image fails
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.textContent).toContain("이미지를 불러오지 못했습니다");

    // Rerender with a different url at the same position
    rerender(<MarkerText text={`![](${urlB})`} />);

    // New image should be present, failure message should be gone
    const imgs = container.querySelectorAll("img");
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute("src")).toBe(urlB);
    expect(container.textContent).not.toContain("이미지를 불러오지 못했습니다");
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
});
