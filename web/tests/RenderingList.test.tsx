// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RenderingList } from "../src/components/RenderingList";
import type { Rendering } from "../src/types";

afterEach(cleanup);

function r(over: Partial<Rendering> & { itemId: string }): Rendering {
  return {
    type: "announcement",
    channel: "telegram",
    text: "본문",
    refined: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    status: "rendered",
    convertedText: "",
    ...over,
  };
}

/** 목록에 남은 아이템 id들. 행 버튼만 `x:`를 담는다 (검색창도 지우기 버튼도 담지 않는다). */
function shownIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll("button")]
    .map((b) => b.textContent ?? "")
    .filter((s) => s.includes("x:"))
    .map((s) => /x:\d+/.exec(s)?.[0] ?? "");
}

const type = (value: string) => fireEvent.change(screen.getByLabelText("검색"), { target: { value } });

describe("RenderingList search", () => {
  /**
   * 한 아이템의 카드는 여러 장이고 미리보기는 첫 장뿐이다. 오픈카톡 카드에만 있는 문구로 검색해도
   * 행이 남아야 한다 — 행의 역할은 보드를 여는 것이지 매치를 증명하는 것이 아니다.
   */
  it("keeps an item whose match is on a card the preview does not show", () => {
    const { container } = render(
      <RenderingList
        items={[
          r({ itemId: "x:1", type: "announcement", channel: "telegram", text: "텔레그램 공지 문구" }),
          r({ itemId: "x:1", type: "announcement", channel: "kakao", text: "카카오에만 있는 에어드랍 안내" }),
          r({ itemId: "x:2", text: "관계없는 다른 아이템" }),
        ]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    type("에어드랍");
    expect(shownIds(container)).toEqual(["x:1"]);
  });

  it("matches by initial consonants and by itemId", () => {
    const { container } = render(
      <RenderingList
        items={[r({ itemId: "x:1", text: "맨틀 네트워크 공지" }), r({ itemId: "x:2", text: "다른 소식" })]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    type("ㅁㅌ");
    expect(shownIds(container)).toEqual(["x:1"]);
    type("x:2");
    expect(shownIds(container)).toEqual(["x:2"]);
  });

  it("ands with the channel filter rather than replacing it", () => {
    const { container } = render(
      <RenderingList
        items={[
          r({ itemId: "x:1", channel: "telegram", text: "맨틀 텔레그램" }),
          r({ itemId: "x:2", channel: "kakao", text: "맨틀 카카오" }),
        ]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    fireEvent.change(screen.getByDisplayValue("모든 채널"), { target: { value: "kakao" } });
    type("맨틀");
    expect(shownIds(container)).toEqual(["x:2"]);
  });

  it("says nothing matched rather than showing a stale list", () => {
    render(<RenderingList items={[r({ itemId: "x:1", text: "맨틀" })]} selectedId={null} onSelect={() => {}} />);
    type("ㅋㅋㅋㅋ");
    expect(screen.getByText("해당하는 항목이 없습니다.")).toBeTruthy();
  });
});
